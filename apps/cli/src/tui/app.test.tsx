import assert from "node:assert/strict";
import test from "node:test";
import { render } from "ink-testing-library";
import { App, type Ops } from "./app.js";
import type { ChatFrame, Decision, LocalApi, Workspace } from "./local.js";
import { DEFAULT_PREFS } from "./prefs.js";

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const job = (id: string, title: string, status: string) => ({
  id,
  taskId: `t-${id}`,
  title,
  status,
  kind: "code",
  provider: "claude-code",
  folder: "/work/app",
  position: null,
  delivery: "commit",
  unattended: false,
  accessMode: "read-write",
  executionMode: "sandbox",
  startedAt: new Date(Date.now() - 90_000).toISOString(),
  finishedAt: null,
  progress: "Running the tests",
});

const empty: Workspace = { root: "/w", paused: false, maxConcurrent: 2, queued: [], running: [], waiting: [], stopped: [], completed: [] };

function fakeApi(input: { workspace?: Workspace; decisions?: Decision[]; frames?: ChatFrame[] } = {}) {
  const calls: Array<{ what: string; body?: unknown }> = [];
  let decisions = input.decisions ?? [];
  const api = {
    discovery: { port: 1234, token: "t" },
    workspace: async () => input.workspace ?? empty,
    decisions: async () => decisions,
    job: async (id: string) => ({ job: (input.workspace?.waiting ?? []).concat(input.workspace?.running ?? []).find((row) => row.id === id) ?? job(id, "x", "running"), log: "step one\nstep two", events: [] }),
    decide: async (id: string, body: unknown) => {
      calls.push({ what: `decide ${id}`, body });
      decisions = decisions.filter((row) => row.id !== id);
    },
    settings: async () => ({ runProfiles: [], defaultRunProfileId: null, orchestration: {}, models: { medium: { provider: "anthropic", model: "claude-x" } }, assistant: { writePolicy: "preview" } }),
    guard: async () => ({ root: "/w", sandbox: { mechanism: "seatbelt", osSandbox: true, strength: "strong" } }),
    json: async (path: string, init?: { body?: unknown }) => {
      calls.push({ what: path, body: init?.body });
      if (path === "/api/tasks") return { task: { id: "new-task" } };
      if (path === "/api/agent/assign") return { jobId: "new-job" };
      return {};
    },
    chat: async (body: unknown, onFrame: (frame: ChatFrame) => void) => {
      calls.push({ what: "chat", body });
      for (const frame of input.frames ?? []) onFrame(frame);
    },
    apply: async (body: unknown) => {
      calls.push({ what: "apply", body });
      return { summary: "Started Claude Code on “Fix it” (job j1)" };
    },
    stopChat: async () => undefined,
    stopJob: async () => undefined,
    retryJob: async () => ({ jobId: "again" }),
    models: async () => ({ providers: [], runtime: true }),
    agentApps: async () => ({ available: true, agents: [] }),
    modelKeys: async () => ({ credentials: [] }),
    trust: async (path: string) => ({ id: "r", path }),
  } as unknown as LocalApi;
  return { api, calls };
}

const ops: Ops = {
  signIn: async () => ({ email: "me@example.com", paired: true }),
  signOut: async () => [],
  runnerService: async () => "Installed.",
  savePrefs: () => undefined,
  connectHook: async () => "Connected.",
  connectedHooks: async () => [],
};

function mount(api: LocalApi, prefs = DEFAULT_PREFS) {
  return render(<App api={api} folder="/work/app" version="0.3.0" account={{ email: null, paired: false, apiBase: "https://x" }} prefs={prefs} ops={ops} />);
}

test("Tasks lists what needs you, with the question's own options as buttons, and a number answers it", async () => {
  const waiting = job("j1", "Fix the login bug", "waiting_approval");
  const question: Decision = {
    id: "d1",
    source: "ensemble",
    event: "question",
    toolName: "question",
    title: "Which database should the tests use?",
    detail: { options: ["SQLite", "Postgres"], recommended: "Postgres", allowCustom: true, jobId: "j1" },
    cwd: null,
    status: "pending",
    requestedAt: new Date().toISOString(),
  };
  const { api, calls } = fakeApi({ workspace: { ...empty, waiting: [waiting] }, decisions: [question] });
  const app = mount(api);
  await tick(150);
  const frame = app.lastFrame()!;
  assert.match(frame, /Tasks · 1 needs you/);
  assert.match(frame, /NEEDS YOU/);
  assert.match(frame, /Which database should the tests use\?/);
  assert.match(frame, /1 SQLite/);
  assert.match(frame, /2 ★ Postgres/);
  app.stdin.write("2");
  await tick();
  assert.deepEqual(calls.find((call) => call.what === "decide d1")?.body, { decision: "allow", reason: "Postgres", confirmed: true });
  app.unmount();
});

test("a typed answer goes back as the person's own words", async () => {
  const question: Decision = { id: "d2", source: "ensemble", event: "question", toolName: "question", title: "Name the branch?", detail: { options: ["main"], allowCustom: true }, cwd: null, status: "pending", requestedAt: new Date().toISOString() };
  const { api, calls } = fakeApi({ decisions: [question] });
  const app = mount(api);
  await tick(150);
  app.stdin.write("release-2026");
  await tick();
  app.stdin.write("\r");
  await tick();
  assert.deepEqual(calls.find((call) => call.what === "decide d2")?.body, { decision: "allow", reason: "release-2026", confirmed: true });
  app.unmount();
});

test("a permission request offers once, for this task, always and deny; /deny sends a reason", async () => {
  const permission: Decision = { id: "d3", source: "claude", event: "PermissionRequest", toolName: "Bash", title: "Run `rm -rf dist`", detail: { command: "rm -rf dist" }, cwd: "/work/app", status: "pending", requestedAt: new Date().toISOString() };
  const { api, calls } = fakeApi({ decisions: [permission] });
  const app = mount(api);
  await tick(150);
  const frame = app.lastFrame()!;
  assert.match(frame, /1 Allow once/);
  assert.match(frame, /2 Allow for this task/);
  assert.match(frame, /3 Always/);
  assert.match(frame, /4 Deny/);
  assert.match(frame, /Claude Code wants to/);
  for (const key of "/deny not now") app.stdin.write(key);
  await tick();
  app.stdin.write("\r");
  await tick();
  assert.deepEqual(calls.find((call) => call.what === "decide d3")?.body, { decision: "deny", reason: "not now", confirmed: true });
  app.unmount();
});

test("/ opens the command menu, filtered as you type", async () => {
  const { api } = fakeApi();
  const app = mount(api);
  await tick(100);
  app.stdin.write("/");
  await tick();
  assert.match(app.lastFrame()!, /\/tasks/);
  assert.match(app.lastFrame()!, /\/run <what to do>/);
  app.stdin.write("pro");
  await tick();
  const frame = app.lastFrame()!;
  assert.match(frame, /❯ \/profile/);
  assert.doesNotMatch(frame, /\/tasks/);
  app.unmount();
});

test("/run starts an agent on a new task in this folder, with the run profile", async () => {
  const { api, calls } = fakeApi();
  const app = mount(api);
  await tick(100);
  for (const key of "/run fix the failing tests") app.stdin.write(key);
  await tick();
  app.stdin.write("\r");
  await tick(120);
  const task = calls.find((call) => call.what === "/api/tasks")?.body as { title: string };
  assert.equal(task.title, "fix the failing tests");
  const assign = calls.find((call) => call.what === "/api/agent/assign")?.body as Record<string, unknown>;
  assert.equal(assign.taskId, "new-task");
  assert.equal(assign.folder, "/work/app");
  assert.equal(assign.kind, "code");
  assert.equal(assign.engine, "ensemble");
  assert.equal(assign.mode, "ask");
  assert.match(app.lastFrame()!, /Started Ensemble agent/);
  app.unmount();
});

test("Chat streams Ensemble Code's reply, and a held change waits for Apply", async () => {
  const frames: ChatFrame[] = [
    { type: "status", conversationId: "c1" },
    { type: "delta", text: "I'll hand this to " },
    { type: "delta", text: "**Claude Code**." },
    { type: "pending", call: { id: "call1", name: "ensemble_start_agent", state: "awaiting_approval", input: { title: "Fix it" } }, preview: "Start Claude Code on “Fix it” in . (Quick: Ask, may commit)" },
    { type: "done", conversationId: "c1", content: "I'll hand this to **Claude Code**. Nothing has changed yet — press Apply." },
  ];
  const { api, calls } = fakeApi({ frames });
  const app = mount(api, { ...DEFAULT_PREFS, tab: "chat" });
  await tick(100);
  for (const key of "fix the login bug") app.stdin.write(key);
  await tick();
  app.stdin.write("\r");
  await tick(150);
  const frame = app.lastFrame()!;
  assert.match(frame, /› fix the login bug/);
  assert.match(frame, /Claude Code\./);
  assert.match(frame, /Waiting for Apply/);
  assert.match(frame, /1 Apply/);
  const sent = calls.find((call) => call.what === "chat")?.body as { message: string; code: { folder: string } };
  assert.equal(sent.message, "fix the login bug");
  assert.equal(sent.code.folder, "/work/app");
  app.stdin.write("1");
  await tick(100);
  const applied = calls.find((call) => call.what === "apply")?.body as { conversationId: string; calls: Array<{ name: string; callId: string }> };
  assert.equal(applied.conversationId, "c1");
  assert.equal(applied.calls[0]!.name, "ensemble_start_agent");
  assert.equal(applied.calls[0]!.callId, "call1");
  assert.match(app.lastFrame()!, /✓ Started Claude Code/);
  app.unmount();
});

test("clicking a tab switches to it; Tab does too", async () => {
  const { api } = fakeApi();
  const app = mount(api);
  await tick(100);
  assert.match(app.lastFrame()!, /Welcome to Ensemble/);
  // " ◆ Ensemble  " is 13 cells, " Tasks " the next 7, then a space: Chat starts at column 22 (1-based).
  app.stdin.write("\u001B[<0;24;1M");
  await tick();
  assert.match(app.lastFrame()!, /Ensemble Code/);
  app.stdin.write("\t");
  await tick();
  assert.match(app.lastFrame()!, /Welcome to Ensemble/);
  app.unmount();
});
