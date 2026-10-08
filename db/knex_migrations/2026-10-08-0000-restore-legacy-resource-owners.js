const { restoreLegacyResourceOwners } = require("../../server/legacy-user-resources");

exports.up = async function (knex) {
    await restoreLegacyResourceOwners(knex);
};

// Ownership restoration must not be reversed into unowned resources.
exports.down = async function () {};
