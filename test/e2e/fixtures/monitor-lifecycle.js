import { expect, test as base } from "@playwright/test";

/**
 * Track monitor loops created by a browser test. Teardown pauses them through
 * the public UI before external receivers are closed or the next snapshot is restored.
 */
export const test = base.extend({
    monitorLifecycle: async ({ page }, use) => {
        const monitorIDs = new Set();
        const finalizers = [];
        const lifecycle = {
            /**
             * @param {string|number} id Persisted monitor ID
             * @returns {void}
             */
            track(id) {
                const normalized = String(id);
                if (!/^\d+$/.test(normalized)) {
                    throw new Error(`Cannot track invalid monitor ID: ${normalized}`);
                }
                monitorIDs.add(normalized);
            },

            /**
             * Register cleanup that must happen after every tracked monitor is paused.
             * @param {() => Promise<void>} finalizer Receiver or resource cleanup
             * @returns {void}
             */
            afterMonitorsStopped(finalizer) {
                finalizers.push(finalizer);
            },
        };

        await use(lifecycle);

        let teardownError;
        try {
            for (const id of [...monitorIDs].reverse()) {
                await pauseMonitor(page, id);
            }
        } catch (error) {
            teardownError = error;
        } finally {
            for (const finalizer of finalizers.reverse()) {
                try {
                    await finalizer();
                } catch (error) {
                    teardownError ||= error;
                }
            }
        }

        if (teardownError) {
            throw teardownError;
        }
    },
});

export { expect };

/**
 * Pause one monitor idempotently through visible controls.
 * @param {import("@playwright/test").Page} page Browser page
 * @param {string} id Monitor ID
 * @returns {Promise<void>}
 */
async function pauseMonitor(page, id) {
    await page.goto(`./dashboard/${id}`);
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    const resume = page.getByRole("button", { name: "Resume", exact: true });
    if (await pause.isVisible()) {
        await pause.click();
        await page.locator(".modal.show").getByRole("button", { name: "Yes", exact: true }).click();
    }
    await expect(resume).toBeVisible();
}
