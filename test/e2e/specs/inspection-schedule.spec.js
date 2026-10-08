import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { io } from "socket.io-client";
import { login, restoreSqliteSnapshot } from "../util-test";

test.describe("Inspection schedule settings", () => {
    test.beforeEach(async ({ page }) => {
        await restoreSqliteSnapshot();
        await page.goto("./dashboard");
        await login(page);
        await expect(page.getByText("Add New Monitor")).toBeVisible();
        await page.goto("./settings/notifications");
    });

    test("settings default to disabled and persist a sorted unique timezone-aware schedule", async ({ page }) => {
        const form = page.getByTestId("inspection-schedule-form");
        await expect(form.getByLabel("Enable scheduled inspection reports")).not.toBeChecked();
        await expect(form.getByLabel("Inspection timezone")).toHaveValue("Asia/Shanghai");
        await expect.poll(() => slotValues(form)).toEqual(["09:30", "17:30"]);
        await form.getByLabel("Inspection timezone").selectOption("UTC");
        await form.getByRole("button", { name: "Add inspection time" }).click();
        await form.getByTestId("inspection-slot").nth(2).fill("09:30");
        await form.getByTestId("inspection-slot").nth(0).fill("18:00");
        await form.getByRole("button", { name: "Save inspection schedule" }).click();
        await expect(form.getByRole("status")).toContainText("Inspection schedule saved");
        await page.reload();
        await expect(form.getByLabel("Inspection timezone")).toHaveValue("UTC");
        await expect.poll(() => slotValues(form)).toEqual(["09:30", "17:30", "18:00"]);
        await form.getByRole("button", { name: "Remove inspection time" }).nth(2).click();
        await form.getByTestId("inspection-slot").nth(1).fill("09:30");
        await form.getByRole("button", { name: "Save inspection schedule" }).click();
        await expect.poll(() => slotValues(form)).toEqual(["09:30"]);
        await expect(form.getByRole("status")).toContainText("Inspection schedule saved");
        await page.evaluate(() => localStorage.setItem("theme", "dark"));
        await page.reload();
        await expect(form.getByLabel("Inspection timezone")).toHaveValue("UTC");
        await form.screenshot({ path: "private/task06-schedule-dark.png", animations: "disabled" });
    });

    test("an unauthenticated socket cannot read or change inspection settings", async () => {
        const socket = io("http://localhost:3001", { autoConnect: false, reconnection: false });
        try {
            await new Promise((resolve) => {
                socket.once("loginRequired", resolve);
                socket.connect();
            });
            const read = await socket.timeout(5000).emitWithAck("getInspectionReportSettings");
            expect(read.ok).toBe(false);
            expect(read.settings).toBeUndefined();
            const write = await socket.timeout(5000).emitWithAck("setInspectionReportSettings", {
                enabled: true, timezone: "UTC", times: ["09:30"],
            });
            expect(write.ok).toBe(false);
        } finally {
            socket.disconnect();
        }
    });

    test("real minute jobs deliver once and use a newly saved future slot without restart", async ({ page }) => {
        test.setTimeout(200000);
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
        const form = page.getByTestId("inspection-schedule-form");
        try {
            await page.getByRole("button", { name: "Set Up Notification" }).click();
            await page.getByLabel("Notification Type").selectOption("webhook");
            await page.locator("#notification-name").fill("Scheduled local receiver");
            await page.getByLabel("Post URL").fill(`http://127.0.0.1:${receiver.address().port}/report`);
            await page.getByLabel("Request Body", { exact: true }).selectOption("json");
            await page.getByLabel("Receive inspection reports").check();
            await page.getByLabel("Default enabled for non-group monitors").check();
            await page.locator(".modal.show").getByRole("button", { name: "Save", exact: true }).click();
            await expect(page.locator(".modal.show")).toHaveCount(0);
            await page.goto("./add");
            await page.getByTestId("friendly-name-input").fill("Scheduled report monitor");
            await page.locator("#url").fill("http://127.0.0.1:3001");
            await page.getByTestId("save-button").click();
            await expect(page).toHaveURL(/\/dashboard\/\d+$/);
            await page.goto("./settings/notifications");
            await form.getByLabel("Inspection timezone").selectOption("UTC");
            await form.getByRole("button", { name: "Remove inspection time" }).nth(1).click();
            const first = new Date(Date.now() + 70000).toISOString().slice(11, 16);
            await form.getByTestId("inspection-slot").fill(first);
            await form.getByLabel("Enable scheduled inspection reports").check();
            await form.getByRole("button", { name: "Save inspection schedule" }).click();
            await expect(form.getByRole("status")).toBeVisible();
            await expect.poll(() => reports.length, { timeout: 85000, intervals: [1000] }).toBe(1);
            expect(reports[0].trigger).toBe("scheduled");
            expect(reports[0].generatedAt.slice(11, 16)).toBe(first);
            expect(reports[0].timezone).toBe("UTC");
            expect(reports[0].statusSummary.total).toBe(1);
            expect(reports[0].today).toHaveProperty("failures");

            // Save twice in the same minute, then replace the next slot live.
            await form.getByRole("button", { name: "Save inspection schedule" }).click();
            await expect(form.getByRole("status")).toBeVisible();
            const second = new Date(Date.now() + 70000).toISOString().slice(11, 16);
            await form.getByTestId("inspection-slot").fill(second);
            await form.getByRole("button", { name: "Save inspection schedule" }).click();
            await expect(form.getByRole("status")).toBeVisible();
            await expect.poll(() => reports.length, { timeout: 85000, intervals: [1000] }).toBe(2);
            expect(reports[1].generatedAt.slice(11, 16)).toBe(second);
            expect(reports[1].reportId).not.toBe(reports[0].reportId);
            await form.getByLabel("Enable scheduled inspection reports").uncheck();
            await form.getByRole("button", { name: "Save inspection schedule" }).click();
            await expect(form.getByRole("status")).toBeVisible();
            await page.reload();
            await expect(form.getByLabel("Enable scheduled inspection reports")).not.toBeChecked();
            expect(reports).toHaveLength(2);
        } finally {
            if (!page.isClosed()) {
                await page.goto("./settings/notifications");
                await form.getByLabel("Enable scheduled inspection reports").uncheck();
                await form.getByRole("button", { name: "Save inspection schedule" }).click();
                await expect(form.getByRole("status")).toBeVisible();
            }
            await new Promise((resolve) => receiver.close(resolve));
        }
    });
});

/**
 * Observe the editable schedule through the visible inputs.
 * @param {import("@playwright/test").Locator} form Schedule form
 * @returns {Promise<string[]>} Displayed times
 */
async function slotValues(form) {
    return form.getByTestId("inspection-slot").evaluateAll((inputs) => inputs.map((input) => input.value));
}
