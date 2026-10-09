import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { login, restoreSqliteSnapshot } from "../util-test";

const createdMonitors = new WeakMap();

test.describe("Default leaf notifications and group events", () => {
    let receiver;
    let endpoint;
    let healthStatus;
    let events;
    let checks;

    test.beforeEach(async ({ page }) => {
        createdMonitors.set(page, []);
        healthStatus = 200;
        events = [];
        checks = [];
        receiver = createServer(async (req, res) => {
            if (req.method === "GET" && req.url === "/health") {
                checks.push({ time: Date.now(), status: healthStatus });
                res.writeHead(healthStatus).end("isolated monitor target");
                return;
            }
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            events.push({ time: Date.now(), payload: JSON.parse(Buffer.concat(chunks).toString()) });
            res.end("accepted");
        });
        await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
        endpoint = `http://127.0.0.1:${receiver.address().port}`;
        await restoreSqliteSnapshot();
        await page.goto("./dashboard");
        await login(page);
        await expect(page.getByText("Add New Monitor")).toBeVisible();
    });

    test.afterEach(async ({ page }) => {
        try {
            // Stop this test's loops before closing their HTTP target or allowing
            // the next test to restore its database snapshot.
            for (const id of createdMonitors.get(page).slice().reverse()) {
                await page.goto(`./dashboard/${id}`);
                await page.getByRole("button", { name: "Pause", exact: true }).click();
                await page.locator(".modal.show").getByRole("button", { name: "Yes", exact: true }).click();
                await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
            }
        } finally {
            receiver.closeAllConnections();
            await new Promise(resolve => receiver.close(resolve));
        }
    });

    test("bulk non-group apply preserves group bindings until cleanup is explicitly selected", async ({ page }) => {
        await createNotification(page, endpoint, false);
        const group = await createMonitor(page, "Existing group", "group", endpoint);
        const leaf = await createMonitor(page, "Existing leaf", "http", endpoint);
        await setBinding(page, group, true);
        await editNotification(page);
        await page.getByLabel("Apply to existing monitors").selectOption("non-group");
        await expect(page.getByLabel("Also remove this notification from all group monitors")).not.toBeChecked();
        await expect(page.locator(".notification-apply-preview")).toContainText("add 1 binding(s) and remove 0");
        await saveNotification(page);
        await expectBinding(page, leaf, true);
        await expectBinding(page, group, true);
        await editNotification(page);
        await expect(page.getByLabel("Apply to existing monitors")).toHaveValue("none");
        await page.getByLabel("Apply to existing monitors").selectOption("non-group");
        await page.getByLabel("Also remove this notification from all group monitors").check();
        await expect(page.locator(".notification-apply-preview")).toContainText("add 0 binding(s) and remove 1");
        await saveNotification(page);
        await expectBinding(page, leaf, true);
        await expectBinding(page, group, false);
    });

    test("clones preserve explicit group and leaf bindings instead of reapplying defaults", async ({ page }) => {
        await createNotification(page, endpoint, true);
        const group = await createMonitor(page, "Bound group", "group", endpoint);
        await setBinding(page, group, true);
        const leaf = await createMonitor(page, "Unbound leaf", "http", endpoint);
        await setBinding(page, leaf, false);
        for (const [id, enabled] of [[group, true], [leaf, false]]) {
            await page.goto(`./clone/${id}`);
            await expect(page.getByLabel("Local event receiver", { exact: false })).toBeChecked({ checked: enabled });
            await page.getByTestId("save-button").click();
            await expect(page).toHaveURL(/\/dashboard\/\d+$/);
            const clone = page.url().split("/").pop();
            createdMonitors.get(page).push(clone);
            expect(clone).not.toBe(id);
            await expectBinding(page, clone, enabled);
        }
    });
});

/**
 * Configure a local receiver through the notification form.
 * @param {Page} page Browser page
 * @param {string} endpoint Local HTTP receiver
 * @param {boolean} isDefault Enable default binding
 * @returns {Promise<void>}
 */
async function createNotification(page, endpoint, isDefault) {
    await page.goto("./settings/notifications");
    await page.getByRole("button", { name: "Set Up Notification" }).click();
    await page.getByLabel("Notification Type").selectOption("webhook");
    await page.locator("#notification-name").fill("Local event receiver");
    await page.getByLabel("Post URL").fill(`${endpoint}/notifications`);
    await page.getByLabel("Request Body", { exact: true }).selectOption("json");
    await page.getByLabel("Default enabled for non-group monitors").setChecked(isDefault);
    await saveNotification(page);
}

/**
 * Create a real monitor through the UI with normal twenty-second checks.
 * @param {Page} page Browser page
 * @param {string} name Monitor name
 * @param {string} type Monitor type
 * @param {string} endpoint Local HTTP target
 * @param {?string} parent Parent group ID
 * @returns {Promise<string>} Created monitor ID
 */
async function createMonitor(page, name, type, endpoint, parent = null) {
    await page.goto("./add");
    await page.getByTestId("monitor-type-select").selectOption(type);
    await page.getByTestId("friendly-name-input").fill(name);
    if (type === "http") {
        await page.getByTestId("url-input").fill(`${endpoint}/health`);
    }
    await page.locator("#interval").fill("20");
    await page.getByLabel("Retries", { exact: true }).fill("0");
    if (parent) {
        await page.getByLabel("Monitor Group", { exact: true }).selectOption(parent);
    }
    await page.getByTestId("save-button").click();
    await expect(page).toHaveURL(/\/dashboard\/\d+$/);
    const id = page.url().split("/").pop();
    createdMonitors.get(page).push(id);
    return id;
}

/**
 * Edit the test notification.
 * @param {Page} page Browser page
 * @returns {Promise<void>}
 */
async function editNotification(page) {
    await page.goto("./settings/notifications");
    await page.getByRole("listitem").filter({ hasText: "Local event receiver" }).getByRole("link", { name: "Edit", exact: true }).click();
}

/**
 * Save the notification form.
 * @param {Page} page Browser page
 * @returns {Promise<void>}
 */
async function saveNotification(page) {
    await page.locator(".modal.show").getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".modal.show")).toHaveCount(0);
}

/**
 * Persist an explicit binding selection.
 * @param {Page} page Browser page
 * @param {string} id Monitor ID
 * @param {boolean} enabled Binding state
 * @returns {Promise<void>}
 */
async function setBinding(page, id, enabled) {
    await page.goto(`./edit/${id}`);
    await page.getByLabel("Local event receiver", { exact: false }).setChecked(enabled);
    await page.getByTestId("save-button").click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
}

/**
 * Read a persisted binding through its edit form.
 * @param {Page} page Browser page
 * @param {string} id Monitor ID
 * @param {boolean} enabled Expected binding state
 * @returns {Promise<void>}
 */
async function expectBinding(page, id, enabled) {
    await page.goto(`./edit/${id}`);
    await expect(page.getByLabel("Local event receiver", { exact: false })).toBeChecked({ checked: enabled });
}
