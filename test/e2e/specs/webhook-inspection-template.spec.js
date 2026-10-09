import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { io } from "socket.io-client";
import { login, restoreSqliteSnapshot } from "../util-test";

test.describe("Independent Webhook inspection templates", () => {
    test.beforeEach(async ({ page }) => {
        await restoreSqliteSnapshot();
        await page.goto("./dashboard");
        await login(page);
        await expect(page.getByText("Add New Monitor")).toBeVisible();
        await page.goto("./settings/notifications");
    });

    test("preview is local, invalid templates cannot save, and the saved template renders real reports", async ({ page }) => {
        const requests = [];
        const receiver = createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            requests.push(Buffer.concat(chunks).toString());
            res.end("accepted");
        });
        await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
        try {
            await page.getByRole("button", { name: "Set Up Notification" }).click();
            await page.getByLabel("Notification Type").selectOption("webhook");
            await page.locator("#notification-name").fill("Independent report");
            await page.getByLabel("Post URL").fill(`http://127.0.0.1:${receiver.address().port}/capture`);
            await page.getByLabel("Request Body", { exact: true }).selectOption("json");
            await page.getByLabel("Receive inspection reports").check();
            const mode = page.getByLabel("Inspection request body", { exact: true });
            await expect(mode).toHaveValue("inherit");
            await mode.selectOption("custom");
            const body = page.getByLabel("Inspection Liquid template", { exact: true });
            const save = page.locator(".modal.show").getByRole("button", { name: "Save", exact: true });
            await body.fill("{% if private-token %}");
            await page.getByRole("button", { name: "Preview inspection template", exact: true }).click();
            await expect(page.getByTestId("inspection-template-error")).toContainText("Invalid inspection template");
            await expect(page.getByTestId("inspection-template-error")).not.toContainText("private-token");
            await save.click();
            await expect(page.getByText(/Invalid inspection template/).last()).toBeVisible();
            await expect(page.locator(".modal.show")).toBeVisible();
            expect(requests).toHaveLength(0);
            const template = "## Inspection {{ report.reportId }}\nTotal: {{ summary.total }} / failures: {{ today.failures }}\n{{ generatedAt }} / {{ timezone }}\n<script>window.templateExecuted = true</script>";
            await body.fill(template);
            await page.getByRole("button", { name: "Preview inspection template", exact: true }).click();
            await expect(page.getByTestId("inspection-template-preview")).toContainText("## Inspection preview-only-report");
            await expect(page.getByTestId("inspection-template-preview")).toContainText("Total: 2 / failures: 3");
            await expect(page.getByTestId("inspection-template-preview").locator("script")).toHaveCount(0);
            expect(await page.evaluate(() => window.templateExecuted)).toBeUndefined();
            expect(requests).toHaveLength(0);
            await page.locator(".modal.show").getByRole("button", { name: "Test", exact: true }).click();
            await expect.poll(() => requests.filter(text => text.startsWith("{")).map(text => JSON.parse(text))).toEqual([
                { msg: "Independent report Testing", monitor: null, heartbeat: null },
            ]);
            await page.getByLabel("Default enabled for non-group monitors").check();
            await expect(save).toBeEnabled();
            await save.click();
            await expect(page.locator(".modal.show")).toHaveCount(0, { timeout: 10000 });
            await page.reload();
            await page.getByRole("listitem").filter({ hasText: "Independent report" }).getByRole("link", { name: "Edit", exact: true }).click();
            await expect(mode).toHaveValue("custom");
            await expect(body).toHaveValue(template);
            await expect(save).toBeEnabled();
            await save.click();
            await expect(page.locator(".modal.show")).toHaveCount(0, { timeout: 10000 });
            await page.goto("./add");
            await page.getByTestId("friendly-name-input").fill("Template monitor");
            await page.locator("#url").fill("http://127.0.0.1:3001");
            await page.getByTestId("save-button").click();
            await expect(page).toHaveURL(/\/dashboard\/\d+$/);
            await page.goto("./dashboard");
            await page.getByTestId("send-inspection-report").click();
            await expect(page.getByTestId("inspection-report-result")).toContainText("1 succeeded, 0 failed, 1 total");
            const reports = requests.filter(text => text.startsWith("## Inspection"));
            expect(reports).toHaveLength(1);
            expect(reports[0]).toContain("Total: 1");
            expect(reports[0]).not.toContain("preview-only-report");
        } finally {
            receiver.closeAllConnections();
            await new Promise(resolve => receiver.close(resolve));
        }
    });

    test("unauthenticated sockets cannot render a preview", async () => {
        const socket = io("http://localhost:3001", { autoConnect: false, reconnection: false });
        try {
            await new Promise(resolve => {
                socket.once("loginRequired", resolve);
                socket.connect();
            });
            const result = await socket.timeout(5000).emitWithAck("previewWebhookInspectionTemplate", "{{ report.reportId }}");
            expect(result.ok).toBe(false);
            expect(result.rendered).toBeUndefined();
        } finally {
            socket.disconnect();
        }
    });
});
