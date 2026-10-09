const axios = require("axios");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const NotificationProvider = require("./notification-provider");
const { DOWN, UP } = require("../../src/util");
const { buildTalkinInspectionText } = require("./talkin-inspection-text");

dayjs.extend(utc);

const BLOCKED_USER_IDS = new Set(["*", "all", "@all", "everyone", "全员"]);
const NAME_LIMIT = 80;
const ERROR_LIMIT = 240;
const clockEpochOffset = BigInt(Date.now()) * 1000000n - process.hrtime.bigint();
let lastMessageTimestamp = 0n;

class Talkin extends NotificationProvider {
    name = "Talkin";

    /**
     * @inheritdoc
     * @throws {Error} When configuration, transport, or business validation fails
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        return this.sendText(notification, buildTalkinMessage(notification, msg, monitorJSON, heartbeatJSON));
    }

    /**
     * Send an inspection report without manufacturing a real-time heartbeat.
     * @param {object} notification Notification configuration
     * @param {object} report Safe inspection report DTO
     * @returns {Promise<string>} Acceptance message
     */
    async sendInspectionReport(notification, report) {
        return this.sendText(notification, buildTalkinInspectionText(report));
    }

    /**
     * Share the accepted single-user transport for alerts and reports.
     * @param {object} notification Notification configuration
     * @param {string} message Plain text
     * @returns {Promise<string>} Acceptance message
     */
    async sendText(notification, message) {
        const config = validateTalkinConfig(notification);
        const formData = new URLSearchParams();
        formData.append("msgType", "text");
        formData.append("msgId", createMessageID());
        formData.append("appId", config.appID);
        formData.append("userId", config.userID);
        formData.append("message", message);

        try {
            const response = await axios.post(config.apiURL, formData.toString(), {
                ...this.getAxiosConfigWithProxy({}),
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Authorization: `Bearer ${config.token}`,
                },
                timeout: 10000,
            });

            assertTalkinResponse(response.data);

            return "Sent Successfully.";
        } catch (error) {
            if (error instanceof TalkinResponseError) {
                throw error;
            }
            throw toTalkinError(error);
        }
    }
}

class TalkinResponseError extends Error {
    /**
     * @param {string} message Internal diagnostic message
     * @param {?number} code Stable Talkin response code
     */
    constructor(message, code = null) {
        super(message);
        this.code = code;
    }
}

/**
 * Check business acceptance without leaking server response details.
 * @param {*} data Response body
 * @returns {void}
 * @throws {TalkinResponseError} If the message was not accepted
 */
function assertTalkinResponse(data) {
    const code = data?.code;
    if (!data || !/^[0-9]+$/.test(String(code))) {
        throw new TalkinResponseError("Talkin returned a malformed response.");
    }
    if (Number(code) !== 200) {
        throw new TalkinResponseError(`Talkin rejected the message (${Number(code)}).`, Number(code));
    }
    if (typeof data.data?.data !== "boolean") {
        throw new TalkinResponseError("Talkin returned a malformed response.");
    }
    if (data.data.data !== true) {
        throw new TalkinResponseError("Talkin rejected the message (200).", 200);
    }
}

/**
 * Convert transport failures into stable errors without response bodies,
 * request data, URLs, or credentials.
 * @param {any} error Axios/network error
 * @returns {Error} Sanitized error
 */
function toTalkinError(error) {
    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        return new Error("Talkin request timed out.");
    }
    if (error.response?.status) {
        return new Error(`Talkin request failed (HTTP ${error.response.status}).`);
    }
    return new Error("Talkin request failed. Check the API URL and network connection.");
}

/**
 * Validate and normalize Talkin configuration without exposing secrets.
 * @param {object} notification Notification configuration
 * @returns {{ apiURL: string, token: string, appID: string, userID: string }} Normalized config
 * @throws {Error} When a required field, URL, or single-user target is invalid
 */
function validateTalkinConfig(notification) {
    const apiURL = String(notification.talkinApiURL || "").trim();
    const token = String(notification.talkinToken || "").trim().replace(/^Bearer(?:\s+|$)/i, "").trim();
    const appID = String(notification.talkinAppID || "").trim();
    const userID = String(notification.talkinUserID || "").trim();

    if (!apiURL || !token || !appID || !userID) {
        throw new Error("Talkin API URL, Token, App ID, and User ID are required.");
    }

    let parsedURL;
    try {
        parsedURL = new URL(apiURL);
    } catch (error) {
        throw new Error("Talkin API URL is invalid.");
    }
    if (!["http:", "https:"].includes(parsedURL.protocol)) {
        throw new Error("Talkin API URL must use HTTP or HTTPS.");
    }

    if (BLOCKED_USER_IDS.has(userID.toLowerCase())) {
        throw new Error("Talkin User ID must identify one user; broadcast targets are not allowed.");
    }

    return {
        apiURL: parsedURL.toString(),
        token,
        appID,
        userID,
    };
}

/**
 * Match the compact prefix + nanosecond timestamp format of working requests.
 * A monotonic clock and counter avoid duplicate IDs within this process.
 * @returns {string} Unique message ID
 */
function createMessageID() {
    const timestamp = clockEpochOffset + process.hrtime.bigint();
    lastMessageTimestamp = timestamp > lastMessageTimestamp ? timestamp : lastMessageTimestamp + 1n;
    return `kuma-${lastMessageTimestamp}`;
}

/**
 * Build the fixed, plain-text Talkin real-time message.
 * @param {object} notification Notification configuration
 * @param {string} msg Generic notification message
 * @param {?object} monitorJSON Monitor details
 * @param {?object} heartbeatJSON Heartbeat details
 * @returns {string} Plain-text message
 */
function buildTalkinMessage(notification, msg, monitorJSON, heartbeatJSON) {
    if (!heartbeatJSON) {
        return [
            "🔵 Uptime Kuma · 通知",
            String(msg || ""),
            "",
            "────────────",
            `配置名称：${compactText(notification.name, NAME_LIMIT, "未命名通知")}`,
            `发送时间：${new Date().toISOString()}`,
        ].join("\n");
    }

    const isDown = heartbeatJSON.status === DOWN;
    const isUp = heartbeatJSON.status === UP;
    const lines = [
        `${isDown ? "🔴" : isUp ? "🟢" : "🔵"} Uptime Kuma · ${isDown ? "监控异常" : isUp ? "监控恢复" : "状态通知"}`,
        isDown ? "服务已离线，请及时处理" : isUp ? "服务已恢复正常" : "监控状态发生变化",
        "",
        "────────────",
        `监控项：${compactText(monitorJSON?.name, NAME_LIMIT, "未命名监控项")}`,
        `状态：${isDown ? "离线" : isUp ? "已恢复" : "已更新"}`,
    ];

    if (isDown) {
        lines.push(`错误摘要：${compactText(heartbeatJSON.msg || msg, ERROR_LIMIT, "未提供错误信息")}`);
        lines.push(`响应耗时：${formatPing(heartbeatJSON.ping)}`);
        lines.push(`发生时间：${formatEventTime(heartbeatJSON)}`);
    } else {
        const downtime = formatDowntime(heartbeatJSON);
        if (downtime) {
            lines.push(`中断时长：${downtime}`);
        }
        lines.push(`恢复时间：${formatEventTime(heartbeatJSON)}`);
    }

    return lines.join("\n");
}

/**
 * Compact user-controlled text for mobile notification readability.
 * @param {*} value Input value
 * @param {number} limit Maximum Unicode code points
 * @param {string} fallback Fallback text
 * @returns {string} Compact text
 */
function compactText(value, limit, fallback) {
    const text = String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    if (!text) {
        return fallback;
    }
    const characters = Array.from(text);
    return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text;
}

/**
 * Format an event time supplied by the existing monitor notification path.
 * @param {object} heartbeatJSON Heartbeat details
 * @returns {string} Event time
 */
function formatEventTime(heartbeatJSON) {
    const time = compactText(heartbeatJSON.localDateTime || heartbeatJSON.time, 40, "时间未知");
    const timezone = compactText(heartbeatJSON.timezone, 40, "");
    return timezone ? `${time} (${timezone})` : time;
}

/**
 * Format ping safely.
 * @param {*} ping Ping value
 * @returns {string} Ping text
 */
function formatPing(ping) {
    return Number.isFinite(Number(ping)) ? `${Number(ping)} ms` : "N/A";
}

/**
 * Format a reliable recovery duration when both timestamps are present.
 * @param {object} heartbeatJSON Heartbeat details
 * @returns {?string} Duration text
 */
function formatDowntime(heartbeatJSON) {
    if (!heartbeatJSON.lastDownTime || !heartbeatJSON.time) {
        return null;
    }
    const startedAt = dayjs.utc(heartbeatJSON.lastDownTime);
    const recoveredAt = dayjs.utc(heartbeatJSON.time);
    if (!startedAt.isValid() || !recoveredAt.isValid() || !recoveredAt.isAfter(startedAt)) {
        return null;
    }

    const totalSeconds = recoveredAt.diff(startedAt, "second");
    if (totalSeconds < 60) {
        return `${totalSeconds} 秒`;
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) {
        return `${totalMinutes} 分钟`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

module.exports = Talkin;
module.exports.buildTalkinMessage = buildTalkinMessage;
module.exports.createMessageID = createMessageID;
module.exports.toTalkinError = toTalkinError;
module.exports.validateTalkinConfig = validateTalkinConfig;
module.exports.assertTalkinResponse = assertTalkinResponse;
module.exports.TalkinResponseError = TalkinResponseError;
