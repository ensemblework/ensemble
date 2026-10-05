/**
 * Click-to-usable for the Diagrams tab and opening one diagram.
 * WEB=http://127.0.0.1:3000 API=http://127.0.0.1:4000 node /tmp/measure-diagrams.mjs
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const WEB = process.env.WEB ?? "http://127.0.0.1:3000";
const API = process.env.API ?? "http://127.0.0.1:4000";
const OUT = process.env.OUT ?? "/tmp/diagrams-before.json";
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error("no session");
  return pair[1];
}

async function signup() {
  const email = `diag-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "nav-pass-1", name: "Diag Bench" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status} ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  const onboard = await fetch(`${API}/api/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
  });
  if (!onboard.ok) throw new Error(`onboard ${onboard.status}`);
  const created = await fetch(`${API}/api/diagrams`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ title: "Checkout" }),
  });
  if (!created.ok) throw new Error(`diagram ${created.status} ${await created.text()}`);
  const body = await created.json();
  return { session, id: body.diagram.id };
}

const { session, id } = await signup();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
const page = await context.newPage();

await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
await page.locator("aside a[href='/diagrams']").waitFor();
await page.waitForTimeout(400);

const listStart = Date.now();
const beforeList = await page.evaluate(() => performance.getEntriesByType("resource").length);
await page.locator("aside a[href='/diagrams']").click();
await page.waitForURL((url) => url.pathname === "/diagrams");
const listUrl = Date.now() - listStart;
await page.getByRole("heading", { name: "Block diagrams", exact: true }).waitFor();
await page.locator("main").waitFor();
const listReady = Date.now() - listStart;
const listJs = await page.evaluate((count) => {
  const rows = performance.getEntriesByType("resource").slice(count);
  const scripts = rows.filter((row) => row.initiatorType === "script" || /\.js(\?|$)/.test(row.name));
  return { jsBytes: scripts.reduce((sum, row) => sum + (row.transferSize || row.encodedBodySize || 0), 0), jsCount: scripts.length };
}, beforeList);

const link = page.locator(`a[href="/diagrams/${id}"]`);
await link.waitFor();
const openStart = Date.now();
const beforeOpen = await page.evaluate(() => performance.getEntriesByType("resource").length);
await link.click();
await page.waitForURL((url) => url.pathname === `/diagrams/${id}`);
const openUrl = Date.now() - openStart;
await page.locator(".react-flow").first().waitFor({ timeout: 30000 });
const openReady = Date.now() - openStart;
const openJs = await page.evaluate((count) => {
  const rows = performance.getEntriesByType("resource").slice(count);
  const scripts = rows.filter((row) => row.initiatorType === "script" || /\.js(\?|$)/.test(row.name));
  return { jsBytes: scripts.reduce((sum, row) => sum + (row.transferSize || row.encodedBodySize || 0), 0), jsCount: scripts.length };
}, beforeOpen);

const payload = {
  at: new Date().toISOString(),
  web: WEB,
  list: { urlMs: Math.round(listUrl), ms: Math.round(listReady), ...listJs },
  open: { urlMs: Math.round(openUrl), ms: Math.round(openReady), ...openJs, id },
};
writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
await browser.close();
