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

test("the files on a message reach a computer that takes them, only through that turn; an older one gets Ensemble's text", async () => {
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
    assert.deepEqual(seen[0], { ...seen[0], prompt: "What does the chart show?", files: list }, "the files themselves, not Ensemble's text");
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
    const file = await key.inject({ method: "GET", url: `/api/devices/self/assistant-turns/${id}/files/${fileId}` });
    assert.equal(file.statusCode, 200, file.body);
    seen.bytes = Buffer.from(file.rawPayload);
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
