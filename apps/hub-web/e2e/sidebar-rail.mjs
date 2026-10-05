/**
 * Collapse becomes an icon rail without unmounting the links, and it stays after reload.
 * Run: node apps/hub-web/e2e/sidebar-rail.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error("no session");
  return pair[1];
}

const email = `rail-${Date.now().toString(36)}@ensemble.test`;
const signup = await fetch(`${API}/api/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "rail-pass-1", name: "Rail" }),
});
if (!signup.ok) throw new Error(await signup.text());
const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
const onboard = await fetch(`${API}/api/onboarding`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
  body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
});
if (!onboard.ok) throw new Error(await onboard.text());

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
  const today = page.locator("aside a.nav-link[href='/today']");
  await today.waitFor();
  const before = await today.boundingBox();
  assert.ok(before && before.width > 100, "expanded link should show its label");
  const started = Date.now();
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.waitForFunction(() => {
    const aside = document.querySelector("aside.app-sidebar");
    return document.documentElement.dataset.sidebar === "rail" && !!aside && aside.getBoundingClientRect().width < 80;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `collapse took ${elapsed}ms`);
  const icon = today.locator("svg");
  await icon.waitFor();
  assert.equal(await icon.isVisible(), true);
  const after = await today.boundingBox();
  assert.ok(after && after.width < 80, `rail link width ${after?.width}`);
  assert.equal(await today.getAttribute("title"), "Today");
  await page.getByRole("button", { name: "Expand sidebar" }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.sidebar === "rail");
  await page.locator("aside a[href='/board'] svg").waitFor();
  console.log("sidebar rail ok", { elapsed });
} finally {
  await browser.close();
}
