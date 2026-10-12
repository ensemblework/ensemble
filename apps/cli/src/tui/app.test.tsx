import assert from "node:assert/strict";
import test from "node:test";
import { render } from "ink-testing-library";
import { App } from "./app.js";
import type { ChatFrame, Decision, LocalApi } from "./local.js";
import { DEFAULT_PREFS } from "./prefs.js";
import { empty, fakeApi, job, ops, screenWith, tick } from "./testing.js";

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
  const frame = await screenWith(app.lastFrame, /2 ★ Postgres/);
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
    await tick(150);
    const task = calls.find((call) => call.what === "/api/tasks")?.body as { title: string };
    assert.equal(task.title, "Chat: what is the answer");
    const first = calls.find((call) => call.what === "/api/agent/assign")?.body as Record<string, unknown>;
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
