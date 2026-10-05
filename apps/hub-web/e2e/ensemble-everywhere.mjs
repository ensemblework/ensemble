/**
 * @ensemble on Board, Graph, a code line, a deliverable, and a watcher.
 * Run: node apps/hub-web/e2e/ensemble-everywhere.mjs
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const exec = promisify(execFile);
const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const EMAIL = process.env.ENSEMBLE_E2E_EMAIL ?? "prajwal@ensemble.local";
const PASSWORD = process.env.ENSEMBLE_E2E_PASSWORD ?? "ensemble-demo";
const SHOTS = process.env.ENSEMBLE_ARTIFACTS ?? "/opt/cursor/artifacts/features";
const WORKSPACE = process.env.ENSEMBLE_WORKSPACE_ROOT ?? "/tmp/ensemble-workspace";
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
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
    return json;
  };
}

async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function ask(page, buttonName, prompt) {
  const button = page.getByRole("button", { name: buttonName, exact: true });
  await button.waitFor();
  const panel = page.locator("[data-ensemble-panel]");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await button.click();
    try {
      await panel.waitFor({ state: "visible", timeout: 2500 });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  await panel.getByLabel("Ask Ensemble on this surface").fill(prompt);
  const done = page.waitForResponse((response) => response.url().includes("/api/ensemble/invoke") && response.status() === 200, { timeout: 40_000 });
  await panel.getByRole("button", { name: "Send to Ensemble" }).click();
  await done;
  await panel.getByText(/Mock answer|Nothing has changed yet|Sources:|Court rules/).first().waitFor({ timeout: 20_000 });
  return panel;
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const session = await login();
  const api = client(session);
  await api("PATCH", "/api/settings", {
    assistant: { defaultTier: "medium", writePolicy: "preview", actAs: "general" },
    models: {
      easy: { provider: "mock", model: "mock", effort: "minimal" },
      medium: { provider: "mock", model: "mock", effort: "low" },
      high: { provider: "mock", model: "mock", effort: "medium" },
      max: { provider: "mock", model: "mock", effort: "high" },
    },
  });

  const project = (await api("POST", "/api/projects", { name: `everywhere ${stamp}` })).project;
  const deliverable = (await api("POST", "/api/deliverables", { title: `Brief ${stamp}`, projectId: project.id, notes: "File the memo before Friday." })).deliverable;
  await api("POST", "/api/tasks", { title: `Board card ${stamp}`, status: "todo", projectId: project.id });
  await api("POST", "/api/tasks", { title: `Done card ${stamp}`, status: "todo", projectId: project.id }).then(async (created) => {
    await api("PATCH", `/api/tasks/${created.task.id}`, { status: "in_progress" });
    await api("PATCH", `/api/tasks/${created.task.id}`, { status: "done" });
  });

  const repo = `${WORKSPACE}/line-${stamp}`;
  await mkdir(repo, { recursive: true });
  await exec("git", ["init"], { cwd: repo });
  await exec("git", ["config", "user.email", "e2e@ensemble.local"], { cwd: repo });
  await exec("git", ["config", "user.name", "e2e"], { cwd: repo });
  await writeFile(`${repo}/line.ts`, "const answer = 1;\n");
  await exec("git", ["add", "line.ts"], { cwd: repo });
  await exec("git", ["commit", "-m", "init"], { cwd: repo });
  await writeFile(`${repo}/line.ts`, "const answer = 1;\nconst answer = 2;\n");

  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  await context.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  await context.addInitScript(() => {
    localStorage.setItem("ensemble.assistant.open", "false");
  });
  const page = await context.newPage();

  await page.goto(`${WEB}/board`, { waitUntil: "domcontentloaded" });
  const board = await ask(page, "Ask Ensemble about To do", `[[fixture:create_task]] split ${stamp} into subtasks`);
  await board.getByRole("button", { name: "Apply" }).waitFor();
  await shot(page, "board-ensemble");
  await board.getByRole("button", { name: "Apply" }).click();
  await board.getByText("Applied", { exact: true }).waitFor({ timeout: 15_000 });
  await board.getByRole("button", { name: "Close" }).click();

  await page.goto(`${WEB}/context?tab=graph`, { waitUntil: "domcontentloaded" });
  await page.locator("canvas").waitFor();
  await page.getByRole("button", { name: "Graph tools" }).click();
  const graph = await ask(page, "Ask Ensemble about the graph", "[[fixture:citation]] how is this connected");
  await graph.getByRole("link", { name: /example\.com/ }).first().waitFor();
  const cited = (await page.locator("canvas").getAttribute("data-cited")) ?? "";
  assert.equal(cited, "", "an answer that names no entity id does not highlight the graph");
  await shot(page, "graph-ensemble");
  await graph.getByRole("button", { name: "Close" }).click();

  await page.goto(`${WEB}/code/review?repo=${encodeURIComponent(repo)}`, { waitUntil: "domcontentloaded" });
  await page.getByText("line.ts").first().waitFor({ timeout: 20_000 });
  const invoke = page.waitForRequest((request) => request.url().includes("/api/ensemble/invoke") && request.method() === "POST");
  const code = await ask(page, "Ask Ensemble about this line", "[[fixture:citation]] explain this line");
  const body = (await invoke).postDataJSON();
  assert.equal(body.surface, "code");
  assert.equal(body.line, 1);
  assert.match(body.codeText, /answer/);
  await shot(page, "code-ensemble");
  await code.getByRole("button", { name: "Close" }).click();

  await api("PUT", "/api/layouts/today", {
    v: 1,
    placements: [
      { type: "focus", size: "l" },
      { type: "deliverables", size: "l" },
      { type: "proposals", size: "m" },
    ],
  });
  await page.goto(`${WEB}/today?view=widgets`, { waitUntil: "domcontentloaded" });
  const deliverableButton = page.getByRole("button", { name: `Ask Ensemble about Brief ${stamp}`, exact: true });
  await deliverableButton.scrollIntoViewIfNeeded();
  const deliverablePanel = await ask(page, `Ask Ensemble about Brief ${stamp}`, "[[fixture:citation]] what is missing before the due date");
  await shot(page, "deliverable-ensemble");
  await shot(page, "today-ensemble");
  await deliverablePanel.getByRole("button", { name: "Close" }).click();

  const watcherPanel = await ask(page, `Ask Ensemble about Brief ${stamp}`, "tell me when all tasks under this deliverable are done");
  await watcherPanel.getByRole("button", { name: "Apply" }).waitFor();
  await shot(page, "watcher-ensemble");
  await watcherPanel.getByRole("button", { name: "Apply" }).click();
  await watcherPanel.getByText("Applied", { exact: true }).waitFor({ timeout: 15_000 });
  const watchers = await api("GET", "/api/watchers");
  assert.ok(watchers.watchers.some((row) => row.scopeId === deliverable.id && row.status === "active"));
  await watcherPanel.getByRole("button", { name: "Close" }).click();

  await page.goto(`${WEB}/needs-me`, { waitUntil: "domcontentloaded" });
  await ask(page, "Ask Ensemble about needs me", "[[fixture:citation]] draft replies for these");
  await shot(page, "needs-me-ensemble");

  await page.goto(`${WEB}/trash`, { waitUntil: "domcontentloaded" });
  await ask(page, "Ask Ensemble about trash", "[[fixture:citation]] what is in here");
  await shot(page, "trash-ensemble");

  await page.goto(`${WEB}/completed`, { waitUntil: "domcontentloaded" });
  await ask(page, "Ask Ensemble about completed", "[[fixture:citation]] what did we finish last month");
  await shot(page, "completed-ensemble");

  await context.addInitScript(() => {
    localStorage.setItem("ensemble.appearance", JSON.stringify({ theme: "light" }));
    localStorage.setItem("ensemble.assistant.open", "false");
  });
  const light = await context.newPage();
  await light.goto(`${WEB}/today?view=widgets`, { waitUntil: "domcontentloaded" });
  await ask(light, "Ask Ensemble about today", "[[fixture:citation]] plan my afternoon");
  await shot(light, "ensemble-light");

  await browser.close();
  console.log("ensemble everywhere e2e ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
