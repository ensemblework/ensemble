/** Run with the isolated mobile-ui-fixture.ts API and local Hub. No hosted accounts. */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const WEB = process.env.HUB_WEB ?? "http://localhost:3092";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(WEB).hostname));
const fixture = JSON.parse(readFileSync(process.env.MOBILE_FIXTURE_PATH ?? "/tmp/ensemble-mobile-ui.json", "utf8"));
const shots = process.env.CLEAN_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ["--no-sandbox"] });
const errors = [];
const fits = async page => assert.equal(await page.locator("#main-content").evaluate(el => el.scrollWidth <= el.clientWidth + 2), true, `${page.url()} fits`);
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
try {
  for (const width of [320, 390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 768, isMobile: width < 768, reducedMotion: "reduce" });
    await context.addCookies([{ name: fixture.cookie.split("=")[0], value: fixture.cookie.split("=")[1], url: WEB }]);
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));

    await page.goto(`${WEB}/runs`);
    await page.getByRole("button", { name: "Assign task", exact: true }).click();
    const assign = page.getByRole("dialog", { name: "Assign to agent", exact: true });
    await assign.waitFor();
    await assign.getByRole("button", { name: "About Thinking", exact: true }).click();
    await page.getByRole("tooltip").waitFor();
    assert.match(await page.getByRole("tooltip").innerText(), /Low: faster/);
    await page.keyboard.press("Escape");
    assert.equal(await assign.isVisible(), true, "help Escape keeps assignment open");
    assert.equal(await assign.locator("[data-testid=assign-mode-help]").count(), 0);
    await shot(page, `assign-${width}`);
    await page.keyboard.press("Escape");

    await page.goto(`${WEB}/tasks/${fixture.taskId}`);
    await page.getByRole("button", { name: "More task actions" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Pin to Today", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Add description", exact: true }).count(), 0);
    await fits(page);
    await shot(page, `task-${width}`);
    await page.getByRole("button", { name: "More task actions" }).click();
    const pinned = await page.getByRole("button", { name: "Unpin from Today", exact: true }).count();
    if (!pinned) {
      await Promise.all([
        page.waitForResponse(response => response.url().includes(`/api/tasks/${fixture.taskId}`) && response.request().method() === "PATCH" && response.ok()),
        page.getByRole("button", { name: "Pin to Today", exact: true }).click(),
      ]);
    } else await page.keyboard.press("Escape");
    await page.goto(`${WEB}/today`);
    await page.locator("[data-today-pins]").getByRole("link", { name: /Plan and implement/ }).waitFor();
    await fits(page);

    await page.goto(`${WEB}/context?tab=projects`);
    await page.getByRole("button", { name: /^Mobile project 0 / }).click();
    await page.locator(".task-peek [data-project-page]").waitFor();
    assert.equal(await page.locator(".task-peek input[aria-label='Project name']").count(), 0);
    await page.locator(".task-peek").getByRole("textbox", { name: "Project name" }).waitFor();
    await page.locator(".task-peek").getByRole("heading", { name: "Deliverables" }).waitFor();
    await shot(page, `project-${width}`);
    await page.getByRole("button", { name: "Open as full page", exact: true }).click();
    await page.waitForURL(/\/projects\//);
    await page.locator("[data-project-page]").waitFor();
    await page.getByRole("button", { name: "Mobile release", exact: true }).waitFor();
    const summary = page.getByRole("button", { name: "Edit short description", exact: true }).first();
    await summary.click();
    const writing = page.getByRole("textbox", { name: "Short description", exact: true });
    await writing.fill(`A concise project summary at ${width}px.`);
    await Promise.all([
      page.waitForResponse(response => response.url().includes(`/api/projects/${fixture.projectId}`) && response.request().method() === "PATCH" && response.ok()),
      writing.blur(),
    ]);
    await page.reload();
    await page.getByText(`A concise project summary at ${width}px.`, { exact: true }).waitFor();
    await fits(page);

    await page.goto(`${WEB}/needs-me`);
    await page.locator(".decision-option").first().waitFor();
    assert.equal(await page.locator(".review-overview, .work-view-tabs").count(), 0);
    assert.equal(await page.getByText("Outgoing approvals", { exact: true }).count(), 0);
    await fits(page);
    await shot(page, `needs-me-${width}`);
    await page.goto(`${WEB}/skills`);
    await page.locator("textarea").waitFor();
    assert.equal(await page.getByText("Test this skill", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Improve skills from my work", { exact: true }).count(), 0);
    await fits(page);

    await page.goto(`${WEB}/pages`);
    const create = page.getByRole("button", { name: "New page", exact: true }).first();
    await create.click();
    await page.waitForURL(/\/pages\/[^/?]+/);
    await page.getByRole("textbox", { name: "Page title", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "New page", exact: true }).count(), 0);

    await page.goto(`${WEB}/settings?tab=data#danger`);
    await page.getByRole("button", { name: "Delete account…", exact: true }).waitFor();
    await page.getByRole("button", { name: "Delete account…", exact: true }).click();
    const deletion = page.getByRole("dialog", { name: "Delete your account?", exact: true });
    await deletion.waitFor();
    assert.equal(await deletion.getByRole("button", { name: "Permanently delete account", exact: true }).isDisabled(), true);
    await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.goto(`${WEB}/settings?tab=account`);
    await page.locator("[data-setting-label=Account]").waitFor();
    assert.equal(await page.getByRole("button", { name: "Delete account…", exact: true }).count(), 0);
    await fits(page);
    await shot(page, `settings-${width}`);
    console.log(`Clean surfaces ${width}px passed`);
    await context.close();
  }
  assert.deepEqual(errors, [], "no browser errors");
} finally { await browser.close(); }
