/**
 * Canvas-only mode can add a block and rename it, and the diagram text follows.
 * Run: node apps/hub-web/e2e/diagram-canvas.mjs
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

const email = `canvas-${Date.now().toString(36)}@ensemble.test`;
const signup = await fetch(`${API}/api/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "canvas-pass-1", name: "Canvas" }),
});
if (!signup.ok) throw new Error(await signup.text());
const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
const onboard = await fetch(`${API}/api/onboarding`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
  body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
});
if (!onboard.ok) throw new Error(await onboard.text());
const created = await fetch(`${API}/api/diagrams`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
  body: JSON.stringify({ title: "Canvas" }),
});
if (!created.ok) throw new Error(await created.text());
const id = (await created.json()).diagram.id;

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  await page.goto(`${WEB}/diagrams/${id}`, { waitUntil: "domcontentloaded" });
  await page.locator(".react-flow").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Canvas only" }).click();
  await page.getByRole("button", { name: "Add Rectangle" }).click();
  const node = page.locator(".react-flow__node", { hasText: "New block" });
  await node.waitFor();
  await node.dblclick();
  const label = page.getByRole("textbox", { name: "Block label" });
  await label.fill("Canvas block");
  await label.press("Enter");
  await page.getByRole("button", { name: "Exit" }).click();
  await page.waitForTimeout(1200);
  const saved = await fetch(`${API}/api/diagrams/${id}`, { headers: { cookie: `ensemble_session=${session}` } });
  const body = await saved.json();
  assert.match(body.diagram.source, /Canvas block/);
  console.log("canvas edit ok");
} finally {
  await browser.close();
}
