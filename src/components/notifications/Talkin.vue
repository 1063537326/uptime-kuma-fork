<template>
    <div class="mb-3">
        <label for="talkin-api-url" class="form-label">{{ $t("Talkin API URL") }}</label>
        <input
            id="talkin-api-url"
            v-model="$parent.notification.talkinApiURL"
            type="url"
            pattern="https?://.+"
            class="form-control"
            required
        />
    </div>

    <div class="mb-3">
        <label for="talkin-token" class="form-label">{{ $t("Talkin Token") }}</label>
        <HiddenInput
            v-model="$parent.notification.talkinToken"
            input-id="talkin-token"
            autocomplete="new-password"
            :maxlength="null"
            :required="true"
        />
        <div class="form-text">{{ $t("talkinTokenDescription") }}</div>
    </div>

    <div class="mb-3">
        <label for="talkin-app-id" class="form-label">{{ $t("Talkin App ID") }}</label>
        <input
            id="talkin-app-id"
            v-model="$parent.notification.talkinAppID"
            type="text"
            class="form-control"
            required
        />
    </div>

    <div class="mb-3">
        <label for="talkin-user-id" class="form-label">{{ $t("Talkin User ID") }}</label>
        <input
            id="talkin-user-id"
            v-model="$parent.notification.talkinUserID"
            type="text"
            pattern=".*\S.*"
            class="form-control"
            required
        />
        <div class="form-text">{{ $t("talkinUserIDDescription") }}</div>
    </div>

    <div class="form-text">{{ $t("talkinPlainTextDescription") }}</div>
</template>

<script>
import HiddenInput from "../HiddenInput.vue";

export default {
    components: { HiddenInput },
};
</script>
