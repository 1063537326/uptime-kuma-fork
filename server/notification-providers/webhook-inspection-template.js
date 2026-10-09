const { Liquid } = require("liquidjs");
const { buildInspectionReportText } = require("./inspection-report-text");

class InspectionTemplateError extends Error {}

/**
 * Render only the safe report DTO, never notification credentials or monitors.
 * @param {string} template Independent inspection body
 * @param {object} report Safe report DTO
 * @param {string} msg Readable report summary
 * @returns {Promise<string>} Rendered body
 */
async function renderInspectionTemplate(template, report, msg) {
    const engine = new Liquid({
        templates: Object.create(null),
        strictFilters: true,
        strictVariables: true,
        ownPropertyOnly: true,
        lenientIf: true,
        parseLimit: 16384,
        renderLimit: 100,
        memoryLimit: 65536,
    });
    try {
        if (typeof template !== "string" || !template.trim() || template.length > 16384) {
            throw new Error("Invalid template size");
        }
        const rendered = await engine.parseAndRender(template, {
            msg, report, summary: report.statusSummary, today: report.today,
            abnormalMonitors: report.abnormalMonitors, generatedAt: report.generatedAt, timezone: report.timezone,
        });
        if (rendered.length > 65536) {
            throw new Error("Output too large");
        }
        return rendered;
    } catch (error) {
        // Liquid errors can contain source text. Never return or log it.
        const line = Number(error.token?.getPosition?.()[0]);
        throw new InspectionTemplateError(`Invalid inspection template${Number.isInteger(line) && line > 0 ? ` at line ${line}` : ""}. Check Liquid syntax, variables, filters and limits (16384 template characters, 65536 output characters; no file includes).`);
    }
}

/**
 * Preview using fictional data only; no DB access or HTTP request.
 * @param {string} template Independent inspection body
 * @returns {Promise<object>} Rendered text and its sample report
 */
async function previewInspectionTemplate(template) {
    const report = {
        schemaVersion: 1, reportId: "preview-only-report", reportType: "inspection", trigger: "scheduled", period: "evening",
        generatedAt: "2026-10-08T09:30:00.000Z", generatedAtLocal: "2026-10-08 17:30:00", timezone: "Asia/Shanghai",
        window: { start: "2026-10-07T16:00:00.000Z", end: "2026-10-08T09:30:00.000Z", startLocal: "2026-10-08 00:00:00", endLocal: "2026-10-08 17:30:00" },
        sinceMorningWindow: { start: "2026-10-08T01:30:00.000Z", end: "2026-10-08T09:30:00.000Z", startLocal: "2026-10-08 09:30:00", endLocal: "2026-10-08 17:30:00" },
        statusSummary: { total: 2, online: 1, offline: 1, pending: 0, paused: 0, maintenance: 0, unknown: 0, stale: 0, onlineRate: 50 },
        today: { failures: 3, recoveries: 2, affectedMonitors: 1, currentlyDown: 1, sinceMorningFailures: 1, sinceMorningRecoveries: 0 },
        monitors: [{ id: 1, name: "Example API", status: "offline" }, { id: 2, name: "Example worker", status: "online" }],
        abnormalMonitors: [{ id: 1, name: "Example API", status: "offline", lastCheckAt: "2026-10-08T09:29:00.000Z", errorSummary: "检查超时" }],
        recentEvents: [{ monitorId: 1, name: "Example API", type: "failure", time: "2026-10-08T09:00:00.000Z", timeLocal: "2026-10-08 17:00:00", errorSummary: "检查超时" }],
        truncation: { abnormalMonitors: 0, recentEvents: 0 },
    };
    return { rendered: await renderInspectionTemplate(template, report, buildInspectionReportText(report)), report };
}

/**
 * Validate the opt-in body mode before saving; legacy configurations stay valid.
 * @param {object} notification Notification configuration
 * @returns {Promise<void>} Resolves when configuration is valid
 */
async function validateInspectionTemplate(notification) {
    if (notification.type !== "webhook") {
        return;
    }
    const mode = notification.webhookInspectionBody ?? "inherit";
    if (!["inherit", "json", "custom"].includes(mode)) {
        throw new InspectionTemplateError("Invalid inspection template body mode.");
    }
    if (mode === "custom" && notification.httpMethod?.toLowerCase() !== "get") {
        await previewInspectionTemplate(notification.webhookInspectionCustomBody);
    }
}

module.exports = { renderInspectionTemplate, previewInspectionTemplate, validateInspectionTemplate, InspectionTemplateError };
