/** Run against scripts/assistant-ui-fixture.ts and an isolated local Hub. */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { chromium } from "playwright-core";
const WEB = process.env.HUB_WEB ?? "http://localhost:3091";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(WEB).hostname), "Use the isolated local fixture.");
const fixture = JSON.parse(readFileSync(process.env.ENSEMBLE_UI_FIXTURE ?? "/tmp/ensemble-assistant-ui.json", "utf8"));
const chrome = process.env.CHROME_PATH ?? (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
 const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
 await context.addCookies([{ name: "ensemble_session", value: fixture.cookie.split("=").slice(1).join("="), url: WEB }]);
 await context.addInitScript(id => { localStorage.setItem("ensemble.assistant.open", "true"); localStorage.setItem("ensemble.assistant.conversation", JSON.stringify(id)); }, fixture.conversationId);
 const page = await context.newPage(); const errors = []; page.on("pageerror", error => errors.push(error.message));
 page.setDefaultTimeout(45000);
 await page.goto(WEB + "/board", { waitUntil: "domcontentloaded", timeout: 120000 });
 await page.locator(".assistant-tool").filter({ hasText: "Change board tiles" }).getByRole("button", { name: "Apply", exact: true }).click();
 await page.locator(".board-insight-row").getByText("Waiting for a next step", { exact: true }).waitFor();
 console.log("PASS: assistant Apply changes the actual Board overview.");
 await page.locator(".assistant-tool").filter({ hasText: "Change a setting" }).getByRole("button", { name: "Apply", exact: true }).click();
 await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
 console.log("PASS: approved appearance change reaches the browser.");
 await page.goto(WEB + "/today", { waitUntil: "domcontentloaded", timeout: 120000 });
 await page.locator(".assistant-tool").filter({ hasText: "Change today tiles" }).getByRole("button", { name: "Apply", exact: true }).click();
 await page.locator('[data-desk-key="calendar"]').waitFor();
 console.log("PASS: assistant Apply adds a tile to the actual profile desk.");
 await page.goto(WEB + "/pages/" + fixture.pageId, { waitUntil: "domcontentloaded", timeout: 120000 });
 await page.locator(".assistant-tool").filter({ hasText: "Edit 1 document block" }).getByRole("button", { name: "Apply", exact: true }).click();
 await page.locator('[contenteditable="true"]').filter({ hasText: "October 22" }).first().waitFor();
 assert.ok(await page.locator('[contenteditable="true"]').filter({ hasText: "Keep this paragraph intact." }).count());
 console.log("PASS: precise edit updates the open document while preserving its other paragraph.");
 assert.deepEqual(errors, []); console.log("PASS: no browser runtime errors.");
 await page.screenshot({ path: "/tmp/ensemble-assistant-ui.png", fullPage: false });
} finally { await browser.close(); }
