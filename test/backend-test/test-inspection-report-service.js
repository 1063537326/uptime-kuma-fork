process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { after, before, describe, test } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { R } = require("redbean-node");
const knex = require("knex");
const { Notification } = require("../../server/notification");
const { Settings } = require("../../server/settings");
const {
    InspectionReportService,
    buildCurrentStatusReportFromData,
    classifyMonitorState,
    getEligibleWebhookRecipients,
    sanitizeDeliveryError,
} = require("../../server/inspection-report-service");
const { TalkinResponseError } = require("../../server/notification-providers/talkin");
const { DOWN, UP, PENDING } = require("../../src/util");

describe("Inspection report service", () => {
    let db;
    let server;
    let baseURL;
    let userOne;
    let userTwo;
    let monitorOne;
    let monitorTwo;
    let capturedReport;

    before(async () => {
        db = knex({
            client: "better-sqlite3",
            connection: { filename: ":memory:" },
            useNullAsDefault: true,
        });
        R.setup(db);
        R.freeze(true);
        await R.exec("CREATE TABLE setting (id INTEGER PRIMARY KEY AUTOINCREMENT, `key` TEXT, value TEXT, type TEXT)");
        await R.exec(
            "CREATE TABLE monitor (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, type TEXT, url TEXT, active INTEGER, `interval` INTEGER, retry_interval INTEGER, parent INTEGER)"
        );
        await R.exec(
            "CREATE TABLE heartbeat (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER, status INTEGER, time TEXT, msg TEXT, important INTEGER DEFAULT 0)"
        );
        await R.exec(
            "CREATE TABLE notification (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, config TEXT)"
        );
        await R.exec(
            "CREATE TABLE monitor_notification (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER, notification_id INTEGER)"
        );
        await R.exec(
            "CREATE TABLE monitor_maintenance (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER, maintenance_id INTEGER)"
        );
        Notification.init();

        const app = express();
        app.use(express.json());
        app.post("/ok", (req, res) => {
            capturedReport = req.body;
            res.json({ ok: true });
        });
        app.post("/fail", (req, res) => res.status(500).json({ secret: "must-not-reach-browser" }));
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", resolve);
        });
        baseURL = `http://127.0.0.1:${server.address().port}`;

        userOne = { id: 1 };
        userTwo = { id: 2 };
        monitorOne = await createMonitor(userOne.id, "Leaf One", "https://private-one.example");
        monitorTwo = await createMonitor(userOne.id, "Leaf Two", "https://private-two.example");
        const otherMonitor = await createMonitor(userTwo.id, "Other User", "https://other-user.example");

        await createHeartbeat(monitorOne.id, UP, new Date().toISOString());
        await createHeartbeat(monitorTwo.id, DOWN, new Date(Date.now() - 86400000).toISOString());

        const okNotification = await createWebhook(userOne.id, "OK", `${baseURL}/ok`, true);
        const failNotification = await createWebhook(userOne.id, "Fail", `${baseURL}/fail`, true);
        const disabledNotification = await createWebhook(userOne.id, "Disabled", `${baseURL}/ok`, false);
        const otherNotification = await createWebhook(userTwo.id, "Other", `${baseURL}/ok`, true);

        await createRelation(monitorOne.id, okNotification.id);
        await createRelation(monitorTwo.id, okNotification.id);
        await createRelation(monitorOne.id, failNotification.id);
        await createRelation(monitorOne.id, disabledNotification.id);
        await createRelation(otherMonitor.id, otherNotification.id);
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await new Promise((resolve) => server.close(resolve));
        await db.destroy();
    });

    test("classifyMonitorState() honors pause, maintenance, unknown, down, stale, up, and pending priority", () => {
        const now = new Date("2026-10-08T10:00:00.000Z");
        const group = { id: 1, active: 0, parent: null };
        const child = { id: 2, active: 1, parent: 1, interval: 60 };
        const monitorsByID = new Map([
            [group.id, group],
            [child.id, child],
        ]);
        const base = { monitor: child, monitorsByID, generatedAt: now };

        assert.strictEqual(
            classifyMonitorState({ ...base, heartbeat: { status: DOWN }, underMaintenance: true }),
            "paused"
        );
        group.active = 1;
        assert.strictEqual(
            classifyMonitorState({ ...base, heartbeat: { status: DOWN }, underMaintenance: true }),
            "maintenance"
        );
        assert.strictEqual(classifyMonitorState({ ...base, heartbeat: null, underMaintenance: false }), "unknown");
        assert.strictEqual(
            classifyMonitorState({
                ...base,
                heartbeat: { status: DOWN, time: "2026-10-01T00:00:00.000Z" },
                underMaintenance: false,
            }),
            "offline"
        );
        assert.strictEqual(
            classifyMonitorState({
                ...base,
                heartbeat: { status: UP, time: "2026-10-08T09:00:00.000Z" },
                underMaintenance: false,
            }),
            "stale"
        );
        assert.strictEqual(
            classifyMonitorState({
                ...base,
                heartbeat: { status: UP, time: "2026-10-08T09:59:00.000Z" },
                underMaintenance: false,
            }),
            "online"
        );
        assert.strictEqual(
            classifyMonitorState({
                ...base,
                heartbeat: { status: PENDING, time: "2026-10-08T09:59:00.000Z" },
                underMaintenance: false,
            }),
            "pending"
        );
    });

    test("pure report builder counts only supplied non-group monitors and calculates online rate", () => {
        const monitors = [
            { id: 1, name: "Up", active: 1, parent: null, interval: 60 },
            { id: 2, name: "Down", active: 1, parent: null, interval: 60 },
            { id: 3, name: "Paused", active: 0, parent: null, interval: 60 },
        ];
        const report = buildCurrentStatusReportFromData({
            monitors,
            monitorsByID: new Map(monitors.map((monitor) => [monitor.id, monitor])),
            heartbeatsByMonitor: new Map([
                [1, { status: UP, time: "2026-10-08T09:59:00.000Z" }],
                [2, { status: DOWN, time: "2026-10-01T00:00:00.000Z" }],
            ]),
            maintenanceByMonitor: new Map(),
            trigger: "manual",
            generatedAt: new Date("2026-10-08T10:00:00.000Z"),
        });

        assert.strictEqual(report.schemaVersion, 1);
        assert.strictEqual(report.statusSummary.total, 3);
        assert.strictEqual(report.statusSummary.online, 1);
        assert.strictEqual(report.statusSummary.offline, 1);
        assert.strictEqual(report.statusSummary.paused, 1);
        assert.strictEqual(report.statusSummary.onlineRate, 50);
    });

    test("recipient query is user-scoped, enabled-only, and deduplicated", async () => {
        const recipients = await getEligibleWebhookRecipients(userOne.id);
        assert.deepStrictEqual(recipients.map((recipient) => recipient.name).sort(), ["Fail", "OK"]);
    });

    test("known business errors remain actionable without exposing arbitrary errors", () => {
        assert.strictEqual(sanitizeDeliveryError(new TalkinResponseError("Talkin rejected the message (1009).")), "Talkin rejected the message (1009).");
        assert.doesNotMatch(sanitizeDeliveryError(new Error("private request body")), /private/);
    });

    test("manual delivery continues after one recipient fails and exposes only a safe report and errors", async () => {
        const result = await InspectionReportService.sendManual(userOne.id);
        const serializedReport = JSON.stringify(capturedReport);

        assert.strictEqual(result.outcome, "partial");
        assert.strictEqual(result.total, 2);
        assert.strictEqual(result.succeeded, 1);
        assert.strictEqual(result.failed, 1);
        assert.strictEqual(result.failures[0].message, "发送失败，请检查通知配置和接收端日志。");
        assert.strictEqual(capturedReport.schemaVersion, 1);
        assert.strictEqual(capturedReport.statusSummary.total, 2);
        assert.doesNotMatch(serializedReport, /private-one|private-two|must-not-reach-browser|webhookURL|hostname/);
    });
});

/**
 * Create a minimal monitor row for service integration tests.
 * @param {number} userID User ID
 * @param {string} name Monitor name
 * @param {string} url Sensitive URL used to prove report whitelisting
 * @returns {Promise<object>} Monitor bean
 */
async function createMonitor(userID, name, url) {
    const monitor = R.dispense("monitor");
    monitor.user_id = userID;
    monitor.name = name;
    monitor.type = "http";
    monitor.url = url;
    monitor.active = 1;
    monitor.interval = 60;
    await R.store(monitor);
    return monitor;
}

/**
 * Create a latest heartbeat row.
 * @param {number} monitorID Monitor ID
 * @param {number} status Heartbeat status
 * @param {string} time Heartbeat timestamp
 * @returns {Promise<void>}
 */
async function createHeartbeat(monitorID, status, time) {
    const heartbeat = R.dispense("heartbeat");
    heartbeat.monitor_id = monitorID;
    heartbeat.status = status;
    heartbeat.time = time.replace("T", " ").replace("Z", "");
    heartbeat.msg = "private heartbeat detail";
    await R.store(heartbeat);
}

/**
 * Create a Webhook notification configuration.
 * @param {number} userID User ID
 * @param {string} name Notification name
 * @param {string} url Webhook URL
 * @param {boolean} enabled Inspection report opt-in
 * @returns {Promise<object>} Notification bean
 */
async function createWebhook(userID, name, url, enabled) {
    const notification = R.dispense("notification");
    notification.user_id = userID;
    notification.name = name;
    notification.config = JSON.stringify({
        type: "webhook",
        name,
        webhookURL: url,
        enableInspectionReports: enabled,
    });
    await R.store(notification);
    return notification;
}

/**
 * Bind one notification to one monitor.
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
