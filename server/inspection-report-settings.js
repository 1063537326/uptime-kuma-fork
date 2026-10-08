const { Settings } = require("./settings");

const SETTINGS_TYPE = "inspection-report";
const SETTINGS_PREFIX = "inspectionReport:";

/**
 * Read user-scoped inspection settings without enabling automatic delivery.
 * @param {string} userID Authenticated resource owner
 * @returns {Promise<object>} Inspection configuration
 */
async function getInspectionReportSettings(userID) {
    return normalizeInspectionReportSettings(await Settings.get(SETTINGS_PREFIX + userID) || {
        enabled: false,
        timezone: "Asia/Shanghai",
        times: ["09:30", "17:30"],
    });
}

/**
 * Validate and whitelist settings before persistence or scheduling.
 * @param {object} value Untrusted settings payload
 * @returns {object} Normalized configuration
 * @throws {Error} When the enabled flag, timezone or times are invalid
 */
function normalizeInspectionReportSettings(value) {
    if (!value || typeof value.enabled !== "boolean") {
        throw new Error("Invalid inspection enabled flag.");
    }
    const timezone = typeof value.timezone === "string" ? value.timezone.trim() : "";
    try {
        if (!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)) {
            throw new Error();
        }
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    } catch (error) {
        throw new Error("Invalid inspection timezone.");
    }
    if (!Array.isArray(value.times) || value.times.some((time) => typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
        throw new Error("Invalid inspection schedule times.");
    }
    const times = [...new Set(value.times)].sort();
    if (value.enabled && times.length === 0) {
        throw new Error("Invalid inspection schedule: at least one time is required.");
    }
    return { enabled: value.enabled, timezone, times };
}

module.exports = { getInspectionReportSettings, normalizeInspectionReportSettings, SETTINGS_TYPE, SETTINGS_PREFIX };
