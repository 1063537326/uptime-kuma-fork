const crypto = require("node:crypto");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("./modules/dayjs/plugin/timezone");
const { R } = require("redbean-node");
const { DOWN, UP, PENDING } = require("../src/util");
const { log } = require("../src/util");
const Monitor = require("./model/monitor");
const { Notification } = require("./notification");
const { TalkinResponseError } = require("./notification-providers/talkin");
const { getInspectionReportSettings } = require("./inspection-report-settings");

dayjs.extend(utc);
dayjs.extend(timezone);

const REPORT_TIMEZONE = "Asia/Shanghai";
const REPORT_SCHEMA_VERSION = 1;
const STALE_MINIMUM_MS = 5 * 60 * 1000;
const ABNORMAL_MONITOR_LIMIT = 10;
const RECENT_EVENT_LIMIT = 5;
const ABNORMAL_PRIORITY = { offline: 0, stale: 1, pending: 2, unknown: 3 };
const activeUsers = new Set();

/**
 * Application service for inspection reports. It reads server-side state,
 * builds a safe DTO, and delivers it independently from real-time alerts.
 */
class InspectionReportService {
    /**
     * Return the number of eligible inspection recipients for one user.
     * @param {number} userID Current user ID
     * @returns {Promise<number>} Recipient count
     */
    static async getEligibleRecipientCount(userID) {
        return (await getEligibleRecipients(userID)).length;
    }

    /**
     * Build and send a manual inspection report.
     * @param {number} userID Current user ID
     * @param {Date} generatedAt Server-controlled generation time
     * @returns {Promise<object>} Safe delivery summary
     */
    static async sendManual(userID, generatedAt = new Date()) {
        const settings = await getInspectionReportSettings(userID);
        return this.send(userID, "manual", generatedAt, { timezone: settings.timezone });
    }

    /**
     * Deliver a scheduled report through the same use case as manual reports.
     * @param {string} userID Resource owner
     * @param {Date} generatedAt Server clock
     * @param {object} options Validated schedule settings and period
     * @returns {Promise<object>} Safe delivery summary
     */
    static async sendScheduled(userID, generatedAt, options) {
        return this.send(userID, "scheduled", generatedAt, options);
    }

    /**
     * Shared delivery boundary with a per-user, cross-trigger mutex.
     * @param {string} userID Resource owner
     * @param {string} trigger Manual or scheduled
     * @param {Date} generatedAt Server clock
     * @param {object} options Report period and timezone
     * @returns {Promise<object>} Safe delivery summary
     */
    static async send(userID, trigger, generatedAt, options = {}) {
        if (activeUsers.has(userID)) {
            throw new Error("An inspection report is already being sent.");
        }

        activeUsers.add(userID);
        try {
            const recipients = await getEligibleRecipients(userID);
            if (recipients.length === 0) {
                return {
                    outcome: "no-recipients",
                    total: 0,
                    succeeded: 0,
                    failed: 0,
                    failures: [],
                };
            }

            const report = await buildCurrentStatusReport(userID, trigger, generatedAt, options);
            const settled = await Promise.allSettled(
                recipients.map(async (recipient) => {
                    const startedAt = Date.now();
                    try {
                        await Notification.sendInspectionReport(recipient.config, report);
                        log.info(
                            "inspection-report",
                            `Report ${report.reportId} delivered to notification ${recipient.id} in ${Date.now() - startedAt} ms`
                        );
                        return recipient;
                    } catch (error) {
                        log.warn(
                            "inspection-report",
                            `Report ${report.reportId} failed for notification ${recipient.id} after ${Date.now() - startedAt} ms ` +
                            `(trigger=${report.trigger}, channel=${recipient.config.type}, window=${report.window.start}/${report.window.end})`
                        );
                        const deliveryError = new Error("Inspection report delivery failed.", { cause: error });
                        deliveryError.recipient = recipient;
                        throw deliveryError;
                    }
                })
            );

            const failures = settled
                .filter((result) => result.status === "rejected")
                .map((result) => ({
                    notificationId: result.reason.recipient.id,
                    notificationName: result.reason.recipient.name,
                    channel: result.reason.recipient.config.type,
                    message: sanitizeDeliveryError(result.reason.cause),
                }));
            const succeeded = settled.length - failures.length;

            return {
                outcome: failures.length === 0 ? "success" : succeeded === 0 ? "failed" : "partial",
                reportId: report.reportId,
                total: settled.length,
                succeeded,
                failed: failures.length,
                failures,
            };
        } finally {
            activeUsers.delete(userID);
        }
    }
}

/**
 * Build a versioned, whitelist-only current status report.
 * @param {number} userID Current user ID
 * @param {"manual"|"scheduled"} trigger Trigger type
 * @param {Date} generatedAt Server-controlled generation time
 * @param {object} options Server-controlled report period and timezone options
 * @returns {Promise<object>} Inspection report DTO
 */
async function buildCurrentStatusReport(userID, trigger, generatedAt = new Date(), options = {}) {
    const end = dayjs(generatedAt).utc();
    if (!end.isValid()) {
        throw new Error("Invalid report generation time.");
    }
    const reportTimezone = options.timezone || REPORT_TIMEZONE;
    try {
        new Intl.DateTimeFormat("en", { timeZone: reportTimezone }).format();
    } catch (error) {
        throw new Error("Invalid report timezone.");
    }
    const morningTime = options.morningTime || "09:30";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(morningTime)) {
        throw new Error("Invalid morning report time.");
    }
    const period = trigger === "manual" ? "manual" : (options.period || "scheduled");
    if (!["manual", "morning", "evening", "scheduled"].includes(period)) {
        throw new Error("Invalid report period.");
    }
    const start = end.tz(reportTimezone).startOf("day").utc();
    const morning = dayjs.tz(`${end.tz(reportTimezone).format("YYYY-MM-DD")} ${morningTime}:00`, reportTimezone).utc();
    if (period === "evening" && morning.isAfter(end)) {
        throw new Error("Evening report cannot precede the morning boundary.");
    }
    const allMonitors = await R.getAll(
        "SELECT id, name, active, parent, type, `interval`, retry_interval AS retryInterval FROM monitor WHERE user_id = ?",
        [userID]
    );
    const nonGroupMonitors = allMonitors.filter((monitor) => monitor.type !== "group");
    const monitorIDs = nonGroupMonitors.map((monitor) => monitor.id);
    const latestHeartbeats = await getLatestHeartbeats(monitorIDs, generatedAt);
    const heartbeatsByMonitor = new Map(latestHeartbeats.map((heartbeat) => [heartbeat.monitor_id, heartbeat]));
    const monitorsByID = new Map(allMonitors.map((monitor) => [monitor.id, monitor]));
    const maintenanceByMonitor = new Map(
        await Promise.all(
            nonGroupMonitors.map(async (monitor) => [monitor.id, await Monitor.isUnderMaintenance(monitor.id)])
        )
    );

    const report = buildCurrentStatusReportFromData({
        monitors: nonGroupMonitors,
        monitorsByID,
        heartbeatsByMonitor,
        maintenanceByMonitor,
        trigger,
        generatedAt,
        timezone: reportTimezone,
    });

    report.reportType = "inspection";
    report.period = period;
    report.window = {
        start: start.toISOString(),
        end: end.toISOString(),
        startLocal: start.tz(reportTimezone).format("YYYY-MM-DD HH:mm:ss"),
        endLocal: end.tz(reportTimezone).format("YYYY-MM-DD HH:mm:ss"),
    };
    const events = await getDayEvents(monitorIDs, start, end);
    report.today = {
        failures: events.filter((event) => Number(event.status) === DOWN).length,
        recoveries: events.filter((event) => Number(event.status) === UP).length,
        affectedMonitors: new Set(events.filter((event) => Number(event.status) === DOWN).map((event) => event.monitor_id)).size,
        currentlyDown: report.statusSummary.offline,
    };
    if (report.period === "evening") {
        const sinceMorning = events.filter((event) => dayjs.utc(event.time).valueOf() >= morning.valueOf());
        report.sinceMorningWindow = {
            start: morning.toISOString(),
            end: end.toISOString(),
            startLocal: morning.tz(reportTimezone).format("YYYY-MM-DD HH:mm:ss"),
            endLocal: report.window.endLocal,
        };
        report.today.sinceMorningFailures = sinceMorning.filter((event) => Number(event.status) === DOWN).length;
        report.today.sinceMorningRecoveries = sinceMorning.filter((event) => Number(event.status) === UP).length;
    }
    const abnormalMonitors = report.monitors
        .filter((monitor) => Object.hasOwn(ABNORMAL_PRIORITY, monitor.status))
        .sort((left, right) => ABNORMAL_PRIORITY[left.status] - ABNORMAL_PRIORITY[right.status]
            || String(left.lastCheckedAt || "").localeCompare(String(right.lastCheckedAt || ""))
            || left.id - right.id);
    report.abnormalMonitors = abnormalMonitors.slice(0, ABNORMAL_MONITOR_LIMIT).map((monitor) => ({
        ...monitor,
        errorSummary: summarizeHeartbeatError(heartbeatsByMonitor.get(monitor.id)?.msg, monitor.status),
    }));
    report.recentEvents = events.slice(-RECENT_EVENT_LIMIT).reverse().map((event) => ({
        monitorId: event.monitor_id,
        name: String(monitorsByID.get(event.monitor_id).name || "未命名监控项"),
        type: Number(event.status) === DOWN ? "failure" : "recovery",
        time: normalizeHeartbeatTime(event.time),
        timeLocal: dayjs.utc(event.time).tz(reportTimezone).format("YYYY-MM-DD HH:mm:ss"),
        errorSummary: Number(event.status) === DOWN ? summarizeHeartbeatError(event.msg, "offline") : "已恢复在线",
    }));
    report.truncation = {
        abnormalMonitors: Math.max(0, abnormalMonitors.length - ABNORMAL_MONITOR_LIMIT),
        recentEvents: Math.max(0, events.length - RECENT_EVENT_LIMIT),
    };
    return report;
}

/**
 * Classify failures without forwarding arbitrary heartbeat messages, which can
 * contain URLs, headers, passwords, SQL, or upstream response bodies.
 * @param {?string} message Raw heartbeat message (internal only)
 * @param {string} status Report status
 * @returns {string} Bounded, single-line, non-sensitive error summary
 */
function summarizeHeartbeatError(message, status) {
    if (status === "unknown") {
        return "暂无可用心跳";
    }
    if (status === "stale") {
        return "最近一次在线或待确认心跳已过期";
    }
    const categories = [
        [/timeout|timed out|ETIMEDOUT|超时/i, "检查超时"],
        [/ECONNREFUSED|connection refused|连接被拒绝/i, "连接被拒绝"],
        [/ENOTFOUND|EAI_AGAIN|DNS.*fail|域名解析/i, "域名解析失败"],
        [/certificate|CERT_|证书/i, "证书校验失败"],
        [/ECONNRESET|connection reset/i, "连接被重置"],
    ];
    for (const [pattern, summary] of categories) {
        if (pattern.test(String(message || ""))) {
            return summary;
        }
    }
    return status === "pending" ? "等待重试确认" : "检查失败，详情请在控制台查看";
}

/**
 * Pure report builder used by the application service and contract tests.
 * @param {object} input Preloaded report data
 * @returns {object} Inspection report DTO
 */
function buildCurrentStatusReportFromData(input) {
    const generatedAt = dayjs(input.generatedAt);
    const reportTimezone = input.timezone || REPORT_TIMEZONE;
    const counts = {
        online: 0,
        offline: 0,
        pending: 0,
        maintenance: 0,
        paused: 0,
        unknown: 0,
        stale: 0,
    };

    const monitors = input.monitors.map((monitor) => {
        const heartbeat = input.heartbeatsByMonitor.get(monitor.id) || null;
        const status = classifyMonitorState({
            monitor,
            monitorsByID: input.monitorsByID,
            heartbeat,
            underMaintenance: input.maintenanceByMonitor.get(monitor.id) === true,
            generatedAt: generatedAt.toDate(),
        });
        counts[status] += 1;

        return {
            id: monitor.id,
            name: String(monitor.name || "未命名监控项"),
            status,
            lastCheckedAt: normalizeHeartbeatTime(heartbeat?.time),
        };
    });

    const rateDenominator = counts.online + counts.offline + counts.pending + counts.unknown + counts.stale;
    const onlineRate = rateDenominator === 0 ? null : Number(((counts.online / rateDenominator) * 100).toFixed(2));

    return {
        schemaVersion: REPORT_SCHEMA_VERSION,
        reportId: crypto.randomUUID(),
        reportType: "current-status",
        trigger: input.trigger,
        timezone: reportTimezone,
        generatedAt: generatedAt.toISOString(),
        generatedAtLocal: generatedAt.tz(reportTimezone).format("YYYY-MM-DD HH:mm:ss"),
        statusSummary: {
            total: monitors.length,
            ...counts,
            onlineRate,
        },
        monitors,
    };
}

/**
 * Classify one monitor using the report-only priority rules.
 * @param {object} input Classification inputs
 * @returns {"paused"|"maintenance"|"unknown"|"offline"|"stale"|"online"|"pending"} State
 */
function classifyMonitorState(input) {
    if (isEffectivelyPaused(input.monitor, input.monitorsByID)) {
        return "paused";
    }
    if (input.underMaintenance) {
        return "maintenance";
    }
    if (!input.heartbeat) {
        return "unknown";
    }

    const heartbeatStatus = Number(input.heartbeat.status);
    if (heartbeatStatus === DOWN) {
        return "offline";
    }

    if (
        [UP, PENDING].includes(heartbeatStatus) &&
        isHeartbeatStale(input.monitor, input.heartbeat, input.generatedAt)
    ) {
        return "stale";
    }
    if (heartbeatStatus === UP) {
        return "online";
    }
    if (heartbeatStatus === PENDING) {
        return "pending";
    }

    return "unknown";
}

/**
 * Determine whether a monitor or any ancestor is paused.
 * @param {object} monitor Monitor row
 * @param {Map<number, object>} monitorsByID Monitor lookup
 * @returns {boolean} Effective pause state
 */
function isEffectivelyPaused(monitor, monitorsByID) {
    const visited = new Set();
    let current = monitor;

    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        if (Number(current.active) !== 1) {
            return true;
        }
        current = current.parent == null ? null : monitorsByID.get(current.parent);
    }

    return false;
}

/**
 * Determine report-only staleness for UP or PENDING heartbeats.
 * @param {object} monitor Monitor row
 * @param {object} heartbeat Latest heartbeat
 * @param {Date} generatedAt Report generation time
 * @returns {boolean} Whether the heartbeat is stale
 */
function isHeartbeatStale(monitor, heartbeat, generatedAt) {
    const heartbeatTime = dayjs.utc(heartbeat.time);
    if (!heartbeatTime.isValid()) {
        return true;
    }

    const interval = Number(heartbeat.status) === PENDING && Number(monitor.retryInterval) > 0
        ? monitor.retryInterval : monitor.interval;
    const expectedIntervalMs = Math.max(Number(interval) || 0, 0) * 3 * 1000;
    const threshold = Math.max(STALE_MINIMUM_MS, expectedIntervalMs);
    return dayjs(generatedAt).diff(heartbeatTime, "millisecond") > threshold;
}

/**
 * Load the latest heartbeat for each requested monitor in one query.
 * @param {number[]} monitorIDs Monitor IDs
 * @param {Date} generatedAt Inclusive snapshot cutoff
 * @returns {Promise<object[]>} Latest heartbeat rows
 */
async function getLatestHeartbeats(monitorIDs, generatedAt) {
    if (monitorIDs.length === 0) {
        return [];
    }

    const placeholders = monitorIDs.map(() => "?").join(",");
    return R.getAll(
        `SELECT heartbeat.monitor_id, heartbeat.status, heartbeat.time, heartbeat.msg
         FROM heartbeat
         INNER JOIN (
             SELECT monitor_id, MAX(id) AS latest_id
             FROM heartbeat
             WHERE monitor_id IN (${placeholders}) AND time <= ?
             GROUP BY monitor_id
         ) latest ON latest.latest_id = heartbeat.id`,
        [...monitorIDs, dayjs(generatedAt).utc().format("YYYY-MM-DD HH:mm:ss.SSS")]
    );
}

/**
 * Load confirmed alert transitions for the whole report scope in one query.
 * The predecessor lookup uses raw heartbeats, including non-important beats
 * and records before midnight, rather than the previous alert event.
 * @param {number[]} monitorIDs Current user's non-group monitor IDs
 * @param {dayjs.Dayjs} start Inclusive UTC start
 * @param {dayjs.Dayjs} end Exclusive UTC end
 * @returns {Promise<object[]>} Important event rows
 */
async function getDayEvents(monitorIDs, start, end) {
    if (monitorIDs.length === 0) {
        return [];
    }
    const placeholders = monitorIDs.map(() => "?").join(",");
    const rows = await R.getAll(
        `SELECT current_beat.id, current_beat.monitor_id, current_beat.status, current_beat.time, current_beat.msg,
                previous_beat.status AS previous_status
         FROM heartbeat current_beat
         LEFT JOIN heartbeat previous_beat ON previous_beat.id = (
             SELECT MAX(raw_beat.id) FROM heartbeat raw_beat
             WHERE raw_beat.monitor_id = current_beat.monitor_id AND raw_beat.id < current_beat.id
         )
         WHERE current_beat.monitor_id IN (${placeholders}) AND current_beat.important = 1
           AND current_beat.status IN (?, ?) AND current_beat.time >= ? AND current_beat.time < ?
         ORDER BY current_beat.time, current_beat.id`,
        [...monitorIDs, DOWN, UP, start.format("YYYY-MM-DD HH:mm:ss"), end.format(end.millisecond() ? "YYYY-MM-DD HH:mm:ss.SSS" : "YYYY-MM-DD HH:mm:ss")]
    );
    return rows.filter((row) => Number(row.status) === DOWN || (row.previous_status != null && Number(row.previous_status) === DOWN));
}

/**
 * Load supported inspection recipients, scoped and deduplicated by notification.
 * @param {number} userID Current user ID
 * @returns {Promise<Array<{ id: number, name: string, config: object }>>} Recipients
 */
async function getEligibleRecipients(userID) {
    const rows = await R.getAll(
        `SELECT DISTINCT notification.id, notification.name, notification.config
         FROM notification
         INNER JOIN monitor_notification ON monitor_notification.notification_id = notification.id
         INNER JOIN monitor ON monitor.id = monitor_notification.monitor_id
         WHERE notification.user_id = ?
           AND monitor.user_id = ?
           AND monitor.type != 'group'`,
        [userID, userID]
    );

    const recipients = [];
    for (const row of rows) {
        try {
            const config = JSON.parse(row.config);
            if (["webhook", "Feishu", "Talkin"].includes(config.type) && config.enableInspectionReports === true) {
                recipients.push({
                    id: row.id,
                    name: row.name,
                    config,
                });
            }
        } catch (error) {
            log.warn("inspection-report", `Skipped invalid notification config ${row.id}`);
        }
    }

    return recipients;
}

/**
 * Return an ISO heartbeat time without exposing other heartbeat fields.
 * @param {?string} value Stored heartbeat time
 * @returns {?string} ISO time
 */
function normalizeHeartbeatTime(value) {
    if (!value) {
        return null;
    }
    const parsed = dayjs.utc(value);
    return parsed.isValid() ? parsed.toISOString() : null;
}

/**
 * Return a stable browser-safe error without URLs, headers, bodies, or tokens.
 * @param {Error} error Delivery error
 * @returns {string} Safe delivery error
 */
function sanitizeDeliveryError(error) {
    if (error instanceof TalkinResponseError) {
        return error.message;
    }
    return "发送失败，请检查通知配置和接收端日志。";
}

module.exports = {
    InspectionReportService,
    buildCurrentStatusReport,
    buildCurrentStatusReportFromData,
    classifyMonitorState,
    getEligibleRecipients,
    isEffectivelyPaused,
    isHeartbeatStale,
    sanitizeDeliveryError,
};
