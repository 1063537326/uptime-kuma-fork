const { after, before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const Feishu = require("../../../server/notification-providers/feishu");

describe("Feishu inspection delivery contract", () => {
    let server;
    let baseURL;
    const received = [];
    before(async () => {
        const app = express();
        app.use(express.json());
        app.post("/:result", (req, res) => {
            received.push(req.body);
            if (req.params.result === "http-error") {
                return res.status(500).json({ secret: "private-response" });
            }
            const responses = {
                ok: { code: 0, msg: "success" },
                legacy: { StatusCode: 0, StatusMessage: "success" },
                rejected: { code: 19024, msg: "private-response" },
                conflicting: { code: 19024, StatusCode: 0, msg: "private-response" },
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
        await new Promise((resolve) => server.close(resolve));
    });

    test("manual, morning and evening cards expose summary, bounded details and explicit time windows", async () => {
        for (const [period, title] of [["manual", "手动巡检"], ["morning", "早报"], ["evening", "晚报"]]) {
            const report = inspectionReport(period);
            await new Feishu().sendInspectionReport({ feishuWebHookUrl: `${baseURL}/ok` }, report);
            const payload = received.at(-1);
            const text = JSON.stringify(payload);
            assert.equal(payload.msg_type, "interactive");
            assert.match(payload.card.header.title.content, new RegExp(title));
            assert.equal(payload.card.header.template, "red");
            for (const expected of ["监控项总数", "当前在线率", "50%", "当日告警摘要", "受影响监控项", "当前未恢复", "统计窗口", "生成时间", "Asia/Shanghai", "不含结束时刻", "另有 3 项", "另有 2 条", "…"]) {
                assert.ok(text.includes(expected), expected);
            }
            if (period === "evening") {
                assert.match(text, /早报后新增/);
                assert.match(text, /09:30:00/);
            } else {
                assert.doesNotMatch(text, /早报后新增/);
            }
            assert.doesNotMatch(text, /private-host|private-token|secret-body|"url"|"action"|"button"|lark_md/);
            assert.ok(Buffer.byteLength(text) < 20000);
        }
    });

    test("status colors distinguish offline, uncertain, healthy and non-evaluable reports", async () => {
        for (const [counts, color, conclusion] of [
            [{ total: 0, online: 0, onlineRate: null }, "blue", "暂无非分组监控项"],
            [{ total: 2, maintenance: 2, online: 0, onlineRate: null }, "blue", "维护或暂停"],
            [{ total: 2, paused: 2, online: 0, onlineRate: null }, "blue", "维护或暂停"],
            [{ total: 2, online: 2, onlineRate: 100 }, "green", "全部监控项运行正常"],
            [{ total: 2, online: 1, maintenance: 1, onlineRate: 100 }, "blue", "维护或暂停"],
            [{ total: 2, online: 1, unknown: 1, onlineRate: 50 }, "orange", "需要确认"],
            [{ total: 2, online: 1, stale: 1, onlineRate: 50 }, "orange", "需要确认"],
            [{ total: 2, online: 1, pending: 1, onlineRate: 50 }, "orange", "需要确认"],
            [{ total: 2, offline: 1, pending: 1, online: 0, onlineRate: 0 }, "red", "发现 1 项离线"],
        ]) {
            const report = inspectionReport();
            report.statusSummary = { total: 0, online: 0, offline: 0, pending: 0, maintenance: 0, paused: 0, unknown: 0, stale: 0, onlineRate: null, ...counts };
            report.abnormalMonitors = [];
            report.recentEvents = [];
            report.truncation = {};
            await new Feishu().sendInspectionReport({ feishuWebHookUrl: `${baseURL}/ok` }, report);
            assert.equal(received.at(-1).card.header.template, color);
            assert.ok(JSON.stringify(received.at(-1)).includes(conclusion));
            if (counts.onlineRate === null) {
                assert.match(JSON.stringify(received.at(-1)), /N\/A/);
            }
        }
    });

    test("HTTP and business failures are rejected without leaking response details or retrying", async () => {
        for (const result of ["rejected", "conflicting", "malformed", "http-error"]) {
            const count = received.length;
            await assert.rejects(new Feishu().sendInspectionReport({ feishuWebHookUrl: `${baseURL}/${result}?token=private-token` }, inspectionReport()),
                { message: "Feishu inspection report delivery failed." });
            assert.equal(received.length, count + 1);
        }
        await new Feishu().sendInspectionReport({ feishuWebHookUrl: `${baseURL}/legacy` }, inspectionReport());
    });
});

/**
 * Fixed public DTO with forbidden extra fields to check payload whitelisting.
 * @param {string} period Report period
 * @returns {object} Report fixture
 */
function inspectionReport(period = "manual") {
    return {
        period,
        timezone: "Asia/Shanghai",
        generatedAtLocal: "2026-10-08 17:30:00",
        window: { startLocal: "2026-10-08 00:00:00", endLocal: "2026-10-08 17:30:00" },
        ...(period === "evening" ? { sinceMorningWindow: { startLocal: "2026-10-08 09:30:00", endLocal: "2026-10-08 17:30:00" } } : {}),
        statusSummary: { total: 2, online: 1, offline: 1, pending: 0, maintenance: 0, paused: 0, unknown: 0, stale: 0, onlineRate: 50 },
        today: { failures: 3, recoveries: 2, affectedMonitors: 1, currentlyDown: 1, sinceMorningFailures: 2, sinceMorningRecoveries: 1 },
        abnormalMonitors: Array.from({ length: 10 }, (_, i) => ({ id: i, name: "中文名称🚦".repeat(50), status: "offline", errorSummary: "检查超时".repeat(60), url: "https://private-host", token: "private-token" })),
        recentEvents: Array.from({ length: 5 }, () => ({ name: "中文名称🚦".repeat(50), type: "failure", timeLocal: "2026-10-08 16:00:00", body: "secret-body" })),
        truncation: { abnormalMonitors: 3, recentEvents: 2 },
    };
}
