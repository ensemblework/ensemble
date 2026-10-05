/**
 * Leaving /today while its fetches are still in flight must not surface
 * WebKit's cancelled-fetch failures, or the offline copy those used to become.
 *
 *   HUB_WEB=http://127.0.0.1:3000 node apps/hub-web/e2e/safari-abort.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium, webkit } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");
const OFFLINE = "Ensemble can't reach its server right now.";

const HOPS = ["/board", "/needs-me", "/context", "/today", "/board", "/needs-me", "/context", "/today", "/board", "/context"];

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function launch(name) {
  if (name === "webkit") return webkit.launch({ headless: true });
  return chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

function hrefFor(path) {
  return path.split("#")[0];
}

/** Sidebar item only. Today's desk also links "Open Focus" at a[href="/board"]. */
function sidebarNavLink(page, path) {
  return page.locator(`aside.app-sidebar nav a[href="${hrefFor(path)}"]`);
}

async function signUp() {
  const email = `safari-abort-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "abort-pass-1", name: "Abort" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status} ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  const onboard = await fetch(`${API}/api/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ role: "lawyer", templateId: "matter-desk" }),
  });
  if (!onboard.ok) throw new Error(`onboarding ${onboard.status} ${await onboard.text()}`);
  return session;
}

async function openToday(browser, session) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    problems.push(`http ${response.status()} ${response.url()}`);
  });
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
  await sidebarNavLink(page, "/board").waitFor();
  return { page, problems };
}

async function leaveToday(browser, session, label) {
  const { page, problems } = await openToday(browser, session);
  try {
    for (const path of HOPS) {
      await sidebarNavLink(page, path).click();
      const pathname = path.split("#")[0];
      await page.waitForURL((url) => url.pathname === pathname, { timeout: 15000 });
    }
    await page.waitForTimeout(400);
    const body = await page.locator("body").innerText();
    assert.equal(body.includes(OFFLINE), false, `${label} showed the offline message`);
    const noisy = problems.filter((line) => !/Failed to load resource.*favicon/i.test(line));
    assert.deepEqual(noisy, [], `${label}\n${noisy.join("\n")}`);
    console.log(`abort navigation ${label} ok`);
  } finally {
    await page.context().close();
  }
}

async function blockedApi(browser, session, label) {
  const { page } = await openToday(browser, session);
  try {
    await page.route("**/api/**", (route) => route.abort("failed"));
    await page.goto(`${WEB}/settings`, { waitUntil: "domcontentloaded" });
    await page.getByText("Reconnecting to Ensemble", { exact: false }).waitFor({ timeout: 8000 });
    await page.getByText(OFFLINE, { exact: false }).waitFor({ timeout: 45000 });
    console.log(`offline state ${label} ok`);
  } finally {
    await page.context().close();
  }
}

async function main() {
  const session = await signUp();
  for (const name of ["chromium", "webkit"]) {
    const browser = await launch(name);
    try {
      await leaveToday(browser, session, name);
      await blockedApi(browser, session, name);
    } finally {
      await browser.close();
    }
  }
  console.log("safari abort ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
