/**
 * Plots opens after Settings enables it, on Chromium and WebKit.
 * The canvas must replace the loader, including after a reload.
 * Run: node apps/hub-web/e2e/plots-browsers.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium, webkit } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function authed(session, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { cookie: `ensemble_session=${session}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text || "null") };
}

async function openCanvas(browser, session, label) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  const started = Date.now();
  await page.goto(`${WEB}/plots`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-plot-canvas]").waitFor({ timeout: 20000 });
  const elapsed = Date.now() - started;
  assert.equal(await page.locator("[data-plot-error]").count(), 0, `${label} error state`);
  assert.equal(await page.getByText("Opening the canvas…").count(), 0, `${label} stuck loader`);
  const fatal = errors.filter((line) => /hydrat|cannot be a descendant|pageerror|ChunkLoad|Importing a module script failed/i.test(line));
  assert.deepEqual(fatal, [], `${label} ${fatal.join("\n")}`);
  await page.context().close();
  console.log(`plots ${label} canvas in ${elapsed}ms`);
}

async function main() {
  const email = `plots-browsers-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "plot-pass-1", name: "Plots" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status}: ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  const onboard = await authed(session, "/api/onboarding", {
    method: "POST",
    body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
  });
  assert.equal(onboard.status, 200, onboard.text);
  const enabled = await authed(session, "/api/settings/modules", {
    method: "PUT",
    body: JSON.stringify({ id: "plots", on: true }),
  });
  assert.equal(enabled.status, 200, enabled.text);

  const chrome = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    await openCanvas(chrome, session, "chromium");
  } finally {
    await chrome.close();
  }

  const kit = await webkit.launch({ headless: true });
  try {
    await openCanvas(kit, session, "webkit");
  } finally {
    await kit.close();
  }
  console.log("plots browsers ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
