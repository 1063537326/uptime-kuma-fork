process.env.UPTIME_KUMA_HIDE_LOG = "info_db,info_server";

const { after, before, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const express = require("express");
const { R } = require("redbean-node");
const { Settings } = require("../../server/settings");
const { Notification } = require("../../server/notification");
const { InspectionReportService } = require("../../server/inspection-report-service");
const { InspectionReportScheduler } = require("../../server/inspection-report-scheduler");

describe("Configurable inspection reports", () => {
    let db;
    let receiver;
    let endpoint;
    let scheduler;
    let now;
    let accept;
    let httpStatus;
    const reports = [];

    before(async () => {
        db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
        R.setup(db);
        R.freeze(true);
        await db.schema.createTable("setting", (table) => {
            table.increments("id");
            table.string("key").unique();
            table.text("value");
            table.string("type");
        });
        await db.schema.createTable("monitor", (table) => {
            table.increments("id");
            table.string("user_id");
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
        });
        await db.schema.createTable("monitor_maintenance", (table) => {
            table.integer("monitor_id");
            table.integer("maintenance_id");
        });
        await db.schema.createTable("notification", (table) => {
            table.increments("id");
            table.string("user_id");
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
        app.post("/report", async (req, res) => {
            reports.push(req.body);
            await accept?.();
            res.status(httpStatus).json({ ok: httpStatus === 200 });
        });
        await new Promise((resolve) => {
            receiver = app.listen(0, "127.0.0.1", resolve);
        });
        endpoint = `http://127.0.0.1:${receiver.address().port}/report`;
    });

    beforeEach(async () => {
        await scheduler?.stop();
        Settings.stopCacheCleaner();
        Settings.cacheList = {};
        for (const table of ["setting", "monitor_notification", "notification", "heartbeat", "monitor_maintenance", "monitor"]) {
            await db(table).delete();
        }
        reports.length = 0;
        accept = null;
        httpStatus = 200;
        now = new Date("2026-10-08T01:29:00Z");
        scheduler = new InspectionReportScheduler({ now: () => now });
        await db("monitor").insert({ id: 1, user_id: "owner", name: "Internal API", type: "http", active: 1, interval: 60 });
        await db("notification").insert({ id: 1, user_id: "owner", name: "Local receiver", config: JSON.stringify({ type: "webhook", enableInspectionReports: true, webhookURL: endpoint, webhookContentType: "json" }) });
        await db("monitor_notification").insert({ monitor_id: 1, notification_id: 1 });
    });

    after(async () => {
        await scheduler?.stop();
        Settings.stopCacheCleaner();
        await new Promise((resolve) => receiver.close(resolve));
        await db.destroy();
    });

    test("a user starts with automatic reports disabled and Shanghai morning and evening slots", async () => {
        assert.deepEqual(await scheduler.getSettings("owner"), {
            enabled: false,
            timezone: "Asia/Shanghai",
            times: ["09:30", "17:30"],
        });
    });

    test("saved settings are validated, deduplicated, sorted, and isolated from another user", async () => {
        const config = { enabled: true, timezone: "Asia/Shanghai", times: ["17:30", "09:30", "09:30"] };
        assert.deepEqual(await scheduler.saveSettings("owner", config), {
            enabled: true, timezone: "Asia/Shanghai", times: ["09:30", "17:30"],
        });
        const reloaded = new InspectionReportScheduler();
        assert.equal((await reloaded.getSettings("owner")).enabled, true);
        assert.equal((await reloaded.getSettings("other-owner")).enabled, false);
        for (const invalid of [
            { ...config, timezone: "Invalid/Timezone" },
            { ...config, timezone: "+08:00" },
            { ...config, times: ["24:00"] },
            { ...config, times: ["9:30"] },
            { ...config, times: [] },
            { ...config, times: "09:30" },
            { ...config, enabled: "true" },
        ]) {
            await assert.rejects(() => scheduler.saveSettings("owner", invalid), /Invalid inspection/);
        }
        assert.deepEqual((await scheduler.getSettings("owner")).times, ["09:30", "17:30"]);
    });

    test("an enabled schedule sends Shanghai morning and evening reports once through the real provider", async () => {
        await scheduler.saveSettings("owner", { enabled: true, timezone: "Asia/Shanghai", times: ["09:30", "17:30"] });
        await scheduler.start();
        await scheduler.runDue();
        assert.equal(reports.length, 0);
        now = new Date("2026-10-08T01:30:00Z");
        await scheduler.runDue();
        await scheduler.runDue();
        assert.equal(reports.length, 1);
        assert.equal(reports[0].trigger, "scheduled");
        assert.equal(reports[0].period, "morning");
        assert.equal(reports[0].statusSummary.total, 1);
        assert.equal(reports[0].window.start, "2026-10-07T16:00:00.000Z");
        now = new Date("2026-10-08T09:30:00Z");
        await scheduler.runDue();
        assert.equal(reports.length, 2);
        assert.equal(reports[1].period, "evening");
        assert.equal(reports[1].today.sinceMorningFailures, 0);
        assert.equal(reports[1].sinceMorningWindow.start, "2026-10-08T01:30:00.000Z");
    });

    test("saving enables, replaces, and disables a live schedule without restarting or replaying missed slots", async () => {
        await scheduler.start();
        now = new Date("2026-10-08T01:30:00Z");
        await scheduler.runDue();
        assert.equal(reports.length, 0);
        await scheduler.saveSettings("owner", { enabled: true, timezone: "Asia/Shanghai", times: ["09:30", "10:00"] });
        now = new Date("2026-10-08T01:31:00Z");
        await scheduler.runDue();
        assert.equal(reports.length, 0);
        await scheduler.saveSettings("owner", { enabled: true, timezone: "UTC", times: ["02:30"] });
        now = new Date("2026-10-08T02:00:00Z");
        await scheduler.runDue();
        assert.equal(reports.length, 0);
        now = new Date("2026-10-08T02:30:00Z");
        await scheduler.runDue();
        assert.equal(reports.length, 1);
        assert.equal(reports[0].timezone, "UTC");
        assert.equal(reports[0].period, "scheduled");
        await scheduler.saveSettings("owner", { enabled: false, timezone: "UTC", times: ["03:00"] });
        now = new Date("2026-10-08T03:00:00Z");
        await scheduler.runDue();
        assert.equal(reports.length, 1);
        await scheduler.stop();
        await scheduler.saveSettings("owner", { enabled: true, timezone: "UTC", times: ["03:00"] });
        await scheduler.runDue();
        assert.equal(reports.length, 1);
    });

    test("manual reports share the saved timezone even while automatic delivery is disabled", async () => {
        await scheduler.saveSettings("owner", { enabled: false, timezone: "America/New_York", times: ["10:00", "18:00"] });
        const result = await InspectionReportService.sendManual("owner", new Date("2026-10-08T18:00:00Z"));
        assert.equal(result.succeeded, 1);
        assert.equal(reports[0].trigger, "manual");
        assert.equal(reports[0].timezone, "America/New_York");
        assert.equal(reports[0].window.start, "2026-10-08T04:00:00.000Z");
    });

    test("concurrent ticks and manual requests cannot overlap; stopping drains the delivery", async () => {
        await scheduler.saveSettings("owner", { enabled: true, timezone: "Asia/Shanghai", times: ["09:30"] });
        await scheduler.start();
        let release;
        let arrived;
        const arrival = new Promise((resolve) => {
            arrived = resolve;
        });
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        accept = () => {
            arrived();
            return gate;
        };
        now = new Date("2026-10-08T01:30:00Z");
        const sending = scheduler.runDue();
        await arrival;
        try {
            await scheduler.runDue();
            await assert.rejects(() => InspectionReportService.sendManual("owner", now), /already being sent/);
            assert.equal(reports.length, 1);
        } finally {
            release();
            await scheduler.stop();
            await sending;
        }
        await scheduler.runDue();
        assert.equal(reports.length, 1);
    });

    test("a failed scheduled request is not retried on a duplicate tick or settings reload", async () => {
        httpStatus = 500;
        const config = { enabled: true, timezone: "Asia/Shanghai", times: ["09:30"] };
        await scheduler.saveSettings("owner", config);
        await scheduler.start();
        now = new Date("2026-10-08T01:30:00Z");
        await scheduler.runDue();
        await scheduler.saveSettings("owner", config);
        await scheduler.runDue();
        assert.equal(reports.length, 1);
    });

    test("daylight-saving repeated local times do not duplicate a user's daily slot", async () => {
        now = new Date("2026-11-01T05:29:00Z");
        await scheduler.saveSettings("owner", { enabled: true, timezone: "America/New_York", times: ["01:30"] });
        await scheduler.start();
        now = new Date("2026-11-01T05:30:00Z");
        await scheduler.runDue();
        now = new Date("2026-11-01T06:30:00Z");
        await scheduler.runDue();
        assert.equal(reports.length, 1);
    });

    test("simultaneous schedules keep each owner's monitor data in their own report", async () => {
        await db("monitor").insert({ id: 2, user_id: "second-owner", name: "Other owner's API", type: "http", active: 1, interval: 60 });
        await db("notification").insert({ id: 2, user_id: "second-owner", name: "Second receiver", config: JSON.stringify({ type: "webhook", enableInspectionReports: true, webhookURL: endpoint, webhookContentType: "json" }) });
        await db("monitor_notification").insert({ monitor_id: 2, notification_id: 2 });
        for (const owner of ["owner", "second-owner"]) {
            await scheduler.saveSettings(owner, { enabled: true, timezone: "Asia/Shanghai", times: ["09:30"] });
        }
        await scheduler.start();
        now = new Date("2026-10-08T01:30:00Z");
        await scheduler.runDue();
        assert.equal(reports.length, 2);
        assert.deepEqual(reports.map((report) => report.monitors.map((monitor) => monitor.id)).sort(), [[1], [2]]);
    });
});
