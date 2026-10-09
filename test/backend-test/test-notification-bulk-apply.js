process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { after, before, describe, test } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const knex = require("knex");
const {
    Notification,
    applyNotificationToMonitors,
    getNotificationApplyPreview,
    normalizeApplyExistingScope,
} = require("../../server/notification");

describe("Notification bulk apply", () => {
    let db;
    let userOne;
    let userTwo;
    let notification;
    let group;
    let leafOne;
    let leafTwo;
    let otherUserLeaf;

    before(async () => {
        db = knex({
            client: "better-sqlite3",
            connection: { filename: ":memory:" },
            useNullAsDefault: true,
        });
        R.setup(db);
        R.freeze(true);
        await R.exec(
            "CREATE TABLE monitor (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, name TEXT, active INTEGER, `interval` INTEGER, parent INTEGER)"
        );
        await R.exec(
            "CREATE TABLE notification (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, config TEXT, is_default INTEGER)"
        );
        await R.exec(
            "CREATE TABLE monitor_notification (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER, notification_id INTEGER)"
        );

        userOne = { id: 1 };
        userTwo = { id: 2 };

        group = await createMonitor(userOne.id, "group", "Group");
        leafOne = await createMonitor(userOne.id, "http", "Leaf One", group.id);
        leafTwo = await createMonitor(userOne.id, "ping", "Leaf Two");
        otherUserLeaf = await createMonitor(userTwo.id, "http", "Other User Leaf");

        notification = R.dispense("notification");
        notification.user_id = userOne.id;
        notification.name = "Bulk notification";
        notification.config = JSON.stringify({ type: "webhook", name: "Bulk notification" });
        await R.store(notification);
    });

    after(async () => {
        await db.destroy();
    });

    test("legacy applyExisting true maps to all monitors", () => {
        assert.strictEqual(normalizeApplyExistingScope({ applyExisting: true }), "all");
        assert.strictEqual(normalizeApplyExistingScope({ applyExisting: false }), "none");
    });

    test("non-group scope is user-scoped, idempotent, previewable, and can explicitly clean groups", async () => {
        assert.deepStrictEqual(await getNotificationApplyPreview(notification.id, userOne.id, "non-group", false), {
            additions: 2,
            removals: 0,
        });

        await applyNotificationToMonitors(notification.id, userOne.id, "non-group", false);
        await applyNotificationToMonitors(notification.id, userOne.id, "non-group", false);

        let monitorIDs = await relationMonitorIDs(notification.id);
        assert.deepStrictEqual(
            monitorIDs,
            [leafOne.id, leafTwo.id].sort((a, b) => a - b)
        );
        assert.ok(!monitorIDs.includes(group.id));
        assert.ok(!monitorIDs.includes(otherUserLeaf.id));

        await createRelation(group.id, notification.id);
        assert.deepStrictEqual(await getNotificationApplyPreview(notification.id, userOne.id, "non-group", true), {
            additions: 0,
            removals: 1,
        });

        await applyNotificationToMonitors(notification.id, userOne.id, "non-group", true);
        monitorIDs = await relationMonitorIDs(notification.id);
        assert.deepStrictEqual(
            monitorIDs,
            [leafOne.id, leafTwo.id].sort((a, b) => a - b)
        );
    });

    test("all scope includes the current user's group but not another user's monitor", async () => {
        await applyNotificationToMonitors(notification.id, userOne.id, "all", false);
        const monitorIDs = await relationMonitorIDs(notification.id);
        assert.deepStrictEqual(
            monitorIDs,
            [group.id, leafOne.id, leafTwo.id].sort((a, b) => a - b)
        );
        assert.ok(!monitorIDs.includes(otherUserLeaf.id));
    });

    test("save cannot edit another user's notification", async () => {
        await assert.rejects(
            Notification.save({ type: "webhook", name: "Forbidden edit" }, notification.id, userTwo.id),
            /notification not found/
        );
    });

    test("saving an invalid independent inspection template is rejected before persistence or bulk apply", async () => {
        await assert.rejects(Notification.save({
            type: "webhook", name: "Invalid inspection", webhookInspectionBody: "custom",
            webhookInspectionCustomBody: "private-token {% if summary.offline %}", applyExistingScope: "all",
        }, null, userOne.id), error => {
            assert.match(error.message, /Invalid inspection template/);
            assert.doesNotMatch(error.stack, /private-token/);
            return true;
        });
    });
});

/**
 * Create a minimal monitor row.
 * @param {number} userID User ID
 * @param {string} type Monitor type
 * @param {string} name Monitor name
 * @param {?number} parent Parent monitor ID
 * @returns {Promise<object>} Monitor bean
 */
async function createMonitor(userID, type, name, parent = null) {
    const monitor = R.dispense("monitor");
    monitor.user_id = userID;
    monitor.type = type;
    monitor.name = name;
    monitor.active = 1;
    monitor.interval = 60;
    monitor.parent = parent;
    await R.store(monitor);
    return monitor;
}

/**
 * Create a monitor-notification relation for integration assertions.
 * @param {number} monitorID Monitor ID
 * @param {number} notificationID Notification ID
 * @returns {Promise<void>}
 */
async function createRelation(monitorID, notificationID) {
    const relation = R.dispense("monitor_notification");
    relation.monitor_id = monitorID;
    relation.notification_id = notificationID;
    await R.store(relation);
}

/**
 * Return all monitor IDs linked to one notification.
 * @param {number} notificationID Notification ID
 * @returns {Promise<number[]>} Linked monitor IDs
 */
async function relationMonitorIDs(notificationID) {
    const rows = await R.getAll(
        "SELECT monitor_id FROM monitor_notification WHERE notification_id = ? ORDER BY monitor_id",
        [notificationID]
    );
    return rows.map((row) => row.monitor_id);
}
