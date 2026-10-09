const { after, before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const Webhook = require("../../../server/notification-providers/webhook");

describe("Webhook independent inspection templates", () => {
    let server;
    let url;
    const received = [];
    const report = {
        schemaVersion: 1, reportId: "inspection-contract", reportType: "inspection", trigger: "manual", period: "manual",
        generatedAt: "2026-10-08T09:30:00.000Z", generatedAtLocal: "2026-10-08 17:30:00", timezone: "Asia/Shanghai",
        window: { start: "2026-10-07T16:00:00.000Z", end: "2026-10-08T09:30:00.000Z", startLocal: "2026-10-08 00:00:00", endLocal: "2026-10-08 17:30:00" },
        statusSummary: { total: 2, online: 1, offline: 1, pending: 0, paused: 0, maintenance: 0, unknown: 0, stale: 0, onlineRate: 50 },
        today: { failures: 3, recoveries: 2, affectedMonitors: 1, currentlyDown: 1 },
        abnormalMonitors: [{ name: "测试 API", status: "offline", errorSummary: "连接超时" }],
        recentEvents: [], truncation: { abnormalMonitors: 0, recentEvents: 0 },
    };
    before(async () => {
        server = createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            received.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
            res.statusCode = req.url === "/error" ? 500 : 200;
            res.end("private-response");
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        url = `http://127.0.0.1:${server.address().port}`;
    });
    after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });

    test("independent inspection body uses safe aliases while real-time custom body is unchanged", async () => {
        const provider = new Webhook();
        const config = {
            webhookURL: url, webhookContentType: "custom", webhookCustomBody: "alert={{ msg }}",
            webhookInspectionBody: "custom",
            webhookInspectionCustomBody: "## {{ report.reportId }}\n{{ summary.total }} / {{ today.failures }} / {{ abnormalMonitors[0].name }}\n{{ generatedAt }} / {{ timezone }}",
            webhookAdditionalHeaders: JSON.stringify({ "X-Report-Test": "retained", "Content-Type": "text/plain" }),
        };
        await provider.sendInspectionReport(config, report);
        assert.equal(received.at(-1).body, "## inspection-contract\n2 / 3 / 测试 API\n2026-10-08T09:30:00.000Z / Asia/Shanghai");
        assert.equal(received.at(-1).headers["x-report-test"], "retained");
        assert.equal(received.at(-1).headers["x-uptime-kuma-report-id"], "inspection-contract");
        await provider.send(config, "down");
        assert.equal(received.at(-1).body, "alert=down");
    });

    test("inspection HTTP failures never expose response data or credentials", async () => {
        await assert.rejects(new Webhook().sendInspectionReport({
            webhookURL: `${url}/error`, webhookInspectionBody: "custom", webhookInspectionCustomBody: "safe text",
            webhookAdditionalHeaders: JSON.stringify({ Authorization: "Bearer private-token" }),
        }, report), error => {
            assert.match(error.message, /HTTP 500/);
            assert.doesNotMatch(error.stack + JSON.stringify(error), /private-response|private-token/);
            return true;
        });
    });

    test("invalid templates stop delivery without fallback or source disclosure", async () => {
        const count = received.length;
        for (const template of ["", "private-token {% if summary.offline %}", "{{ notification.webhookURL }}", "{{ msg | nonexistent_filter }}", "{% include '/etc/passwd' %}", "{% render '/etc/passwd' %}", "{% layout '/etc/passwd' %}", "x".repeat(16385), "{% for i in (1..100000000) %}x{% endfor %}"]) {
            await assert.rejects(new Webhook().sendInspectionReport({
                webhookURL: url, webhookInspectionBody: "custom", webhookInspectionCustomBody: template,
            }, report), error => {
                assert.match(error.message, /Invalid inspection template/);
                assert.doesNotMatch(error.stack, /private-token|\/etc\/passwd|nonexistent_filter/);
                return true;
            });
        }
        assert.equal(received.length, count);
    });

    test("JSON override preserves the versioned DTO and GET ignores POST-only template settings", async () => {
        const provider = new Webhook();
        const config = {
            webhookURL: url,
            webhookContentType: "custom",
            webhookCustomBody: "old={{ msg }}",
            webhookInspectionBody: "json",
            webhookAdditionalHeaders: JSON.stringify({ "X-Uptime-Kuma-Report-Id": "must-not-override" }),
        };
        await provider.sendInspectionReport(config, report);
        assert.deepEqual(JSON.parse(received.at(-1).body), report);
        assert.match(received.at(-1).headers["content-type"], /application\/json/);
        assert.equal(received.at(-1).headers["x-uptime-kuma-report-id"], "inspection-contract");
        await provider.sendInspectionReport({ ...config, httpMethod: "get", webhookInspectionBody: "custom", webhookInspectionCustomBody: "{% invalid %}" }, report);
        const request = received.at(-1);
        assert.equal(request.method, "GET");
        assert.equal(request.body, "");
        const params = new URL(request.url, url).searchParams;
        assert.deepEqual(JSON.parse(params.get("report")), report);
        assert.match(params.get("msg"), /监控项总数：2/);
        await provider.send({ webhookURL: url, webhookInspectionBody: "custom", webhookInspectionCustomBody: "inspection" }, "down", { name: "leaf" }, { status: 0 });
        assert.deepEqual(JSON.parse(received.at(-1).body), { msg: "down", monitor: { name: "leaf" }, heartbeat: { status: 0 } });
    });
});
