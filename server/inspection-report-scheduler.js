const { Settings } = require("./settings");
const Cron = require("croner");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("./modules/dayjs/plugin/timezone");
const { log } = require("../src/util");
const { getInspectionReportSettings, normalizeInspectionReportSettings, SETTINGS_TYPE, SETTINGS_PREFIX } = require("./inspection-report-settings");

dayjs.extend(utc);
dayjs.extend(timezone);

/** User-scoped automatic inspection lifecycle, independent from real-time alerts. */
class InspectionReportScheduler {
    /**
     * @param {object} options System clock boundary for deterministic tests
     * @param {function(): Date} options.now Current server clock
     */
    constructor({ now = () => new Date() } = {}) {
        this.now = now;
        this.configs = new Map();
        this.attemptedSlots = new Map();
        this.started = false;
        this.inFlight = null;
        this.job = null;
    }

    /**
     * Read the current user's configuration.
     * @param {string} userID Authenticated user
     * @returns {Promise<object>} Inspection settings
     */
    async getSettings(userID) {
        return getInspectionReportSettings(userID);
    }

    /**
     * Persist a validated user-owned schedule.
     * @param {string} userID Authenticated user, never taken from a payload
     * @param {object} value Requested settings
     * @returns {Promise<object>} Canonical settings
     */
    async saveSettings(userID, value) {
        const config = normalizeInspectionReportSettings(value);
        await Settings.set(SETTINGS_PREFIX + userID, config, SETTINGS_TYPE);
        this.configs.set(String(userID), config);
        return config;
    }

    /**
     * Start only after database and monitor initialization.
     * @returns {Promise<void>} Lifecycle initialization
     */
    async start() {
        if (this.started) {
            return;
        }
        const stored = await Settings.getSettings(SETTINGS_TYPE);
        this.configs.clear();
        for (const [key, value] of Object.entries(stored)) {
            if (key.startsWith(SETTINGS_PREFIX)) {
                try {
                    this.configs.set(key.slice(SETTINGS_PREFIX.length), normalizeInspectionReportSettings(value));
                } catch (error) {
                    log.warn("inspection-report", "Skipped invalid stored inspection settings.");
                }
            }
        }
        this.started = true;
        // A single minute job evaluates owner-local slots. Croner starts at the
        // next minute, so startup never replays slots missed while offline.
        this.job = new Cron("* * * * *", {
            timezone: "UTC",
            catch: () => log.warn("inspection-report", "Inspection scheduler tick failed; no automatic retry."),
        }, () => this.runDue());
    }

    /**
     * Run the current minute only; repeated and concurrent ticks are ignored.
     * @returns {Promise<void>} Completion of this tick, including deliveries
     */
    async runDue() {
        if (!this.started || this.inFlight) {
            return;
        }
        const generatedAt = this.now();
        this.inFlight = this.deliverDue(generatedAt);
        try {
            await this.inFlight;
        } finally {
            this.inFlight = null;
        }
    }

    /**
     * Evaluate current local slots, remembering attempts before network I/O.
     * @param {Date} generatedAt Current server clock
     * @returns {Promise<void>} Settled deliveries
     */
    async deliverDue(generatedAt) {
        const { InspectionReportService } = require("./inspection-report-service");
        const pending = [];
        for (const [userID, config] of this.configs) {
            const local = dayjs(generatedAt).tz(config.timezone);
            const time = local.format("HH:mm");
            const index = config.times.indexOf(time);
            const key = `${userID}|${config.timezone}|${local.format("YYYY-MM-DD")}|${time}`;
            if (!config.enabled || index < 0 || this.attemptedSlots.has(key)) {
                continue;
            }
            this.attemptedSlots.set(key, generatedAt.valueOf());
            const period = config.times.length < 2 ? "scheduled" : index === 0 ? "morning" : index === config.times.length - 1 ? "evening" : "scheduled";
            pending.push(InspectionReportService.sendScheduled(userID, generatedAt, {
                timezone: config.timezone, morningTime: config.times[0], period,
            }).then((result) => {
                log.info("inspection-report", `Scheduled delivery: ${result.succeeded} succeeded, ${result.failed} failed.`);
            }).catch(() => {
                // Never log raw provider/configuration errors or retry here.
                log.warn("inspection-report", "Scheduled report skipped or failed; no automatic retry.");
            }));
        }
        for (const [key, time] of this.attemptedSlots) {
            if (generatedAt.valueOf() - time > 48 * 60 * 60 * 1000) {
                this.attemptedSlots.delete(key);
            }
        }
        await Promise.all(pending);
    }

    /**
     * Stop the scheduler before the database is closed.
     * @returns {Promise<void>} In-flight deliveries drained
     */
    async stop() {
        this.started = false;
        this.job?.stop();
        this.job = null;
        await this.inFlight;
    }
}

const inspectionReportScheduler = new InspectionReportScheduler();
module.exports = { InspectionReportScheduler, inspectionReportScheduler };
