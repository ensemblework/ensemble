/**
 * Undo and redo in the browser: @ensemble Apply, a board drag, and two toasts.
 * Run: node apps/hub-web/e2e/undo-redo.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const EMAIL = process.env.ENSEMBLE_E2E_EMAIL ?? "prajwal@ensemble.local";
const PASSWORD = process.env.ENSEMBLE_E2E_PASSWORD ?? "ensemble-demo";
const ARTIFACTS = process.env.ENSEMBLE_ARTIFACTS ?? "/opt/cursor/artifacts/features";
const stamp = Date.now().toString(36);

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`login did not set a session: ${list.join(" | ")}`);
  return pair[1];
}

async function login() {
  let response = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  let text = await response.text();
  let created = false;
  if (response.status === 401) {
    response = await fetch(`${API}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "E2E" }),
    });
    text = await response.text();
    if (response.status === 409) {
      response = await fetch(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      });
      text = await response.text();
    } else {
      created = response.ok;
    }
  }
  if (!response.ok) throw new Error(`login ${response.status}: ${text}`);
  const session = cookieHeader(typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : response.headers.get("set-cookie"));
  if (created) {
    const onboard = await fetch(`${API}/api/onboarding`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
      body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
    });
    if (!onboard.ok) throw new Error(`onboarding ${onboard.status}: ${await onboard.text()}`);
  }
  return session;
}

function client(session) {
  return async function api(method, path, body) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        cookie: `ensemble_session=${session}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!response.ok) {
      const error = new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 400)}`);
      error.status = response.status;
      throw error;
    }
    return json;
  };
}

async function drag(page, from) {
  const handle = from.locator("xpath=ancestor::*[@data-bdg-card]");
  await handle.scrollIntoViewIfNeeded();
  const startBox = await handle.boundingBox();
  const endBox = await page.locator("[data-column='in_progress']").boundingBox();
  if (!startBox || !endBox) throw new Error("drag target has no box");
  const start = { x: startBox.x + 24, y: startBox.y + 16 };
  const end = { x: endBox.x + 48, y: endBox.y + 120 };
  // MouseSensor listens for mouse events. Synthetic pointer events do not start a drag.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 24 });
  await page.mouse.up();
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });
  const session = await login();
  const api = client(session);
  await api("PATCH", "/api/settings", {
    undoDepth: 5,
    assistant: { defaultTier: "medium", writePolicy: "preview" },
    models: {
      easy: { provider: "mock", model: "mock", effort: "minimal" },
      medium: { provider: "mock", model: "mock", effort: "low" },
      high: { provider: "mock", model: "mock", effort: "medium" },
      max: { provider: "mock", model: "mock", effort: "high" },
    },
  });
  const before = new Set((await api("GET", "/api/tasks")).tasks.map((task) => task.id));
  const dragTitle = `undo drag ${stamp}`;
  const firstTitle = `undo toast a ${stamp}`;
  const secondTitle = `undo toast b ${stamp}`;
  const dragged = (await api("POST", "/api/tasks", { title: dragTitle, status: "todo", priority: "p1" })).task;
  const first = (await api("POST", "/api/tasks", { title: firstTitle, status: "todo", priority: "p0" })).task;
  const second = (await api("POST", "/api/tasks", { title: secondTitle, status: "todo", priority: "p0" })).task;

  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await context.addCookies([{ name: "ensemble_session", value: session, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(() => {
    localStorage.setItem("ensemble.assistant.open", "false");
    localStorage.setItem("ensemble.appearance", JSON.stringify({ theme: "dark" }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => console.error("PAGE", error));

  await page.goto(`${WEB}/settings#retention`, { waitUntil: "domcontentloaded" });
  const depth = page.getByLabel("Undo depth");
  await depth.waitFor();
  assert.equal(await depth.inputValue(), "5");
  await page.locator("#retention").screenshot({ path: `${ARTIFACTS}/settings-undo-depth.png` });

  await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
  await page.getByText(firstTitle, { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Ask Ensemble", exact: true }).click();
  const composer = page.getByPlaceholder("Ask, or tell me what to change");
  await composer.waitFor();
  await composer.fill(`[[fixture:create_task]] add filing ${stamp}`);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Apply" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Apply" }).click();
  await page.locator(".tile").getByRole("button", { name: "Undo", exact: true }).waitFor();
  await page.screenshot({ path: `${ARTIFACTS}/dock-undo-redo.png` });
  const created = (await api("GET", "/api/tasks")).tasks.find((task) => task.title === "File the response" && !before.has(task.id));
  assert.ok(created, "apply did not create the filing task");
  await page.getByText("Assistant", { exact: true }).click();
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  let missing = false;
  try {
    await api("GET", `/api/tasks/${created.id}`);
  } catch (error) {
    missing = error.status === 404;
  }
  assert.equal(missing, true, "Ctrl+Z did not move the created task to Trash");
  await page.locator(".tile").getByRole("button", { name: "Redo", exact: true }).waitFor();
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(400);
  const restored = await api("GET", `/api/tasks/${created.id}`);
  assert.equal(restored.task.deletedAt ?? null, null);
  await page.locator(".tile").getByRole("button", { name: "Undo", exact: true }).waitFor();
  await page.keyboard.press("Control+j");

  await page.goto(`${WEB}/board`, { waitUntil: "domcontentloaded" });
  const card = page.locator("[data-column='todo']").getByText(dragTitle, { exact: true });
  await card.waitFor();
  const moved = page.waitForResponse((response) => response.url().includes("/move") && response.request().method() === "POST");
  await drag(page, card);
  const moveResponse = await moved;
  assert.equal(moveResponse.ok(), true, await moveResponse.text());
  assert.equal((await api("GET", `/api/tasks/${dragged.id}`)).task.status, "in_progress");
  await page.locator("header").click();
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(500);
  assert.equal((await api("GET", `/api/tasks/${dragged.id}`)).task.status, "todo");

  await page.goto(`${WEB}/today?view=widgets`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: `Mark done: ${firstTitle}` }).click();
  await page.getByRole("button", { name: `Mark done: ${secondTitle}` }).click();
  const undos = page.locator("div.pointer-events-none.fixed").getByRole("button", { name: "Undo", exact: true });
  await undos.nth(1).waitFor();
  await undos.nth(0).click();
  await page.waitForTimeout(400);
  assert.equal((await api("GET", `/api/tasks/${first.id}`)).task.status, "todo");
  assert.equal((await api("GET", `/api/tasks/${second.id}`)).task.status, "done");
  await page.locator("div.pointer-events-none.fixed").getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForTimeout(400);
  assert.equal((await api("GET", `/api/tasks/${second.id}`)).task.status, "todo");

  await browser.close();
  console.log("undo e2e ok");
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
