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
    getEligibleRecipients,
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
    const capturedCards = [];
    const capturedTalkin = [];

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
        app.use(express.urlencoded({ extended: false }));
        app.post("/ok", (req, res) => {
            capturedReport = req.body;
            res.json({ ok: true });
        });
        app.post("/fail", (req, res) => res.status(500).json({ secret: "must-not-reach-browser" }));
        app.post("/feishu", (req, res) => {
            capturedCards.push(req.body);
            res.json({ code: 0, msg: "success" });
        });
        app.post("/talkin/:result", (req, res) => {
            capturedTalkin.push(req.body);
            res.json(req.params.result === "ok" ? { code: 200, data: { data: true } } : { code: 1009, msg: "private-response" });
        });
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
        const recipients = await getEligibleRecipients(userOne.id);
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

    test("an opted-in Feishu recipient receives one inspection card across multiple leaf bindings", async (t) => {
        const notification = R.dispense("notification");
        notification.user_id = userOne.id;
        notification.name = "Feishu reports";
        notification.config = JSON.stringify({ type: "Feishu", enableInspectionReports: true, feishuWebHookUrl: `${baseURL}/feishu` });
        await R.store(notification);
        t.after(async () => {
            await R.exec("DELETE FROM monitor_notification WHERE notification_id = ?", [notification.id]);
            await R.trash(notification);
        });
        await createRelation(monitorOne.id, notification.id);
        await createRelation(monitorTwo.id, notification.id);
        assert.strictEqual(await InspectionReportService.getEligibleRecipientCount(userOne.id), 3);
        const result = await InspectionReportService.sendManual(userOne.id);
        assert.strictEqual(result.succeeded, 2);
        assert.strictEqual(result.failed, 1);
        assert.strictEqual(capturedCards.length, 1);
        assert.strictEqual(capturedCards[0].msg_type, "interactive");
        assert.strictEqual(capturedCards[0].card.header.template, "red");
        assert.match(capturedCards[0].card.header.title.content, /手动巡检/);
        assert.doesNotMatch(JSON.stringify(capturedCards[0]), /private-one|private-two|heartbeat|feishuWebHookUrl/);

        for (const [period, title] of [["morning", "早报"], ["evening", "晚报"]]) {
            const scheduled = await InspectionReportService.sendScheduled(userOne.id, new Date("2026-10-08T09:30:00Z"), { period, timezone: "Asia/Shanghai" });
            assert.strictEqual(scheduled.succeeded, 2);
            assert.match(capturedCards.at(-1).card.header.title.content, new RegExp(title));
        }
        assert.strictEqual(capturedCards.length, 3);
        notification.config = JSON.stringify({ type: "Feishu", enableInspectionReports: true, feishuWebHookUrl: `${baseURL}/fail?secret=private-token` });
        await R.store(notification);
        const failed = await InspectionReportService.sendManual(userOne.id);
        assert.strictEqual(failed.outcome, "partial");
        assert.strictEqual(failed.succeeded, 1);
        assert.strictEqual(failed.failed, 2);
        assert.ok(failed.failures.some((failure) => failure.channel === "Feishu"));
        assert.doesNotMatch(JSON.stringify(failed), /private-token|must-not-reach-browser/);

        for (const enabled of [undefined, false, "true", 1]) {
            notification.config = JSON.stringify({ type: "Feishu", enableInspectionReports: enabled, feishuWebHookUrl: `${baseURL}/feishu` });
            await R.store(notification);
            assert.strictEqual(await InspectionReportService.getEligibleRecipientCount(userOne.id), 2);
        }
        notification.config = JSON.stringify({ type: "Feishu", enableInspectionReports: true, feishuWebHookUrl: `${baseURL}/feishu` });
        notification.user_id = userTwo.id;
        await R.store(notification);
        assert.strictEqual(await InspectionReportService.getEligibleRecipientCount(userOne.id), 2);
        assert.strictEqual(await InspectionReportService.getEligibleRecipientCount(userTwo.id), 1);
        notification.user_id = userOne.id;
        await R.store(notification);
        await R.exec("DELETE FROM monitor_notification WHERE notification_id = ?", [notification.id]);
        assert.strictEqual(await InspectionReportService.getEligibleRecipientCount(userOne.id), 2);
        const group = await createMonitor(userOne.id, "Report group", "");
        group.type = "group";
        await R.store(group);
        t.after(() => R.trash(group));
        await createRelation(group.id, notification.id);
        assert.strictEqual(await InspectionReportService.getEligibleRecipientCount(userOne.id), 2);
    });
    test("Talkin inspection delivery is opted-in, user-scoped, deduplicated and isolated from other channel failures", async (t) => {
        const config = { type: "Talkin", enableInspectionReports: true, talkinApiURL: `${baseURL}/talkin/ok`, talkinToken: "private-token", talkinAppID: "test-app", talkinUserID: "test-user" };
        const notification = R.dispense("notification");
        notification.user_id = userOne.id;
        notification.name = "Talkin reports";
        notification.config = JSON.stringify(config);
        await R.store(notification);
        t.after(async () => {
            await R.exec("DELETE FROM monitor_notification WHERE notification_id = ?", [notification.id]);
            await R.trash(notification);
        });
        await createRelation(monitorOne.id, notification.id);
        await createRelation(monitorTwo.id, notification.id);
        assert.strictEqual(await InspectionReportService.getEligibleRecipientCount(userOne.id), 3);
        const manual = await InspectionReportService.sendManual(userOne.id);
        assert.strictEqual(manual.succeeded, 2);
        assert.strictEqual(manual.failed, 1);
        assert.strictEqual(capturedTalkin.length, 1);
        assert.match(capturedTalkin[0].message, /手动巡检/);
        assert.strictEqual(capturedTalkin[0].userId, "test-user");
        assert.doesNotMatch(capturedTalkin[0].message, /private-one|private-two|private-token/);
        for (const [period, title] of [["morning", "早间巡检"], ["evening", "晚间巡检"]]) {
            const result = await InspectionReportService.sendScheduled(userOne.id, new Date("2026-10-08T09:30:00Z"), { period, timezone: "Asia/Shanghai" });
            assert.strictEqual(result.succeeded, 2);
            assert.match(capturedTalkin.at(-1).message, new RegExp(title));
        }
        assert.strictEqual(capturedTalkin.length, 3);
        assert.strictEqual(new Set(capturedTalkin.map((item) => item.msgId)).size, 3);
        notification.config = JSON.stringify({ ...config, talkinApiURL: `${baseURL}/talkin/rejected` });
        await R.store(notification);
        const failed = await InspectionReportService.sendManual(userOne.id);
        assert.strictEqual(failed.succeeded, 1);
        assert.strictEqual(failed.failed, 2);
        assert.ok(failed.failures.some((failure) => failure.channel === "Talkin" && failure.message.includes("1009")));
        assert.doesNotMatch(JSON.stringify(failed), /private-token|private-response/);
        for (const enabled of [undefined, false, "true", 1]) {
            notification.config = JSON.stringify({ ...config, enableInspectionReports: enabled });
            await R.store(notification);
            assert.strictEqual(await InspectionReportService.getEligibleRecipientCount(userOne.id), 2);
        }
        notification.config = JSON.stringify(config);
        notification.user_id = userTwo.id;
        await R.store(notification);
        assert.strictEqual(await InspectionReportService.getEligibleRecipientCount(userOne.id), 2);
        assert.strictEqual(await InspectionReportService.getEligibleRecipientCount(userTwo.id), 1);
        notification.user_id = userOne.id;
        await R.store(notification);
        await R.exec("DELETE FROM monitor_notification WHERE notification_id = ?", [notification.id]);
        assert.strictEqual(await InspectionReportService.getEligibleRecipientCount(userOne.id), 2);
        const group = await createMonitor(userOne.id, "Talkin report group", "");
        group.type = "group";
        await R.store(group);
        t.after(() => R.trash(group));
        await createRelation(group.id, notification.id);
        assert.strictEqual(await InspectionReportService.getEligibleRecipientCount(userOne.id), 2);
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
