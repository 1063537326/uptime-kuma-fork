<template>
    <div class="mb-3">
        <label for="Feishu-WebHookUrl" class="form-label">
            {{ $t("Feishu WebHookUrl") }}
            <span style="color: red"><sup>*</sup></span>
        </label>
        <input
            id="Feishu-WebHookUrl"
            v-model="$parent.notification.feishuWebHookUrl"
            type="text"
            class="form-control"
            required
        />
        <div class="form-text">
            <p>
                <span style="color: red"><sup>*</sup></span>
                {{ $t("Required") }}
            </p>
        </div>
        <i18n-t tag="div" keypath="wayToGetTeamsURL" class="form-text">
            <a href="https://www.feishu.cn/hc/zh-CN/articles/360024984973" target="_blank">{{ $t("here") }}</a>
        </i18n-t>
    </div>
    <div class="mb-3">
        <div class="form-check form-switch">
            <input
                id="feishu-enable-inspection-reports"
                v-model="$parent.notification.enableInspectionReports"
                class="form-check-input"
                type="checkbox"
            />
            <label class="form-check-label" for="feishu-enable-inspection-reports">
                {{ $t("Receive inspection reports") }}
            </label>
        </div>
        <div class="form-text">{{ $t("feishuInspectionReportsDescription") }}</div>
    </div>
</template>
