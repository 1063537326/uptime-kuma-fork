const NotificationProvider = require("./notification-provider");
const axios = require("axios");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const { DOWN, UP } = require("../../src/util");

dayjs.extend(utc);

const MONITOR_NAME_LIMIT = 80;
const ERROR_SUMMARY_LIMIT = 300;

class Feishu extends NotificationProvider {
    name = "Feishu";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            const config = this.getAxiosConfigWithProxy({});
            if (heartbeatJSON == null) {
                await axios.post(
                    notification.feishuWebHookUrl,
                    {
                        msg_type: "text",
                        content: {
                            text: msg,
                        },
                    },
                    config
                );
                return okMsg;
            }

            if (heartbeatJSON.status === DOWN || heartbeatJSON.status === UP) {
                await axios.post(notification.feishuWebHookUrl, buildRealtimeCard(monitorJSON, heartbeatJSON), config);
                return okMsg;
            }
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

/**
 * Build a Feishu interactive card for a real-time down or recovery event.
 * @param {object} monitorJSON Monitor details
 * @param {object} heartbeatJSON Heartbeat details
 * @returns {object} Feishu webhook payload
 */
function buildRealtimeCard(monitorJSON, heartbeatJSON) {
    const isDown = heartbeatJSON.status === DOWN;
    const monitorName = escapeLarkMarkdown(truncateText(monitorJSON?.name, MONITOR_NAME_LIMIT, "未命名监控项"));
    const eventTime = getEventTime(heartbeatJSON);
    const fields = [
        createField("当前状态", isDown ? "🔴 离线" : "🟢 已恢复"),
        createField(isDown ? "异常时间" : "恢复时间", eventTime),
    ];

    if (isDown) {
        fields.push(createField("响应耗时", formatPing(heartbeatJSON.ping)));
    } else {
        const downtime = getDowntime(heartbeatJSON);
        if (downtime) {
            fields.push(createField("中断时长", downtime));
        }
    }

    const elements = [
        {
            tag: "div",
            text: {
                tag: "lark_md",
                content: `**监控项**\n${monitorName}`,
            },
        },
        {
            tag: "hr",
        },
        {
            tag: "div",
            fields,
        },
    ];

    if (isDown) {
        const errorSummary = escapeLarkMarkdown(truncateText(heartbeatJSON.msg, ERROR_SUMMARY_LIMIT, "未提供错误信息"));
        elements.push(
            {
                tag: "div",
                text: {
                    tag: "lark_md",
                    content: `**错误摘要**\n${errorSummary}`,
                },
            },
            {
                tag: "note",
                elements: [
                    {
                        tag: "plain_text",
                        content: "请及时检查服务状态。",
                    },
                ],
            }
        );
    } else {
        elements.push({
            tag: "note",
            elements: [
                {
                    tag: "plain_text",
                    content: "服务已恢复，实时监控继续运行。",
                },
            ],
        });
    }

    return {
        msg_type: "interactive",
        card: {
            config: {
                update_multi: false,
                wide_screen_mode: true,
            },
            header: {
                title: {
                    tag: "plain_text",
                    content: isDown ? "Uptime Kuma · 服务异常" : "Uptime Kuma · 服务恢复",
                },
                template: isDown ? "red" : "green",
            },
            elements,
        },
    };
}

/**
 * Create a compact card field.
 * @param {string} label Field label
 * @param {string} value Field value
 * @returns {object} Feishu card field
 */
function createField(label, value) {
    return {
        is_short: true,
        text: {
            tag: "lark_md",
            content: `**${label}**\n${escapeLarkMarkdown(value)}`,
        },
    };
}

/**
 * Return the server-local event time already prepared by the monitor model.
 * @param {object} heartbeatJSON Heartbeat details
 * @returns {string} Display time
 */
function getEventTime(heartbeatJSON) {
    const localDateTime = truncateText(heartbeatJSON.localDateTime, 40, "时间未知");
    const timezone = truncateText(heartbeatJSON.timezone, 40, "");
    return timezone ? `${localDateTime} (${timezone})` : localDateTime;
}

/**
 * Format ping without exposing monitor connection details.
 * @param {?number} ping Ping in milliseconds
 * @returns {string} Display value
 */
function formatPing(ping) {
    return Number.isFinite(Number(ping)) ? `${Number(ping)} ms` : "N/A";
}

/**
 * Calculate recovery downtime only when both timestamps form a valid range.
 * @param {object} heartbeatJSON Heartbeat details
 * @returns {?string} Human-readable duration
 */
function getDowntime(heartbeatJSON) {
    if (!heartbeatJSON.lastDownTime || !heartbeatJSON.time) {
        return null;
    }

    const startedAt = dayjs.utc(heartbeatJSON.lastDownTime);
    const recoveredAt = dayjs.utc(heartbeatJSON.time);
    if (!startedAt.isValid() || !recoveredAt.isValid() || !recoveredAt.isAfter(startedAt)) {
        return null;
    }

    let remainingSeconds = recoveredAt.diff(startedAt, "second");
    const days = Math.floor(remainingSeconds / 86400);
    remainingSeconds %= 86400;
    const hours = Math.floor(remainingSeconds / 3600);
    remainingSeconds %= 3600;
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    const parts = [];

    if (days) {
        parts.push(`${days} 天`);
    }
    if (hours) {
        parts.push(`${hours} 小时`);
    }
    if (minutes) {
        parts.push(`${minutes} 分钟`);
    }
    if (!parts.length || (days === 0 && hours === 0)) {
        parts.push(`${seconds} 秒`);
    }

    return parts.slice(0, 2).join(" ");
}

/**
 * Normalize whitespace and truncate by Unicode code point.
 * @param {*} value Input value
 * @param {number} limit Maximum number of code points
 * @param {string} fallback Fallback text
 * @returns {string} Safe compact text
 */
function truncateText(value, limit, fallback) {
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
 * Escape user-controlled text inserted into lark_md blocks.
 * @param {*} value Input value
 * @returns {string} Escaped text
 */
function escapeLarkMarkdown(value) {
    return String(value).replace(/([\\*_~`>[\]()#+\-.!])/g, "\\$1");
}

module.exports = Feishu;
module.exports.buildRealtimeCard = buildRealtimeCard;
module.exports.getDowntime = getDowntime;
module.exports.truncateText = truncateText;
