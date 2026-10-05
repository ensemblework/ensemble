/**
 * Motion suites switch live, reduced motion stops loops, and a fast cached
 * page does not flash a loader. The slow path must wait out the show delay
 * and the minimum hold.
 *
 * Run: node apps/hub-web/e2e/motion.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const SHOW_DELAY = 180;
const MIN_VISIBLE = 300;

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function signup(name) {
  const email = `motion-${name}-${Date.now().toString(36)}@ensemble.test`;
  const response = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "motion-pass-1", name: "Motion" }),
  });
  if (!response.ok) throw new Error(`signup ${response.status} ${await response.text()}`);
  const session = cookieHeader(typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : response.headers.get("set-cookie"));
  const onboard = await fetch(`${API}/api/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
  });
  if (!onboard.ok) throw new Error(`onboard ${onboard.status} ${await onboard.text()}`);
  return session;
}

async function openHub(browser, session, reduced) {
  const context = await browser.newContext(reduced ? { reducedMotion: "reduce" } : undefined);
  await context.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  await context.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const page = await context.newPage();
  return { context, page };
}

async function theme(page) {
  return page.evaluate(() => document.documentElement.dataset.motionTheme);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const session = await signup("live");
  const { context, page } = await openHub(browser, session, false);
  await page.goto(`${WEB}/settings#appearance`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  await page.getByRole("radio", { name: /Expressive/ }).waitFor();
  assert.equal(await theme(page), "expressive");

  await page.getByRole("radio", { name: /Minimal · Quiet/ }).click();
  assert.equal(await theme(page), "minimal-quiet");
  await page.getByRole("radio", { name: /Minimal · Dot/ }).click();
  assert.equal(await theme(page), "minimal-dot");
  await page.getByRole("radio", { name: /Expressive/ }).click();
  assert.equal(await theme(page), "expressive");
  assert.equal(new URL(page.url()).pathname, "/settings");

  const morph = page.locator("[data-motion-slot='agent.thinking'] .u-morph").first();
  await morph.waitFor({ state: "attached", timeout: 3000 });
  await page.waitForFunction(() => {
    const el = document.querySelector("[data-motion-slot='agent.thinking'] .u-morph");
    const path = el?.querySelector(".u-mo")?.getAttribute("d") ?? "";
    return el?.hasAttribute("data-running") && path.includes("L");
  });

  await page.getByRole("switch", { name: "Reduce motion" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.reduceMotion === "true");
  await page.waitForFunction(() => {
    const el = document.querySelector("[data-motion-slot='agent.thinking'] .u-morph");
    const path = el?.querySelector(".u-mo")?.getAttribute("d") ?? "";
    return el && !el.hasAttribute("data-running") && path.includes("A");
  });
  await context.close();

  const reducedSession = await signup("os");
  const reduced = await openHub(browser, reducedSession, true);
  await reduced.page.goto(`${WEB}/settings#appearance`, { waitUntil: "domcontentloaded" });
  await reduced.page.getByRole("heading", { name: "Settings" }).waitFor();
  await reduced.page.waitForFunction(() => document.documentElement.dataset.reduceMotion === "true");
  assert.equal(await theme(reduced.page), "minimal-dot");
  await reduced.page.getByText("this device asked for it").waitFor();
  await reduced.context.close();

  const cached = await signup("cache");
  const fast = await openHub(browser, cached, false);
  await fast.page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
  await fast.page.getByRole("heading", { name: "Today" }).waitFor();
  await fast.page.goto(`${WEB}/metrics`, { waitUntil: "domcontentloaded" });
  await fast.page.getByRole("heading", { name: "Metrics" }).waitFor();
  await fast.page.waitForFunction(() => !document.querySelector("[data-motion-loading='1']"), { timeout: 8000 });
  const metricsCls = await fast.page.evaluate(() => window.__cls);
  const metricsBeforeSlow = metricsCls;
  await fast.page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
  await fast.page.getByRole("heading", { name: "Today" }).waitFor();
  assert.equal(await fast.page.locator("[data-motion-slot='moment.celebrate']").count(), 0, "celebrate fired on an already-settled page");
  const flashed = await fast.page.locator("[data-motion-loading='1']").count();
  assert.equal(flashed, 0, "cached Today flashed a loader");
  const todayCls = await fast.page.evaluate(() => window.__cls);
  console.log(`cls metrics=${metricsCls.toFixed(3)} today=${todayCls.toFixed(3)}`);
  assert.ok(todayCls < 0.25, `Today CLS ${todayCls}`);
  assert.ok(metricsCls < 0.25, `Metrics CLS ${metricsCls}`);

  let requestAt = 0;
  let responseAt = 0;
  await fast.page.route("**/api/metrics/summary", async (route) => {
    requestAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 320));
    responseAt = Date.now();
    await route.continue();
  });
  const samples = [];
  let stop = false;
  const polling = (async () => {
    while (!stop) {
      const count = await fast.page.locator("[data-motion-slot='content.skeleton'][data-motion-loading='1']").count().catch(() => 0);
      samples.push({ t: Date.now(), count });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  await fast.page.goto(`${WEB}/metrics`, { waitUntil: "domcontentloaded" });
  await fast.page.getByRole("heading", { name: "Metrics" }).waitFor();
  await fast.page.waitForFunction(() => !document.querySelector("[data-motion-slot='content.skeleton']"), { timeout: 15000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop = true;
  await polling;
  const visible = samples.filter((row) => row.count > 0);
  const first = visible[0];
  const last = visible[visible.length - 1];
  console.log(`delay samples=${samples.length} visible=${visible.length} request=${requestAt} response=${responseAt}`);
  assert.ok(requestAt > 0 && first, "slow metrics load never showed a loader");
  assert.ok(first.t - requestAt >= SHOW_DELAY - 60, `loader appeared too soon (${first.t - requestAt}ms after the request)`);
  const visibleFor = last.t - first.t;
  assert.ok(visibleFor >= MIN_VISIBLE - 80, `loader did not hold (${visibleFor}ms)`);
  const metricsShift = (await fast.page.evaluate(() => window.__cls)) - metricsBeforeSlow;
  console.log(`cls metrics-swap=${metricsShift.toFixed(3)}`);
  assert.ok(metricsShift < 0.1, `Metrics skeleton shift ${metricsShift}`);
  await fast.context.close();

  const coldSession = await signup("cls");
  const cold = await openHub(browser, coldSession, false);
  await cold.page.route("**/api/desk/live**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await cold.page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
  await cold.page.getByRole("heading", { name: "Today" }).waitFor();
  await cold.page.waitForFunction(() => !document.querySelector(".bento .sk"), { timeout: 15000 });
  const todayShift = await cold.page.evaluate(() => window.__cls);
  console.log(`cls today-swap=${todayShift.toFixed(3)}`);
  assert.ok(todayShift < 0.1, `Today skeleton shift ${todayShift}`);
  await cold.context.close();
  console.log("motion checks passed");
} finally {
  await browser.close();
}
