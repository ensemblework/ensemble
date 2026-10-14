/**
 * The assistant on the person's own subscription, through Ensemble's real routes on an in-memory
 * database: the web hands the turn to the paired computer, the computer (simulated here) reads it
 * with its device key, calls Ensemble's tools (which run on the server, writes waiting for Apply),
 * streams its reply and finishes. Plus the subscriptions list, check and sign-in for the web.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";

let harness: HttpHarness;
// Loaded after the harness: it reads the configuration, and the harness sets Redis to memory first.
let sseHub: (typeof import("../lib/sse.js"))["sseHub"];

before(async () => {
  harness = await createHttpHarness();
  ({ sseHub } = await import("../lib/sse.js"));
});

after(async () => {
  await harness?.close();
});

const CLAUDE = { id: "claude-code", via: "app", version: "2.1.293", signedIn: true, plan: "max", models: [{ id: "haiku", label: "Haiku (latest)" }], typedModels: true, checkedAt: new Date().toISOString() };

async function pairedComputer(user: HttpUser, name: string, capabilities: Record<string, unknown>) {
  await harness.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  const key = await harness.asToken(user, "device");
  const device = await harness.prisma.device.create({ data: { userId: user.id, name, platform: "macos", appVersion: "cli-0.3.10", tokenId: key.id, lastSeenAt: new Date(), capabilities } });
  return { key, device };
}

/** Frames a computer hears on its event stream, answered by `answer`. */
function computer(deviceId: string, answer: (event: string, data: Record<string, unknown>) => Promise<void>) {
  const heard: string[] = [];
  const failures: unknown[] = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${deviceId}`) return;
    heard.push(frame.event);
    setTimeout(() => void answer(frame.event, frame.data as Record<string, unknown>).catch((error: unknown) => failures.push(error)), 5);
  });
  return { heard, failures, stop };
}

test("a chat turn on the person's Claude plan runs on their computer; the tools run here and writes wait for Apply", async () => {
  const person = await harness.asUser();
  const { key, device } = await pairedComputer(person, "Studio Mac", { assistantTurns: 1, agents: [CLAUDE] });
  const set = await person.inject({ method: "PATCH", url: "/api/settings", payload: { models: { medium: { provider: "claude-code", model: "haiku", effort: "default" } }, assistant: { defaultTier: "medium", writePolicy: "preview" } } });
  assert.equal(set.statusCode, 200, set.body);
  const task = await person.inject({ method: "POST", url: "/api/tasks", payload: { title: "Write the brief", status: "todo" } });
  assert.equal(task.statusCode, 201, task.body);

  const seen: Record<string, unknown> = {};
  const simulated = computer(device.id, async (event, data) => {
    if (event !== "assistant.turn") return;
    const id = String(data.id);
    const read = await key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${id}` });
    assert.equal(read.statusCode, 200, read.body);
    const spec = (read.json() as { spec: { agent: string; model: string; system: string; prompt: string; tools: Array<{ name: string; inputSchema: unknown }> } }).spec;
    seen.spec = spec;
    const tool = async (name: string, input: unknown) => {
      const response = await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/tool`, payload: { name, input } });
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as { text: string; isError?: boolean; tools?: unknown[] };
    };
    seen.list = await tool("hub_list_tasks", {});
    seen.create = await tool("hub_use_tool", { name: "hub_create_tasks", input: { tasks: [{ title: "Buy oat milk" }] } });
    seen.missing = await tool("hub_no_such_tool", {});
    for (const [seq, text] of [[1, "Proposed "], [2, "the task."], [2, "the task."]] as const) {
      const streamed = await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/stream`, payload: { seq, text } });
      assert.equal(streamed.statusCode, 200);
    }
    const done = await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/done`, payload: { result: { text: "Proposed the task Buy oat milk.", model: "claude-haiku-5-5", tokensIn: 120, tokensOut: 30, costUsd: null } } });
    assert.equal(done.statusCode, 200, done.body);
  });
  try {
    const turn = await person.inject({ method: "POST", url: "/api/assistant/turn", payload: { message: "Add buy oat milk to my list" } });
    assert.equal(turn.statusCode, 200, turn.body);
    assert.deepEqual(simulated.failures, []);
    assert.deepEqual(simulated.heard, ["assistant.turn"]);
    assert.doesNotMatch(turn.body, /event: error/, turn.body);

    const spec = seen.spec as { agent: string; model: string; system: string; prompt: string; tools: Array<{ name: string }> };
    assert.equal(spec.agent, "claude-code");
    assert.equal(spec.model, "haiku");
    assert.match(spec.system, /## How you run here/);
    assert.match(spec.system, /Claude subscription/);
    assert.equal(spec.prompt, "Add buy oat milk to my list");
    const names = spec.tools.map((tool) => tool.name);
    assert.ok(names.includes("hub_list_tasks") && names.includes("hub_how_to") && names.includes("hub_use_tool"), names.join(","));

    assert.match((seen.list as { text: string }).text, /Write the brief/, "a read runs on the server, in the person's space");
    assert.match((seen.create as { text: string }).text, /awaiting_approval/, "a write waits for Apply");
    assert.equal((seen.missing as { isError?: boolean }).isError, true, "a tool the turn does not have is refused");
    assert.equal(await harness.prisma.task.count({ where: { userId: person.id, title: "Buy oat milk" } }), 0, "nothing was created before Apply");

    assert.match(turn.body, /event: delta\ndata: \{"type":"delta","text":"Proposed "\}/);
    assert.equal((turn.body.match(/"text":"the task\."/g) ?? []).length, 1, "a repeated batch is shown once");
    assert.match(turn.body, /event: pending/);
    assert.match(turn.body, /Asking Claude on Studio Mac/);
    const saved = await harness.prisma.assistantMessage.findFirstOrThrow({ where: { role: "assistant", conversation: { userId: person.id } }, orderBy: { createdAt: "desc" } });
    assert.equal(saved.model, "claude-haiku-5-5");
    assert.match(saved.content, /Proposed the task Buy oat milk\./);
    assert.match(saved.content, /press Apply/);
    const calls = saved.toolCalls as Array<{ name: string; state: string }>;
    assert.deepEqual(
      calls.map((call) => [call.name, call.state]),
      [
        ["hub_list_tasks", "ok"],
        ["hub_create_tasks", "awaiting_approval"],
        ["hub_no_such_tool", "failed"],
      ],
    );
  } finally {
    simulated.stop();
  }
});

test("a turn reaches only the person's own computer, and says why when it cannot", async () => {
  const person = await harness.asUser();
  const stranger = await harness.asUser();
  const theirs = await pairedComputer(stranger, "Their Mac", { assistantTurns: 1, agents: [CLAUDE] });
  await person.inject({ method: "PATCH", url: "/api/settings", payload: { models: { medium: { provider: "claude-code", model: "haiku", effort: "default" } }, assistant: { defaultTier: "medium" } } });
  await harness.prisma.user.update({ where: { id: person.id }, data: { emailVerifiedAt: new Date() } });
  const none = await person.inject({ method: "POST", url: "/api/assistant/turn", payload: { message: "hello" } });
  assert.match(none.body, /event: error/);
  assert.match(none.body, /Install Ensemble there/, "someone else's computer is never used");

  const old = await pairedComputer(person, "Old Mac", { code: true });
  const update = await person.inject({ method: "POST", url: "/api/assistant/turn", payload: { message: "hello" } });
  assert.match(update.body, /Update Ensemble on Old Mac/);

  // A stranger's computer cannot read or answer the person's turn.
  await harness.prisma.device.update({ where: { id: old.device.id }, data: { capabilities: { assistantTurns: 1, agents: [CLAUDE] } } });
  let turnId = "";
  const simulated = computer(old.device.id, async (event, data) => {
    if (event !== "assistant.turn") return;
    turnId = String(data.id);
    const stolen = await theirs.key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${turnId}` });
    assert.equal(stolen.statusCode, 410);
    const forged = await theirs.key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${turnId}/tool`, payload: { name: "hub_list_tasks", input: {} } });
    assert.equal(forged.statusCode, 410);
    await old.key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${turnId}` });
    await old.key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${turnId}/done`, payload: { error: { problem: "signed_out", message: "Claude is not signed in on this computer." } } });
  });
  try {
    const signedOut = await person.inject({ method: "POST", url: "/api/assistant/turn", payload: { message: "hello" } });
    assert.deepEqual(simulated.failures, []);
    assert.ok(turnId);
    assert.match(signedOut.body, /event: error/);
    assert.match(signedOut.body, /Claude is not signed in on this computer/);
    const late = await old.key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${turnId}/stream`, payload: { seq: 1, text: "late" } });
    assert.equal(late.statusCode, 410, "an ended turn takes nothing more");
  } finally {
    simulated.stop();
  }
});

test("the web lists the person's computers and their subscriptions, and asks a computer to check again or sign in", async () => {
  const person = await harness.asUser();
  const stranger = await harness.asUser();
  const mine = await pairedComputer(person, "Studio Mac", { assistantTurns: 1, agents: [CLAUDE, { bad: "row" }] });
  const theirs = await pairedComputer(stranger, "Their Mac", { assistantTurns: 1, agents: [CLAUDE] });
  const listed = await person.inject({ method: "GET", url: "/api/subscriptions" });
  assert.equal(listed.statusCode, 200, listed.body);
  const view = listed.json() as { computers: Array<{ id: string; name: string; online: boolean; ready: boolean; agents: Array<{ id: string }> }>; preferred: string | null };
  assert.deepEqual(
    view.computers.map((row) => [row.name, row.online, row.ready, row.agents.map((agent) => agent.id).join(",")]),
    [["Studio Mac", true, true, "claude-code"]],
    "a row that does not parse is left out; another person's computer is not listed",
  );
  const frames = computer(mine.device.id, async () => undefined);
  try {
    const check = await person.inject({ method: "POST", url: "/api/subscriptions/check", payload: { deviceId: mine.device.id } });
    assert.equal(check.statusCode, 202, check.body);
    const signIn = await person.inject({ method: "POST", url: "/api/subscriptions/sign-in", payload: { deviceId: mine.device.id, agent: "codex" } });
    assert.equal(signIn.statusCode, 202, signIn.body);
    assert.match(signIn.body, /sign-in window is opening on Studio Mac/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(frames.heard, ["agents.refresh", "agents.signin"]);
    const foreign = await person.inject({ method: "POST", url: "/api/subscriptions/sign-in", payload: { deviceId: theirs.device.id, agent: "codex" } });
    assert.equal(foreign.statusCode, 404);
    const wrong = await person.inject({ method: "POST", url: "/api/subscriptions/sign-in", payload: { deviceId: mine.device.id, agent: "gemini" } });
    assert.equal(wrong.statusCode, 400);
  } finally {
    frames.stop();
  }
});
