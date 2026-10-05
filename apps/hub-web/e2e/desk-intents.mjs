/**
 * Desk intents in quick capture and Ask, with Undo, plus CLS on the Today bento.
 * Run from apps/hub-web: node e2e/desk-intents.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const stamp = Date.now().toString(36);

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function signup(name, email) {
  const response = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "widget-pass-1", name }),
  });
  if (!response.ok) throw new Error(`signup ${response.status}: ${await response.text()}`);
  return cookieHeader(typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : response.headers.get("set-cookie"));
}

async function liveTasks(session) {
  const response = await fetch(`${API}/api/desk/live`, { headers: { cookie: `ensemble_session=${session}` } });
  if (!response.ok) throw new Error(`live ${response.status}`);
  const body = await response.json();
  return body.tasks;
}

async function waitGone(session, pred, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tasks = await liveTasks(session);
    if (!tasks.some(pred)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

async function main() {
  const session = await signup("Counsel", `intents-${stamp}@ensemble.test`);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await context.addInitScript(() => {
    window.__cls = 0;
    window.__bentoCls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        window.__cls += entry.value;
        const nodes = entry.sources?.map((source) => source.node).filter(Boolean) ?? [];
        const hits = nodes.some((node) => node.closest?.("[data-widget-grid='desk'], [data-desk-tile], .bento"));
        if (hits) window.__bentoCls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await context.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  const page = await context.newPage();
  await page.goto(`${WEB}/start`, { waitUntil: "networkidle" });
  await page.locator("[data-role=lawyer]").click();
  await page.locator("[data-template=matter-desk]").click();
  await page.getByRole("button", { name: "Use this template" }).click();
  await page.waitForURL(/\/today/, { timeout: 20_000 });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-desk-tile]").first().waitFor();
  await page.waitForTimeout(800);
  const shifts = await page.evaluate(() => ({ cls: window.__cls, bento: window.__bentoCls }));
  console.log("today bento CLS", shifts);
  assert.ok(shifts.bento < 0.05, `bento CLS ${shifts.bento} (page ${shifts.cls})`);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("ensemble:capture")));
  const capture = page.getByRole("dialog", { name: "Quick capture" });
  await capture.waitFor();
  await capture.locator("textarea").fill("mock 112/200 today");
  await capture.getByRole("button", { name: "Save task" }).click();
  const saved = page.getByRole("status").filter({ hasText: "112/200" });
  await saved.waitFor();
  await saved.getByRole("button", { name: "Undo" }).click();
  await waitGone(session, (row) => row.taskType === "mock" && row.measure === 112, "mock survived undo");

  await page.locator('input[aria-label="Ask Ensemble"]').fill("hearing Rao v Sunrise 5 Oct Court 32");
  await page.locator('input[aria-label="Ask Ensemble"]').press("Enter");
  await page.locator("p").filter({ hasText: "Listed Rao v Sunrise" }).waitFor();
  await page.locator("[data-ask-undo]").click();
  await page.locator("p").filter({ hasText: "Undone" }).waitFor();
  await waitGone(session, (row) => row.taskType === "hearing" && /Rao v Sunrise/.test(row.title), "hearing survived undo");

  await browser.close();
  console.log("desk intents ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
