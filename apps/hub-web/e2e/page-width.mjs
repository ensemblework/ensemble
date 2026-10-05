/**
 * One page width: drag it on a task, reload, open a deliverable, and read the same width.
 * Run: node apps/hub-web/e2e/page-width.mjs
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

async function authed(session, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      cookie: `ensemble_session=${session}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

const email = `width-${Date.now().toString(36)}@ensemble.test`;
const signup = await fetch(`${API}/api/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "width-pass-1", name: "Width" }),
});
if (!signup.ok) throw new Error(await signup.text());
const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
const onboard = await authed(session, "/api/onboarding", {
  method: "POST",
  body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
});
assert.equal(onboard.status, 200, onboard.text);
const project = await authed(session, "/api/projects", { method: "POST", body: JSON.stringify({ name: "Width project" }) });
assert.equal(project.status, 201, project.text);
const deliverable = await authed(session, "/api/deliverables", {
  method: "POST",
  body: JSON.stringify({ title: "Width deliverable", projectId: project.body.project.id }),
});
assert.equal(deliverable.status, 201, deliverable.text);
const task = await authed(session, "/api/tasks", { method: "POST", body: JSON.stringify({ title: "Width task", status: "todo" }) });
assert.equal(task.status, 201, task.text);

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  await page.goto(`${WEB}/board?peek=${task.body.task.id}`, { waitUntil: "domcontentloaded" });
  const handle = page.getByRole("separator", { name: "Page width" });
  await handle.waitFor();
  const box = await handle.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + 2, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x - 180, box.y + 80, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("[data-page-width]")?.getAttribute("data-page-width") !== "50");
  const width = await handle.getAttribute("data-page-width");
  assert.ok(width && Number(width) > 50 && Number(width) <= 80, width);
  await page.waitForTimeout(700);
  const saved = await authed(session, "/api/settings");
  assert.equal(saved.body.settings.pageWidth, Number(width));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction((expected) => document.querySelector("[data-page-width]")?.getAttribute("data-page-width") === expected, width);
  await page.goto(`${WEB}/today?peek=${deliverable.body.deliverable.id}&kind=deliverable`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-peek-kind='deliverable']").waitFor();
  await page.waitForFunction((expected) => document.querySelector("[data-page-width]")?.getAttribute("data-page-width") === expected, width);
  const projectHandle = page.getByRole("button", { name: "Width project" });
  await projectHandle.click();
  await page.locator("[data-peek-kind='project']").waitFor();
  await page.waitForFunction((expected) => document.querySelector("[data-page-width]")?.getAttribute("data-page-width") === expected, width);
  console.log("page width ok", { width });
} finally {
  await browser.close();
}
