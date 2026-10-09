<template>
    <div class="mb-3">
        <label for="webhook-url" class="form-label">{{ $t("Post URL") }}</label>
        <input
            id="webhook-url"
            v-model="$parent.notification.webhookURL"
            type="url"
            pattern="https?://.+"
            class="form-control"
            required
        />
    </div>

    <div class="mb-3">
        <label for="webhook-http-method" class="form-label">{{ $t("HTTP Method") }}</label>
        <select id="webhook-http-method" v-model="$parent.notification.httpMethod" class="form-select">
            <option value="post">POST</option>
            <option value="get">GET</option>
        </select>
        <div class="form-text">
            {{ $parent.notification.httpMethod === "get" ? $t("webhookGetMethodDesc") : $t("webhookPostMethodDesc") }}
        </div>
    </div>

    <div v-if="$parent.notification.httpMethod === 'post'" class="mb-3">
        <label for="webhook-request-body" class="form-label">{{ $t("Request Body") }}</label>
        <select
            id="webhook-request-body"
            v-model="$parent.notification.webhookContentType"
            class="form-select"
            required
        >
            <option value="json">{{ $t("webhookBodyPresetOption", ["application/json"]) }}</option>
            <option value="form-data">{{ $t("webhookBodyPresetOption", ["multipart/form-data"]) }}</option>
            <option value="custom">{{ $t("webhookBodyCustomOption") }}</option>
        </select>

        <div v-if="$parent.notification.webhookContentType == 'json'" class="form-text">
            {{ $t("webhookJsonDesc", ['"application/json"']) }}
        </div>
        <i18n-t
            v-else-if="$parent.notification.webhookContentType == 'form-data'"
            tag="div"
            keypath="webhookFormDataDesc"
            class="form-text"
        >
            <template #multipart>multipart/form-data"</template>
            <template #decodeFunction>
                <strong>json_decode($_POST['data'])</strong>
            </template>
        </i18n-t>
        <template v-else-if="$parent.notification.webhookContentType == 'custom'">
            <label for="customBody" class="form-label mt-2">{{ $t("Real-time event template") }}</label>
            <TemplatedTextarea
                id="customBody"
                v-model="$parent.notification.webhookCustomBody"
                :required="true"
                :placeholder="customBodyPlaceholder"
            ></TemplatedTextarea>
        </template>
    </div>

    <div class="mb-3">
        <div class="form-check form-switch">
            <input v-model="showAdditionalHeadersField" class="form-check-input" type="checkbox" />
            <label class="form-check-label">{{ $t("webhookAdditionalHeadersTitle") }}</label>
        </div>
        <div class="form-text">{{ $t("webhookAdditionalHeadersDesc") }}</div>
        <textarea
            v-if="showAdditionalHeadersField"
            id="additionalHeaders"
            v-model="$parent.notification.webhookAdditionalHeaders"
            class="form-control"
            :placeholder="headersPlaceholder"
            :required="showAdditionalHeadersField"
        ></textarea>
    </div>

    <div class="mb-3">
        <div class="form-check form-switch">
            <input
                id="webhook-enable-inspection-reports"
                v-model="$parent.notification.enableInspectionReports"
                class="form-check-input"
                type="checkbox"
            />
            <label class="form-check-label" for="webhook-enable-inspection-reports">
                {{ $t("Receive inspection reports") }}
            </label>
        </div>
        <div class="form-text">{{ $t("webhookInspectionReportsDescription") }}</div>
    </div>

    <div v-if="$parent.notification.enableInspectionReports && $parent.notification.httpMethod === 'post'" class="mb-3">
        <label for="webhook-inspection-body" class="form-label">{{ $t("Inspection request body") }}</label>
        <select id="webhook-inspection-body" v-model="$parent.notification.webhookInspectionBody" class="form-select">
            <option value="inherit">{{ $t("Inherit existing request body") }}</option>
            <option value="json">{{ $t("Versioned inspection JSON") }}</option>
            <option value="custom">{{ $t("Independent Liquid template") }}</option>
        </select>
        <div class="form-text">{{ $t("webhookInspectionBodyHelp") }}</div>
        <template v-if="$parent.notification.webhookInspectionBody === 'custom'">
            <label for="webhook-inspection-template" class="form-label mt-3">{{ $t("Inspection Liquid template") }}</label>
            <textarea
                id="webhook-inspection-template"
                v-model="$parent.notification.webhookInspectionCustomBody"
                class="form-control"
                maxlength="16384"
                required
                :placeholder="inspectionExample"
            ></textarea>
            <div class="form-text">{{ $t("webhookInspectionVariables") }}</div>
            <code>msg, report, summary, today, abnormalMonitors, generatedAt, timezone</code>
            <details class="mt-2">
                <summary>{{ $t("Safe Markdown example") }}</summary>
                <pre class="inspection-template-output">{{ inspectionExample }}</pre>
            </details>
            <button type="button" class="btn btn-outline-primary mt-2" :disabled="previewLoading" @click="previewInspection">
                {{ $t("Preview inspection template") }}
            </button>
            <div class="form-text">{{ $t("webhookInspectionPreviewHelp") }}</div>
            <div v-if="previewError" role="alert" data-testid="inspection-template-error" class="alert alert-danger mt-2">{{ previewError }}</div>
            <template v-if="previewResult">
                <pre data-testid="inspection-template-preview" class="inspection-template-output mt-2" role="status">{{ previewResult.rendered }}</pre>
                <details>
                    <summary>{{ $t("Fictional preview data") }}</summary>
                    <pre class="inspection-template-output">{{ JSON.stringify(previewResult.report, null, 2) }}</pre>
                </details>
            </template>
        </template>
    </div>
</template>

<script>
import TemplatedTextarea from "../TemplatedTextarea.vue";

export default {
    components: {
        TemplatedTextarea,
    },
    data() {
        return {
            showAdditionalHeadersField: this.$parent.notification.webhookAdditionalHeaders != null,
            previewLoading: false,
            previewError: "",
            previewResult: null,
            inspectionExample: [
                "## Uptime Kuma · {{ report.period }}",
                "报告标识：{{ report.reportId }}",
                "{% if summary.offline > 0 %}🔴 {{ summary.offline }} 项离线{% else %}📋 请查看状态概览{% endif %}",
                "- 监控项：{{ summary.total }}",
                "- 在线：{{ summary.online }} / 离线：{{ summary.offline }}",
                "- 在线率：{% if summary.onlineRate == nil %}N/A{% else %}{{ summary.onlineRate }}%{% endif %}",
                "{% for item in abnormalMonitors %}- {{ item.name }}：{{ item.status }} — {{ item.errorSummary }}",
                "{% endfor %}今日故障 {{ today.failures }} · 恢复 {{ today.recoveries }}",
                "报告时间：{{ report.generatedAtLocal }}（{{ timezone }}）",
                "统计窗口：{{ report.window.startLocal }} → {{ report.window.endLocal }}（不含结束时刻）",
            ].join("\n"),
        };
    },
    computed: {
        headersPlaceholder() {
            return this.$t("Example:", [
                `{
    "Authorization": "Authorization Token"
}`,
            ]);
        },
        customBodyPlaceholder() {
            return this.$t("Example:", [
                `{
    "Title": "Uptime Kuma Alert{% if monitorJSON %} - {{ monitorJSON['name'] }}{% endif %}",
    "Body": "{{ msg }}"
}`,
            ]);
        },
    },
    watch: {
        "$parent.notification.webhookInspectionCustomBody"() {
            this.previewResult = null;
            this.previewError = "";
        },
    },
    mounted() {
        if (typeof this.$parent.notification.httpMethod === "undefined") {
            this.$parent.notification.httpMethod = "post";
        }
        if (typeof this.$parent.notification.enableInspectionReports === "undefined") {
            this.$parent.notification.enableInspectionReports = false;
        }
        if (typeof this.$parent.notification.webhookInspectionBody === "undefined") {
            this.$parent.notification.webhookInspectionBody = "inherit";
        }
    },
    methods: {
        /**
         * Render fictional data on the server without contacting the receiver.
         * @returns {void}
         */
        previewInspection() {
            const template = this.$parent.notification.webhookInspectionCustomBody;
            this.previewLoading = true;
            this.previewError = "";
            this.previewResult = null;
            this.$root.getSocket().timeout(10000).emit("previewWebhookInspectionTemplate", template, (error, result) => {
                this.previewLoading = false;
                if (template !== this.$parent.notification.webhookInspectionCustomBody) {
                    return;
                }
                if (error) {
                    this.previewError = this.$t("Unable to preview inspection template");
                } else if (!result.ok) {
                    this.previewError = result.msg;
                } else {
                    this.previewResult = result;
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
textarea {
    min-height: 200px;
}

.inspection-template-output {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 300px;
    overflow: auto;
}
</style>
