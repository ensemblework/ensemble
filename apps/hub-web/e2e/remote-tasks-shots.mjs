/**
 * Screenshots and UI checks for the hosted remote-task flow.
 * Run after hub-api (:4000) and hub-web (:3000) are up:
 *   node apps/hub-web/e2e/remote-tasks-shots.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const SHOTS = new URL("../../../docs/screenshots/remote-tasks-api/", import.meta.url).pathname;
const stamp = Date.now().toString(36);

function cookieHeader(response) {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error("signup did not set a session");
  return pair[1];
}

async function call(path, { method = "GET", token, cookie, body, ok = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = `ensemble_session=${cookie}`;
  const response = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (ok && !response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`);
  return { status: response.status, body: parsed };
}

function sql(statement) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-c", statement], { stdio: "pipe" });
}

async function pair(session, name, platform, capabilities) {
  const paired = await call("/api/devices/pair", { method: "POST", cookie: session, body: {} });
  const registered = await call("/api/devices/register", {
    method: "POST",
    body: { code: paired.body.code, name, platform, appVersion: "0.1.0", capabilities },
  });
  await call("/api/devices/self/heartbeat", { method: "POST", token: registered.body.token, body: { runningJobIds: [] } });
  return registered.body;
}

const signup = await fetch(`${API}/api/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `shots-${stamp}@ensemble.test`, password: "remote-tasks-pass-1", name: "Remote shots" }),
});
if (!signup.ok) throw new Error(`signup ${signup.status}: ${await signup.text()}`);
const session = cookieHeader(signup);

const task = await call("/api/tasks", { method: "POST", cookie: session, body: { title: "Say hello from the computer", status: "todo" } });
const taskId = task.body.task?.id ?? task.body.id;
const office = await pair(session, "Office", "macos", { folders: ["Notes", "Desk"], runBranchPush: true });
const studio = await pair(session, "Studio PC", "windows", { folders: ["Desk"], runBranchPush: false });
const build = await pair(session, "Build box", "linux", { folders: ["Src"], runBranchPush: false });

const flip = await call("/api/devices/self/heartbeat", {
  method: "POST",
  cookie: session,
  ok: false,
  body: { runningJobIds: [], capabilities: { runBranchPush: true } },
});
assert.equal(flip.status, 403);
const listed = await call("/api/devices", { cookie: session });
const platforms = Object.fromEntries(listed.body.devices.map((device) => [device.name, device.platform]));
assert.deepEqual(platforms, { Office: "macos", "Studio PC": "windows", "Build box": "linux" });

const assigned = await call("/api/agent/assign", {
  method: "POST",
  cookie: session,
  body: { taskId, kind: "code", deviceId: office.device.id, repoUrl: "octocat/Hello-World", instructions: "Say hello from the paired computer." },
});
const claimed = await call("/api/devices/self/claim", { method: "POST", token: office.token });
await call(`/api/devices/self/jobs/${claimed.body.id}/progress`, {
  method: "POST",
  token: office.token,
  body: {
    leaseToken: claimed.body.leaseToken,
    status: "running",
    progress: "Reading the repo",
    events: [{ kind: "prepared", data: { root: "runs/hello" } }],
    logs: { seqFrom: 1, seqTo: 1, text: "hello from the paired computer\n" },
  },
});
const asked = await call(`/api/devices/self/jobs/${claimed.body.id}/ask`, {
  method: "POST",
  token: office.token,
  body: { leaseToken: claimed.body.leaseToken, title: "Continue and write the greeting?", event: "question", tier: "ordinary" },
});

const retryTask = await call("/api/tasks", { method: "POST", cookie: session, body: { title: "Retry the notes", status: "todo" } });
const retryId = retryTask.body.task?.id ?? retryTask.body.id;
await call("/api/agent/assign", {
  method: "POST",
  cookie: session,
  body: { taskId: retryId, kind: "code", deviceId: studio.device.id, repoUrl: "octocat/Hello-World", instructions: "Retry." },
});
const retryClaimed = await call("/api/devices/self/claim", { method: "POST", token: studio.token });
sql(`UPDATE workspace_jobs SET status = 'interrupted', finished_at = (NOW() AT TIME ZONE 'UTC'), progress = 'Interrupted', error = 'Interrupted: your computer went offline.', lease_token = NULL WHERE id = '${retryClaimed.body.id}'`);

const riskTask = await call("/api/tasks", { method: "POST", cookie: session, body: { title: "Risky checkout", status: "todo" } });
const riskId = riskTask.body.task?.id ?? riskTask.body.id;
await call("/api/agent/assign", {
  method: "POST",
  cookie: session,
  body: { taskId: riskId, kind: "code", deviceId: build.device.id, repoUrl: "octocat/Hello-World", instructions: "Ask first." },
});
const riskClaimed = await call("/api/devices/self/claim", { method: "POST", token: build.token });
await call(`/api/devices/self/jobs/${riskClaimed.body.id}/ask`, {
  method: "POST",
  token: build.token,
  body: { leaseToken: riskClaimed.body.leaseToken, title: "Delete the checkout?", event: "permission", tier: "high_risk", toolName: "Shell" },
});

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1600 }, colorScheme: "dark" });
await context.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
const page = await context.newPage();

await page.goto(`${WEB}/start`, { waitUntil: "load" });
const engineer = page.locator("[data-role=engineer]");
await engineer.waitFor();
await engineer.click();
await page.locator("[data-template=branch-desk]").waitFor();
await page.locator("[data-template=branch-desk]").click();
await page.getByRole("button", { name: "Use this template" }).click();
await page.waitForURL(/\/today/, { timeout: 20_000 });
for (const path of ["/today", "/board", "/workspace", "/needs-me", "/settings"]) {
  const response = await page.goto(`${WEB}${path}`, { waitUntil: "load" });
  if (page.url().includes("/login") || page.url().includes("/start")) throw new Error(`${path} landed on ${page.url()}`);
  if (response && response.status() >= 500) throw new Error(`${path} status ${response.status()}`);
}

await page.goto(`${WEB}/settings#devices`, { waitUntil: "load" });
await page.getByRole("button", { name: "Pair a device" }).click();
await page.getByText("Type this code into your computer").waitFor();
await page.getByText("Studio PC · Windows").waitFor();
await page.getByText("Build box · Linux").waitFor();
const pill = page.locator("#devices [data-run-branch=on]");
await pill.waitFor();
assert.equal(await pill.locator("text=set on Office").count(), 1);
assert.equal(await pill.evaluate((element) => element.closest("button, [role=switch]") !== null), false);
assert.equal(await page.getByRole("switch", { name: "Run-branch push" }).count(), 0);
await page.locator("#devices").scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/device-settings.png` });
await pill.screenshot({ path: `${SHOTS}/run-branch-pill.png` });

await page.goto(`${WEB}/workspace`, { waitUntil: "load" });
await page.getByRole("button", { name: "Assign task" }).click();
const dialog = page.getByRole("dialog");
await dialog.getByRole("heading", { name: "Assign to agent" }).waitFor();
await dialog.getByRole("button", { name: /Code on your computer/ }).click();
await dialog.getByRole("button", { name: /Studio PC/ }).click();
await dialog.getByText("A folder on Studio PC").waitFor();
await dialog.getByPlaceholder(/github.com/).fill("octocat/Hello-World");
const windowsCopy = await dialog.innerText();
for (const banned of ["this Mac", "your Mac", "the Mac", "on the Mac"]) {
  assert.equal(windowsCopy.includes(banned), false, banned);
}
assert.match(windowsCopy, /A fresh clone on Studio PC/);
assert.equal(windowsCopy.includes("ensemble-workspace"), false);
assert.ok((windowsCopy.match(/Queued until Studio PC is back/g) ?? []).length <= 1);
assert.match(windowsCopy, /set on Studio PC/);
assert.equal(await dialog.locator("[data-run-branch=off]").count(), 1);
await dialog.getByRole("button", { name: /Build box/ }).click();
await dialog.getByText("A folder on Build box").waitFor();
const linuxCopy = await dialog.innerText();
for (const banned of ["this Mac", "your Mac", "the Mac"]) {
  assert.equal(linuxCopy.includes(banned), false, banned);
}
await dialog.getByRole("button", { name: /Studio PC/ }).click();
await page.getByText("Run on", { exact: true }).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/assign-flow.png` });

await page.goto(`${WEB}/tasks/${taskId}`, { waitUntil: "load" });
await page.getByText("Continue and write the greeting?").waitFor({ timeout: 20_000 });
await page.getByRole("button", { name: "What it did" }).click();
await page.getByText("hello from the paired computer").waitFor();
await page.screenshot({ path: `${SHOTS}/live-remote-run.png` });

await page.goto(`${WEB}/tasks/${retryId}`, { waitUntil: "load" });
await page.getByText("Studio PC went offline").waitFor({ timeout: 20_000 });
await page.getByRole("button", { name: "Run again" }).click();
await page.getByText("Queued again on Studio PC.").waitFor({ timeout: 20_000 });

await page.goto(`${WEB}/needs-me`, { waitUntil: "load" });
await page.getByRole("button", { name: "Yes" }).waitFor({ timeout: 20_000 });
const risk = page.locator(".tile", { hasText: "Delete the checkout?" });
await risk.getByText("Confirm this on Build box").waitFor();
assert.equal(await risk.getByRole("button", { name: "Yes" }).count(), 0);
await page.screenshot({ path: `${SHOTS}/needs-me.png` });

await browser.close();
console.log(JSON.stringify({ taskId, jobId: claimed.body.id, decisionId: asked.body.decisionId, assignJobId: assigned.body.jobId, shots: SHOTS }, null, 2));
