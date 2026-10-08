const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const migration = require("../../db/knex_migrations/2026-10-08-0000-restore-legacy-resource-owners");

const resourceTables = ["docker_host", "proxy", "monitor", "maintenance", "notification", "api_key", "remote_browser"];

/**
 * Build an isolated post-Better-Auth-upgrade database with lost owners.
 * @param {object} t Test context for database cleanup
 * @returns {Promise<object>} SQLite connection
 */
async function upgradedDatabase(t) {
    const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
    t.after(() => db.destroy());
    await db.schema.createTable("user", (table) => {
        table.increments("id");
        table.string("username");
    });
    await db.schema.createTable("better_auth_user", (table) => {
        table.string("id").primary();
        table.string("username");
    });
    await db("user").insert({ id: 1, username: "owner" });
    await db("better_auth_user").insert({ id: "new-owner", username: "owner" });
    for (const name of resourceTables) {
        await db.schema.createTable(name, (table) => {
            table.increments("id");
            table.string("user_id");
        });
        await db(name).insert([{ id: 1, user_id: null }, { id: 2, user_id: "already-owned" }]);
    }
    return db;
}

test("upgrade restores unowned resources for the already migrated sole legacy account, preserving existing owners", async (t) => {
    const db = await upgradedDatabase(t);
    await db.transaction((trx) => migration.up(trx));
    await db.transaction((trx) => migration.up(trx));
    for (const table of resourceTables) {
        assert.deepEqual(await db(table).orderBy("id"), [
            { id: 1, user_id: "new-owner" }, { id: 2, user_id: "already-owned" },
        ]);
    }
});

test("ambiguous or unmatched accounts leave unowned resources untouched", async (t) => {
    for (const scenario of ["multiple-legacy", "multiple-current", "renamed", "no-legacy", "not-yet-migrated"]) {
        await t.test(scenario, async (t) => {
            const db = await upgradedDatabase(t);
            if (scenario === "multiple-legacy") {
                await db("user").insert({ id: 2, username: "other" });
            } else if (scenario === "multiple-current") {
                await db("better_auth_user").insert({ id: "other", username: "other" });
            } else if (scenario === "renamed") {
                await db("better_auth_user").update({ username: "renamed" });
            } else if (scenario === "no-legacy") {
                await db("user").delete();
            } else {
                await db("better_auth_user").delete();
            }
            await db.transaction((trx) => migration.up(trx));
            for (const table of resourceTables) {
                assert.equal((await db(table).where({ id: 1 }).first()).user_id, null);
                assert.equal((await db(table).where({ id: 2 }).first()).user_id, "already-owned");
            }
        });
    }
});

test("legacy mixed-case usernames match Better Auth's normalized username", async (t) => {
    const db = await upgradedDatabase(t);
    await db("user").update({ username: "Owner" });
    await db.transaction((trx) => migration.up(trx));
    assert.equal((await db("notification").where({ id: 1 }).first()).user_id, "new-owner");
});

test("a failed ownership migration rolls back every resource table", async (t) => {
    const db = await upgradedDatabase(t);
    await db.schema.dropTable("remote_browser");
    await assert.rejects(db.transaction((trx) => migration.up(trx)), /remote_browser/);
    for (const table of resourceTables.slice(0, -1)) {
        assert.equal((await db(table).where({ id: 1 }).first()).user_id, null);
    }
});
