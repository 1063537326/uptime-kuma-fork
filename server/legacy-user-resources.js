const RESOURCE_TABLES = ["docker_host", "proxy", "monitor", "maintenance", "notification", "api_key", "remote_browser"];

/**
 * Restore owners lost by the Better Auth foreign-key migration, only when
 * the retained legacy account uniquely matches the sole current account.
 * The caller supplies a transaction; existing unrelated owners are preserved.
 * @param {object} trx Knex transaction
 * @returns {Promise<void>} Completion of the guarded repair
 */
async function restoreLegacyResourceOwners(trx) {
    const legacyUsers = await trx("user").select("id", "username").limit(2);
    const currentUsers = await trx("better_auth_user").select("id", "username").limit(2);
    // Fresh installs and upgrades awaiting their first login have no pair yet.
    if (legacyUsers.length === 0 || currentUsers.length === 0) {
        return;
    }
    // The configured Better Auth username() plugin lowercases on creation.
    if (legacyUsers.length !== 1 || currentUsers.length !== 1 ||
        !legacyUsers[0].username || !currentUsers[0].username ||
        legacyUsers[0].username.toLowerCase() !== currentUsers[0].username.toLowerCase()) {
        console.warn("Legacy resource ownership was not restored: account mapping is ambiguous; manual review is required.");
        return;
    }
    for (const table of RESOURCE_TABLES) {
        await trx(table)
            .whereNull("user_id")
            .orWhere("user_id", String(legacyUsers[0].id))
            .update({ user_id: currentUsers[0].id });
    }
}

module.exports = { restoreLegacyResourceOwners };
