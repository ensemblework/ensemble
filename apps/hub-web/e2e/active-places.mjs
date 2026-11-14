/** Uses the isolated mobile-ui-fixture.ts API and a local Hub, never a hosted account. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const WEB = process.env.HUB_WEB ?? "http://localhost:3220";
const API = process.env.NEXT_PUBLIC_HUB_API ?? "http://127.0.0.1:4220";
for (const origin of [WEB, API]) assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const fixture = JSON.parse(readFileSync(process.env.MOBILE_FIXTURE_PATH, "utf8"));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true });
const cookie = { name: fixture.cookie.split("=")[0], value: fixture.cookie.split("=")[1] };
const contexts = [];
const errors = [];
const openWindow = async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  context.setDefaultTimeout(120_000);
  await context.route("**/*", route => {
    const headers = route.request().headers();
    if (headers["next-router-prefetch"] || headers.purpose === "prefetch") return route.fulfill({ status: 204 });
    return route.continue();
  });
  contexts.push(context);
  await context.addCookies([{ ...cookie, url: WEB }, { ...cookie, url: API }]);
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${WEB}/settings?tab=data`, { timeout: 120_000, waitUntil: "domcontentloaded" });
  await page.getByRole("spinbutton", { name: "Undo depth", exact: true }).waitFor({ timeout: 120_000 });
  return { context, page };
};
const holdSave = async page => {
  let release;
  let saw;
  const held = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { saw = resolve; });
  let used = false;
  await page.route("**/api/settings", async route => {
    if (route.request().method() !== "PATCH" || used) return route.continue();
    used = true;
    saw();
    await held;
    await route.continue();
  });
  return { release, seen };
};
const saveValue = async (page, name, value) => {
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/settings" && response.request().method() === "PATCH" && response.ok());
  await page.getByRole("spinbutton", { name, exact: true }).fill(String(value));
  await saved;
};

try {
  const first = await openWindow();
  const second = await openWindow();
  const held = await holdSave(second.page);
  await second.page.getByRole("spinbutton", { name: "Undo depth", exact: true }).fill("8");
  await held.seen;
  await saveValue(first.page, "Undo depth", 7);
  held.release();
  const dialog = second.page.getByRole("dialog", { name: "Choose which version to save", exact: true });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Saved in the other place[\s\S]*7[\s\S]*Your changes[\s\S]*8/);
  await dialog.getByRole("button", { name: "Save my version", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await first.page.reload();
  const depth = first.page.getByRole("spinbutton", { name: "Undo depth", exact: true });
  await depth.waitFor();
  assert.equal(await depth.inputValue(), "8", "the other window loads the chosen value");
  await second.page.unroute("**/api/settings");

  const disjoint = await holdSave(second.page);
  await second.page.getByRole("spinbutton", { name: "Context review days", exact: true }).fill("20");
  await disjoint.seen;
  await saveValue(first.page, "Undo depth", 9);
  const merged = second.page.waitForResponse(response => new URL(response.url()).pathname === "/api/settings" && response.request().method() === "PATCH" && response.ok());
  disjoint.release();
  await merged;
  assert.equal(await second.page.getByRole("dialog", { name: "Choose which version to save", exact: true }).count(), 0);
  await first.page.reload();
  await depth.waitFor();
  assert.equal(await depth.inputValue(), "9");
  assert.equal(await first.page.getByRole("spinbutton", { name: "Context review days", exact: true }).inputValue(), "20");

  const third = await first.context.newPage();
  await third.goto(`${WEB}/settings?tab=data`, { waitUntil: "domcontentloaded" });
  await third.getByRole("spinbutton", { name: "Undo depth", exact: true }).waitFor();
  const fourth = await first.context.newPage();
  await fourth.goto(`${WEB}/settings?tab=data`, { waitUntil: "domcontentloaded" });
  await fourth.getByRole("heading", { name: "Choose where to continue" }).waitFor();
  assert.equal(await fourth.locator("#main-content").count(), 0, "the fourth tab cannot enter the app");
  assert.equal(await fourth.locator("section[aria-label='Open places'] li").count(), 3);
  await fourth.getByRole("button", { name: "Continue here", exact: true }).click();
  await fourth.getByRole("spinbutton", { name: "Undo depth", exact: true }).waitFor();
  await third.close();
  const fifth = await first.context.newPage();
  await fifth.goto(`${WEB}/settings?tab=data`, { waitUntil: "domcontentloaded" });
  await fifth.getByRole("spinbutton", { name: "Undo depth", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Two-window conflicts, disjoint saves, fourth-tab chooser, replacement and closed-slot reuse passed.");
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
