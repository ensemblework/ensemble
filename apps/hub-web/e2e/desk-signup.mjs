/**
 * A new lawyer lands on the Chambers bento, ghost tiles, and the sample banner.
 * Run: node apps/hub-web/e2e/desk-signup.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const email = `chambers-${Date.now().toString(36)}@ensemble.test`;
  const response = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "widget-pass-1", name: "Counsel" }),
  });
  if (!response.ok) throw new Error(`signup ${response.status}: ${await response.text()}`);
  const session = cookieHeader(typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : response.headers.get("set-cookie"));
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  await page.goto(`${WEB}/start`, { waitUntil: "networkidle" });
  await page.locator("[data-role=lawyer]").click();
  await page.locator("[data-template=matter-desk]").click();
  await page.getByRole("button", { name: "Use this template" }).click();
  await page.waitForURL(/\/today/, { timeout: 20_000 });
  await page.locator("[data-desk=chambers] >> visible=true").waitFor();
  await page.waitForFunction(() => {
    const tiles = [...document.querySelectorAll("[data-desk-tile]")];
    if (tiles.length < 4) return false;
    return tiles.every((el) => {
      const box = el.getBoundingClientRect();
      return box.height >= 48 && Number(getComputedStyle(el).opacity) > 0.9;
    });
  });
  const pad = await page.locator("[data-desk=chambers] >> visible=true").evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  assert.ok(pad >= 32, `today padding ${pad}`);
  await page.getByRole("button", { name: "Try with sample data" }).waitFor();
  assert.equal(await page.locator("[data-sample]").count(), 0);
  await page.getByText(/hearing/i).first().waitFor();
  const shell = await fetch(`${API}/api/shell`, { headers: { cookie: `ensemble_session=${session}` } });
  const body = await shell.json();
  assert.equal(body.activeTemplateId, "mkt.chambers");
  await page.goto(`${WEB}/context`, { waitUntil: "networkidle" });
  await page.locator("[data-context-lens=chambers]").waitFor();
  await page.getByRole("tab", { name: "People" }).click();
  await page.locator("[data-lens-panel=people]").waitFor();
  await page.getByRole("tab", { name: "Matters" }).click();
  await page.locator("[data-lens-panel=matters]").waitFor();
  await browser.close();
  console.log("desk signup e2e ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
