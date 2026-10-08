import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { login, restoreSqliteSnapshot } from "../util-test";

test.describe("Inspection and notification UI", () => {
    test.beforeEach(async ({ page }) => {
        await restoreSqliteSnapshot();
        await page.goto("./dashboard");
        await login(page);
        await expect(page.getByText("Add New Monitor")).toBeVisible();
    });

    test("notification dialog exposes three one-time apply scopes", async ({ page }) => {
        await openNotificationDialog(page);
        const scope = page.getByLabel("Apply to existing monitors");
        await expect(scope).toBeVisible();
        await expect(scope.locator("option")).toHaveText([
            "Do not apply in bulk",
            "Apply to all existing non-group monitors",
            "Apply on all existing monitors",
        ]);

        await scope.selectOption("non-group");
        await expect(page.getByLabel("Also remove this notification from all group monitors")).toBeVisible();
        await expect(page.getByText(/This save will add \d+ binding/)).toBeVisible();
    });

    test("Webhook has an explicit inspection report opt-in", async ({ page }) => {
        await openNotificationDialog(page);
        await page.getByLabel("Notification Type").selectOption("webhook");
        await expect(page.getByLabel("Receive inspection reports")).toBeVisible();
        await expect(page.getByLabel("Receive inspection reports")).not.toBeChecked();
    });

    test("bulk preview uses dark surfaces and remains legible in light mode", async ({ page }) => {
        await page.evaluate(() => localStorage.setItem("theme", "dark"));
        await page.reload();
        await openNotificationDialog(page);
        await page.getByLabel("Apply to existing monitors").selectOption("non-group");
        const preview = page.locator(".notification-apply-preview");
        await expect(preview).toHaveCSS("background-color", "rgb(7, 10, 16)");
        await expect(preview).toHaveCSS("color", "rgb(177, 184, 192)");
        await preview.screenshot({ path: "private/notification-preview-dark.png", animations: "disabled" });
        await page.evaluate(() => localStorage.setItem("theme", "light"));
        await page.reload();
        await openNotificationDialog(page);
        await page.getByLabel("Apply to existing monitors").selectOption("non-group");
        await expect(preview).not.toHaveCSS("background-color", "rgb(7, 10, 16)");
        await preview.screenshot({ path: "private/notification-preview-light.png", animations: "disabled" });
    });

    test("defaults apply to new leaves only, while manual group bindings survive editing", async ({ page }) => {
        await openNotificationDialog(page);
        await page.getByLabel("Notification Type").selectOption("webhook");
        await page.locator("#notification-name").fill("Default leaf notification");
        await page.getByLabel("Post URL").fill("http://127.0.0.1:1/mock-notification");
        await page.getByLabel("Request Body", { exact: true }).selectOption("json");
        await page.getByLabel("Default enabled for non-group monitors").check();
        await page.locator(".modal.show").getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator(".modal.show")).toHaveCount(0);

        await page.goto("./add");
        const binding = page.getByLabel("Default leaf notification", { exact: false });
        const type = page.getByTestId("monitor-type-select");
        await expect(binding).toBeChecked();
        await type.selectOption("group");
        await expect(binding).not.toBeChecked();
        await type.selectOption("http");
        await expect(binding).toBeChecked();
        await binding.uncheck();
        await type.selectOption("group");
        await type.selectOption("http");
        await expect(binding).not.toBeChecked();

        await type.selectOption("group");
        await binding.check();
        await page.getByTestId("friendly-name-input").fill("Explicit group binding");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page).toHaveURL(/\/dashboard\/\d+$/);
        const id = page.url().split("/").pop();
        await page.goto(`./edit/${id}`);
        await expect(binding).toBeChecked();
        await expect(type).toHaveValue("group");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
        await page.goto(`./edit/${id}`);
        await expect(binding).toBeChecked();

        // A fresh add form must not reuse the previous monitor's notification map.
        await page.goto("./add");
        await expect(binding).toBeChecked();
        await type.selectOption("group");
        await expect(binding).not.toBeChecked();
    });

    test("Talkin requires a targeted user and secret token fields", async ({ page }) => {
        await openNotificationDialog(page);
        await page.getByLabel("Notification Type").selectOption("Talkin");
        await expect(page.getByLabel("Talkin API URL")).toHaveAttribute("required", "");
        await expect(page.getByLabel("Talkin Token")).toHaveAttribute("type", "password");
        await expect(page.getByLabel("Talkin App ID")).toHaveAttribute("required", "");
        await expect(page.getByLabel("Talkin User ID")).toHaveAttribute("required", "");
        await expect(page.getByText(/Broadcast, all-user, and group targets are not supported/)).toBeVisible();
    });

    test("dashboard disables manual reports when no eligible recipient exists", async ({ page }) => {
        await page.goto("./dashboard");
        const button = page.getByTestId("send-inspection-report");
        await expect(button).toBeDisabled();
        await expect(page.getByText(/Enable inspection reports on a Webhook/)).toBeVisible();
    });

    test("dashboard sends a daily inspection report through the configured Webhook", async ({ page }) => {
        const reports = [];
        const receiver = createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            const payload = JSON.parse(Buffer.concat(chunks).toString());
            if (payload.reportType === "inspection") {
                reports.push(payload);
            }
            res.end("accepted");
        });
        await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
        try {
            await openNotificationDialog(page);
            await page.getByLabel("Notification Type").selectOption("webhook");
            await page.locator("#notification-name").fill("Daily report receiver");
            await page.getByLabel("Post URL").fill(`http://127.0.0.1:${receiver.address().port}/report`);
            await page.getByLabel("Request Body", { exact: true }).selectOption("json");
            await page.getByLabel("Receive inspection reports").check();
            await page.getByLabel("Default enabled for non-group monitors").check();
            await page.locator(".modal.show").getByRole("button", { name: "Save", exact: true }).click();
            await expect(page.locator(".modal.show")).toHaveCount(0);
            await page.goto("./add");
            await page.getByTestId("friendly-name-input").fill("Local report monitor");
            await page.locator("#url").fill("http://127.0.0.1:3001");
            await page.getByTestId("save-button").click();
            await expect(page).toHaveURL(/\/dashboard\/\d+$/);
            await page.goto("./dashboard");
            const send = page.getByTestId("send-inspection-report");
            await expect(send).toBeEnabled();
            await send.click();
            await expect(page.getByTestId("inspection-report-result")).toContainText("1 succeeded");
            expect(reports).toHaveLength(1);
            expect(reports[0].timezone).toBe("Asia/Shanghai");
            expect(reports[0].period).toBe("manual");
            expect(reports[0].today).toHaveProperty("failures");
            expect(reports[0].window).toHaveProperty("startLocal");
            await page.screenshot({ path: "private/task05-manual-report.png", animations: "disabled" });
        } finally {
            await new Promise((resolve) => receiver.close(resolve));
        }
    });
});

/**
 * Open the notification settings dialog after authentication is ready.
 * @param {import("@playwright/test").Page} page Playwright page
 * @returns {Promise<void>}
 */
async function openNotificationDialog(page) {
    await page.goto("./settings/notifications");
    const setupButton = page.getByRole("button", { name: "Set Up Notification" });
    await expect(setupButton).toBeVisible();
    await setupButton.click();
}
