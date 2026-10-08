const { after, before, describe, test } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const Talkin = require("../../../server/notification-providers/talkin");
const { DOWN, UP } = require("../../../src/util");

describe("Talkin notification provider", () => {
    let server;
    let baseURL;
    const requests = [];

    before(async () => {
        const app = express();
        app.use(express.raw({ type: () => true, limit: "1mb" }));
        app.post("/:result", (req, res) => {
            requests.push({
                result: req.params.result,
                authorization: req.headers.authorization,
                contentType: req.headers["content-type"],
                body: req.body.toString("utf8"),
            });

            if (req.params.result === "success") {
                return res.json({ code: 200, msg: "Success", data: { data: true } });
            }
            if (req.params.result === "business-error") {
                return res.json({ code: 1001, msg: "secret upstream detail", data: null });
            }
            if (req.params.result === "malformed") {
                return res.json({ unexpected: true });
            }
            return res.status(500).json({ token: "response-secret", request: "full-body" });
        });

        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", resolve);
        });
        baseURL = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    test("send() posts targeted urlencoded text requests with unique IDs", async () => {
        const provider = new Talkin();
        const notification = buildNotification(`${baseURL}/success`);
        const heartbeat = {
            status: DOWN,
            msg: "Connection timed out",
            ping: 800,
            localDateTime: "2026-10-08 17:30:00",
            timezone: "Asia/Shanghai",
        };

        await provider.send(notification, "down", { name: "Shanghai API" }, heartbeat);
        await provider.send(notification, "down", { name: "Shanghai API" }, heartbeat);

        const received = requests.filter((request) => request.result === "success").slice(-2);
        assert.strictEqual(received.length, 2);
        for (const request of received) {
            assert.strictEqual(request.authorization, "Bearer top-secret-token");
            assert.match(request.contentType, /^application\/x-www-form-urlencoded/);
            const body = new URLSearchParams(request.body);
            assert.strictEqual(body.get("msgType"), "text");
            assert.strictEqual(body.get("appId"), "app-test");
            assert.strictEqual(body.get("userId"), "one-user");
            assert.match(body.get("message"), /监控异常/);
        }
        assert.notStrictEqual(
            new URLSearchParams(received[0].body).get("msgId"),
            new URLSearchParams(received[1].body).get("msgId")
        );
    });

    test("message builder produces distinct plain-text down, recovery, and test layouts", () => {
        const notification = buildNotification(`${baseURL}/success`);
        assert.match(Talkin.buildTalkinMessage(notification, "test", null, null), /测试通知/);
        assert.match(
            Talkin.buildTalkinMessage(notification, "down", { name: "API" }, { status: DOWN, msg: "Timeout" }),
            /服务已离线/
        );
        const recovery = Talkin.buildTalkinMessage(
            notification,
            "up",
            { name: "API" },
            {
                status: UP,
                lastDownTime: "2026-10-08T09:00:00.000Z",
                time: "2026-10-08T09:10:00.000Z",
            }
        );
        assert.match(recovery, /服务已恢复正常/);
        assert.match(recovery, /中断时长：10 分钟/);
    });

    test("message IDs use the compact timestamp format accepted by the integration", () => {
        const ids = Array.from({ length: 1000 }, () => Talkin.createMessageID());
        assert.strictEqual(new Set(ids).size, ids.length);
        for (const id of ids) {
            assert.match(id, /^kuma-\d{19}$/);
        }
    });

    test("broadcast-style and empty User IDs are rejected before sending", async () => {
        const provider = new Talkin();
        await assert.rejects(
            provider.send({ ...buildNotification(`${baseURL}/success`), talkinUserID: "" }, "test"),
            /required/
        );
        await assert.rejects(
            provider.send({ ...buildNotification(`${baseURL}/success`), talkinUserID: "@all" }, "test"),
            /broadcast targets are not allowed/
        );
    });

    test("business, malformed, HTTP, and timeout failures are sanitized", async () => {
        const provider = new Talkin();
        await assert.rejects(
            provider.send(buildNotification(`${baseURL}/business-error`), "test"),
            (error) => /1001/.test(error.message) && !/secret upstream detail|top-secret-token/.test(error.message)
        );
        await assert.rejects(provider.send(buildNotification(`${baseURL}/malformed`), "test"), /malformed response/);
        await assert.rejects(
            provider.send(buildNotification(`${baseURL}/http-error`), "test"),
            (error) =>
                /HTTP 500/.test(error.message) && !/response-secret|full-body|top-secret-token/.test(error.message)
        );

        const timeout = new Error("request containing top-secret-token");
        timeout.code = "ECONNABORTED";
        assert.strictEqual(Talkin.toTalkinError(timeout).message, "Talkin request timed out.");
    });
});

/**
 * Build a valid Talkin configuration for mock endpoint tests.
 * @param {string} apiURL Mock endpoint URL
 * @returns {object} Notification configuration
 */
function buildNotification(apiURL) {
    return {
        name: "Talkin test",
        talkinApiURL: apiURL,
        talkinToken: "top-secret-token",
        talkinAppID: "app-test",
        talkinUserID: "one-user",
    };
}
