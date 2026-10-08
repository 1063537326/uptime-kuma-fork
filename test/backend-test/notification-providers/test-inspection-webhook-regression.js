const { after, before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const Talkin = require("../../../server/notification-providers/talkin");
const Webhook = require("../../../server/notification-providers/webhook");

describe("Talkin and custom Webhook inspection delivery", () => {
    let server;
    let url;
    const delivered = [];
    let captured;
    const report = {
        schemaVersion: 1,
        reportId: "report-test",
        generatedAtLocal: "2026-10-08 17:30:00",
        timezone: "Asia/Shanghai",
        statusSummary: { total: 2, online: 1, offline: 1, pending: 0, paused: 0, maintenance: 0, unknown: 0, stale: 0, onlineRate: 50 },
        monitors: [{ name: "Offline API", status: "offline" }],
    };

    before(async () => {
        const app = express();
        app.use(express.urlencoded({ extended: false }));
        app.use(express.json());
        app.use(express.raw({ type: "multipart/form-data" }));
        app.all("/capture", (req, res) => {
            captured = { method: req.method, body: req.body, query: req.query, headers: req.headers };
            // Generic Webhooks must not inherit Talkin's business-code contract.
            res.json({ code: 0 });
        });
        app.post("/miic/talkin/app/sendMessageAll", (req, res) => {
            if (req.headers.authorization !== "Bearer test-token") {
                return res.json({ code: 1001, msg: "private token details", data: null });
            }
            if (!req.body?.appId || !req.body?.userId || !req.body?.message) {
                return res.json({ code: 1009, msg: "private request details", data: null });
            }
            delivered.push(req.body);
            res.json({ code: 200, data: { data: true } });
        });
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", resolve);
        });
        url = `http://127.0.0.1:${server.address().port}/miic/talkin/app/sendMessageAll`;
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    test("Talkin delivers urlencoded text with either pasted Bearer or bare token", async () => {
        const provider = new Talkin();
        for (const token of ["test-token", "Bearer test-token"]) {
            const beforeCount = delivered.length;
            await provider.send({ talkinApiURL: url, talkinToken: token, talkinAppID: "app-test", talkinUserID: "user-test" }, "test");
            assert.equal(delivered.length, beforeCount + 1);
            assert.equal(delivered.at(-1).userId, "user-test");
        }
    });

    test("inspection uses the same working custom transport as a Webhook test", async () => {
        const provider = new Webhook();
        const config = {
            webhookURL: url,
            webhookContentType: "custom",
            webhookCustomBody: "msgType=text&msgId={{ report.reportId }}&appId=app-test&userId=user-test&message={{ msg | url_encode }}",
            webhookAdditionalHeaders: JSON.stringify({ Authorization: "Bearer test-token", "Content-Type": "application/x-www-form-urlencoded" }),
        };
        await provider.send(config, "test");
        const beforeCount = delivered.length;
        await provider.sendInspectionReport(config, report);
        assert.equal(delivered.length, beforeCount + 1, "must deliver a message, not merely get HTTP 200");
        assert.equal(delivered.at(-1).msgId, "report-test");
        assert.match(delivered.at(-1).message, /监控项总数：2/);
        assert.match(delivered.at(-1).message, /离线：1/);
        assert.match(delivered.at(-1).message, /Offline API/);
    });

    test("HTTP 200 with Talkin business rejection is a delivery failure", async () => {
        await assert.rejects(new Webhook().sendInspectionReport({
            webhookURL: url,
            webhookAdditionalHeaders: JSON.stringify({ Authorization: "Bearer test-token" }),
        }, report), /1009/);
    });

    test("JSON reports and real-time payloads keep their distinct contracts", async () => {
        const config = { webhookURL: new URL("/capture", url).href };
        const provider = new Webhook();
        await provider.sendInspectionReport(config, report);
        assert.deepEqual(captured.body, report);
        const heartbeat = { status: 0 };
        const monitor = { name: "API" };
        await provider.send(config, "down", monitor, heartbeat);
        assert.deepEqual(captured.body, { msg: "down", monitor, heartbeat });
    });

    test("GET reports respect the method, headers, and independent report context", async () => {
        await new Webhook().sendInspectionReport({
            webhookURL: new URL("/capture", url).href,
            httpMethod: "get",
            webhookAdditionalHeaders: JSON.stringify({ "X-Test": "retained" }),
        }, report);
        assert.equal(captured.method, "GET");
        assert.equal(captured.headers["x-test"], "retained");
        assert.deepEqual(JSON.parse(captured.query.report), report);
        assert.match(captured.query.msg, /监控项总数：2/);
        assert.equal(captured.query.heartbeat, undefined);
    });

    test("multipart report wraps the same DTO in the data field", async () => {
        await new Webhook().sendInspectionReport({
            webhookURL: new URL("/capture", url).href,
            webhookContentType: "form-data",
        }, report);
        assert.match(captured.headers["content-type"], /^multipart\/form-data/);
        assert.ok(captured.body.toString().includes(`name="data"\r\n\r\n${JSON.stringify(report)}`));
    });
});
