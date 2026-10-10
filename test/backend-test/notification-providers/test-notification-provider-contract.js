const { after, before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { exerciseNotificationProviderContract } = require("./notification-provider-contract");
const Feishu = require("../../../server/notification-providers/feishu");
const Talkin = require("../../../server/notification-providers/talkin");
const Webhook = require("../../../server/notification-providers/webhook");

describe("notification provider public contract", () => {
    let server;
    let baseURL;
    const received = {
        feishu: [],
        talkin: [],
        webhook: [],
    };

    before(async () => {
        server = createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            const rawBody = Buffer.concat(chunks).toString();
            const contentType = req.headers["content-type"] || "";
            const body = contentType.includes("application/x-www-form-urlencoded")
                ? Object.fromEntries(new URLSearchParams(rawBody))
                : JSON.parse(rawBody);
            const [, provider, result = "ok"] = new URL(req.url, "http://localhost").pathname.split("/");
            received[provider].push({ body, headers: req.headers });
            res.setHeader("Content-Type", "application/json");
            if (provider === "feishu") {
                return res.end(JSON.stringify(result === "ok" ? { code: 0 } : { code: 19024, msg: "private-response" }));
            }
            if (provider === "talkin") {
                return res.end(JSON.stringify(result === "ok"
                    ? { code: 200, data: { data: true } }
                    : { code: 1009, msg: "private-response", data: null }));
            }
            // A generic Webhook intentionally has no provider-specific business contract.
            return res.end(JSON.stringify({ code: 19024, msg: "generic-response" }));
        });
        await new Promise(resolve => {
            server.listen(0, "127.0.0.1", resolve);
        });
        baseURL = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });

    test("Webhook, Feishu and Talkin preserve general, certificate, real-time and inspection modes", async () => {
        const cases = [
            {
                name: "Webhook",
                provider: new Webhook(),
                notification: { webhookURL: `${baseURL}/webhook` },
                deliveries: received.webhook,
                assertDelivery(mode, delivery, marker) {
                    if (mode === "inspection") {
                        assert.equal(delivery.body.reportId, REPORT.reportId);
                        assert.equal(delivery.headers["x-uptime-kuma-report-id"], REPORT.reportId);
                    } else {
                        assert.equal(delivery.body.msg, marker);
                    }
                },
            },
            {
                name: "Feishu",
                provider: new Feishu(),
                notification: { feishuWebHookUrl: `${baseURL}/feishu` },
                deliveries: received.feishu,
                assertDelivery(mode, delivery, marker) {
                    const text = JSON.stringify(delivery.body);
                    if (["general", "certificate"].includes(mode)) {
                        assert.match(text, new RegExp(marker));
                    } else if (mode === "down") {
                        assert.match(text, /服务异常/);
                    } else if (mode === "recovery") {
                        assert.match(text, /服务恢复/);
                    } else {
                        assert.match(text, /手动巡检/);
                    }
                },
            },
            {
                name: "Talkin",
                provider: new Talkin(),
                notification: {
                    name: "契约测试",
                    talkinApiURL: `${baseURL}/talkin`,
                    talkinToken: "private-token",
                    talkinAppID: "contract-app",
                    talkinUserID: "contract-user",
                },
                deliveries: received.talkin,
                assertDelivery(mode, delivery, marker) {
                    const text = delivery.body.message;
                    if (["general", "certificate"].includes(mode)) {
                        assert.match(text, new RegExp(marker));
                    } else if (mode === "down") {
                        assert.match(text, /监控异常/);
                    } else if (mode === "recovery") {
                        assert.match(text, /监控恢复/);
                    } else {
                        assert.match(text, /手动巡检/);
                    }
                },
            },
        ];

        for (const contract of cases) {
            await exerciseNotificationProviderContract({ ...contract, report: REPORT });
        }
    });

    test("providers with business acknowledgements reject HTTP 200 failures without leaking secrets", async () => {
        await assert.rejects(
            new Talkin().send({
                talkinApiURL: `${baseURL}/talkin/rejected?token=private-token`,
                talkinToken: "private-token",
                talkinAppID: "contract-app",
                talkinUserID: "contract-user",
            }, "contract"),
            error => assertSafeFailure(error, /Talkin rejected/)
        );
        await assert.rejects(
            new Feishu().send({ feishuWebHookUrl: `${baseURL}/feishu/rejected?token=private-token` }, "contract"),
            error => assertSafeFailure(error, /Feishu/)
        );
        await new Webhook().send({ webhookURL: `${baseURL}/webhook/rejected` }, "contract");
    });
});

const REPORT = {
    schemaVersion: 1,
    reportId: "notification-contract",
    period: "manual",
    timezone: "Asia/Shanghai",
    generatedAtLocal: "2026-10-09 17:30:00",
    window: { startLocal: "2026-10-09 00:00:00", endLocal: "2026-10-09 17:30:00" },
    statusSummary: { total: 1, online: 1, offline: 0, pending: 0, maintenance: 0, paused: 0, unknown: 0, stale: 0, onlineRate: 100 },
    today: { failures: 0, recoveries: 0, affectedMonitors: 0, currentlyDown: 0 },
    abnormalMonitors: [],
    recentEvents: [],
    truncation: { abnormalMonitors: 0, recentEvents: 0 },
};

/**
 * Check that provider failures remain useful without containing upstream data or credentials.
 * @param {Error} error Provider error
 * @param {RegExp} expected Stable public error fragment
 * @returns {boolean} Assertion predicate result
 */
function assertSafeFailure(error, expected) {
    assert.match(error.message, expected);
    assert.doesNotMatch(error.stack + JSON.stringify(error), /private-response|private-token/);
    return true;
}
