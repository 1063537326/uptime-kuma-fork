/**
 * Render a current-status report for text-oriented Webhook templates.
 * @param {object} report Safe inspection report DTO
 * @returns {string} Plain-text summary without internal URLs or credentials
 */
function buildInspectionReportText(report) {
    const summary = report.statusSummary;
    const titles = { manual: "手动巡检", morning: "早间巡检", evening: "晚间巡检", scheduled: "定时巡检" };
    const lines = [
        `📋 Uptime Kuma · ${titles[report.period] || "当前状态巡检"}`,
        "────────────",
        `报告时间：${report.generatedAtLocal} (${report.timezone})`,
        `监控项总数：${summary.total}（不含分组）`,
        `在线：${summary.online} · 离线：${summary.offline} · 重试中：${summary.pending}`,
        `暂停：${summary.paused} · 维护：${summary.maintenance} · 未知：${summary.unknown} · 数据过期：${summary.stale}`,
        `在线率：${summary.onlineRate === null ? "N/A" : `${summary.onlineRate}%`}`,
    ];
    if (report.window) {
        lines.push("", `统计窗口：${report.window.startLocal} → ${report.window.endLocal}（不含结束时刻）`);
    }
    if (report.today) {
        lines.push("", "当日告警摘要",
            `今日故障：${report.today.failures} · 今日恢复：${report.today.recoveries}`,
            `受影响监控项：${report.today.affectedMonitors} · 当前未恢复：${report.today.currentlyDown}`);
        if (report.sinceMorningWindow) {
            lines.push(`早报后新增（${report.sinceMorningWindow.startLocal} 起）：故障 ${report.today.sinceMorningFailures} · 恢复 ${report.today.sinceMorningRecoveries}`);
        }
    }
    const statuses = { offline: "离线", pending: "重试中", unknown: "未知", stale: "数据过期" };
    const attention = report.abnormalMonitors || report.monitors.filter((monitor) => statuses[monitor.status]);
    if (attention.length) {
        lines.push("", "需关注的监控项");
        for (const monitor of attention.slice(0, 10)) {
            const name = Array.from(String(monitor.name).replace(/\s+/g, " ").trim()).slice(0, 80).join("");
            lines.push(`• ${name} · ${statuses[monitor.status]}`);
            if (monitor.errorSummary) {
                lines.push(`  ${monitor.errorSummary}`);
            }
        }
        const omitted = report.truncation?.abnormalMonitors ?? Math.max(0, attention.length - 10);
        if (omitted > 0) {
            lines.push(`另有 ${omitted} 项未展开，请在控制台查看。`);
        }
    } else {
        lines.push("", "当前无离线、重试中或数据异常的监控项。");
    }
    if (report.recentEvents?.length) {
        lines.push("", "最近事件");
        for (const event of report.recentEvents.slice(0, 5)) {
            const name = Array.from(String(event.name).replace(/\s+/g, " ").trim()).slice(0, 80).join("");
            lines.push(`• ${event.timeLocal} · ${name} · ${event.type === "failure" ? "故障" : "恢复"}`);
        }
        if (report.truncation?.recentEvents > 0) {
            lines.push(`另有 ${report.truncation.recentEvents} 条事件未展开。`);
        }
    }
    lines.push("", "巡检报告不替代实时掉线 / 恢复告警。");
    return lines.join("\n");
}

module.exports = { buildInspectionReportText };
