/**
 * Format the safe report DTO as mobile-friendly plain text for one Talkin user.
 * @param {object} report Inspection report
 * @returns {string} Bounded plain text, without connection details
 */
function buildTalkinInspectionText(report) {
    const summary = report.statusSummary;
    const titles = { manual: "手动巡检", morning: "早间巡检", evening: "晚间巡检", scheduled: "定时巡检" };
    let icon = "🟢";
    let conclusion = "全部监控项运行正常";
    if (summary.offline > 0) {
        icon = "🔴";
        conclusion = `发现 ${summary.offline} 项离线，请及时处理`;
    } else if (summary.pending + summary.unknown + summary.stale > 0) {
        icon = "🟠";
        conclusion = "存在待确认、未知或数据陈旧的监控项，运行情况需要确认";
    } else if (summary.total === 0) {
        icon = "🔵";
        conclusion = "暂无非分组监控项，当前在线率不可用";
    } else if (summary.maintenance + summary.paused > 0) {
        icon = "🔵";
        conclusion = "存在维护或暂停的监控项，其余监控项无当前异常";
    }
    const lines = [
        `${icon} Uptime Kuma · ${titles[report.period] || "定时巡检"}`,
        conclusion,
        "", "────────────", "监控概览",
        `监控项总数：${summary.total}（不含分组）`,
        `当前在线率：${summary.onlineRate === null ? "N/A" : `${summary.onlineRate}%`}`,
        `在线：${summary.online} · 离线：${summary.offline}`,
        `维护：${summary.maintenance} · 待确认：${summary.pending}`,
        `暂停：${summary.paused} · 未知：${summary.unknown} · 数据陈旧：${summary.stale}`,
        "", "异常明细",
    ];
    const statuses = { offline: "离线", pending: "待确认", unknown: "未知", stale: "数据陈旧" };
    const abnormal = report.abnormalMonitors || [];
    for (const [index, monitor] of abnormal.slice(0, 10).entries()) {
        lines.push(`${index + 1}. ${compact(monitor.name, 80)}`,
            `${statuses[monitor.status] || "未知"}｜${compact(monitor.errorSummary, 120)}`, "");
    }
    if (!abnormal.length) {
        lines.push("当前无离线、待确认、未知或数据陈旧的监控项。");
    }
    const omitted = (report.truncation?.abnormalMonitors || 0) + Math.max(0, abnormal.length - 10);
    if (omitted) {
        lines.push(`另有 ${omitted} 项异常未展开，请在控制台查看。`);
    }
    const today = report.today;
    lines.push("", "────────────", "当日告警摘要",
        `今日故障：${today.failures} 次 · 今日恢复：${today.recoveries} 次`,
        `受影响监控项：${today.affectedMonitors} 项 · 当前未恢复：${today.currentlyDown} 项`);
    if (report.period === "evening" && report.sinceMorningWindow) {
        lines.push(`早报后新增：故障 ${today.sinceMorningFailures} 次 · 恢复 ${today.sinceMorningRecoveries} 次`,
            `${report.sinceMorningWindow.startLocal} → ${report.sinceMorningWindow.endLocal}（不含结束时刻）`);
    }
    const events = report.recentEvents || [];
    if (events.length) {
        lines.push("", "最近事件");
        for (const event of events.slice(0, 5)) {
            lines.push(`• ${event.timeLocal} · ${compact(event.name, 80)} · ${event.type === "failure" ? "故障" : "恢复"}`);
        }
        const omittedEvents = (report.truncation?.recentEvents || 0) + Math.max(0, events.length - 5);
        if (omittedEvents) {
            lines.push(`另有 ${omittedEvents} 条事件未展开。`);
        }
    }
    lines.push("", "────────────",
        `统计窗口：${report.window.startLocal} → ${report.window.endLocal}（不含结束时刻）`,
        `报告时间：${report.generatedAtLocal}`, `时区：${report.timezone}`,
        "巡检报告不替代实时掉线 / 恢复告警。");
    return lines.join("\n");
}

/**
 * Collapse whitespace and truncate by Unicode code point, retaining an ellipsis.
 * @param {*} value Display text
 * @param {number} limit Maximum characters
 * @returns {string} Bounded text
 */
function compact(value, limit) {
    const characters = Array.from(String(value || "").replace(/\s+/g, " ").trim());
    return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : characters.join("");
}

module.exports = { buildTalkinInspectionText };
