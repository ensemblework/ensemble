/**
 * Load /plots against a production `next start` build.
 * The dev server hides React's hook-order crash; production minifies it to error #310.
 *
 * Build and serve first (port 3100 leaves the dev server on 3000):
 *   NEXT_PUBLIC_HUB_API=http://127.0.0.1:4000 NEXT_DIST_DIR=.next-prod pnpm --filter @ensemble/hub-web build
 *   NEXT_PUBLIC_HUB_API=http://127.0.0.1:4000 NEXT_DIST_DIR=.next-prod pnpm --filter @ensemble/hub-web exec next start -p 3100
 *   HUB_WEB=http://127.0.0.1:3100 node apps/hub-web/e2e/plots-production.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3100";
const CHROME =
  process.env.CHROME_PATH ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function main() {
  const email = `plots-prod-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "plot-pass-1", name: "Prod" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status} ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  const onboard = await fetch(`${API}/api/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
  });
  if (!onboard.ok) throw new Error(`onboarding ${onboard.status} ${await onboard.text()}`);
  const modules = await fetch(`${API}/api/settings/modules`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ id: "plots", on: true }),
  });
  if (!modules.ok) throw new Error(`modules ${modules.status} ${await modules.text()}`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const crashes = [];
  page.on("pageerror", (error) => crashes.push(error.message));
  try {
    await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    await page.goto(`${WEB}/plots`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-plot-canvas], [data-plot-error], [data-feature-landing=plots]").first().waitFor({ timeout: 20000 });
    const errorText = await page.locator("[data-plot-error]").innerText().catch(() => "");
    const body = await page.locator("body").innerText();
    assert.equal(await page.locator("[data-plot-error]").count(), 0, errorText || body.slice(0, 400));
    assert.doesNotMatch(body, /Minified React error #310|Rendered more hooks than during the previous render/);
    assert.equal(crashes.filter((line) => /310|more hooks/i.test(line)).join("\n"), "");
    await page.locator("[data-plot-canvas], [data-plot-sample]").first().waitFor({ timeout: 20000 });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
