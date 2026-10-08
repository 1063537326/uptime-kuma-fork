<template>
    <form class="my-4 pt-4" data-testid="inspection-schedule-form" @submit.prevent="save">
        <h5 class="settings-subheading">{{ $t("Scheduled inspection reports") }}</h5>
        <p class="form-text">{{ $t("inspectionScheduleDescription") }}</p>
        <p v-if="loading">{{ $t("Loading...") }}</p>
        <fieldset v-else :disabled="saving">
            <div class="form-check form-switch mb-3">
                <input id="inspection-enabled" v-model="settings.enabled" class="form-check-input" type="checkbox" />
                <label for="inspection-enabled" class="form-check-label">{{ $t("Enable scheduled inspection reports") }}</label>
            </div>
            <div class="mb-3">
                <label for="inspection-timezone" class="form-label">{{ $t("Inspection timezone") }}</label>
                <select id="inspection-timezone" v-model="settings.timezone" class="form-select" required>
                    <option value="UTC">UTC</option>
                    <option v-for="zone in timezones" :key="zone.value" :value="zone.value">{{ zone.name }}</option>
                </select>
            </div>
            <label class="form-label">{{ $t("Inspection times") }}</label>
            <p class="form-text">{{ $t("inspectionTimesDescription") }}</p>
            <div v-for="(time, index) in settings.times" :key="index" class="input-group mb-2">
                <input
                    v-model="settings.times[index]"
                    type="time"
                    step="60"
                    class="form-control"
                    required
                    data-testid="inspection-slot"
                    :aria-label="$t('Inspection time', { index: index + 1 })"
                />
                <button class="btn btn-outline-danger" type="button" :aria-label="$t('Remove inspection time')" @click="settings.times.splice(index, 1)">
                    <font-awesome-icon icon="times" />
                </button>
            </div>
            <div class="d-flex flex-wrap gap-2 my-3">
                <button class="btn btn-outline-primary" type="button" @click="settings.times.push('09:30')">{{ $t("Add inspection time") }}</button>
                <button class="btn btn-outline-secondary" type="button" @click="sortTimes">{{ $t("Sort inspection times") }}</button>
                <button class="btn btn-primary" type="submit">{{ $t("Save inspection schedule") }}</button>
            </div>
        </fieldset>
        <p v-if="message" :role="failed ? 'alert' : 'status'" :class="failed ? 'text-danger' : 'text-success'">{{ message }}</p>
    </form>
</template>

<script>
import { timezoneList } from "../../util-frontend";

export default {
    data() {
        return {
            loading: true,
            saving: false,
            failed: false,
            message: "",
            settings: { enabled: false, timezone: "Asia/Shanghai", times: ["09:30", "17:30"] },
            timezones: timezoneList().filter((zone) => zone.value !== "UTC"),
        };
    },
    mounted() {
        this.$root.getSocket().timeout(10000).emit("getInspectionReportSettings", (error, response) => {
            if (error || !response.ok) {
                this.failed = true;
                this.message = this.$t("Unable to load inspection settings.");
                return;
            }
            this.settings = response.settings;
            this.loading = false;
        });
    },
    methods: {
        /**
         * Sort and deduplicate the visible times.
         * @returns {void}
         */
        sortTimes() {
            this.settings.times = [...new Set(this.settings.times)].sort();
        },
        /**
         * Save only inspection settings, leaving other notification settings alone.
         * @returns {void}
         */
        save() {
            this.message = "";
            this.failed = false;
            this.sortTimes();
            if (this.settings.enabled && this.settings.times.length === 0) {
                this.failed = true;
                this.message = this.$t("inspectionTimeRequired");
                return;
            }
            this.saving = true;
            this.$root.getSocket().timeout(10000).emit("setInspectionReportSettings", this.settings, (error, response) => {
                this.saving = false;
                this.failed = Boolean(error || !response.ok);
                if (this.failed) {
                    this.message = this.$t("Unable to save inspection settings.");
                } else {
                    this.settings = response.settings;
                    this.message = this.$t("Inspection schedule saved");
                }
            });
        },
    },
};
</script>
