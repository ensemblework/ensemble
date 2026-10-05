/**
 * Marketplace apply, reload, blocked /code, Default, and revert.
 * Run: node apps/hub-web/e2e/marketplace.mjs
 */
import assert from "node:assert/strict";
import { markTester } from "./sql-change.mjs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const SHOTS = "/opt/cursor/artifacts/marketplace-r2";
const stamp = Date.now().toString(36);
const TEMPLATES = [
  "mkt.semester-desk",
  "mkt.exam-season",
  "mkt.literature-desk",
  "mkt.chambers",
  "mkt.bench",
  "mkt.staff-week",
  "mkt.branch-desk",
  "mkt.classes",
];

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function authed(session, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      cookie: `ensemble_session=${session}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) };
}

async function signup() {
  const response = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `mkt-${stamp}@ensemble.test`, password: "widget-pass-1", name: "Marketplace" }),
  });
  if (!response.ok) throw new Error(`signup ${response.status}: ${await response.text()}`);
  return cookieHeader(typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : response.headers.get("set-cookie"));
}

async function cls(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        let score = 0;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) if (!entry.hadRecentInput) score += entry.value;
        });
        observer.observe({ type: "layout-shift", buffered: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(score);
        }, 600);
      }),
  );
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const session = await signup();
  markTester(process.env.DATABASE_URL ?? "postgresql://ensemble:ensemble@127.0.0.1:5432/ensemble", `mkt-${stamp}@ensemble.test`);
  const onboard = await authed(session, "/api/onboarding", {
    method: "POST",
    body: JSON.stringify({ role: "student", templateId: "semester-desk" }),
  });
  assert.equal(onboard.status, 200, onboard.text);
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);

  await page.goto(`${WEB}/today`, { waitUntil: "networkidle" });
  assert.equal(await page.locator("aside").getByText("Marketplace", { exact: true }).count(), 0);
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/jump|search|type/i).first().waitFor({ timeout: 5000 }).catch(() => undefined);
  const palette = await page.locator("body").innerText();
  assert.equal(palette.includes("Marketplace"), false);
  await page.keyboard.press("Escape");

  await page.goto(`${WEB}/marketplace`, { waitUntil: "networkidle" });
  await page.locator("[data-market-card]").first().waitFor();
  assert.equal(await page.locator("[data-market-card]").count(), 8);
  const galleryShift = await cls(page);
  assert.ok(galleryShift < 0.05, `gallery CLS ${galleryShift}`);
  await page.screenshot({ path: `${SHOTS}/index-1440.png` });
  await page.getByRole("button", { name: "Removes Code" }).click();
  const filtered = await page.locator("[data-market-card]").count();
  assert.equal(filtered, 7);
  await page.getByLabel("Search templates").fill("chambers");
  await page.locator('[data-market-card="mkt.chambers"]').waitFor();
  await page.screenshot({ path: `${SHOTS}/index-search.png` });

  await page.goto(`${WEB}/marketplace/mkt.exam-season`, { waitUntil: "networkidle" });
  const diff = page.getByRole("region", { name: "What will change" });
  await diff.waitFor();
  const order = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("a, button, [tabindex='0']")];
    return nodes.map((node) => (node.getAttribute("aria-label") || node.textContent || "").trim().slice(0, 40));
  });
  const diffAt = order.findIndex((line) => line.includes("What will change") || line.includes("will not open"));
  const applyAt = order.findIndex((line) => line.startsWith("Apply"));
  assert.ok(diffAt >= 0 && applyAt > diffAt, order.join(" | "));
  await page.screenshot({ path: `${SHOTS}/detail-diff-1440.png` });
  await page.getByLabel("Preview").waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${SHOTS}/preview-1440.png` });
  await page.getByRole("button", { name: /Apply Exam season/ }).click();
  await page.waitForURL(/\/today/);
  await page.getByText(/You're on/).waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${SHOTS}/apply-toast.png` });
  await page.locator("[data-desk=exam]").waitFor();
  await page.screenshot({ path: `${SHOTS}/today-mkt.exam-sprint.png` });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-desk=exam]").waitFor();
  const todayShift = await cls(page);
  // The desk bento settles as the live tiles replace the skeleton. A full jump is still a failure.
  assert.ok(todayShift < 0.08, `today CLS ${todayShift}`);

  await page.goto(`${WEB}/code`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Enable Code" }).waitFor();
  await page.locator("[data-feature-landing=code]").waitFor();
  await page.screenshot({ path: `${SHOTS}/code-unavailable.png` });
  const reviews = await authed(session, "/api/code/reviews");
  assert.equal(reviews.status, 404);
  assert.match(reviews.text, /Not part of this template/);
  await page.goto(`${WEB}/code/review`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Enable Code" }).waitFor();

  await page.goto(`${WEB}/settings`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Use Default" }).click();
  await page.waitForTimeout(500);
  await page.goto(`${WEB}/code`, { waitUntil: "networkidle" });
  assert.equal(await page.getByRole("button", { name: "Enable Code" }).count(), 0);
  await page.screenshot({ path: `${SHOTS}/code-after-default.png` });

  const again = await authed(session, "/api/marketplace/apply", { method: "POST", body: JSON.stringify({ id: "mkt.exam-season" }) });
  assert.equal(again.status, 200, again.text);
  const reverted = await authed(session, "/api/marketplace/revert", { method: "POST", body: "{}" });
  assert.equal(reverted.status, 200, reverted.text);
  await page.goto(`${WEB}/today`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });

  for (const id of TEMPLATES) {
    const applied = await authed(session, "/api/marketplace/apply", { method: "POST", body: JSON.stringify({ id }) });
    assert.equal(applied.status, 200, `${id} ${applied.text}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB}/today`, { waitUntil: "networkidle" });
    await page.locator("[data-desk]").first().waitFor();
    await page.screenshot({ path: `${SHOTS}/today-${id}.png`, fullPage: false });
    await page.goto(`${WEB}/context`, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${SHOTS}/context-${id}.png`, fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${WEB}/today`, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${SHOTS}/today-${id}-390.png`, fullPage: false });
    await page.goto(`${WEB}/context`, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${SHOTS}/context-${id}-390.png`, fullPage: false });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${WEB}/settings`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Use Default" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/settings-history.png` });
  await page.goto(`${WEB}/today`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => /@ensemble\.test/.test(document.body.innerText));
  await page.getByRole("button", { name: "Add a tile" }).click();
  await page.getByRole("dialog", { name: "Add a tile" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/widget-gallery.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${WEB}/marketplace`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/index-390.png` });
  await page.goto(`${WEB}/marketplace/mkt.chambers`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/detail-390.png` });
  await page.goto(`${WEB}/today`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/today-390.png` });

  await browser.close();
  console.log("marketplace e2e ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
