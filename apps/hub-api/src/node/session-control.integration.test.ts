/**
 * Ensemble Node's session control end to end against an in-memory database, with the model scripted and
 * the computer played through the device routes (or jobs updated directly): run settings as asked, sent
 * and observed, and F4 (a session continued with an explicit model and long context keeps both); a
 * setting the computer's agent cannot honour refused once; the session card's routes acting exactly as
 * the node's tools; queue order and the run each claimed run continues, also while claims, reorders,
 * cancels and steers race; the watchdog; a node answering its agent's questions only from a quoted
 * source; and Needs me requests that close with their run, refusing a late answer, first answer winning.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { refreshRunCard, refreshRunSettings, settingsLine } = await import("./settings.js");
const { checkSessions, setWatchdogForTests, WATCHDOG } = await import("./watchdog.js");
const { sessionEvents } = await import("./session-queue.js");
const { sweepExpiredDeviceLeases } = await import("../devices/lease.js");
const { WORK_ENDED } = await import("../lib/decisions.js");
after(() => h.close());

type Call = { name: string; arguments: Record<string, unknown> };
type Step = { calls?: Call[]; text?: string; then?: string };
type Seen = { slug: string; transcript: string; tools: string[] };
let script: (turn: Seen) => Step = () => ({ text: "ok" });
const seen: Seen[] = [];
/** What each tool call returned to the model, in order. */
const results: string[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(system)?.[1] ?? "?";
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current: Seen = { slug, transcript, tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name) };
  if (second) {
    const tail: string[] = [];
    for (let index = messages.length - 1; index >= 0 && messages[index]!.role === "tool"; index -= 1) tail.unshift(typeof messages[index]!.content === "string" ? (messages[index]!.content as string) : JSON.stringify(messages[index]!.content));
    results.push(...tail);
  } else seen.push(current);
  const step = script(current);
  const calls = second ? [] : (step.calls ?? []);
  const text = second ? (step.then ?? "(no reply)") : calls.length ? "" : (step.text ?? "(no reply)");
  const turn: RuntimeTurn = {
    text,
    toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })),
    model: "test-model",
    credits: 0,
    tokensIn: 10,
    tokensOut: 5,
    reasoning: "",
    raw: {},
    finishReason: "stop",
    cutOff: false,
  };
  if (text) args.onDelta?.(text);
  return turn;
});

afterEach(async () => {
  await settleTurns();
  seen.length = 0;
  results.length = 0;
  script = () => ({ text: "(no reply)" });
  // Runs a test left on a computer end, so a real test database can delete its accounts afterwards.
  await h.prisma.workspaceJob.updateMany({ where: { status: { in: ["claimed", "running", "waiting_approval", "stopping"] } }, data: { status: "cancelled", finishedAt: new Date() } });
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

async function createNode(user: HttpUser, templateId: string) {
  const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response) as { node: { id: string; slug: string }; room: { id: string } };
}

async function say(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
  return json(response).message as { id: string };
}

async function read(user: HttpUser, roomId: string) {
  const response = await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` });
  assert.equal(response.statusCode, 200, response.body);
  return json(response).messages as Array<{ id: string; kind: string; body: string; authorNodeId: string | null; data: any }>;
}

const COPILOT = {
  id: "copilot-cli",
  via: "cli",
  version: "1.0",
  signedIn: true,
  checkedAt: new Date().toISOString(),
  models: [
    { id: "gpt-6.1-sol", label: "GPT 6.1 Sol", efforts: ["low", "medium", "high", "xhigh"], contexts: [{ id: "default", label: "272K", tokens: 272_000 }, { id: "long_context", label: "1M", tokens: 1_000_000 }] },
    { id: "claude-opus-4.8", label: "Claude Opus 4.8", efforts: ["low", "medium", "high", "xhigh"], contexts: [{ id: "default", label: "200K", tokens: 200_000 }, { id: "long_context", label: "1M", tokens: 1_000_000 }] },
    { id: "gpt-5-mini", label: "GPT-5 mini", efforts: ["low", "medium", "high"], contexts: [{ id: "default", label: "128K", tokens: 128_000 }] },
  ],
};

/** A paired computer sharing the "ensemble" folder, with Claude Code as the default run profile's agent. */
async function laptopFor(user: HttpUser, name: string, agents: unknown[] = []) {
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({
    data: { userId: user.id, name, platform: "macos", appVersion: "cli-0.4.30", tokenId: key.id, capabilities: { folders: ["ensemble"], engines: ["claude-code", "codex", "copilot-cli"], sessions: 1, ...(agents.length ? { agents } : {}) } as never, lastSeenAt: new Date() },
  });
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "careful", name: "Careful", engine: "claude-code", mode: "ask", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "careful" });
  return { laptop, key };
}

type Spec = { id: string; leaseToken: string; continueFromJobId: string | null; folderLabel: string | null; model: string; reasoningEffort: string | null; contextTier?: string; steer?: { update: string } };
type Device = Awaited<ReturnType<typeof laptopFor>>["key"];

/** The computer claims its next run; null when nothing may start. */
async function claim(key: Device): Promise<Spec | null> {
  const response = await key.inject({ method: "POST", url: "/api/devices/self/claim" });
  if (response.statusCode === 204) return null;
  assert.equal(response.statusCode, 200, response.body);
  return json(response) as Spec;
}

async function complete(key: Device, spec: Spec, outcome: "succeeded" | "failed" | "cancelled" = "succeeded", totals?: Record<string, unknown>) {
  const response = await key.inject({ method: "POST", url: `/api/devices/self/jobs/${spec.id}/complete`, payload: { leaseToken: spec.leaseToken, outcome, summary: "Done.", ...(totals ? { totals } : {}) } });
  assert.equal(response.statusCode, 200, response.body);
}

const call = (name: string, args: Record<string, unknown>, then = "(no reply)"): Step => ({ calls: [{ name, arguments: args }], then });
const startCall = (title: string, prompt: string, extra: Record<string, unknown> = {}) => call("node_session_start", { title, prompt, folder: "ensemble", ...extra });
const newestJob = (user: HttpUser) => h.prisma.workspaceJob.findFirstOrThrow({ where: { userId: user.id }, orderBy: { sequence: "desc" } });
const tuning = (job: { provider: string | null; model: string; reasoningEffort: string | null; context: unknown }) => [job.provider, job.model, job.reasoningEffort, (job.context as { contextTier?: string } | null)?.contextTier ?? null];

const control = (user: HttpUser, session: string, payload: Record<string, unknown>) => user.inject({ method: "POST", url: `/api/node/sessions/${session}/control`, payload });
const sessionOf = async (user: HttpUser, session: string) => {
  const response = await user.inject({ method: "GET", url: `/api/node/sessions/${session}` });
  assert.equal(response.statusCode, 200, response.body);
  return json(response).session as { id: string; nodeId: string | null; status: string; agent: string; agentName: string; running: { jobId: string } | null; queue: Array<{ jobId: string; title: string; prompt: string | null; position: number }>; runs: Array<{ jobId: string; status: string }> };
};

test("F4: a session continued with an explicit model and long context keeps both; each setting is kept, reset or named, and recorded as asked, sent and observed", async () => {
  const mira = await person("Mira");
  const { key } = await laptopFor(mira, "Mira's laptop", [COPILOT]);
  const { room } = await createNode(mira, "assistant");
  script = () => startCall("Fix the redirect", "Fix the login redirect.", { agent: "copilot-cli", model: "GPT 6.1 Sol", effort: "Extra High", context: "long_context" });
  await say(mira, room.id, "fix the redirect with GPT 6.1 Sol, extra high, long context");
  const first = await newestJob(mira);
  assert.deepEqual(tuning(first), ["copilot-cli", "gpt-6.1-sol", "xhigh", "long_context"]);
  assert.match(first.instructions, /Ensemble already started you with gpt-6\.1-sol, xhigh thinking and the long context window\. Do not check these settings yourself\.$/, "the agent is told not to check its own settings");
  const run = await h.prisma.nodeRun.findUniqueOrThrow({ where: { jobId: first.id } });
  const recorded = run.settings as any;
  assert.deepEqual(recorded.requested, { agent: "copilot-cli", model: "GPT 6.1 Sol", effort: "Extra High", context: "long_context" }, "requested is what was asked, as asked");
  assert.deepEqual(recorded.resolved, { agent: "copilot-cli", model: "gpt-6.1-sol", effort: "xhigh", context: "long_context", fast: false }, "resolved is what the agent was sent");
  assert.deepEqual(recorded.observed, { agent: "not_reported", model: "not_reported", effort: "not_reported", context: "not_reported", fast: "not_reported" });
  const card = (await read(mira, room.id)).find((row) => row.kind === "run" && row.data.jobId === first.id)!;
  assert.deepEqual(card.data.settings, recorded, "the run card carries the same settings");
  assert.equal(card.data.session.id, first.id);
  assert.equal(card.data.session.agent, "GitHub Copilot");

  // The computer runs it and reports what Copilot said it runs with.
  const spec = (await claim(key))!;
  assert.deepEqual([spec.model, spec.reasoningEffort, spec.contextTier], ["gpt-6.1-sol", "xhigh", "long_context"]);
  const progress = await key.inject({
    method: "POST",
    url: `/api/devices/self/jobs/${spec.id}/progress`,
    payload: { leaseToken: spec.leaseToken, status: "running", progress: "Working", events: [{ kind: "engine", data: { engine: "copilot", model: "gpt-6.1-sol", session: "s-1", observed: { model: "gpt-6.1-sol", effort: "xhigh" } } }], observed: { model: "gpt-6.1-sol", effort: "xhigh" } },
  });
  assert.equal(progress.statusCode, 200, progress.body);
  assert.deepEqual((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: first.id } })).observedSettings, { model: "gpt-6.1-sol", effort: "xhigh" });
  const refreshed = await refreshRunSettings(h.prisma, await h.prisma.nodeRun.findUniqueOrThrow({ where: { jobId: first.id } }));
  assert.deepEqual(refreshed!.observed, { agent: "copilot-cli", model: "gpt-6.1-sol", effort: "xhigh", context: "not_reported", fast: "not_reported" });
  assert.equal(settingsLine(refreshed), "GitHub Copilot · GPT 6.1 Sol · Extra High effort · long context (requested); observed model gpt-6.1-sol, effort xhigh, context not reported");
  await complete(key, spec, "succeeded", { model: "gpt-6.1-sol", files: [], observed: { model: "gpt-6.1-sol", effort: "xhigh", context: "long_context", contextTokens: 1_000_000 } });
  await refreshRunCard(h.prisma, await h.prisma.nodeRun.findUniqueOrThrow({ where: { jobId: first.id } }));
  const settled = (await read(mira, room.id)).find((row) => row.kind === "run" && row.data.jobId === first.id)!;
  assert.equal(settled.data.settings.observed.context, "long_context", "the card shows what the engine reported");
  assert.match(settingsLine(settled.data.settings), /observed model gpt-6\.1-sol, effort xhigh, context long \(1M\)$/);
  const unchanged = await h.prisma.nodeRun.findUniqueOrThrow({ where: { jobId: first.id } });
  const cardBefore = await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: unchanged.messageId! } });
  await refreshRunCard(h.prisma, unchanged);
  assert.deepEqual((await h.prisma.nodeRun.findUniqueOrThrow({ where: { jobId: first.id } })).updatedAt, unchanged.updatedAt, "nothing new, nothing written");
  assert.deepEqual((await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: unchanged.messageId! } })).data, cardBefore.data);

  const send = (args: Record<string, unknown>) => call("node_session_send", { session: first.id, prompt: "Next.", delivery: "queue", ...args });
  // F4: an explicit model and long context, both kept.
  script = () => send({ model: "Claude Opus 4.8", context: "long_context", title: "Add tests" });
  await say(mira, room.id, "add tests with Claude Opus 4.8, long context");
  const f4 = await newestJob(mira);
  assert.deepEqual(tuning(f4), ["copilot-cli", "claude-opus-4.8", "xhigh", "long_context"], "F4: the model and the long context window both stick, and the thinking level carries over");
  assert.deepEqual(((await h.prisma.nodeRun.findUniqueOrThrow({ where: { jobId: f4.id } })).settings as any).requested, { model: "Claude Opus 4.8", context: "long_context" });

  // Naming only a model keeps the session's thinking level and window.
  script = () => send({ model: "gpt-6.1-sol", title: "Back to Sol" });
  await say(mira, room.id, "use GPT 6.1 Sol again");
  assert.deepEqual(tuning(await newestJob(mira)), ["copilot-cli", "gpt-6.1-sol", "xhigh", "long_context"]);

  // "default" resets just that setting to the agent's own; nothing comes from the model tier.
  script = () => send({ effort: "default", title: "Default thinking" });
  await say(mira, room.id, "use the default thinking level");
  assert.deepEqual(tuning(await newestJob(mira)), ["copilot-cli", "gpt-6.1-sol", null, "long_context"]);

  // A model without long context, while the session's long context carries over: refused once, nothing made.
  const before = await h.prisma.workspaceJob.count({ where: { userId: mira.id } });
  script = () => send({ model: "gpt-5-mini", title: "Mini" });
  await say(mira, room.id, "switch to GPT-5 mini");
  assert.equal(await h.prisma.workspaceJob.count({ where: { userId: mira.id } }), before, "no run is made with a setting quietly dropped");
  assert.ok(results.some((text) => text.includes("GitHub Copilot on Mira's laptop does not offer long context for GPT-5 mini. This session used long context, so it was kept.")), results.join("\n"));
  assert.ok(results.some((text) => text.includes("context: default")), "the refusal says what to do instead");

  // Naming the default window makes it go.
  script = () => send({ model: "gpt-5-mini", context: "default", title: "Mini" });
  await say(mira, room.id, "switch to GPT-5 mini with the default window");
  assert.deepEqual(tuning(await newestJob(mira)), ["copilot-cli", "gpt-5-mini", null, null]);

  // Starting a session the agent cannot honour is refused too.
  results.length = 0;
  const count = await h.prisma.workspaceJob.count({ where: { userId: mira.id } });
  script = () => startCall("Fast", "Do it fast.", { agent: "copilot-cli", model: "gpt-6.1-sol", fast: true });
  await say(mira, room.id, "do it in fast mode");
  assert.equal(await h.prisma.workspaceJob.count({ where: { userId: mira.id } }), count);
  assert.ok(results.some((text) => text.includes("GitHub Copilot has no fast mode.")), results.join("\n"));
});

test("the session card's routes act exactly as the node's tools: read, queue, steer, reorder, take out, replace and stop, for its owner's browser only", async () => {
  const mira = await person("Mira");
  const ben = await person("Ben");
  const { key } = await laptopFor(mira, "Mira's desktop");
  const { node, room } = await createNode(mira, "feature-engineer");
  script = () => startCall("Add the export button", "Add an export button to the reports page.");
  await say(mira, room.id, "add an export button");
  const root = await newestJob(mira);
  const running = (await claim(key))!;
  assert.equal(running.id, root.id);

  // The node queues one from the chat; its owner queues another from the card.
  script = () => call("node_session_send", { session: root.id, prompt: "Then write the docs.", delivery: "queue", title: "Write the docs" });
  await say(mira, room.id, "then write the docs");
  const docs = await newestJob(mira);
  const queued = await control(mira, root.id, { action: "queue", prompt: "Then add a changelog entry.", title: "Changelog" });
  assert.equal(queued.statusCode, 200, queued.body);
  const changelog = json(queued).jobId as string;
  const viaCard = await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: changelog } });
  assert.equal(viaCard.continueFromJobId, docs.id, "the card's message queues after the chain's end, as the tool's does");
  assert.equal((await h.prisma.nodeRun.findUniqueOrThrow({ where: { jobId: changelog } })).sessionId, root.id);
  assert.ok((await read(mira, room.id)).some((row) => row.kind === "run" && row.data.jobId === changelog), "it has its run card in the thread");

  let view = await sessionOf(mira, root.id);
  assert.equal(view.nodeId, node.id);
  assert.deepEqual([view.status, view.agent, view.agentName, view.running?.jobId], ["working", "claude-code", "Claude Code", root.id]);
  assert.deepEqual(view.queue.map((row) => [row.jobId, row.position]), [[docs.id, 1], [changelog, 2]]);
  assert.equal(view.queue[0]!.prompt, "Then write the docs.");
  const events = await sessionEvents(h.prisma, node.id, { sessionId: root.id });
  assert.deepEqual(events.map((row) => [row.action, row.actor, row.via]).reverse(), [["queue", "node", "chat"], ["queue", "owner", "card"]], "both are on the node's work board, with who did it");
  const newest = (await read(mira, room.id)).filter((row) => row.kind === "run").at(-1)!;
  assert.deepEqual(newest.data.session.queue.map((row: { jobId: string }) => row.jobId), [docs.id, changelog], "the session card shows the queue");

  // Only its owner, signed in in the browser.
  assert.equal((await ben.inject({ method: "GET", url: `/api/node/sessions/${root.id}` })).statusCode, 404);
  assert.equal((await control(ben, root.id, { action: "stop" })).statusCode, 404);
  const bridge = await h.asToken(mira, "bridge");
  assert.equal((await bridge.inject({ method: "GET", url: `/api/node/sessions/${root.id}` })).statusCode, 403);
  const full = await h.asToken(mira, "full");
  assert.equal((await full.inject({ method: "POST", url: `/api/node/sessions/${root.id}/control`, payload: { action: "stop" } })).statusCode, 403);
  assert.equal((await control(mira, root.id, { action: "queue" })).statusCode, 400, "a message needs words");

  // Reorder from the card; a stale order is refused and changes nothing.
  const reordered = await mira.inject({ method: "POST", url: `/api/node/sessions/${root.id}/queue`, payload: { order: [changelog, docs.id] } });
  assert.equal(reordered.statusCode, 200, reordered.body);
  view = await sessionOf(mira, root.id);
  assert.deepEqual(view.queue.map((row) => row.jobId), [changelog, docs.id]);
  const stale = await mira.inject({ method: "POST", url: `/api/node/sessions/${root.id}/queue`, payload: { order: [docs.id] } });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.deepEqual((await sessionOf(mira, root.id)).queue.map((row) => row.jobId), [changelog, docs.id]);
  // The node reorders from the chat through the same function.
  script = () => call("node_session_queue", { session: root.id, order: [docs.id, changelog] });
  await say(mira, room.id, "docs first after all");
  assert.deepEqual((await sessionOf(mira, root.id)).queue.map((row) => row.jobId), [docs.id, changelog]);

  // Take one out from the card: it never starts, its card says so, and its end wakes nobody.
  assert.equal((await mira.inject({ method: "DELETE", url: `/api/node/sessions/${root.id}/queue/${changelog}` })).statusCode, 204);
  assert.equal((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: changelog } })).status, "cancelled");
  assert.equal((await read(mira, room.id)).find((row) => row.kind === "run" && row.data.jobId === changelog)!.data.quiet, "cancelled");
  assert.equal((await mira.inject({ method: "DELETE", url: `/api/node/sessions/${root.id}/queue/${changelog}` })).statusCode, 409, "a message no longer queued cannot be taken out");
  assert.equal((await mira.inject({ method: "DELETE", url: `/api/node/sessions/${root.id}/queue/${randomUUID()}` })).statusCode, 404);

  // Steer from the card: a run that continues the one going on, first in the queue; the computer is asked to stop it.
  const steered = await control(mira, root.id, { action: "steer", prompt: "Export CSV, not JSON." });
  assert.equal(steered.statusCode, 200, steered.body);
  const steer = await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: json(steered).jobId } });
  assert.equal(steer.continueFromJobId, root.id);
  assert.deepEqual((steer.context as { steer?: unknown }).steer, { update: "Export CSV, not JSON." });
  assert.ok((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: root.id } })).cancelRequestedAt);
  assert.deepEqual((await sessionOf(mira, root.id)).queue.map((row) => row.jobId), [steer.id, docs.id], "the change goes before what was queued");

  // The computer ends the interrupted run and claims the change, which continues it.
  await complete(key, running, "cancelled");
  const next = (await claim(key))!;
  assert.deepEqual([next.id, next.continueFromJobId, next.steer?.update], [steer.id, root.id, "Export CSV, not JSON."]);

  // Stop, keeping the queue: only the run going on stops.
  assert.equal((await control(mira, root.id, { action: "stop", queued: "keep" })).statusCode, 200);
  assert.ok((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: steer.id } })).cancelRequestedAt);
  assert.equal((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: docs.id } })).status, "queued");
  await complete(key, next, "cancelled");

  // Replace from the card: what is queued is dropped, the replacement continues the last run that ran.
  const replaced = await control(mira, root.id, { action: "replace", prompt: "Make the export a PDF instead.", title: "PDF export" });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: docs.id } })).status, "cancelled");
  const pdf = (await claim(key))!;
  assert.deepEqual([pdf.id, pdf.continueFromJobId], [json(replaced).jobId, steer.id], "it continues the run that actually ran last");

  // Stop and drop from the card: the run stops; the node is not woken for it.
  assert.equal((await control(mira, root.id, { action: "stop" })).statusCode, 200);
  assert.ok((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: pdf.id } })).cancelRequestedAt);
  assert.equal((await read(mira, room.id)).find((row) => row.kind === "run" && row.data.jobId === pdf.id)!.data.quiet, "stopped");
  const actions = (await sessionEvents(h.prisma, node.id, { sessionId: root.id })).map((row) => `${row.action}:${row.via}`).reverse();
  assert.deepEqual(actions, ["queue:chat", "queue:card", "reorder:card", "reorder:chat", "cancel:card", "steer:card", "stop:card", "replace:card", "stop:card"]);
});

test("a session goes to another node when its node hands it over or from its card; a node takes over a session no node manages; the node that had it no longer sees it", async () => {
  const ama = await person("Ama");
  const { laptop } = await laptopFor(ama, "Ama's laptop");
  const builder = await createNode(ama, "feature-engineer");
  const writer = await createNode(ama, "tester");
  script = (turn) => (turn.slug === builder.node.slug ? startCall("Add the export button", "Add an export button to the reports page.") : { text: "(no reply)" });
  await say(ama, builder.room.id, "add an export button");
  const root = await newestJob(ama);

  // The node hands it over when asked, with a note for the node it goes to.
  script = (turn) => (turn.slug === builder.node.slug ? call("node_session_hand_over", { session: root.id, to: `@${writer.node.slug}`, note: "The docs are next." }) : { text: "(no reply)" });
  await say(ama, builder.room.id, "give that session to the tester");
  assert.match(results.at(-1)!, new RegExp(`@${writer.node.slug} manages the Claude Code session`));
  assert.equal((await sessionOf(ama, root.id)).nodeId, writer.node.id, "the card names the node it went to");
  const { sessionEventLine } = await import("./session-queue.js");
  const handed = (await sessionEvents(h.prisma, writer.node.id, { sessionId: root.id }))[0]!;
  assert.deepEqual([handed.action, handed.actor, handed.via], ["adopt", "node", "chat"]);
  assert.match(sessionEventLine(handed), new RegExp(`^@${builder.node.slug} handed you this session: “The docs are next.”`), "the new node's work board says who handed it over and why");

  // The node that had it can no longer use it; the one it went to can.
  script = (turn) => (turn.slug === builder.node.slug ? call("node_session_send", { session: root.id, prompt: "Also add a test.", delivery: "queue", title: "Test" }) : { text: "(no reply)" });
  await say(ama, builder.room.id, "also add a test");
  assert.match(results.at(-1)!, /belongs to another of your owner's nodes/);
  const { sessionsForNode } = await import("./sessions.js");
  assert.ok(!(await sessionsForNode(h.prisma, { id: builder.node.id, userId: ama.id })).some((row) => row.id === root.id));
  assert.equal((await sessionsForNode(h.prisma, { id: writer.node.id, userId: ama.id })).find((row) => row.id === root.id)?.yours, true);

  // Its card acts as that node, from that node's chat, where the new run's card goes.
  const queued = await control(ama, root.id, { action: "queue", prompt: "Then write the docs.", title: "Docs" });
  assert.equal(queued.statusCode, 200, queued.body);
  const docsRun = await h.prisma.nodeRun.findUniqueOrThrow({ where: { jobId: json(queued).jobId } });
  assert.deepEqual([docsRun.nodeId, docsRun.roomId], [writer.node.id, writer.room.id]);

  // The owner hands it back from the card; never to another account's node, nor another account's session.
  const back = await ama.inject({ method: "POST", url: `/api/node/sessions/${root.id}/hand-over`, payload: { nodeId: builder.node.id } });
  assert.equal(back.statusCode, 200, back.body);
  assert.equal((await sessionOf(ama, root.id)).nodeId, builder.node.id);
  const backLine = sessionEventLine((await sessionEvents(h.prisma, builder.node.id, { sessionId: root.id }))[0]!);
  assert.ok(backLine.startsWith(`Your owner handed you this session (@${writer.node.slug} had it) from the session card`), backLine);
  const kwame = await person("Kwame");
  const theirs = await createNode(kwame, "assistant");
  assert.equal((await ama.inject({ method: "POST", url: `/api/node/sessions/${root.id}/hand-over`, payload: { nodeId: theirs.node.id } })).statusCode, 404);
  assert.equal((await kwame.inject({ method: "POST", url: `/api/node/sessions/${root.id}/hand-over`, payload: { nodeId: theirs.node.id } })).statusCode, 404);

  // A session started elsewhere: a node takes it over without sending it anything; then only it sees it.
  const task = await h.prisma.task.create({ data: { userId: ama.id, title: "Bump the version", createdBy: "me" } });
  const elsewhere = await h.prisma.workspaceJob.create({
    data: { userId: ama.id, taskId: task.id, kind: "code", provider: "codex", model: "default", executionMode: "sandbox", deviceId: laptop.id, folderLabel: "ensemble", status: "succeeded", startedAt: new Date(), finishedAt: new Date(), summary: "Bumped the version." },
  });
  assert.equal((await sessionsForNode(h.prisma, { id: builder.node.id, userId: ama.id })).find((row) => row.id === elsewhere.id)?.yours, false);
  script = (turn) => (turn.slug === writer.node.slug ? call("node_session_adopt", { session: elsewhere.id }) : { text: "(no reply)" });
  await say(ama, writer.room.id, "look after the version bump session");
  assert.equal((await sessionsForNode(h.prisma, { id: writer.node.id, userId: ama.id })).find((row) => row.id === elsewhere.id)?.yours, true);
  assert.ok(!(await sessionsForNode(h.prisma, { id: builder.node.id, userId: ama.id })).some((row) => row.id === elsewhere.id), "other nodes no longer see it");
  assert.equal(sessionEventLine((await sessionEvents(h.prisma, writer.node.id, { sessionId: elsewhere.id }))[0]!).split(" (")[0], "You took the session over");
});

test("reordering changes the order runs start in; each claimed run continues the run that actually ran before it, and a session that never ran starts afresh in its folder", async () => {
  const kofi = await person("Kofi");
  const { key } = await laptopFor(kofi, "Kofi's laptop");
  const { room } = await createNode(kofi, "assistant");
  script = () => startCall("Refactor", "Refactor the parser.");
  await say(kofi, room.id, "refactor the parser");
  const root = await newestJob(kofi);
  await complete(key, (await claim(key))!);
  const queue: string[] = [];
  for (const title of ["One", "Two", "Three"]) queue.push(json(await control(kofi, root.id, { action: "queue", prompt: `Do ${title.toLowerCase()}.`, title })).jobId);
  assert.deepEqual((await h.prisma.workspaceJob.findMany({ where: { id: { in: queue } }, orderBy: { sequence: "asc" } })).map((row) => row.queuePosition), [1, 2, 3]);
  assert.equal((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: queue[1]! } })).continueFromJobId, queue[0], "queued, a run starts from the end of the chain");

  assert.equal((await kofi.inject({ method: "POST", url: `/api/node/sessions/${root.id}/queue`, payload: { order: [queue[2], queue[0], queue[1]] } })).statusCode, 200);
  let previous = root.id;
  for (const expected of [queue[2], queue[0], queue[1]]) {
    const spec = (await claim(key))!;
    assert.equal(spec.id, expected, "runs start in the new order");
    assert.equal(spec.continueFromJobId, previous, "and each continues the run that ran just before it");
    assert.equal((await claim(key)), null, "one run of a session at a time");
    await complete(key, spec);
    previous = spec.id;
  }

  // A session whose first run never reached the computer: its next run starts in the session's folder.
  script = () => startCall("Write the guide", "Write the guide.");
  await say(kofi, room.id, "write the guide");
  const unstarted = await newestJob(kofi);
  const after = json(await control(kofi, unstarted.id, { action: "queue", prompt: "Then proofread it.", title: "Proofread" })).jobId as string;
  await h.prisma.workspaceJob.update({ where: { id: unstarted.id }, data: { status: "cancelled", finishedAt: new Date() } });
  const fresh = (await claim(key))!;
  assert.deepEqual([fresh.id, fresh.continueFromJobId, fresh.folderLabel], [after, unstarted.id, "ensemble"], "nothing ran: it starts afresh in the folder, still in the session");
});

/** A small seeded random, so a failing interleaving can be replayed. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const shuffle = <T>(items: T[], random: () => number): T[] => {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
};

/** The session's runs form one true line: every run reaches the first, those that ran each continue the one claimed before, one at a time. */
async function assertOneLine(userId: string, rootId: string, label: string) {
  const jobs = await h.prisma.workspaceJob.findMany({ where: { userId }, orderBy: { sequence: "asc" } });
  const byId = new Map(jobs.map((row) => [row.id, row]));
  for (const job of jobs) {
    let current = job;
    const visited = new Set<string>();
    while (current.continueFromJobId) {
      assert.ok(!visited.has(current.id), `${label}: no cycle through ${current.id}`);
      visited.add(current.id);
      const parent = byId.get(current.continueFromJobId);
      assert.ok(parent, `${label}: ${current.id} continues a run of the session`);
      current = parent!;
    }
    assert.equal(current.id, rootId, `${label}: ${job.id} belongs to the session`);
  }
  assert.ok(jobs.filter((row) => ["claimed", "running", "waiting_approval", "stopping"].includes(row.status)).length <= 1, `${label}: one run on the computer at a time`);
  const ran = jobs.filter((row) => row.claimedAt).sort((a, b) => a.claimedAt!.getTime() - b.claimedAt!.getTime() || Number(a.sequence - b.sequence));
  for (let index = 1; index < ran.length; index += 1) assert.equal(ran[index]!.continueFromJobId, ran[index - 1]!.id, `${label}: run ${index} continues the run claimed before it`);
  const parents = ran.slice(1).map((row) => row.continueFromJobId);
  assert.equal(new Set(parents).size, parents.length, `${label}: no two runs continue the same run`);
  const positions = jobs.filter((row) => row.status === "queued" && row.queuePosition !== null).map((row) => row.queuePosition);
  assert.equal(new Set(positions).size, positions.length, `${label}: queue positions are distinct`);
}

test("reordering while runs are claimed, taken out and steered never breaks or branches the resume chain", async () => {
  const kofi = await person("Kofi");
  const { key } = await laptopFor(kofi, "Kofi's laptop");
  const { room } = await createNode(kofi, "assistant");
  script = () => startCall("Build", "Build it.");
  await say(kofi, room.id, "build it");
  const root = await newestJob(kofi);
  let current: Spec | null = await claim(key);
  for (let index = 1; index <= 4; index += 1) await control(kofi, root.id, { action: "queue", prompt: `Step ${index}.`, title: `Step ${index}` });
  const random = seeded(20261102);
  const allowed = new Set([200, 204, 409]);
  for (let round = 0; round < 14; round += 1) {
    const queue = (await sessionOf(kofi, root.id)).queue.map((row) => row.jobId);
    const ops: Array<() => Promise<unknown>> = [
      async () => {
        if (current) {
          const done = current;
          current = null;
          await complete(key, done, random() < 0.7 ? "succeeded" : "cancelled");
        }
        const got = await claim(key);
        if (got) {
          assert.equal(current, null, `round ${round}: a second run of the session never starts while one is on the computer`);
          current = got;
        }
      },
      async () => {
        if (queue.length < 2) return;
        const response = await kofi.inject({ method: "POST", url: `/api/node/sessions/${root.id}/queue`, payload: { order: shuffle(queue, random) } });
        assert.ok(allowed.has(response.statusCode), response.body);
      },
      async () => {
        if (queue.length < 3 || random() < 0.5) return;
        const response = await kofi.inject({ method: "DELETE", url: `/api/node/sessions/${root.id}/queue/${queue[Math.floor(random() * queue.length)]}` });
        assert.ok(allowed.has(response.statusCode), response.body);
      },
      async () => {
        const response = await control(kofi, root.id, random() < 0.5 ? { action: "steer", prompt: `Change ${round}.` } : { action: "queue", prompt: `More ${round}.`, title: `More ${round}` });
        assert.ok(allowed.has(response.statusCode), response.body);
      },
      async () => {
        const got = await claim(key);
        if (got) {
          assert.equal(current, null, `round ${round}: a second run of the session never starts while one is on the computer`);
          current = got;
        }
      },
    ];
    await Promise.all(shuffle(ops, random).map((op) => op()));
    await assertOneLine(kofi.id, root.id, `round ${round}`);
  }
  // Everything left runs, in queue order, one line to the end.
  for (let guard = 0; guard < 60; guard += 1) {
    if (current) await complete(key, current);
    current = await claim(key);
    if (!current && !(await h.prisma.workspaceJob.count({ where: { userId: kofi.id, status: "queued" } }))) break;
    assert.ok(current, "what is queued can always start once nothing runs");
  }
  assert.equal(await h.prisma.workspaceJob.count({ where: { userId: kofi.id, status: "queued" } }), 0);
  await assertOneLine(kofi.id, root.id, "at the end");
});

test("the watchdog raises a stalled run, a repeated error, tokens without changes and files outside the folder once each, as attention turns", async () => {
  const lin = await person("Lin");
  const { key } = await laptopFor(lin, "Lin's laptop");
  const { node, room } = await createNode(lin, "assistant");
  script = () => startCall("Migrate the database", "Migrate the database.");
  await say(lin, room.id, "migrate the database");
  const job = await newestJob(lin);
  const spec = (await claim(key))!;
  const original = { ...WATCHDOG };
  setWatchdogForTests({ stallMs: 10 * 60_000, repeats: 3, tokens: 5_000 });
  const attentions = async () => (await sessionEvents(h.prisma, node.id)).filter((row) => row.action === "attention").length;
  /** One watchdog pass; how many attention turns it gave this node. */
  const pass = async () => {
    const before = await attentions();
    await checkSessions(h.app);
    return (await attentions()) - before;
  };
  try {
    // The computer still checks in every half minute; that is not progress.
    const old = new Date(Date.now() - 20 * 60_000);
    await h.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "running", startedAt: old, claimedAt: old, lastProgressAt: new Date(), progress: "Running migrations" } });
    seen.length = 0;
    script = () => ({ text: "(no reply)" });
    const spoken = (await read(lin, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text").length;
    assert.equal(await pass(), 1);
    await settleTurns();
    const turn = seen.find((row) => row.transcript.includes("no progress for 20 minutes"))!;
    assert.ok(turn, "the node gets one attention turn");
    assert.match(turn.transcript, /Attention: the run “Migrate the database” in your session .+ has shown no progress for 20 minutes \(its last word: “Running migrations”\)\./);
    assert.match(turn.transcript, /not from your owner/);
    assert.equal((await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: node.id }, orderBy: { createdAt: "desc" } })).reason, "attention");
    assert.equal((await read(lin, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text").length, spoken, "nothing is said in the chat");
    assert.equal(await pass(), 0, "once per run");

    // The same failing command three times.
    for (let index = 0; index < 3; index += 1) await h.prisma.workspaceEvent.create({ data: { jobId: job.id, kind: "command", data: { command: "npx prisma migrate deploy", exitCode: 1 } } });
    await h.prisma.workspaceJob.update({ where: { id: job.id }, data: { lastProgressAt: new Date() } });
    assert.equal(await pass(), 1);
    await settleTurns();
    assert.ok(seen.some((row) => /has hit the same error 3 times: “`npx prisma migrate deploy` failed \(exit 1\)”/.test(row.transcript)));

    // Tokens spent without a file changed.
    await h.prisma.workspaceJob.update({ where: { id: job.id }, data: { tokensIn: 6_000, tokensOut: 500 } });
    assert.equal(await pass(), 1);
    await settleTurns();
    assert.ok(seen.some((row) => /has used about 7K tokens without changing a file/.test(row.transcript)));

    // A paused node hears nothing; the finding waits for it.
    await complete(key, spec, "succeeded", { files: [{ path: "~/.zshrc", added: 1, removed: 0 }, { path: "db/schema.sql", added: 3, removed: 1 }] });
    await h.prisma.nodeAgent.update({ where: { id: node.id }, data: { status: "paused" } });
    assert.equal(await pass(), 0);
    assert.deepEqual(Object.keys((await h.prisma.nodeRun.findUniqueOrThrow({ where: { jobId: job.id } })).watchdog as object).sort(), ["no_changes", "repeated_error", "stalled"], "the finding stays open");
    await h.prisma.nodeAgent.update({ where: { id: node.id }, data: { status: "active" } });
    assert.equal(await pass(), 1, "files changed outside the folder, once the node is back");
    await settleTurns();
    assert.ok(seen.some((row) => /changed files outside its folder: ~\/\.zshrc\./.test(row.transcript)));
    assert.equal(await pass(), 0);
    const raised = (await sessionEvents(h.prisma, node.id, { sessionId: job.id })).filter((row) => row.action === "attention").map((row) => (row.detail as { condition: string }).condition).sort();
    assert.deepEqual(raised, ["no_changes", "outside_files", "repeated_error", "stalled"]);
  } finally {
    setWatchdogForTests(original);
  }
});

async function ask(key: Device, spec: Spec, title: string, extra: Record<string, unknown> = {}) {
  const response = await key.inject({ method: "POST", url: `/api/devices/self/jobs/${spec.id}/ask`, payload: { leaseToken: spec.leaseToken, title, event: "question", tier: "ordinary", ...extra } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response).decisionId as string;
}

test("an agent's question of fact is answered by its node from the owner's own words; a permission, a refused topic or a made-up quote stays in Needs me", async () => {
  const ada = await person("Ada");
  const { key } = await laptopFor(ada, "Ada's laptop");
  const { node, room } = await createNode(ada, "feature-engineer");
  script = () => startCall("Fix the login redirect", "Fix the login redirect in the ensemble folder.");
  await say(ada, room.id, "Fix the login redirect in ensemble. Work on the testing branch and keep dark mode as it is.");
  const job = await newestJob(ada);
  const spec = (await claim(key))!;
  await h.prisma.workspaceJob.update({ where: { id: job.id }, data: { lastProgressAt: new Date() } });

  const branch = await ask(key, spec, "Which branch should I work on?", { options: ["main", "testing"] });
  const cost = await ask(key, spec, "The tests need the paid plan. Should I buy it?");
  const permission = await ask(key, spec, "Run `npm install`?", { event: "permission", command: "npm install" });
  seen.length = 0;
  script = (turn) =>
    turn.transcript.includes("Which branch should I work on?")
      ? call("node_answer_question", { decision: branch, answer: "testing", quote: "Work on the testing branch", source: "owner" })
      : { text: "(no reply)" };
  const before = (await sessionEvents(h.prisma, node.id)).filter((row) => row.action === "attention").length;
  await checkSessions(h.app);
  assert.equal((await sessionEvents(h.prisma, node.id)).filter((row) => row.action === "attention").length - before, 1, "only the question the node may answer reaches it");
  await settleTurns();
  const note = seen.find((row) => row.transcript.includes("Which branch should I work on?"))!;
  assert.match(note.transcript, /asks: “Which branch should I work on\?” \(options: “main”, “testing”\)\. It waits in your owner's Needs me/);
  assert.ok(note.tools.includes("node_answer_question"));
  const answered = await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: branch } });
  assert.deepEqual([answered.status, answered.decision, answered.reason], ["decided", "allow", "testing"]);
  assert.deepEqual((({ handle, source, quote }) => ({ handle, source, quote }))((answered.detail as any).answeredBy), { handle: node.slug, source: "owner", quote: "Work on the testing branch" });
  const fromComputer = json(await key.inject({ method: "GET", url: `/api/devices/self/decisions/${branch}?timeout=1` }));
  assert.deepEqual([fromComputer.status, fromComputer.reason], ["decided", "testing"], "the computer's agent gets the answer");
  const line = await h.prisma.workspaceEvent.findFirstOrThrow({ where: { jobId: job.id, kind: "needs_me_answered" } });
  assert.match((line.data as { title: string }).title, new RegExp(`^Answered by @${node.slug} from its owner's message: “testing”`));
  assert.ok((await sessionEvents(h.prisma, node.id, { sessionId: job.id })).some((row) => row.action === "answer"));

  // The node cannot answer the rest, whatever it tries.
  results.length = 0;
  const port = await ask(key, spec, "Which port should the dev server use?");
  const tries: Record<string, unknown>[] = [
    { decision: cost, answer: "Yes", quote: "Fix the login redirect in ensemble", source: "owner" },
    { decision: permission, answer: "allow", quote: "Fix the login redirect in ensemble", source: "owner" },
    { decision: port, answer: "3000", quote: "use port 3000 for the dev server", source: "owner" },
    { decision: port, answer: "3000", quote: "Work on the testing branch", source: "mission" },
  ];
  for (const args of tries) {
    script = () => call("node_answer_question", args);
    await say(ada, room.id, "answer the agent if you can");
  }
  for (const id of [cost, permission, port]) assert.equal((await h.prisma.agentDecision.findUniqueOrThrow({ where: { id } })).status, "pending", "it waits in Needs me");
  const said = results.join("\n");
  assert.match(said, /It is about cost, which only your owner decides\./);
  assert.match(said, /It asks for a permission, which only your owner gives\./);
  assert.match(said, /That quote is not in your owner's message, word for word\./);
  assert.match(said, /This run is not part of a mission\./);

  // Its owner can turn answering off: then the tool is not offered and no question reaches the node.
  const off = await ada.inject({ method: "PATCH", url: `/api/node/nodes/${node.id}`, payload: { autonomy: { answerAgentQuestions: false } } });
  assert.equal(off.statusCode, 200, off.body);
  seen.length = 0;
  script = () => ({ text: "(no reply)" });
  await ask(key, spec, "Should the button be blue?");
  const quiet = (await sessionEvents(h.prisma, node.id)).length;
  await checkSessions(h.app);
  assert.equal((await sessionEvents(h.prisma, node.id)).length, quiet, "no question reaches a node told not to answer");
  await say(ada, room.id, "anything new?");
  assert.ok(!seen.at(-1)!.tools.includes("node_answer_question"));
});

test("a run's end closes its Needs me requests in the same transaction; a late answer is refused and the first answer wins", async () => {
  const sam = await person("Sam");
  const { key } = await laptopFor(sam, "Sam's laptop");
  const { room } = await createNode(sam, "assistant");
  script = () => startCall("Ship it", "Ship it.");
  await say(sam, room.id, "ship it");
  const spec = (await claim(key))!;

  // Two answers at once: one wins, the other is told and changes nothing.
  const contested = await ask(key, spec, "Ready to continue?", { event: "permission" });
  const [allow, deny] = await Promise.all([
    sam.inject({ method: "POST", url: `/api/decisions/${contested}/decide`, payload: { decision: "allow" } }),
    sam.inject({ method: "POST", url: `/api/decisions/${contested}/decide`, payload: { decision: "deny" } }),
  ]);
  assert.deepEqual([allow.statusCode, deny.statusCode].sort(), [200, 409], `${allow.body} ${deny.body}`);
  const loser = allow.statusCode === 409 ? allow : deny;
  assert.equal(json(loser).error, "Already answered.");
  const kept = await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: contested } });
  assert.equal(kept.decision, allow.statusCode === 200 ? "allow" : "deny");

  // The run ends on the computer: its open request closes with it.
  const open = await ask(key, spec, "Which file?");
  await complete(key, spec, "failed");
  const closed = await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: open } });
  assert.deepEqual([closed.status, closed.reason], ["expired", WORK_ENDED]);
  assert.ok(closed.decidedAt);
  const late = await sam.inject({ method: "POST", url: `/api/decisions/${open}/decide`, payload: { decision: "allow" } });
  assert.equal(late.statusCode, 409);
  assert.equal(json(late).error, "This request ended with its work.");
  assert.deepEqual(await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: open } }), closed, "a late answer changes nothing");
  assert.ok(!json(await sam.inject({ method: "GET", url: "/api/decisions?status=pending" })).decisions.some((row: { id: string }) => row.id === open), "Needs me no longer lists it");

  // Every other way a run ends closes them too: a lease that ran out, a stop, a direct update.
  script = () => call("node_session_send", { session: spec.id, prompt: "Try again.", delivery: "queue", title: "Again" });
  await say(sam, room.id, "try again");
  const again = (await claim(key))!;
  const lost = await ask(key, again, "Which config?");
  await h.prisma.workspaceJob.update({ where: { id: again.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
  await sweepExpiredDeviceLeases(h.app);
  assert.deepEqual(await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: lost }, select: { status: true, reason: true } }), { status: "expired", reason: WORK_ENDED });

  const task = await h.prisma.task.create({ data: { userId: sam.id, title: "Elsewhere", createdBy: "me" } });
  const other = await h.prisma.workspaceJob.create({ data: { userId: sam.id, taskId: task.id, kind: "code", provider: "codex", model: "default", executionMode: "sandbox", status: "running", startedAt: new Date() } });
  const pending = await h.prisma.agentDecision.create({ data: { userId: sam.id, source: "ensemble", event: "question", toolName: "Question", title: "Which?", sessionId: other.id, expiresAt: new Date(Date.now() + 3600_000) } });
  const editor = await h.prisma.agentDecision.create({ data: { userId: sam.id, source: "claude", event: "PreToolUse", toolName: "Bash", title: "Run ls", sessionId: other.id, expiresAt: new Date(Date.now() + 3600_000) } });
  await h.prisma.workspaceJob.update({ where: { id: other.id }, data: { status: "cancelled", finishedAt: new Date() } });
  assert.equal((await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: pending.id } })).status, "expired");
  assert.equal((await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: editor.id } })).status, "pending", "an editor's own prompt is not a run's request");

  // A request left pending by a run that ended before requests closed with it is refused and closed when answered.
  const stale = await h.prisma.agentDecision.create({ data: { userId: sam.id, source: "ensemble", event: "question", toolName: "Question", title: "Old?", sessionId: other.id, expiresAt: new Date(Date.now() + 3600_000) } });
  const refused = await sam.inject({ method: "POST", url: `/api/decisions/${stale.id}/decide`, payload: { decision: "allow" } });
  assert.equal(refused.statusCode, 409);
  assert.equal(json(refused).error, "This request ended with its work.");
  assert.deepEqual(await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: stale.id }, select: { status: true, reason: true } }), { status: "expired", reason: WORK_ENDED });
});
