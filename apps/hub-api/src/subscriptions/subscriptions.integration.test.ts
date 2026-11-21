/**
 * The assistant on the person's own subscription, through Ensemble's real routes on an in-memory
 * database: the web hands the turn to the paired computer, the computer (simulated here) reads it
 * with its device key, calls Ensemble's tools (which run on the server, writes waiting for Apply),
 * streams its reply and finishes. Plus the subscriptions list, check and sign-in for the web.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type { Prisma } from "@prisma/client";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { subscriptionRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

let harness: HttpHarness;
// Loaded after the harness: it reads the configuration, and the harness sets Redis to memory first.
let sseHub: (typeof import("../lib/sse.js"))["sseHub"];

before(async () => {
  harness = await createHttpHarness();
  ({ sseHub } = await import("../lib/sse.js"));
});

const covered = new Map<string, Set<RouteCheck>>();
function claim(route: string, ...checks: RouteCheck[]): void {
  const set = covered.get(route) ?? new Set<RouteCheck>();
  for (const check of checks) set.add(check);
  covered.set(route, set);
}

after(async () => {
  try {
    for (const [route, checks] of Object.entries(subscriptionRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness?.close();
  }
});

const CLAUDE = { id: "claude-code", via: "app", version: "2.1.293", signedIn: true, plan: "max", models: [{ id: "haiku", label: "Haiku (latest)" }], typedModels: true, checkedAt: new Date().toISOString() };

async function pairedComputer(user: HttpUser, name: string, capabilities: Record<string, unknown>) {
  await harness.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  const key = await harness.asToken(user, "device");
  const device = await harness.prisma.device.create({ data: { userId: user.id, name, platform: "macos", appVersion: "cli-0.3.10", tokenId: key.id, lastSeenAt: new Date(), capabilities: capabilities as Prisma.InputJsonValue } });
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
    claim("GET /api/devices/self/assistant-turns/:id", "happy-path");
    const spec = (read.json() as { spec: { agent: string; model: string; system: string; prompt: string; tools: Array<{ name: string; inputSchema: unknown }> } }).spec;
    seen.spec = spec;
    const tool = async (name: string, input: unknown) => {
      const response = await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/tool`, payload: { name, input } });
      assert.equal(response.statusCode, 200, response.body);
      claim("POST /api/devices/self/assistant-turns/:id/tool", "happy-path");
      return response.json() as { text: string; isError?: boolean; tools?: unknown[] };
    };
    seen.list = await tool("hub_list_tasks", {});
    seen.create = await tool("hub_use_tool", { name: "hub_create_tasks", input: { tasks: [{ title: "Buy oat milk" }] } });
    seen.missing = await tool("hub_no_such_tool", {});
    for (const [seq, text] of [[1, "Proposed "], [2, "the task."], [2, "the task."]] as const) {
      const streamed = await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/stream`, payload: { seq, text } });
      assert.equal(streamed.statusCode, 200);
    }
    claim("POST /api/devices/self/assistant-turns/:id/stream", "happy-path");
    const done = await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/done`, payload: { result: { text: "Proposed the task Buy oat milk.", model: "claude-haiku-5-5", tokensIn: 120, tokensOut: 30, costUsd: null } } });
    assert.equal(done.statusCode, 200, done.body);
    claim("POST /api/devices/self/assistant-turns/:id/done", "happy-path");
  });
  try {
    const turn = await person.inject({ method: "POST", url: "/api/assistant/turn", payload: { message: "Add buy oat milk to my list" } });
    assert.equal(turn.statusCode, 200, turn.body);
    assert.deepEqual(simulated.failures, []);
    assert.deepEqual(simulated.heard, ["assistant.turn"]);
    assert.doesNotMatch(turn.body, /event: error/, turn.body);
    assert.match(turn.body, /credentialSource/);
    assert.match(turn.body, /Claude subscription/);

    const spec = seen.spec as { agent: string; model: string; system: string; prompt: string; tools: Array<{ name: string }> };
    assert.equal(spec.agent, "claude-code");
    assert.equal(spec.model, "haiku");
    assert.match(spec.system, /You run on their own Claude subscription/);
    assert.match(spec.prompt, /^<context>\nToday is .*\n<\/context>\n\nAdd buy oat milk to my list$/s, "the message's context, then the message");
    assert.equal((spec as { session?: unknown }).session, undefined, "a computer before sessions gets no session");
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
    assert.match(saved.content, /press Apply/i);
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
    claim("GET /api/devices/self/assistant-turns/:id", "isolation");
    claim("POST /api/devices/self/assistant-turns/:id/tool", "isolation");
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

test("the files on a message reach a computer that takes them, only through that turn; an older one gets the fallback note", async () => {
  const FILE_ROUTE = "GET /api/devices/self/assistant-turns/:id/files/:fileId";
  const person = await harness.asUser();
  const stranger = await harness.asUser();
  const mine = await pairedComputer(person, "Studio Mac", { assistantTurns: 2, agents: [CLAUDE] });
  const theirs = await pairedComputer(stranger, "Their Mac", { assistantTurns: 2, agents: [CLAUDE] });
  const { runSubscriptionTurn } = await import("./turn.js");
  const { loadSettings } = await import("../lib/settings.js");
  const picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
  const list = [
    { id: "file-chart", name: "chart.png", mediaType: "image/png", kind: "image" as const, size: picture.byteLength },
    { id: "file-gone", name: "brief.pdf", mediaType: "application/pdf", kind: "pdf" as const, size: 900, text: "The brief." },
  ];
  const read = async (id: string) => (id === "file-chart" ? picture : null);
  const ask = async () =>
    runSubscriptionTurn({
      userId: person.id,
      settings: await loadSettings(harness.prisma, person.id),
      agent: "claude-code",
      model: "haiku",
      system: "You are the Ensemble assistant.",
      prompt: "What does the chart show?",
      tools: [],
      call: async () => ({ text: "{}" }),
      files: { list, read, fallback: "## Attached files\nchart.png: a picture. brief.pdf: The brief." },
      prisma: harness.prisma,
    });

  const seen: Array<{ prompt: string; files?: unknown }> = [];
  let turnId = "";
  const simulated = computer(mine.device.id, async (event, data) => {
    if (event !== "assistant.turn") return;
    turnId = String(data.id);
    const turn = await mine.key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${turnId}` });
    const spec = (turn.json() as { spec: { prompt: string; files?: Array<{ id: string }> } }).spec;
    seen.push(spec);
    if (spec.files) {
      const file = await mine.key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${turnId}/files/file-chart` });
      assert.equal(file.statusCode, 200, file.body);
      assert.equal(file.headers["content-type"], "image/png");
      assert.equal(file.headers["cache-control"], "no-store");
      assert.equal(file.headers["x-content-type-options"], "nosniff");
      assert.deepEqual(new Uint8Array(file.rawPayload), picture);
      claim(FILE_ROUTE, "happy-path");
      const gone = await mine.key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${turnId}/files/file-gone` });
      assert.equal(gone.statusCode, 404, "a file Ensemble can no longer read");
      const other = await mine.key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${turnId}/files/some-other-file` });
      assert.equal(other.statusCode, 404, "only the turn's own files");
      claim(FILE_ROUTE, "unknown-id");
      const stolen = await theirs.key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${turnId}/files/file-chart` });
      assert.equal(stolen.statusCode, 410, "another computer cannot read the turn's files");
      claim(FILE_ROUTE, "isolation");
    }
    const done = await mine.key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${turnId}/done`, payload: { result: { text: "A rising line.", model: "claude-haiku-5-5", tokensIn: 1, tokensOut: 1, costUsd: null } } });
    assert.equal(done.statusCode, 200, done.body);
  });
  try {
    const answered = await ask();
    assert.equal(answered.text, "A rising line.");
    assert.deepEqual(simulated.failures, []);
    assert.deepEqual(seen[0], { ...seen[0], prompt: "What does the chart show?", files: list }, "the files themselves, no fallback note");
    const ended = await mine.key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${turnId}/files/file-chart` });
    assert.equal(ended.statusCode, 410, "an ended turn's files are gone");

    await harness.prisma.device.update({ where: { id: mine.device.id }, data: { capabilities: { assistantTurns: 1, agents: [CLAUDE] } } });
    await ask();
    assert.deepEqual(simulated.failures, []);
    assert.equal(seen[1]!.files, undefined, "an older computer is not sent files it cannot fetch");
    assert.equal(seen[1]!.prompt, "What does the chart show?\n\n## Attached files\nchart.png: a picture. brief.pdf: The brief.");
  } finally {
    simulated.stop();
  }
});

test("a chat message's attached file reaches the person's agent as the file itself, named in the prompt", async () => {
  const person = await harness.asUser();
  const { key, device } = await pairedComputer(person, "Studio Mac", { assistantTurns: 2, agents: [CLAUDE] });
  const set = await person.inject({ method: "PATCH", url: "/api/settings", payload: { models: { medium: { provider: "claude-code", model: "haiku", effort: "default" } }, assistant: { defaultTier: "medium" } } });
  assert.equal(set.statusCode, 200, set.body);
  const notes = Buffer.from("The backup window is Sunday 02:00 UTC.", "utf8");
  const upload = await person.inject({ method: "POST", url: "/api/documents", payload: { filename: "notes.md", mediaType: "text/markdown", dataBase64: notes.toString("base64"), summarize: false } });
  assert.equal(upload.statusCode, 201, upload.body);
  const fileId = upload.json().file.id as string;

  const seen: { spec?: { prompt: string; files?: Array<{ id: string; name: string; kind: string; text?: string }> }; bytes?: Buffer } = {};
  const simulated = computer(device.id, async (event, data) => {
    if (event !== "assistant.turn") return;
    const id = String(data.id);
    seen.spec = (await key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${id}` })).json().spec;
    if (seen.spec?.files) {
      const file = await key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${id}/files/${fileId}` });
      assert.equal(file.statusCode, 200, file.body);
      seen.bytes = Buffer.from(file.rawPayload);
    }
    await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/done`, payload: { result: { text: "Sunday 02:00 UTC.", model: "claude-haiku-5-5", tokensIn: 1, tokensOut: 1, costUsd: null } } });
  });
  try {
    const turn = await person.inject({ method: "POST", url: "/api/assistant/turn", payload: { message: "When is the backup window?", mentions: [{ kind: "file", id: fileId, label: "notes.md" }] } });
    assert.equal(turn.statusCode, 200, turn.body);
    assert.deepEqual(simulated.failures, []);
    assert.deepEqual(seen.spec?.files?.map((file) => [file.id, file.name, file.kind]), [[fileId, "notes.md", "text"]]);
    assert.match(seen.spec!.prompt, /These come with this message as files: “notes\.md”/);
    assert.doesNotMatch(seen.spec!.prompt, /02:00/, "the prompt names the file; the agent reads the file");
    assert.deepEqual(seen.bytes, notes, "the computer fetches the original bytes");

    await harness.prisma.device.update({ where: { id: device.id }, data: { capabilities: { assistantTurns: 1, agents: [CLAUDE] } } });
    delete seen.spec;
    const older = await person.inject({ method: "POST", url: "/api/assistant/turn", payload: { message: "When is the backup window?", mentions: [{ kind: "file", id: fileId, label: "notes.md" }] } });
    assert.equal(older.statusCode, 200, older.body);
    const olderSpec = seen.spec as { prompt: string; files?: unknown } | undefined;
    assert.equal(olderSpec?.files, undefined);
    assert.match(olderSpec!.prompt, /“notes\.md”\) could not be given to you: the Ensemble on the person's computer is too old to receive files/);
    assert.doesNotMatch(olderSpec!.prompt, /02:00/, "an older computer is told to update, not given Ensemble's text");
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
  claim("GET /api/subscriptions", "happy-path", "isolation");
  const frames = computer(mine.device.id, async () => undefined);
  try {
    const check = await person.inject({ method: "POST", url: "/api/subscriptions/check", payload: { deviceId: mine.device.id } });
    assert.equal(check.statusCode, 202, check.body);
    claim("POST /api/subscriptions/check", "happy-path");
    const signIn = await person.inject({ method: "POST", url: "/api/subscriptions/sign-in", payload: { deviceId: mine.device.id, agent: "codex" } });
    assert.equal(signIn.statusCode, 202, signIn.body);
    assert.match(signIn.body, /sign-in window is opening on Studio Mac/);
    claim("POST /api/subscriptions/sign-in", "happy-path");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(frames.heard, ["agents.refresh", "agents.signin"]);
    const foreign = await person.inject({ method: "POST", url: "/api/subscriptions/sign-in", payload: { deviceId: theirs.device.id, agent: "codex" } });
    assert.equal(foreign.statusCode, 404);
    claim("POST /api/subscriptions/sign-in", "isolation");
    const wrong = await person.inject({ method: "POST", url: "/api/subscriptions/sign-in", payload: { deviceId: mine.device.id, agent: "gemini" } });
    assert.equal(wrong.statusCode, 400);
    claim("POST /api/subscriptions/sign-in", "invalid-input");
  } finally {
    frames.stop();
  }
});

test("an agent's app there without the agent is listed with the computer, and Set up goes to that computer only", async () => {
  const person = await harness.asUser();
  const stranger = await harness.asUser();
  // The Linux homeserver: the Cursor app without Cursor's agent; an app this server does not know is left out.
  const mine = await pairedComputer(person, "Homeserver", { assistantTurns: 3, agents: [CLAUDE], agentApps: ["cursor-app", "zed-app"] });
  const older = await pairedComputer(person, "Old Mac", { assistantTurns: 3, agents: [] });
  const theirs = await pairedComputer(stranger, "Their Mac", { assistantTurns: 3, agents: [], agentApps: ["cursor-app"] });
  const listed = await person.inject({ method: "GET", url: "/api/subscriptions" });
  assert.equal(listed.statusCode, 200, listed.body);
  const view = listed.json() as { computers: Array<{ name: string; apps: string[] }> };
  assert.deepEqual(view.computers.map((row) => [row.name, row.apps]).sort(), [["Homeserver", ["cursor-app"]], ["Old Mac", []]]);
  const frames = computer(mine.device.id, async () => undefined);
  try {
    const setUp = await person.inject({ method: "POST", url: "/api/subscriptions/set-up", payload: { deviceId: mine.device.id, agent: "cursor-agent" } });
    assert.equal(setUp.statusCode, 202, setUp.body);
    assert.match(setUp.body, /A terminal window is opening on Homeserver: it installs Cursor's agent with Cursor's installer, then opens Cursor's sign-in/);
    claim("POST /api/subscriptions/set-up", "happy-path");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(frames.heard, ["agents.setup"]);
    const noApp = await person.inject({ method: "POST", url: "/api/subscriptions/set-up", payload: { deviceId: mine.device.id, agent: "copilot-cli" } });
    assert.equal(noApp.statusCode, 409);
    assert.match(noApp.body, /Homeserver has no app Ensemble can set GitHub Copilot up from/);
    const tooOld = await person.inject({ method: "POST", url: "/api/subscriptions/set-up", payload: { deviceId: older.device.id, agent: "cursor-agent" } });
    assert.equal(tooOld.statusCode, 409);
    assert.match(tooOld.body, /Update Ensemble on Old Mac/);
    const foreign = await person.inject({ method: "POST", url: "/api/subscriptions/set-up", payload: { deviceId: theirs.device.id, agent: "cursor-agent" } });
    assert.equal(foreign.statusCode, 404);
    claim("POST /api/subscriptions/set-up", "isolation");
    const wrong = await person.inject({ method: "POST", url: "/api/subscriptions/set-up", payload: { deviceId: mine.device.id, agent: "cursor" } });
    assert.equal(wrong.statusCode, 400);
    claim("POST /api/subscriptions/set-up", "invalid-input");
    assert.deepEqual(frames.heard, ["agents.setup"], "nothing else reached the computer");
  } finally {
    frames.stop();
  }
});

// ── an Ensemble Node's turn on its owner's plan ────────────────────────────────────────────────

type NodeSpec = {
  system: string;
  prompt: string;
  maxTurns?: number;
  ownTools?: boolean;
  node?: { id: string; slug: string; mission: string; attended: boolean; trusted: boolean; sudo: boolean };
  session?: { key: string; position?: number } | null;
};
type RoomMessage = { id: string; kind: string; body: string; authorNodeId: string | null; data: Record<string, any> | null };

/** A node of `user` on their Claude plan, with its direct chat. */
async function nodeOnPlan(user: HttpUser) {
  const made = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(made.statusCode, 201, made.body);
  const { node, room } = made.json() as { node: { id: string; slug: string }; room: { id: string } };
  await harness.prisma.nodeAgent.update({ where: { id: node.id }, data: { provider: "claude-code", model: "haiku" } });
  return { node, room };
}

async function postTo(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
}

async function roomMessages(user: HttpUser, roomId: string): Promise<RoomMessage[]> {
  return (await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` })).json().messages as RoomMessage[];
}

async function until<T>(check: () => Promise<T | null | undefined | false>, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const finished = (text: string) => ({ result: { text, model: "claude-haiku-5-5", tokensIn: 1, tokensOut: 1, costUsd: null } });

test("a node's turn on its owner's plan keeps the agent's own tools where the computer judges them, with no turn limit; an older computer keeps Ensemble's tools and 64 turns", async () => {
  const { settleTurns } = await import("../node/queue.js");
  const mira = await harness.asUser();
  const { key, device } = await pairedComputer(mira, "Mira's laptop", { assistantTurns: 5, agents: [CLAUDE], nodeTools: 1 });
  const { node, room } = await nodeOnPlan(mira);
  const specs: NodeSpec[] = [];
  const simulated = computer(device.id, async (event, data) => {
    if (event !== "assistant.turn") return;
    const id = String(data.id);
    specs.push(((await key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${id}` })).json() as { spec: NodeSpec }).spec);
    await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/done`, payload: finished("Done.") });
  });
  try {
    await postTo(mira, room.id, "Tidy the notes folder");
    await settleTurns();
    assert.deepEqual(simulated.failures, []);
    const spec = specs[0]!;
    assert.equal(spec.ownTools, true, "its shell, files and web stay on");
    assert.equal(spec.maxTurns, undefined, "no turn limit of Ensemble's own");
    assert.deepEqual(spec.node, { id: node.id, slug: node.slug, mission: `conversation:${room.id}:shared`, attended: true, trusted: true, sudo: true });
    assert.match(spec.system, /all your own tools: your shell, files and web/);
    assert.match(spec.system, /once per folder, on a card in this chat/);
    assert.match(spec.system, /computer_sudo: your owner types their password on a card/);
    assert.doesNotMatch(spec.system, /reached only through Ensemble's tools/);

    await harness.prisma.device.update({ where: { id: device.id }, data: { capabilities: { assistantTurns: 4, agents: [CLAUDE], nodeTools: 1 } } });
    await postTo(mira, room.id, "And the drafts folder");
    await settleTurns();
    const older = specs[1]!;
    assert.deepEqual([older.ownTools, older.node, older.maxTurns], [undefined, undefined, 64], "Ensemble's tools only, and the most turns it takes");
    assert.match(older.system, /reached only through Ensemble's tools/);
    assert.deepEqual(simulated.failures, []);
  } finally {
    simulated.stop();
  }
});

test("an own call the node's policy asks about waits for its owner's card: answered in time it goes on; not answered, the turn parks and the answer resumes the same session", async () => {
  const { settleTurns } = await import("../node/queue.js");
  const waitSetting = process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS;
  const mira = await harness.asUser();
  await harness.prisma.user.update({ where: { id: mira.id }, data: { name: "Mira" } });
  const { key, device } = await pairedComputer(mira, "Mira's laptop", { assistantTurns: 5, agents: [CLAUDE], nodeTools: 1 });
  const theirs = await pairedComputer(await harness.asUser(), "Their Mac", { assistantTurns: 5, agents: [CLAUDE] });
  const { node, room } = await nodeOnPlan(mira);
  const site = { capability: "files", target: "/home/mira/projects/site", label: "~/projects/site", scope: "folder", operation: "Change: ~/projects/site/index.html", what: "change index.html" };
  const blog = { ...site, target: "/home/mira/projects/blog", label: "~/projects/blog", operation: "Change: ~/projects/blog/post.md", what: "change post.md" };
  const specs: NodeSpec[] = [];
  const answers: Array<{ decision: string; message?: string; waiting?: boolean; grant?: unknown }> = [];
  const frames: Array<{ frame: { type: string; call?: { name: string; state: string; summary?: string } } }> = [];
  const listen = sseHub.onFrame(({ userId, frame }) => {
    if (userId === `node:${mira.id}` && frame.event === "node.frame") frames.push(frame.data as (typeof frames)[number]);
  });
  // The agent's first two turns each want to change a file outside the node's folder; then it says what it did.
  const simulated = computer(device.id, async (event, data) => {
    if (event !== "assistant.turn") return;
    const id = String(data.id);
    specs.push(((await key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${id}` })).json() as { spec: NodeSpec }).spec);
    const turn = specs.length;
    if (turn === 1) {
      const forged = await theirs.key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/ask`, payload: site });
      assert.equal(forged.statusCode, 410, "another computer cannot ask on this turn");
      claim("POST /api/devices/self/assistant-turns/:id/ask", "isolation");
    }
    if (turn <= 2) {
      const asked = await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/ask`, payload: turn === 1 ? site : blog });
      assert.equal(asked.statusCode, 200, asked.body);
      claim("POST /api/devices/self/assistant-turns/:id/ask", "happy-path");
      answers.push(asked.json());
      if (answers.at(-1)!.decision !== "allow") {
        await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/done`, payload: finished("I will wait for your answer.") });
        return;
      }
    }
    const tools = [{ id: `edit-${turn}`, name: "Edit", summary: turn === 1 ? "~/projects/site/index.html" : "~/projects/blog/post.md", phase: "end", ok: true, acts: true }];
    await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/stream`, payload: { seq: 1, text: "", tools } });
    await key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${id}/done`, payload: finished("Done.") });
  });
  const replies = async () => (await roomMessages(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text");
  const pendingCard = () => until(async () => (await roomMessages(mira, room.id)).find((row) => row.kind === "approval" && row.data?.type === "computer" && row.data?.status === "pending"), "the owner's card");
  try {
    await postTo(mira, room.id, "Fix the title on my site");
    const card = await pendingCard();
    assert.deepEqual([card.data!.options, card.data!.call, card.data!.label, card.data!.capability], [["Allow", "Allow for this run"], site.operation, site.label, "files"], "one press, with exactly what would change");
    assert.match(card.body, /@assistant wants to change files in ~\/projects\/site on Mira's laptop/);
    assert.deepEqual((await harness.prisma.nodeMessage.findUniqueOrThrow({ where: { id: card.id } })).visibleTo, [mira.id], "for the owner only");
    const decided = await mira.inject({ method: "POST", url: `/api/decisions/${card.data!.decisionId}/decide`, payload: { decision: "allow", scope: "once", reason: "Allow for this run" } });
    assert.equal(decided.statusCode, 200, decided.body);
    await settleTurns();
    assert.deepEqual(simulated.failures, []);
    assert.deepEqual(answers[0], { decision: "allow", grant: { id: card.data!.decisionId, scope: "mission", target: site.target } });
    assert.equal((await replies()).at(-1)!.body, "Done.");
    const shown = frames.find((row) => row.frame.type === "tool" && row.frame.call?.name === "Edit");
    assert.deepEqual(shown?.frame.call, { id: "edit-1", name: "Edit", state: "ok", summary: "~/projects/site/index.html" }, "the agent's own call reaches its owner's chat");
    await until(async () => {
      const first = await harness.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: node.id }, orderBy: { createdAt: "asc" } });
      return (first.receipts as Array<{ name: string; state: string }>).some((row) => row.name === "Edit" && row.state === "ok");
    }, "the call in the turn's receipts");

    process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS = "300";
    await postTo(mira, room.id, "Now write the blog post");
    await settleTurns();
    assert.deepEqual([answers[1]!.decision, answers[1]!.waiting], ["deny", true]);
    assert.match(answers[1]!.message!, /^Waiting for Mira to answer the card about change post\.md in ~\/projects\/blog\. Stop here: end your turn now without a reply\./);
    assert.equal((await replies()).length, 1, "the parked turn posts nothing");
    const conversation = (await harness.prisma.nodeRoomMember.findFirstOrThrow({ where: { roomId: room.id, nodeId: node.id } })).conversationId!;
    const note = await harness.prisma.assistantMessage.findFirstOrThrow({ where: { conversationId: conversation, role: "assistant" }, orderBy: { createdAt: "desc" } });
    assert.equal(note.content, "Waiting for Mira to answer the card about change post.md in ~/projects/blog.");

    const later = await pendingCard();
    assert.equal(later.data!.call, blog.operation);
    const allowed = await mira.inject({ method: "POST", url: `/api/decisions/${later.data!.decisionId}/decide`, payload: { decision: "allow", scope: "once", reason: "Allow" } });
    assert.equal(allowed.statusCode, 200, allowed.body);
    await until(async () => specs.length === 3, "the node to be woken");
    await settleTurns();
    const woken = specs[2]!;
    assert.match(woken.prompt, /Allowed: change post\.md in ~\/projects\/blog\. Do it now\./);
    assert.equal(woken.session?.key, specs[1]!.session?.key, "in the same agent session");
    assert.equal(woken.session?.position, specs[1]!.session!.position! + 2, "where the parked turn left it");
    assert.equal((await replies()).at(-1)!.body, "Done.");
    const settled = (await roomMessages(mira, room.id)).find((row) => row.id === later.id)!;
    assert.deepEqual([settled.data!.status, settled.data!.answer], ["allowed", "Allow"]);
    assert.deepEqual(simulated.failures, []);
  } finally {
    if (waitSetting === undefined) delete process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS;
    else process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS = waitSetting;
    listen();
    simulated.stop();
  }
});
