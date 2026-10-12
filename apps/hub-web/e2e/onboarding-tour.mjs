/** Run against an isolated local API and a production Hub build: HUB_API=… HUB_WEB=… node apps/hub-web/e2e/onboarding-tour.mjs. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4107";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3107";
for (const url of [API, WEB]) assert.ok(["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Use isolated local services; this check creates fictional accounts.");
const chrome = process.env.CHROME_PATH ?? (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const shots = process.env.TOUR_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: chrome, headless: true });

async function account(role, theme, reduce) {
  const response = await fetch(`${API}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Mira Chen", email: `tour-${role}-${Date.now()}@fieldnote.example`, password: "tour-check-123456" }) });
  assert.equal(response.status, 200, await response.clone().text());
  const session = /ensemble_session=([^;]+)/.exec(response.headers.get("set-cookie"))?.[1];
  assert.ok(session);
  const request = async (path, method = "GET", body) => {
    const result = await fetch(`${API}${path}`, { method, headers: { cookie: `ensemble_session=${session}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(result.ok, `${path}: ${result.status} ${await result.clone().text()}`);
    return result.json();
  };
  const appearance = { theme, motion: "expressive", reduceMotion: reduce, accent: "indigo", accentCustom: null, font: "system", textScale: 100 };
  await request("/api/settings", "PATCH", { appearance });
  return { session, request, appearance };
}

async function bounds(page) {
  const result = await page.locator(".tour-card").evaluate((card) => {
    const rect = card.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight, scroll: document.documentElement.scrollWidth };
  });
  assert.ok(result.left >= 0 && result.top >= 0 && result.right <= result.width + 1 && result.bottom <= result.height + 1, JSON.stringify(result));
  assert.ok(result.scroll <= result.width, "no horizontal page overflow");
}

try {
  for (const scenario of [
    { role: "engineer", theme: "dark", viewport: { width: 1440, height: 900 }, reduce: false, stop: "code" },
    { role: "student", theme: "light", viewport: { width: 390, height: 844 }, reduce: true, stop: "files" },
    { role: "manager", theme: "light", viewport: { width: 844, height: 390 }, reduce: true, stop: "meetings" },
  ]) {
    const fixture = await account(scenario.role, scenario.theme, scenario.reduce);
    const context = await browser.newContext({ viewport: scenario.viewport, reducedMotion: scenario.reduce ? "reduce" : "no-preference" });
    await context.addCookies([{ name: "ensemble_session", value: fixture.session, url: WEB }]);
    await context.addInitScript((appearance) => localStorage.setItem("ensemble.appearance", JSON.stringify(appearance)), fixture.appearance);
    const page = await context.newPage();
    const crashes = [];
    page.on("pageerror", (error) => crashes.push(error.message));
    await page.goto(`${WEB}/start`, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-role="${scenario.role}"]`).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.locator("[data-start-template]").click();
    await page.locator('[data-onboarding-tour="welcome"]').waitFor({ timeout: 30000 });
    assert.equal(await page.locator("html").getAttribute("data-theme"), scenario.theme);
    assert.match(await page.locator("#tour-title").innerText(), /Mira/);
    if (shots) await page.screenshot({ path: `${shots}/${scenario.role}-welcome.png` });
    const before = await fixture.request("/api/tasks");
    const visited = [];
    let resumed = false;
    while (true) {
      const step = await page.locator("[data-onboarding-tour]").getAttribute("data-onboarding-tour");
      visited.push(step);
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await Promise.all(document.querySelector(".guided-tour").getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
      });
      await bounds(page);
      if (scenario.reduce) assert.equal(await page.locator(".tour-cursor").count(), 0);
      if (shots && ["today", "board", scenario.stop, "assistant"].includes(step)) await page.screenshot({ path: `${shots}/${scenario.role}-${step}.png` });
      if (step === "board" && !resumed) {
        await page.waitForFunction(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((key) => key.startsWith("ensemble.tour:"))))?.step === "board");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.locator('[data-onboarding-tour="board"]').waitFor();
        resumed = true;
      }
      if (step === "finish") break;
      await page.locator("[data-tour-next]").click();
      await page.waitForFunction((previous) => document.querySelector("[data-onboarding-tour]")?.dataset.onboardingTour !== previous, step);
    }
    assert.ok(visited.includes(scenario.stop), `${scenario.role} gets ${scenario.stop}`);
    await page.locator("[data-tour-next]").click();
    await page.locator("[data-onboarding-tour]").waitFor({ state: "detached" });
    const after = await fixture.request("/api/tasks");
    assert.equal(after.tasks.length, before.tasks.length, "tour does not create tasks");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-account-avatar]").waitFor();
    assert.equal(await page.locator("[data-onboarding-tour]").count(), 0, "completed guide stays dismissed");
    await page.locator("[data-account-avatar]").click();
    await page.getByRole("menuitem", { name: "Take a tour" }).click();
    await page.locator('[data-onboarding-tour="welcome"]').waitFor();
    await page.keyboard.press("Escape");
    await page.locator("[data-onboarding-tour]").waitFor({ state: "detached" });
    assert.deepEqual(crashes, []);
    console.log(`${scenario.role}: setup, ${visited.length} steps, ${scenario.stop}, resume, completion, replay and Escape passed (${scenario.theme}, ${scenario.viewport.width}×${scenario.viewport.height})`);
    await context.close();
  }
} finally { await browser.close(); }
