/**
 * Sidebar navigation timings on a production build.
 * WEB=http://127.0.0.1:3000 API=http://127.0.0.1:4000 node /tmp/measure-nav.mjs
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const WEB = process.env.WEB ?? "http://127.0.0.1:3000";
const API = process.env.API ?? "http://127.0.0.1:4000";
const OUT = process.env.OUT ?? "/tmp/nav-before.json";
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";

const PAGES = [
  ["Today", "Today", "/today"],
  ["Context", "Context", "/context"],
  ["Settings", "Settings", "/settings"],
  ["Metrics", "Metrics", "/metrics"],
  ["Code", "Code", "/code"],
  ["Workspace", "Workspace", "/workspace"],
  ["Runs", "Recent runs", "/runs"],
  ["Skills", "Skill library", "/skills"],
  ["Needs me", "Needs me", "/needs-me"],
  ["Meeting notes", "Meeting notes", "/meetings"],
  ["Weekly recap", "Weekly recap", "/recap"],
  ["Block diagrams", "Block diagrams", "/diagrams"],
];

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error("no session");
  return pair[1];
}

async function signup() {
  const email = `nav-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "nav-pass-1", name: "Nav Bench" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status} ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  const onboard = await fetch(`${API}/api/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
  });
  if (!onboard.ok) throw new Error(`onboard ${onboard.status} ${await onboard.text()}`);
  return session;
}

async function measure(page, label, heading, href) {
  const link = page.locator(`aside a[href="${href}"]`);
  await link.waitFor();
  const before = await page.evaluate(() => performance.getEntriesByType("resource").length);
  const started = await page.evaluate(() => performance.now());
  const requests = [];
  const onRequest = (request) => {
    requests.push({ url: request.url(), method: request.method(), type: request.resourceType() });
  };
  const failed = [];
  const onFailed = (request) => {
    failed.push({ url: request.url(), error: request.failure()?.errorText ?? "" });
  };
  page.on("request", onRequest);
  page.on("requestfailed", onFailed);
  await link.click();
  await page.waitForURL((url) => url.pathname === href, { timeout: 8000 });
  const urlAt = await page.evaluate((start) => performance.now() - start, started);
  await page.getByRole("heading", { name: heading, exact: true }).first().waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector("main .skeleton"), { timeout: 20000 }).catch(() => {});
  const ready = await page.evaluate((start) => performance.now() - start, started);
  await page.waitForTimeout(400);
  const resources = await page.evaluate((count) => {
    const rows = performance.getEntriesByType("resource").slice(count);
    const scripts = rows.filter((row) => row.initiatorType === "script" || /\.js(\?|$)/.test(row.name));
    const api = rows.filter((row) => row.name.includes("/api/"));
    return {
      jsBytes: scripts.reduce((sum, row) => sum + (row.transferSize || row.encodedBodySize || 0), 0),
      jsCount: scripts.length,
      apiCount: api.length,
      apiMs: api.map((row) => ({ name: row.name.replace(location.origin, ""), ms: Math.round(row.duration) })),
    };
  }, before);
  page.off("request", onRequest);
  page.off("requestfailed", onFailed);
  const apiReqs = requests.filter((row) => row.url.includes("/api/"));
  const cancelled = failed.filter((row) => /cancel|abort|ERR_ABORTED/i.test(row.error));
  return {
    label,
    url: page.url(),
    urlMs: Math.round(urlAt),
    ms: Math.round(ready),
    requests: apiReqs.length,
    cancelled: cancelled.length,
    cancelledSample: cancelled.slice(0, 6),
    jsBytes: resources.jsBytes,
    jsCount: resources.jsCount,
    api: resources.apiMs.slice(0, 20),
  };
}

const session = await signup();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
const page = await context.newPage();
const client = await context.newCDPSession(page);
await client.send("Network.enable");
await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
await page.locator("aside").waitFor();
await page.waitForTimeout(800);

const metricsClicks = await page.evaluate(async () => {
  const link = [...document.querySelectorAll("aside a")].find((node) => node.textContent?.includes("Metrics"));
  if (!link) return { error: "no metrics link" };
  link.click();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return { url: location.pathname, heading: document.querySelector("h1")?.textContent ?? "" };
});

await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
await page.locator("aside").waitFor();
await page.waitForTimeout(500);

const rows = [];
for (const [label, heading, href] of PAGES) {
  if (label === "Today") {
    const start = Date.now();
    await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Today" }).first().waitFor();
    await page.waitForFunction(() => !document.querySelector("main .skeleton")).catch(() => {});
    rows.push({ label, url: page.url(), ms: Date.now() - start, requests: null, cancelled: null, jsBytes: null, note: "document load" });
    continue;
  }
  if (!page.url().includes("/today")) {
    await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
    await page.locator("aside").waitFor();
  }
  rows.push(await measure(page, label, heading, href));
  await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
  await page.locator("aside a[href='/today']").first().waitFor();
  await page.waitForTimeout(250);
}

const payload = { at: new Date().toISOString(), metricsOneClick: metricsClicks, rows };
writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
await browser.close();
if (process.env.ASSERT === "1") {
  const slow = rows.filter((row) => typeof row.ms === "number" && row.ms >= 1000);
  const click = metricsClicks.url === "/metrics" && /Metrics/.test(metricsClicks.heading ?? "");
  if (slow.length || !click) {
    console.error(JSON.stringify({ slow, metricsOneClick: metricsClicks }));
    process.exit(1);
  }
}
