import { createServer } from "node:http";
import { expect, test } from "../fixtures/monitor-lifecycle";
import { login, restoreSqliteSnapshot } from "../util-test";

test.describe("Default leaf notifications and group events", () => {
    let receiver;
    let endpoint;
    let healthStatus;
    let events;
    let checks;

    test.beforeEach(async ({ page, monitorLifecycle }) => {
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
        monitorLifecycle.afterMonitorsStopped(async () => {
            receiver.closeAllConnections();
            await new Promise(resolve => receiver.close(resolve));
        });
        endpoint = `http://127.0.0.1:${receiver.address().port}`;
        await restoreSqliteSnapshot();
        await page.goto("./dashboard");
        await login(page);
        await expect(page.getByText("Add New Monitor")).toBeVisible();
    });

    test("bulk non-group apply preserves group bindings until cleanup is explicitly selected", async ({ page, monitorLifecycle }) => {
        await createNotification(page, endpoint, false);
        const group = await createMonitor(page, monitorLifecycle, "Existing group", "group", endpoint);
        const leaf = await createMonitor(page, monitorLifecycle, "Existing leaf", "http", endpoint);
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

    test("real leaf failures notify immediately while nested groups notify only after explicit binding", async ({ page, monitorLifecycle }) => {
        test.setTimeout(360000);
        await createNotification(page, endpoint, true);
        const root = await createMonitor(page, monitorLifecycle, "Root group", "group", endpoint);
        const child = await createMonitor(page, monitorLifecycle, "Child group", "group", endpoint, root);
        const leaf = await createMonitor(page, monitorLifecycle, "HTTP leaf", "http", endpoint, child);
        await expectBinding(page, leaf, true);
        await expectBinding(page, child, false);
        await expectBinding(page, root, false);
        await expectStatus(page, root, "Up");
        events.length = 0;
        checks.length = 0;

        healthStatus = 503;
        await expect.poll(() => eventIDs(events, 0), { timeout: 40000 }).toEqual([leaf]);
        const failedCheck = checks.find(check => check.status === 503);
        expect(failedCheck).toBeDefined();
        // Measure delivery after the failing check, not after flipping the target:
        // the normal monitor interval still applies before a check observes failure.
        expect(events[0].time - failedCheck.time).toBeLessThan(10000);
        await expectStatus(page, root, "Down");
        await expectStatus(page, child, "Down");
        expect(eventIDs(events, 0)).toEqual([leaf]);

        healthStatus = 200;
        await expectStatus(page, root, "Up");
        await expect.poll(() => eventIDs(events, 1)).toEqual([leaf]);
        expect(events).toHaveLength(2);

        await setBinding(page, child, true);
        await setBinding(page, root, true);
        await expectBinding(page, child, true);
        await expectBinding(page, root, true);
        await expectStatus(page, root, "Up");
        events.length = 0;

        healthStatus = 503;
        const allIDs = [leaf, child, root].sort();
        await expect.poll(() => eventIDs(events, 0), { timeout: 90000 }).toEqual(allIDs);
        await expectStatus(page, root, "Down");
        healthStatus = 200;
        await expect.poll(() => eventIDs(events, 1), { timeout: 90000 }).toEqual(allIDs);
        await expectStatus(page, root, "Up");
        expect(events).toHaveLength(6);
    });

    test("clones preserve explicit group and leaf bindings instead of reapplying defaults", async ({ page, monitorLifecycle }) => {
        await createNotification(page, endpoint, true);
        const group = await createMonitor(page, monitorLifecycle, "Bound group", "group", endpoint);
        await setBinding(page, group, true);
        const leaf = await createMonitor(page, monitorLifecycle, "Unbound leaf", "http", endpoint);
        await setBinding(page, leaf, false);
        for (const [id, enabled] of [[group, true], [leaf, false]]) {
            await page.goto(`./clone/${id}`);
            await expect(page.getByLabel("Local event receiver", { exact: false })).toBeChecked({ checked: enabled });
            await page.getByTestId("save-button").click();
            await expect(page).toHaveURL(/\/dashboard\/\d+$/);
            const clone = page.url().split("/").pop();
            monitorLifecycle.track(clone);
            expect(clone).not.toBe(id);
            await expectBinding(page, clone, enabled);
        }
    });
});

/**
 * Observe monitor IDs from actual received realtime Webhook requests.
 * @param {object[]} events Received requests
 * @param {number} status Heartbeat status
 * @returns {string[]} Sorted IDs; duplicates remain visible to assertions
 */
function eventIDs(events, status) {
    return events.filter(event => event.payload.heartbeat?.status === status)
        .map(event => String(event.payload.monitor.id)).sort();
}

/**
 * Wait for the actual monitor loop to propagate status to the dashboard.
 * @param {Page} page Browser page
 * @param {string} id Monitor ID
 * @param {string} status Expected visible status
 * @returns {Promise<void>}
 */
async function expectStatus(page, id, status) {
    await page.goto(`./dashboard/${id}`);
    await expect(page.getByTestId("monitor-status")).toHaveText(status, { timeout: 90000 });
}

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
 * @param {object} monitorLifecycle Monitor cleanup fixture
 * @param {string} name Monitor name
 * @param {string} type Monitor type
 * @param {string} endpoint Local HTTP target
 * @param {?string} parent Parent group ID
 * @returns {Promise<string>} Created monitor ID
 */
async function createMonitor(page, monitorLifecycle, name, type, endpoint, parent = null) {
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
    monitorLifecycle.track(id);
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
