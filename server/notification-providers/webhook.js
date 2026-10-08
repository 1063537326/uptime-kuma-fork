const NotificationProvider = require("./notification-provider");
const axios = require("axios");
const FormData = require("form-data");
const { assertTalkinResponse, TalkinResponseError, toTalkinError } = require("./talkin");
const { buildInspectionReportText } = require("./inspection-report-text");

class Webhook extends NotificationProvider {
    name = "webhook";

    /**
     * Send a versioned inspection report without changing the existing
     * real-time Webhook payload contract.
     * @param {object} notification Notification configuration
     * @param {object} report Safe inspection report DTO
     * @returns {Promise<string>} Success message
     */
    async sendInspectionReport(notification, report) {
        return this.sendPayload(notification, buildInspectionReportText(report), null, null, report);
    }

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        return this.sendPayload(notification, msg, monitorJSON, heartbeatJSON);
    }

    /**
     * Share the configured transport between alerts, tests, and reports.
     * @param {object} notification Notification configuration
     * @param {string} msg Readable message
     * @param {?object} monitorJSON Alert monitor, never synthesized for reports
     * @param {?object} heartbeatJSON Alert heartbeat, never synthesized for reports
     * @param {?object} report Inspection report DTO
     * @returns {Promise<string>} Acceptance message
     */
    async sendPayload(notification, msg, monitorJSON, heartbeatJSON, report = null) {
        const okMsg = "Sent Successfully.";
        const isTalkin = new URL(notification.webhookURL).pathname.replace(/\/$/, "") === "/miic/talkin/app/sendMessageAll";

        try {
            const httpMethod = notification.httpMethod?.toLowerCase() || "post";

            let data = report || {
                heartbeat: heartbeatJSON,
                monitor: monitorJSON,
                msg,
            };
            let config = {
                headers: {},
            };
            if (report) {
                config.timeout = 10000;
            }

            if (httpMethod === "get") {
                config.params = {
                    msg: msg,
                };

                if (report) {
                    config.params.report = JSON.stringify(report);
                }

                if (heartbeatJSON) {
                    config.params.heartbeat = JSON.stringify(heartbeatJSON);
                }

                if (monitorJSON) {
                    config.params.monitor = JSON.stringify(monitorJSON);
                }
            } else if (notification.webhookContentType === "form-data") {
                const formData = new FormData();
                formData.append("data", JSON.stringify(data));
                config.headers = formData.getHeaders();
                data = formData;
            } else if (notification.webhookContentType === "custom") {
                data = await this.renderTemplate(notification.webhookCustomBody, msg, monitorJSON, heartbeatJSON, report);
            }

            if (notification.webhookAdditionalHeaders) {
                try {
                    config.headers = {
                        ...config.headers,
                        ...JSON.parse(notification.webhookAdditionalHeaders),
                    };
                } catch (err) {
                    throw new Error("Additional Headers is not a valid JSON");
                }
            }

            config = this.getAxiosConfigWithProxy(config);

            const response = httpMethod === "get"
                ? await axios.get(notification.webhookURL, config)
                : await axios.post(notification.webhookURL, data, config);
            // This API returns HTTP 200 even when authentication or delivery fails.
            // Other Webhooks retain their own response contracts.
            if (isTalkin) {
                assertTalkinResponse(response.data);
            }

            return okMsg;
        } catch (error) {
            if (error instanceof TalkinResponseError) {
                throw error;
            }
            if (isTalkin) {
                throw toTalkinError(error);
            }
            this.throwGeneralAxiosError(error);
        }
    }
}

module.exports = Webhook;
