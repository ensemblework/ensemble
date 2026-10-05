/**
 * A disabled feature shows an enable landing, joins the sidebar without a reload,
 * offers a tour that walks suggested tiles and closes with Not now, and can be turned off in Settings
 * without deleting what was already saved.
 *
 * Run: node apps/hub-web/e2e/features.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME =
  process.env.CHROME_PATH ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");

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

async function settled(page) {
  await page.waitForFunction(() => /@ensemble\.test/.test(document.body.innerText));
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const email = `feat-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "widget-pass-1", name: "Counsel" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status}: ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  const onboard = await authed(session, "/api/onboarding", {
    method: "POST",
    body: JSON.stringify({ role: "lawyer", templateId: "matter-desk" }),
  });
  assert.equal(onboard.status, 200, onboard.text);
  const diagram = await authed(session, "/api/diagrams", {
    method: "POST",
    body: JSON.stringify({ title: "Keep me" }),
  });
  assert.equal(diagram.status, 201, diagram.text);

  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-desk=chambers] >> visible=true").waitFor();
  await settled(page);
  await page.getByRole("button", { name: "Add a tile" }).click();
  await page.getByRole("dialog", { name: "Add a tile" }).waitFor();
  await page.locator("[data-gallery-tile=syllabus]").waitFor();
  assert.equal(await page.locator("[data-gallery-tile=review-queue]").count(), 0);
  await page.getByRole("button", { name: "Close" }).click();

  await page.goto(`${WEB}/code`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-feature-landing=code]").waitFor();
  await page.locator("[data-feature-preview]").waitFor();
  assert.match(page.url(), /\/code$/);
  const landing = await page.locator("[data-feature-landing=code]").innerText();
  assert.match(landing, /Review changes, edit files/);
  assert.equal(/forbidden/i.test(landing), false);
  assert.equal(landing.includes("isn't part of your template"), false);
  assert.equal(await page.locator("aside a[href='/code']").count(), 0);
  const blocked = await authed(session, "/api/code/reviews");
  assert.equal(blocked.status, 404);

  await page.evaluate(() => {
    window.__stamp = 1;
  });
  await page.getByRole("button", { name: "Enable Code" }).click();
  await page.locator("[data-tour-step=intro]").waitFor();
  assert.equal(await page.evaluate(() => window.__stamp), 1);
  await page.locator("aside a[href='/code']").waitFor();
  await page.getByRole("button", { name: "Not now", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Skip", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Show suggestions" }).click();
  await page.locator("[data-tour-step=repos]").waitFor();
  await page.getByRole("heading", { name: "Repos", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Starter tiles" }).waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Code" }).waitFor();
  const open = await authed(session, "/api/code/reviews");
  assert.equal(open.status, 200, open.text);

  await page.goto(`${WEB}/settings#features`, { waitUntil: "domcontentloaded" });
  const codeSwitch = page.getByRole("switch", { name: "Code" });
  await codeSwitch.waitFor();
  await page.evaluate(() => {
    window.__stamp = 2;
  });
  await codeSwitch.click();
  await page.locator("aside a[href='/code']").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.__stamp), 2);
  const closed = await authed(session, "/api/code/reviews");
  assert.equal(closed.status, 404);

  await page.goto(`${WEB}/code`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Enable Code" }).waitFor();
  await page.getByRole("button", { name: "Enable Code" }).click();
  await page.locator("[data-tour-step=intro]").waitFor();
  await page.getByRole("button", { name: "Show suggestions" }).click();
  await page.locator("[data-tour-step=repos]").waitFor();
  await page.getByRole("button", { name: "Place", exact: true }).click();
  await page.locator("[data-tour-step=review-queue]").waitFor();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await page.getByRole("dialog", { name: "Starter tiles" }).waitFor({ state: "hidden" });

  await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
  await settled(page);
  await page.locator("[data-desk-added] [data-widget=repos]").waitFor();
  assert.equal(await page.locator("[data-widget=review-queue]").count(), 0);
  await page.getByRole("button", { name: "Add a tile" }).click();
  await page.locator("[data-gallery-tile=review-queue]").waitFor();
  await page.locator("[data-gallery-tile=syllabus]").waitFor();
  await page.getByRole("button", { name: "Close" }).click();

  await page.goto(`${WEB}/settings#features`, { waitUntil: "domcontentloaded" });
  const diagrams = page.getByRole("switch", { name: "Block diagrams" });
  await diagrams.waitFor();
  await diagrams.click();
  await page.locator("aside a[href='/diagrams']").waitFor({ state: "detached" });
  const hidden = await authed(session, "/api/diagrams");
  assert.equal(hidden.status, 404);
  await diagrams.click();
  await page.locator("[data-tour-step=note]").waitFor();
  await page.getByRole("dialog", { name: "Starter tiles" }).getByRole("button", { name: "Close", exact: true }).click();
  await page.locator("aside a[href='/diagrams']").waitFor();
  const restored = await authed(session, "/api/diagrams");
  assert.equal(restored.status, 200, restored.text);
  assert.match(restored.text, /Keep me/);
  await page.goto(`${WEB}/diagrams`, { waitUntil: "domcontentloaded" });
  await page.getByText("Keep me").waitFor();

  const market = await authed(session, "/api/marketplace/apply", {
    method: "POST",
    body: JSON.stringify({ id: "mkt.exam-season" }),
  });
  assert.equal(market.status, 403, market.text);

  await browser.close();
  console.log("features e2e ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
