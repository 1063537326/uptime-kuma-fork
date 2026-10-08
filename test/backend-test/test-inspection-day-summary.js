process.env.UPTIME_KUMA_HIDE_LOG = "info_db,info_server";

const { after, before, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const express = require("express");
const { R } = require("redbean-node");
const { buildCurrentStatusReport, InspectionReportService } = require("../../server/inspection-report-service");
const { Notification } = require("../../server/notification");
const { Settings } = require("../../server/settings");
const { DOWN, UP, PENDING, MAINTENANCE } = require("../../src/util");

describe("Inspection day summary through the application service", () => {
    let db;
    let server;
    let baseURL;
    const received = [];

    before(async () => {
        db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
        R.setup(db);
        R.freeze(true);
        await db.schema.createTable("setting", (table) => {
            table.increments("id");
            table.string("key");
            table.text("value");
            table.string("type");
        });
        await db.schema.createTable("monitor", (table) => {
            table.increments("id");
            table.integer("user_id");
            table.string("name");
            table.string("type");
            table.integer("active");
            table.integer("interval");
            table.integer("parent");
        });
        await db.schema.createTable("heartbeat", (table) => {
            table.increments("id");
            table.integer("monitor_id");
            table.integer("status");
            table.boolean("important");
            table.string("time");
            table.text("msg");
            table.index(["monitor_id", "time"]);
        });
        await db.schema.createTable("monitor_maintenance", (table) => {
            table.integer("monitor_id");
            table.integer("maintenance_id");
        });
        await db.schema.createTable("notification", (table) => {
            table.increments("id");
            table.integer("user_id");
            table.string("name");
            table.text("config");
        });
        await db.schema.createTable("monitor_notification", (table) => {
            table.integer("monitor_id");
            table.integer("notification_id");
        });
        Notification.init();
        const app = express();
        app.use(express.json());
        app.use(express.urlencoded({ extended: false }));
        app.post("/:format", (req, res) => {
            received.push({ format: req.params.format, body: req.body });
            res.json({ ok: true });
        });
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", resolve);
        });
        baseURL = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(async () => {
        received.length = 0;
        await db("monitor_notification").delete();
        await db("notification").delete();
        await db("heartbeat").delete();
        await db("monitor_maintenance").delete();
        await db("monitor").delete();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await new Promise((resolve) => server.close(resolve));
        await db.destroy();
    });

    test("morning report counts only confirmed failures in the Shanghai half-open day window", async () => {
        await monitor(1);
        await beat(1, "2026-10-07 15:59:59.999", DOWN);
        await beat(1, "2026-10-07 16:00:00.000", DOWN);
        await beat(1, "2026-10-07 17:00:00.000", DOWN, false);
        await beat(1, "2026-10-08 01:29:59.999", DOWN);
        await beat(1, "2026-10-08 01:30:00.000", DOWN);

        const report = await buildCurrentStatusReport(1, "scheduled", new Date("2026-10-08T01:30:00.000Z"), { period: "morning" });
        assert.equal(report.timezone, "Asia/Shanghai");
        assert.equal(report.period, "morning");
        assert.equal(report.window.start, "2026-10-07T16:00:00.000Z");
        assert.equal(report.window.end, "2026-10-08T01:30:00.000Z");
        assert.equal(report.today.failures, 2);
        assert.equal(report.today.affectedMonitors, 1);
        assert.equal(report.today.currentlyDown, 1);
    });

    test("summary uses raw previous status, deduplicates flapping monitors, and excludes groups and other users", async () => {
        for (let id = 1; id <= 5; id++) {
            await monitor(id);
        }
        await monitor(6, { type: "group" });
        await monitor(7, { user_id: 2 });
        await beat(1, "2026-10-07 15:59:00.000", DOWN);
        await beat(1, "2026-10-07 16:00:00.000", UP);
        await beat(1, "2026-10-07 17:00:00.000", DOWN);
        await beat(1, "2026-10-07 17:01:00.000", DOWN, false);
        await beat(1, "2026-10-07 18:00:00.000", UP);
        await beat(1, "2026-10-07 19:00:00.000", DOWN);
        await beat(1, "2026-10-07 20:00:00.000", UP);
        await beat(2, "2026-10-07 15:59:00.000", DOWN);
        await beat(2, "2026-10-07 17:00:00.000", MAINTENANCE);
        await beat(2, "2026-10-07 18:00:00.000", UP);
        await beat(3, "2026-10-07 17:00:00.000", PENDING, false);
        await beat(3, "2026-10-07 18:00:00.000", UP, false);
        await beat(4, "2026-10-07 18:00:00.000", UP);
        await beat(5, "2026-10-06 12:00:00.000", DOWN);
        await beat(6, "2026-10-07 19:00:00.000", DOWN);
        await beat(7, "2026-10-07 19:00:00.000", DOWN);

        const report = await buildCurrentStatusReport(1, "manual", new Date("2026-10-08T01:30:00Z"));
        assert.deepEqual(report.today, { failures: 2, recoveries: 3, affectedMonitors: 1, currentlyDown: 1 });
        assert.equal(report.statusSummary.total, 5);
    });

    test("evening report adds the since-morning window and ignores future heartbeat data", async () => {
        await monitor(1);
        await beat(1, "2026-10-08 01:29:59.999", DOWN);
        await beat(1, "2026-10-08 01:30:00.000", UP);
        await beat(1, "2026-10-08 02:00:00.000", DOWN);
        await beat(1, "2026-10-08 08:00:00.000", UP);
        await beat(1, "2026-10-08 09:29:59.999", DOWN);
        await beat(1, "2026-10-08 09:30:00.000", UP);
        await beat(1, "2026-10-08 09:30:01.000", DOWN);
        const report = await buildCurrentStatusReport(1, "scheduled", new Date("2026-10-08T09:30:00Z"), { period: "evening" });
        assert.equal(report.today.failures, 3);
        assert.equal(report.today.recoveries, 2);
        assert.equal(report.today.currentlyDown, 0);
        assert.equal(report.today.sinceMorningFailures, 2);
        assert.equal(report.today.sinceMorningRecoveries, 2);
        assert.equal(report.sinceMorningWindow.start, "2026-10-08T01:30:00.000Z");
        assert.equal(report.sinceMorningWindow.end, "2026-10-08T09:30:00.000Z");
    });

    test("a recovery from yesterday does not inflate today's affected monitor count", async () => {
        await monitor(1);
        await beat(1, "2026-10-07 15:59:00.000", DOWN);
        await beat(1, "2026-10-07 16:00:00.000", UP);
        const report = await buildCurrentStatusReport(1, "manual", new Date("2026-10-07T16:00:00.001Z"));
        assert.deepEqual(report.today, { failures: 0, recoveries: 1, affectedMonitors: 0, currentlyDown: 0 });
    });

    test("report timezone controls midnight and the configured morning boundary across DST", async () => {
        await monitor(1);
        await beat(1, "2026-11-01 03:59:59.999", DOWN);
        await beat(1, "2026-11-01 04:00:00.000", DOWN);
        await beat(1, "2026-11-01 15:00:00.000", DOWN);
        const report = await buildCurrentStatusReport(1, "scheduled", new Date("2026-11-01T22:30:00Z"), {
            period: "evening", timezone: "America/New_York", morningTime: "10:00",
        });
        assert.equal(report.timezone, "America/New_York");
        assert.equal(report.window.start, "2026-11-01T04:00:00.000Z");
        assert.equal(report.window.endLocal, "2026-11-01 17:30:00");
        assert.equal(report.sinceMorningWindow.start, "2026-11-01T15:00:00.000Z");
        assert.equal(report.today.failures, 2);
        assert.equal(report.today.sinceMorningFailures, 1);
        await assert.rejects(buildCurrentStatusReport(1, "manual", new Date(), { timezone: "not-a-zone" }), /timezone/i);
        await assert.rejects(buildCurrentStatusReport(1, "scheduled", new Date(), { morningTime: "25:00" }), /morning/i);
        await assert.rejects(buildCurrentStatusReport(1, "manual", new Date("invalid")), /generation time/i);
    });

    test("report caps and orders abnormal monitors and recent events without leaking raw error details", async () => {
        await monitor(1);
        await monitor(2);
        await monitor(3);
        await beat(2, "2026-10-08 09:59:00.000", PENDING, false);
        await beat(3, "2026-10-08 08:00:00.000", UP, false);
        for (let id = 4; id <= 11; id++) {
            await monitor(id);
            await beat(id, `2026-10-08 09:0${id - 4}:00.000`, DOWN, true,
                `ECONNREFUSED https://private.example/path?token=secret-value 10.0.0.1 Authorization: Bearer secret-value\n${"很长的错误😀".repeat(100)}`);
        }
        await monitor(12, { active: 0 });
        await beat(12, "2026-10-08 09:58:00.000", DOWN, false);
        const report = await buildCurrentStatusReport(1, "manual", new Date("2026-10-08T10:00:00Z"));
        assert.equal(report.reportType, "inspection");
        assert.deepEqual(report.abnormalMonitors.map((item) => item.id), [4, 5, 6, 7, 8, 9, 10, 11, 3, 2]);
        assert.deepEqual(report.recentEvents.map((event) => event.monitorId), [11, 10, 9, 8, 7]);
        assert.deepEqual(report.truncation, { abnormalMonitors: 1, recentEvents: 3 });
        assert.equal(report.today.failures, 8);
        assert.equal(report.today.currentlyDown, 8);
        for (const item of report.abnormalMonitors) {
            assert.ok(Array.from(item.errorSummary).length <= 120);
            assert.doesNotMatch(item.errorSummary, /[\r\n\x00-\x1F]/);
        }
        assert.equal(report.abnormalMonitors[0].errorSummary, "连接被拒绝");
        assert.doesNotMatch(JSON.stringify(report), /private\.example|secret-value|10\.0\.0\.1|Authorization|很长的错误/);
    });

    test("manual delivery sends the full daily report as JSON and readable custom text without database writes", async () => {
        await monitor(1);
        await beat(1, "2026-10-08 01:00:00.000", DOWN);
        await beat(1, "2026-10-08 09:59:59.000", UP);
        for (const [id, format] of [[1, "json"], [2, "text"]]) {
            const config = { type: "webhook", enableInspectionReports: true, webhookURL: `${baseURL}/${format}` };
            if (format === "text") {
                config.webhookContentType = "custom";
                config.webhookCustomBody = "message={{ msg | url_encode }}&failures={{ report.today.failures }}";
                config.webhookAdditionalHeaders = JSON.stringify({ "Content-Type": "application/x-www-form-urlencoded" });
            }
            await db("notification").insert({ id, user_id: 1, name: format, config: JSON.stringify(config) });
            await db("monitor_notification").insert({ monitor_id: 1, notification_id: id });
        }
        // Enforce read-only behavior at the database boundary, not by mocking internal services.
        await db.raw("PRAGMA query_only = ON");
        let result;
        try {
            result = await InspectionReportService.sendManual(1, new Date("2026-10-08T10:00:00Z"));
        } finally {
            await db.raw("PRAGMA query_only = OFF");
        }
        assert.equal(result.succeeded, 2);
        assert.equal(received.length, 2);
        const report = received.find((request) => request.format === "json").body;
        assert.deepEqual(report.today, { failures: 1, recoveries: 1, affectedMonitors: 1, currentlyDown: 0 });
        assert.equal(report.window.endLocal, "2026-10-08 18:00:00");
        assert.equal(report.schemaVersion, 1);
        const text = received.find((request) => request.format === "text").body;
        assert.equal(text.failures, "1");
        assert.match(text.message, /今日故障：1/);
        assert.match(text.message, /今日恢复：1/);
        assert.match(text.message, /受影响监控项：1/);
        assert.match(text.message, /当前未恢复：0/);
        assert.match(text.message, /2026-10-08 00:00:00/);
        assert.match(text.message, /最近事件/);
    });

    test("manual report at Shanghai midnight has an empty daily window but retains the current state", async () => {
        await monitor(1);
        await beat(1, "2026-10-07 15:59:59.999", DOWN);
        await beat(1, "2026-10-07 16:00:00", UP);
        const report = await buildCurrentStatusReport(1, "manual", new Date("2026-10-07T16:00:00Z"));
        assert.equal(report.window.start, report.window.end);
        assert.equal(report.period, "manual");
        assert.deepEqual(report.today, { failures: 0, recoveries: 0, affectedMonitors: 0, currentlyDown: 0 });
        assert.equal(report.statusSummary.online, 1);
        assert.deepEqual(report.recentEvents, []);
    });

    test("empty monitor scope yields a complete zero-count report without a fabricated online rate", async () => {
        const report = await buildCurrentStatusReport(1, "manual", new Date("2026-10-08T10:00:00Z"));
        assert.equal(report.statusSummary.total, 0);
        assert.equal(report.statusSummary.onlineRate, null);
        assert.deepEqual(report.today, { failures: 0, recoveries: 0, affectedMonitors: 0, currentlyDown: 0 });
        assert.deepEqual(report.abnormalMonitors, []);
        assert.deepEqual(report.recentEvents, []);
        assert.deepEqual(report.truncation, { abnormalMonitors: 0, recentEvents: 0 });
    });

    /**
     * Seed a monitor as an input fixture, never as an assertion side channel.
     * @param {number} id Monitor ID
     * @param {object} overrides Fixture overrides
     * @returns {Promise<void>}
     */
    async function monitor(id, overrides = {}) {
        await db("monitor").insert({ id, user_id: 1, name: `Monitor ${id}`, type: "http", active: 1, interval: 60, parent: null, ...overrides });
    }

    /**
     * Seed a raw UTC heartbeat in the production database timestamp format.
     * @param {number} monitorID Monitor ID
     * @param {string} time UTC SQL timestamp
     * @param {number} status Heartbeat status
     * @param {boolean} important Important heartbeat flag
     * @param {string} msg Raw heartbeat message
     * @returns {Promise<void>}
     */
    async function beat(monitorID, time, status = UP, important = true, msg = "") {
        await db("heartbeat").insert({ monitor_id: monitorID, time, status, important, msg });
    }
});
