const { after, before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const Talkin = require("../../../server/notification-providers/talkin");

describe("Talkin inspection delivery", () => {
    let server;
    let baseURL;
    const received = [];
    before(async () => {
        const app = express();
        app.use(express.urlencoded({ extended: false }));
        app.post("/:result", (req, res) => {
            received.push({ body: req.body, headers: req.headers });
            if (req.params.result === "timeout") {
                return;
            }
            if (req.params.result === "http-error") {
                return res.status(500).json({ secret: "private-response" });
            }
            const responses = {
                ok: { code: 200, data: { data: true } },
                rejected: { code: 1009, msg: "private-response" },
                false: { code: 200, data: { data: false } },
                malformed: { unexpected: "private-response" },
            };
            res.json(responses[req.params.result]);
        });
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", resolve);
        });
        baseURL = `http://127.0.0.1:${server.address().port}`;
    });
    after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });

    test("inspection reports use the accepted targeted form transport with unique IDs and complete plain text", async () => {
        for (const [period, title] of [["manual", "手动巡检"], ["morning", "早间巡检"], ["evening", "晚间巡检"]]) {
            await new Talkin().sendInspectionReport(notification(`${baseURL}/ok`), report(period));
            const { body, headers } = received.at(-1);
            assert.deepEqual(Object.keys(body).sort(), ["appId", "message", "msgId", "msgType", "userId"]);
            assert.equal(headers.authorization, "Bearer private-token");
            assert.match(headers["content-type"], /^application\/x-www-form-urlencoded/);
            assert.equal(body.userId, "test-user");
            assert.equal(body.appId, "test-app");
            assert.equal(body.msgType, "text");
            assert.match(body.msgId, /^kuma-\d{19}$/);
            assert.ok(body.message.startsWith(`🔴 Uptime Kuma · ${title}`));
            for (const text of ["发现 1 项离线", "监控概览", "监控项总数：2", "当前在线率：50%", "异常明细", "当日告警摘要", "今日故障：3", "今日恢复：2", "当前未恢复：1", "受影响监控项：1", "报告时间：2026-10-08 17:30:00", "时区：Asia/Shanghai", "不含结束时刻"]) {
                assert.ok(body.message.includes(text), text);
            }
            assert.doesNotMatch(body.message, /private-token|private-host|secret-body|配置名称|测试通知|连接正常/);
            assert.equal(body.message.includes("早报后新增"), period === "evening");
        }
        assert.equal(new Set(received.map((item) => item.body.msgId)).size, 3);
    });

    test("status icons distinguish healthy, offline, uncertain, paused, maintenance and empty scope", async () => {
        for (const [counts, icon, conclusion] of [
            [{ total: 2, online: 2, onlineRate: 100 }, "🟢", "全部监控项运行正常"],
            [{ total: 2, online: 1, offline: 1, onlineRate: 50 }, "🔴", "发现 1 项离线"],
            [{ total: 1, pending: 1, onlineRate: 0 }, "🟠", "需要确认"],
            [{ total: 1, unknown: 1, onlineRate: 0 }, "🟠", "需要确认"],
            [{ total: 1, stale: 1, onlineRate: 0 }, "🟠", "需要确认"],
            [{ total: 1, maintenance: 1 }, "🔵", "维护或暂停"],
            [{ total: 1, paused: 1 }, "🔵", "维护或暂停"],
            [{ total: 0 }, "🔵", "暂无非分组监控项"],
        ]) {
            const input = report();
            input.statusSummary = { total: 0, online: 0, offline: 0, pending: 0, maintenance: 0, paused: 0, unknown: 0, stale: 0, onlineRate: null, ...counts };
            await new Talkin().sendInspectionReport(notification(`${baseURL}/ok`), input);
            const message = received.at(-1).body.message;
            assert.ok(message.startsWith(icon));
            assert.ok(message.includes(conclusion));
            if (counts.onlineRate === undefined) {
                assert.match(message, /当前在线率：N\/A/);
            }
        }
    });

    test("long names and excess detail are bounded with visible omissions", async () => {
        const input = report("evening");
        const name = "中文🚦".repeat(100);
        input.abnormalMonitors = Array.from({ length: 11 }, (_, index) => ({ name: index === 10 ? "hidden-abnormal" : name, status: "offline", errorSummary: "检查超时".repeat(100) }));
        input.recentEvents = Array.from({ length: 6 }, (_, index) => ({ name: index === 5 ? "hidden-event" : name, timeLocal: "2026-10-08 16:00:00", type: "failure" }));
        input.truncation = { abnormalMonitors: 3, recentEvents: 2 };
        await new Talkin().sendInspectionReport(notification(`${baseURL}/ok`), input);
        const message = received.at(-1).body.message;
        assert.match(message, /另有 4 项异常/);
        assert.match(message, /另有 3 条事件/);
        assert.match(message, /…/);
        assert.doesNotMatch(message, /hidden-abnormal|hidden-event/);
        assert.ok(!message.includes(name));
        assert.ok(Array.from(message).length < 5000);
    });

    test("empty and broadcast targets fail before any request", async () => {
        const count = received.length;
        for (const userID of ["", "  ", "*", "all", "@all", "EVERYONE", "全员"]) {
            await assert.rejects(new Talkin().sendInspectionReport({ ...notification(`${baseURL}/ok`), talkinUserID: userID }, report()), /required|broadcast targets/);
        }
        assert.equal(received.length, count);
    });

    test("business, HTTP, malformed and real timeout failures are sanitized and not retried", async () => {
        for (const [path, errorText] of [["rejected", "1009"], ["false", "200"], ["http-error", "HTTP 500"], ["malformed", "malformed response"], ["timeout", "timed out"]]) {
            const count = received.length;
            await assert.rejects(new Talkin().sendInspectionReport(notification(`${baseURL}/${path}?secret=private-query`), report()), (error) => {
                assert.ok(error.message.includes(errorText));
                assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /private-token|private-response|private-query|Authorization/);
                return true;
            });
            assert.equal(received.length, count + 1);
        }
    });
});

/**
 * Isolated single-user configuration; never a real credential or destination.
 * @param {string} url Local receiver
 * @returns {object} Notification configuration
 */
function notification(url) {
    return { talkinApiURL: url, talkinToken: "Bearer private-token", talkinAppID: "test-app", talkinUserID: "test-user" };
}

/**
 * Public report fixture including forbidden connection data.
 * @param {string} period Report period
 * @returns {object} Report fixture
 */
function report(period = "manual") {
    return {
        period, timezone: "Asia/Shanghai", generatedAtLocal: "2026-10-08 17:30:00",
        statusSummary: { total: 2, online: 1, offline: 1, pending: 0, maintenance: 0, paused: 0, unknown: 0, stale: 0, onlineRate: 50 },
        today: { failures: 3, recoveries: 2, affectedMonitors: 1, currentlyDown: 1, sinceMorningFailures: 2, sinceMorningRecoveries: 1 },
        window: { startLocal: "2026-10-08 00:00:00", endLocal: "2026-10-08 17:30:00" },
        ...(period === "evening" ? { sinceMorningWindow: { startLocal: "2026-10-08 09:30:00", endLocal: "2026-10-08 17:30:00" } } : {}),
        abnormalMonitors: [{ name: "上海 API", status: "offline", errorSummary: "检查超时", url: "https://private-host", body: "secret-body" }],
        recentEvents: [{ name: "上海 API", timeLocal: "2026-10-08 16:00:00", type: "failure" }],
        truncation: { abnormalMonitors: 0, recentEvents: 0 },
    };
}
