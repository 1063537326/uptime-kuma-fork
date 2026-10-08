const { describe, test } = require("node:test");
const assert = require("node:assert");
const Feishu = require("../../../server/notification-providers/feishu");
const Monitor = require("../../../server/model/monitor");
const { DOWN, UP, PENDING } = require("../../../src/util");

describe("Feishu real-time cards", () => {
    test("down card is red, readable, truncated, and excludes connection details", () => {
        const payload = Feishu.buildRealtimeCard(
            {
                name: "异常监控".repeat(30),
                url: "https://internal.example/secret",
                hostname: "10.0.0.8",
            },
            {
                status: DOWN,
                msg: "连接超时".repeat(100),
                ping: 123,
                timezone: "Asia/Shanghai",
                localDateTime: "2026-10-08 17:30:00",
            }
        );
        const serialized = JSON.stringify(payload);

        assert.strictEqual(payload.msg_type, "interactive");
        assert.strictEqual(payload.card.header.template, "red");
        assert.match(serialized, /服务异常/);
        assert.match(serialized, /响应耗时/);
        assert.match(serialized, /错误摘要/);
        assert.match(serialized, /…/);
        assert.doesNotMatch(serialized, /internal\.example|10\.0\.0\.8|secret/);
        assert.ok(serialized.length < 2500);
    });

    test("recovery card is green and includes reliable downtime", () => {
        const payload = Feishu.buildRealtimeCard(
            { name: "上海 API" },
            {
                status: UP,
                time: "2026-10-08 09:10:30",
                lastDownTime: "2026-10-08 09:00:00",
                timezone: "Asia/Shanghai",
                localDateTime: "2026-10-08 17:10:30",
            }
        );
        const serialized = JSON.stringify(payload);

        assert.strictEqual(payload.card.header.template, "green");
        assert.match(serialized, /服务恢复/);
        assert.match(serialized, /中断时长/);
        assert.match(serialized, /10 分钟 30 秒/);
        assert.doesNotMatch(serialized, /错误摘要/);
    });

    test("real-time notification transitions retain existing important-beat behavior", () => {
        assert.strictEqual(Monitor.isImportantForNotification(false, UP, DOWN), true);
        assert.strictEqual(Monitor.isImportantForNotification(false, DOWN, UP), true);
        assert.strictEqual(Monitor.isImportantForNotification(false, UP, PENDING), false);
        assert.strictEqual(Monitor.isImportantForNotification(false, DOWN, DOWN), false);
    });
});
