import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { render } from "ink-testing-library";
import { App } from "./app.js";
import type { ChatFrame, Decision, LocalApi } from "./local.js";
import { DEFAULT_PREFS } from "./prefs.js";
import { empty, fakeApi, job, ops, screenWith, tick, until } from "./testing.js";

const mounted: Array<{ unmount: () => void }> = [];

function mount(api: LocalApi, prefs = DEFAULT_PREFS) {
  const app = render(<App api={api} folder="/work/app" version="0.3.0" account={{ email: null, paired: false, apiBase: "https://x" }} prefs={prefs} ops={ops} />);
  mounted.push(app);
  return app;
}

// A failed assertion must not leave an app polling: the test file would never end.
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
});

const call = (calls: Array<{ what: string; body?: unknown }>, what: string) => until(() => calls.find((row) => row.what === what)?.body);

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
  const frame = await screenWith(app.lastFrame, /2 ★ Postgres/);
  assert.match(frame, /Tasks · 1 needs you/);
  assert.match(frame, /NEEDS YOU/);
  assert.match(frame, /Which database should the tests use\?/);
  assert.match(frame, /1 SQLite/);
  assert.match(frame, /2 ★ Postgres/);
  app.stdin.write("2");
  assert.deepEqual(await call(calls, "decide d1"), { decision: "allow", reason: "Postgres", confirmed: true });
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
  assert.deepEqual(await call(calls, "decide d2"), { decision: "allow", reason: "release-2026", confirmed: true });
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
  assert.deepEqual(await call(calls, "decide d3"), { decision: "deny", reason: "not now", confirmed: true });
  app.unmount();
});

test("/ opens the command menu, filtered as you type", async () => {
  const { api } = fakeApi();
  const app = mount(api);
  await tick(100);
  app.stdin.write("/");
  const menu = await screenWith(app.lastFrame, /\/run <what to do>/);
  assert.match(menu, /\/tasks/);
  assert.match(menu, /\/run <what to do>/);
  app.stdin.write("pro");
  const frame = await screenWith(app.lastFrame, /❯ \/profile/);
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
  const task = (await call(calls, "/api/tasks")) as { title: string };
  assert.equal(task.title, "fix the failing tests");
  const assign = (await call(calls, "/api/agent/assign")) as Record<string, unknown>;
  assert.equal(assign.taskId, "new-task");
  assert.equal(assign.folder, "/work/app");
  assert.equal(assign.kind, "code");
  assert.equal(assign.engine, "ensemble");
  assert.equal(assign.mode, "ask");
  assert.match(await screenWith(app.lastFrame, /Started Ensemble agent/), /Started Ensemble agent/);
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
  const frame = await screenWith(app.lastFrame, /1 Apply/);
  assert.match(frame, /› fix the login bug/);
  assert.match(frame, /Claude Code\./);
  assert.match(frame, /Waiting for Apply/);
  assert.match(frame, /1 Apply/);
  const sent = calls.find((call) => call.what === "chat")?.body as { message: string; code: { folder: string } };
  assert.equal(sent.message, "fix the login bug");
  assert.equal(sent.code.folder, "/work/app");
  app.stdin.write("1");
  const applied = (await call(calls, "apply")) as { conversationId: string; calls: Array<{ name: string; callId: string }> };
  assert.equal(applied.conversationId, "c1");
  assert.equal(applied.calls[0]!.name, "ensemble_start_agent");
  assert.equal(applied.calls[0]!.callId, "call1");
  assert.match(await screenWith(app.lastFrame, /✓ Started Claude Code/), /✓ Started Claude Code/);
  app.unmount();
});

test("clicking a tab switches to it; Tab does too", async () => {
  const { api } = fakeApi();
  const app = mount(api);
  assert.match(await screenWith(app.lastFrame, /Welcome to Ensemble/), /Welcome to Ensemble/);
  // " ◆ Ensemble  " is 13 cells, " Tasks " the next 7, then a space: Chat starts at column 22 (1-based).
  app.stdin.write("\u001B[<0;24;1M");
  assert.match(await screenWith(app.lastFrame, /Ensemble Code/), /Ensemble Code/);
  app.stdin.write("\t");
  assert.match(await screenWith(app.lastFrame, /Welcome to Ensemble/), /Welcome to Ensemble/);
  app.unmount();
});

test("Chat with Claude Code: a message runs it here, the reply streams in, its question is answered in Chat, and the next message continues it", async () => {
  const { api, calls, ask } = fakeApi({
    runs: {
      "chat-1": [
        { status: "running", log: "Looking at the tests.\n· Read src/app.test.ts\n" },
        { status: "waiting_approval", log: "Looking at the tests.\n· Read src/app.test.ts\n", hold: true },
        { status: "succeeded", log: "Looking at the tests.\n· Read src/app.test.ts\nThe answer is 42.\n", summary: "The answer is 42." },
      ],
      "chat-2": [{ status: "succeeded", log: "", summary: "Committed it." }],
    },
  });
  const app = mount(api, { ...DEFAULT_PREFS, tab: "chat", engine: "claude-code" });
  try {
    await tick(100);
    assert.match(app.lastFrame()!, /Chat with Claude Code/);
    assert.match(app.lastFrame()!, /Message Claude Code/);
    for (const key of "what is the answer") app.stdin.write(key);
    await tick();
    app.stdin.write("\r");
    const task = (await call(calls, "/api/tasks")) as { title: string };
    assert.equal(task.title, "Chat: what is the answer");
    const first = (await call(calls, "/api/agent/assign")) as Record<string, unknown>;
    assert.equal(first.chat, true);
    assert.equal(first.engine, "claude-code");
    assert.equal(first.folder, "/work/app");
    assert.equal(first.instructions, "what is the answer");
    assert.equal(first.branchMode, "as-is");
    assert.equal(first.continueFromJobId, undefined);
    assert.match(await screenWith(app.lastFrame, /⏺ Read src\/app\.test\.ts/), /⏺ Read src\/app\.test\.ts/);
    // Claude Code asks something: the buttons are in Chat, and a number answers it.
    ask({ id: "q1", source: "claude", event: "question", toolName: "question", title: "Run the slow tests too?", detail: { options: ["Yes", "No"], recommended: "No", jobId: "chat-1" }, cwd: "/work/app", status: "pending", requestedAt: new Date().toISOString() });
    const asked = await screenWith(app.lastFrame, /2 ★ No/);
    assert.match(asked, /Run the slow tests too\?/);
    assert.match(asked, /2 ★ No/);
    app.stdin.write("2");
    await tick(100);
    assert.deepEqual(calls.find((call) => call.what === "decide q1")?.body, { decision: "allow", reason: "No", confirmed: true });
    assert.match(await screenWith(app.lastFrame, /The answer is 42\./), /The answer is 42\./);
    // The run has ended once the composer offers it again.
    await screenWith(app.lastFrame, /Message Claude Code/);
    // The next message continues the same chat: same task, after the first run.
    for (const key of "commit it") app.stdin.write(key);
    await tick();
    app.stdin.write("\r");
    const reply = await screenWith(app.lastFrame, /Committed it\./);
    const second = calls.filter((call) => call.what === "/api/agent/assign")[1]?.body as Record<string, unknown>;
    assert.equal(second.taskId, "new-task");
    assert.equal(second.continueFromJobId, "chat-1");
    assert.equal(calls.filter((call) => call.what === "/api/tasks").length, 1);
    assert.match(reply, /Committed it\./);
  } finally {
    app.unmount();
  }
});

test("no model key on this computer: Chat works with the agent that is installed", async () => {
  const { api } = fakeApi({ agents: [{ id: "claude", name: "Claude", app: true, cli: "/Users/me/.local/bin/claude" }] });
  const app = mount(api, { ...DEFAULT_PREFS, tab: "chat" });
  const frame = await screenWith(app.lastFrame, /Message Claude Code/);
  assert.match(frame, /working with Claude Code on your own sign-in/);
  assert.match(frame, /Chat with Claude Code/);
  app.unmount();
});

test("with a model key, Chat stays Ensemble Code", async () => {
  const { api } = fakeApi({ keys: ["anthropic"], agents: [{ id: "claude", name: "Claude", app: true, cli: "/x/claude" }] });
  const app = mount(api, { ...DEFAULT_PREFS, tab: "chat" });
  try {
    await tick(200);
    assert.match(app.lastFrame()!, /ENSEMBLE CODE/);
    assert.doesNotMatch(app.lastFrame()!, /Message Claude Code|working with Claude Code/);
  } finally {
    app.unmount();
  }
});

test("signed in, with a key only on the account: Chat stays Ensemble Code and /status says where the key is", async () => {
  const { api } = fakeApi({ accountKeys: ["google"], agents: [{ id: "claude", name: "Claude", app: true, cli: "/x/claude" }] });
  const app = mount(api, { ...DEFAULT_PREFS, tab: "chat" });
  try {
    await tick(200);
    assert.doesNotMatch(app.lastFrame()!, /working with Claude Code/, "the account's key counts as a key");
    for (const key of "/status") app.stdin.write(key);
    await tick();
    app.stdin.write("\r");
    assert.match(await screenWith(app.lastFrame, /Model keys/), /google \(your account\)/);
  } finally {
    app.unmount();
  }
});

test("a failed turn shows its error once, not again as the reply", async () => {
  const message = "No key for Google Gemini. Add one in Settings → Models (in the Ensemble CLI: /keys google), or pick a model whose provider has a key.";
  const frames: ChatFrame[] = [
    { type: "status", conversationId: "c1" },
    { type: "error", message },
    { type: "done", conversationId: "c1", content: message },
  ];
  const { api } = fakeApi({ frames, keys: ["anthropic"] });
  const app = mount(api, { ...DEFAULT_PREFS, tab: "chat" });
  try {
    await tick(100);
    for (const key of "hi") app.stdin.write(key);
    await tick();
    app.stdin.write("\r");
    const frame = await screenWith(app.lastFrame, /No key for Google Gemini/);
    await tick(100);
    assert.equal((app.lastFrame()!.match(/No key for Google Gemini/g) ?? []).length, 1, frame);
  } finally {
    app.unmount();
  }
});

test("an included refusal is a framed notice with the command that fixes it, shown once", async () => {
  const message = "Included models need this computer connected to your Ensemble account: they run on Ensemble's server and use your account's credits. Connect it in Settings → Account → This computer, or use your own API key or AI plan (Settings → Models).";
  const frames: ChatFrame[] = [
    { type: "status", conversationId: "c1" },
    { type: "error", message, code: "included_local_only" },
    { type: "done", conversationId: "c1", content: message },
  ];
  const { api } = fakeApi({ frames, keys: ["anthropic"] });
  const app = mount(api, { ...DEFAULT_PREFS, tab: "chat", chatModel: "ensemble::gpt-5-mini" });
  try {
    await tick(100);
    for (const key of "hi") app.stdin.write(key);
    await tick();
    app.stdin.write("\r");
    const frame = await screenWith(app.lastFrame, /Included models need your Ensemble account/);
    assert.match(frame, /╭─ Included models need your Ensemble account/);
    assert.match(frame, /\/login and approve/);
    assert.match(frame, /GPT-5 mini \(2025-08-07\)/, "the status line names the included model with its version");
    await tick(100);
    assert.equal((app.lastFrame()!.match(/Included models need your Ensemble account/g) ?? []).length, 1);
  } finally {
    app.unmount();
  }
});
