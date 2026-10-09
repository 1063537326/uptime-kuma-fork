/**
 * Render the safe inspection DTO without adding links or alert semantics.
 * @param {object} report Inspection report
 * @returns {object} Feishu interactive payload
 */
function buildFeishuInspectionCard(report) {
    const summary = report.statusSummary;
    const titles = { manual: "手动巡检", morning: "早报", evening: "晚报", scheduled: "定时巡检" };
    let template = "green";
    let conclusion = "🟢 全部监控项运行正常。";
    if (summary.offline > 0) {
        template = "red";
        conclusion = `🔴 发现 ${summary.offline} 项离线，请及时处理。`;
    } else if (summary.pending + summary.unknown + summary.stale > 0) {
        template = "orange";
        conclusion = "🟠 存在待确认、未知或数据陈旧的监控项，运行情况需要确认。";
    } else if (summary.total === 0) {
        template = "blue";
        conclusion = "🔵 暂无非分组监控项，当前在线率不可用。";
    } else if (summary.maintenance + summary.paused > 0) {
        template = "blue";
        conclusion = "🔵 存在维护或暂停的监控项，其余监控项无当前异常。";
    }
    const statuses = { offline: "离线", stale: "数据陈旧", pending: "待确认", unknown: "未知" };
    const elements = [
        block(conclusion),
        {
            tag: "div",
            fields: [
                field("监控项总数", `${summary.total}（不含分组）`),
                field("当前在线率", summary.onlineRate === null ? "N/A" : `${summary.onlineRate}%`),
                field("在线 / 离线", `${summary.online} / ${summary.offline}`),
                field("维护 / 暂停", `${summary.maintenance} / ${summary.paused}`),
                field("待确认 / 未知 / 数据陈旧", `${summary.pending} / ${summary.unknown} / ${summary.stale}`),
            ],
        },
        { tag: "hr" },
        block("异常明细"),
    ];
    const abnormal = report.abnormalMonitors || [];
    for (const monitor of abnormal.slice(0, 10)) {
        elements.push(block(`${compact(monitor.name, 80)} · ${statuses[monitor.status] || "未知"}\n${compact(monitor.errorSummary, 120)}`));
    }
    if (abnormal.length === 0) {
        elements.push(block("当前无离线、待确认、未知或数据陈旧的监控项。"));
    }
    const omitted = (report.truncation?.abnormalMonitors || 0) + Math.max(0, abnormal.length - 10);
    if (omitted) {
        elements.push(block(`另有 ${omitted} 项异常未展开，请在控制台查看。`));
    }
    const today = report.today;
    elements.push({ tag: "hr" }, block(`当日告警摘要\n故障 ${today.failures} 次 · 恢复 ${today.recoveries} 次\n受影响监控项 ${today.affectedMonitors} 项 · 当前未恢复 ${today.currentlyDown} 项`));
    if (report.period === "evening" && report.sinceMorningWindow) {
        elements.push(block(`早报后新增：故障 ${today.sinceMorningFailures} 次 · 恢复 ${today.sinceMorningRecoveries} 次\n${report.sinceMorningWindow.startLocal} → ${report.sinceMorningWindow.endLocal}（不含结束时刻）`));
    }
    const events = report.recentEvents || [];
    if (events.length) {
        elements.push(block("最近事件"));
        for (const event of events.slice(0, 5)) {
            elements.push(block(`${event.timeLocal} · ${compact(event.name, 80)} · ${event.type === "failure" ? "故障" : "恢复"}`));
        }
        const omittedEvents = (report.truncation?.recentEvents || 0) + Math.max(0, events.length - 5);
        if (omittedEvents) {
            elements.push(block(`另有 ${omittedEvents} 条事件未展开。`));
        }
    }
    elements.push({ tag: "hr" }, {
        tag: "note",
        elements: [{ tag: "plain_text", content: `统计窗口：${report.window.startLocal} → ${report.window.endLocal}（不含结束时刻）\n生成时间：${report.generatedAtLocal}\n时区：${report.timezone}\n巡检报告不替代实时掉线 / 恢复告警。` }],
    });
    return {
        msg_type: "interactive",
        card: {
            config: { update_multi: false, wide_screen_mode: true },
            header: {
                title: { tag: "plain_text", content: `Uptime Kuma · ${titles[report.period] || "定时巡检"}` },
                template,
            },
            elements,
        },
    };
}

/**
 * Plain text prevents monitor names from introducing markdown links or mentions.
 * @param {string} content Display text
 * @returns {object} Card paragraph
 */
function block(content) {
    return { tag: "div", text: { tag: "plain_text", content } };
}

/**
 * Build a compact overview field.
 * @param {string} label Field label
 * @param {string} value Display value
 * @returns {object} Card field
 */
function field(label, value) {
    return { is_short: true, text: { tag: "plain_text", content: `${label}\n${value}` } };
}

/**
 * Bound names and summaries by Unicode code points and collapse whitespace.
 * @param {*} value Display value
 * @param {number} limit Maximum characters
 * @returns {string} Bounded text
 */
function compact(value, limit) {
    const characters = Array.from(String(value || "").replace(/\s+/g, " ").trim());
    return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : characters.join("");
}

module.exports = { buildFeishuInspectionCard };
