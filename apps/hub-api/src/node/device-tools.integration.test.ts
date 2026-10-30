/**
 * A node's own tools on its owner's computer, from the server's side (node/device-tools.ts): each call
 * goes to the computer as `node.tool.request` and comes back as its answer; the first use of a folder
 * asks the owner once in Needs me, and the answer reaches the computer with the node's next call and
 * wakes the node; unattended calls say so; an older computer is asked to update; a long command runs
 * on in the background and wakes its node once when it ends. Node runs get only the secrets they name.
 * The computer is simulated: it hears frames on its event stream and answers with its device key.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { sseHub } = await import("../lib/sse.js");
const { deviceTools } = await import("./device-tools.js");
const { postMessage } = await import("./store.js");
after(() => h.close());

type Call = { name: string; arguments: Record<string, unknown> };
type Seen = { slug: string; transcript: string; tools: string[] };
let script: (turn: Seen) => { calls?: Call[]; text?: string; then?: string } = () => ({ text: "ok" });
const seen: Seen[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(system)?.[1] ?? "?";
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current: Seen = { slug, transcript, tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name) };
  if (!second) seen.push(current);
  const step = script(current);
  const calls = second ? [] : (step.calls ?? []);
  const text = second ? (step.then ?? "Done.") : calls.length ? "" : (step.text ?? "ok");
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
  script = () => ({ text: "ok" });
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

/** Mira's computer, new enough for node tools, with her run profile in the mode given. */
async function laptopFor(user: HttpUser, mode: "ask" | "unattended" = "ask", capabilities: Record<string, unknown> = { nodeTools: 1 }) {
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({ data: { userId: user.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: { folders: ["app"], engines: ["claude-code"], ...capabilities } as never } });
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", mode, delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "main" });
  return { laptop, key };
}

async function createNode(user: HttpUser) {
  const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response) as { node: { id: string; slug: string }; room: { id: string } };
}

async function say(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
}

async function lastReply(user: HttpUser, roomId: string, nodeId: string) {
  const response = await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` });
  const rows = json(response).messages as Array<{ authorNodeId: string | null; body: string; data: { tools?: Array<{ name: string; state: string; summary: string | null }> } }>;
  return rows.filter((row) => row.authorNodeId === nodeId).at(-1)!;
}

/** The simulated computer: answers each node tool request with `answer(data)`, and records what it heard. */
function computer(laptopId: string, key: { inject: HttpUser["inject"] }, answer: (data: Record<string, unknown>) => { status: number; body: Record<string, unknown> } | Promise<{ status: number; body: Record<string, unknown> }>) {
  const heard: Array<Record<string, unknown>> = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${laptopId}` || frame.event !== "node.tool.request") return;
    const data = frame.data as Record<string, unknown> & { id: string };
    heard.push(data);
    setTimeout(async () => {
      const reply = await answer(data);
      await key.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, payload: reply });
    }, 5);
  });
  return { heard, stop };
}

const gitStatus = { calls: [{ name: "computer_git", arguments: { folder: "app", op: "status" } }], then: "Checked." };

test("the first use of a folder asks the owner once; the answer reaches the computer with the next call and wakes the node", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira);
  const { node, room } = await createNode(mira);
  const ask = { capability: "git", target: "/home/mira/projects/app", label: "app", scope: "folder", weak: false };
  const device = computer(laptop.id, key, (data) => {
    const grants = data.grants as Array<{ id: string; scope: string; target: string }>;
    if (!grants.length) return { status: 428, body: { ask } };
    return { status: 200, body: { exitCode: 0, output: "## main\n M src/app.ts\n", grantsUsed: grants.map((grant) => grant.id) } };
  });
  try {
    script = (turn) => (turn.transcript.includes("allowed your computer tools") ? gitStatus : turn.transcript.includes("what changed") ? gitStatus : { text: "ok" });
    await say(mira, room.id, "what changed in app?");
    assert.ok(seen[0]!.tools.includes("computer_run") && seen[0]!.tools.includes("computer_git") && seen[0]!.tools.includes("computer_http"), "a DM with its owner has the computer tools");
    assert.equal(device.heard.length, 1);
    assert.equal(device.heard[0]!.attended, true, "the owner's profile asks first");
    assert.equal(device.heard[0]!.tool, "git");
    const cards = await h.prisma.agentDecision.findMany({ where: { userId: mira.id, toolName: "Computer tools" } });
    assert.equal(cards.length, 1);
    assert.match(cards[0]!.title, /@assistant wants to read git in app on Mira's laptop/);
    assert.deepEqual((cards[0]!.detail as { options: string[] }).options, ["Once", "This mission", "Always for this folder"]);
    assert.match((await lastReply(mira, room.id, node.id)).data.tools![0]!.summary!, /asked once in Needs me/);
    const needs = json(await mira.inject({ method: "GET", url: "/api/decisions" })).decisions as Array<{ id: string; canAnswer: boolean }>;
    assert.ok(needs.some((row) => row.id === cards[0]!.id && row.canAnswer), "in Needs me, answerable by the owner");

    // Asked again before the owner answers: no second card.
    await say(mira, room.id, "what changed in app?");
    assert.equal(await h.prisma.agentDecision.count({ where: { userId: mira.id, toolName: "Computer tools" } }), 1);

    // The owner answers for this mission: the node is woken, calls again, and the computer gets the answer with that call.
    const answered = await mira.inject({ method: "POST", url: `/api/decisions/${cards[0]!.id}/decide`, payload: { decision: "allow", scope: "once", reason: "This mission" } });
    assert.equal(answered.statusCode, 200, answered.body);
    for (let tries = 0; tries < 50 && !seen.some((turn) => turn.transcript.includes("allowed your computer tools")); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await settleTurns();
    }
    assert.ok(seen.some((turn) => /allowed your computer tools in app on Mira's laptop for this mission/.test(turn.transcript)), "the node hears the answer");
    const withGrant = device.heard.at(-1)!;
    assert.deepEqual(withGrant.grants, [{ id: cards[0]!.id, scope: "mission", target: ask.target }]);
    assert.equal(((await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: cards[0]!.id } })).detail as { nodeTool: { delivered: boolean } }).nodeTool.delivered, true);
    assert.equal((await lastReply(mira, room.id, node.id)).data.tools![0]!.state, "ok");

    // Once used, the answer is the computer's to keep: it is not sent again.
    await say(mira, room.id, "what changed in app?");
    assert.deepEqual(device.heard.at(-1)!.grants, []);
  } finally {
    device.stop();
  }
});

test("unattended calls say so; the computer's refusal is the node's answer; an older computer is asked to update", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira, "unattended");
  const { node, room } = await createNode(mira);
  const device = computer(laptop.id, key, (data) => (data.op === "show" ? { status: 403, body: { error: "~/.ssh holds keys, sign-ins or browser data." } } : { status: 200, body: { exitCode: 0, output: "## main\n" } }));
  try {
    script = () => gitStatus;
    await say(mira, room.id, "status of app?");
    assert.equal(device.heard[0]!.attended, false);
    assert.equal(await h.prisma.agentDecision.count({ where: { userId: mira.id } }), 0, "nothing to ask unattended");
    script = () => ({ calls: [{ name: "computer_git", arguments: { folder: "app", op: "show" } }], then: "Refused." });
    await say(mira, room.id, "show the key");
    const refused = (await lastReply(mira, room.id, node.id)).data.tools![0]!;
    assert.equal(refused.state, "failed");
    assert.match(refused.summary!, /refused: ~\/\.ssh holds keys/);
  } finally {
    device.stop();
  }

  await h.prisma.device.update({ where: { id: laptop.id }, data: { capabilities: { folders: ["app"], engines: ["claude-code"] } } });
  script = () => gitStatus;
  await say(mira, room.id, "status of app?");
  assert.match((await lastReply(mira, room.id, node.id)).data.tools![0]!.summary!, /Update Ensemble on Mira's laptop/);
});

test("the computer tools are the owner's alone: not in a turn someone else started or that others read", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira);
  const row = await h.prisma.nodeAgent.findUniqueOrThrow({ where: { id: node.id } });
  const scopeRoom = await h.prisma.nodeRoom.findUniqueOrThrow({ where: { id: room.id } });
  const scope = { prisma: h.prisma, node: row, room: scopeRoom, lineage: { rootMessageId: null, botDepth: 0, fromNonOwner: false }, privateTo: null, ownerOnly: true, redis: h.app.redis as never, dispatch: async () => undefined, turnId: "t", plan: null };
  assert.ok(deviceTools(scope).some((tool) => tool.name === "computer_run"));
  assert.deepEqual(deviceTools({ ...scope, lineage: { ...scope.lineage, fromNonOwner: true } }), []);
  assert.deepEqual(deviceTools({ ...scope, ownerOnly: false }), []);
});

test("a long command runs on in the background and wakes its node once when it ends; its output stays readable", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await laptopFor(mira, "unattended");
  const { node, room } = await createNode(mira);
  let runId = "";
  const post = (seq: number, text: string, done = false) =>
    key.inject({ method: "POST", url: `/api/devices/self/tool-runs/${runId}/output`, payload: { seq, text, done, ...(done ? { exitCode: 0, wake: true } : {}) } });
  const device = computer(laptop.id, key, (data) => {
    runId = String(data.runId);
    return { status: 202, body: { runId, background: true, output: "building…\n" } };
  });
  try {
    script = (turn) =>
      turn.transcript.includes("ended after")
        ? { calls: [{ name: "computer_run_output", arguments: { run: runId } }], then: "The build passed." }
        : { calls: [{ name: "computer_run", arguments: { folder: "app", command: "npm run build", timeoutSec: 900 } }], then: "It is building; I will say when it ends." };
    await say(mira, room.id, "build app");
    assert.equal(device.heard[0]!.tool, "run");
    assert.match((await lastReply(mira, room.id, node.id)).data.tools![0]!.summary!, /running in the background/);
    const turnsBefore = await h.prisma.nodeTurn.count({ where: { nodeId: node.id } });
    assert.equal((await post(0, "step 1 of 2\n")).statusCode, 200);
    assert.equal((await post(1, "built in 5 min\n", true)).statusCode, 200);
    // The end arrives twice (a retried post): the node wakes once.
    assert.equal((await post(1, "built in 5 min\n", true)).statusCode, 409);
    assert.equal((await post(2, "", true)).statusCode, 200);
    await settleTurns();
    const woken = seen.filter((turn) => turn.transcript.includes("ended after"));
    assert.equal(woken.length, 1);
    assert.match(woken[0]!.transcript, /`npm run build` in app on Mira's laptop ended after .*, exit code 0/);
    assert.equal(await h.prisma.nodeTurn.count({ where: { nodeId: node.id } }), turnsBefore + 1);
    const read = (await lastReply(mira, room.id, node.id)).data.tools![0]!;
    assert.equal(read.name, "computer_run_output");
    assert.equal(read.state, "ok");
    // Another computer cannot write into this run's output.
    const other = await person("Tom");
    const tomKey = await h.asToken(other, "device");
    await h.prisma.device.create({ data: { userId: other.id, name: "Tom's PC", platform: "linux", tokenId: tomKey.id, lastSeenAt: new Date() } });
    assert.equal((await tomKey.inject({ method: "POST", url: `/api/devices/self/tool-runs/${runId}/output`, payload: { seq: 3, text: "x" } })).statusCode, 410);
  } finally {
    device.stop();
  }
});

test("a node's agent run gets only the secrets it names: none by default, a saved request's name once saved", async () => {
  const mira = await person("Mira");
  const { key } = await laptopFor(mira, "ask", { secrets: 1 });
  const { node, room } = await createNode(mira);
  script = () => ({ calls: [{ name: "node_session_start", arguments: { title: "Test payments", prompt: "Run the payment tests.", folder: "app" } }], then: "Started." });
  await say(mira, room.id, "run the payment tests");
  const first = await h.prisma.workspaceJob.findFirstOrThrow({ where: { userId: mira.id }, orderBy: { createdAt: "desc" } });
  assert.deepEqual((first.context as { secrets?: unknown }).secrets, [], "no saved secret by default");
  const claim = await key.inject({ method: "POST", url: "/api/devices/self/claim" });
  assert.equal(claim.statusCode, 200, claim.body);
  assert.deepEqual(json(claim).secrets, [], "the computer is told: none");

  await postMessage(h.prisma, { roomId: room.id, userId: mira.id, authorKind: "node", authorNodeId: node.id, kind: "approval", body: "To call the payments API.", data: { type: "secret", status: "saved", name: "STRIPE_KEY", deviceId: "x", computer: "Mira's laptop" }, visibleTo: [mira.id] });
  await say(mira, room.id, "run them again with the key");
  const second = await h.prisma.workspaceJob.findFirstOrThrow({ where: { userId: mira.id, id: { not: first.id } }, orderBy: { createdAt: "desc" } });
  assert.deepEqual((second.context as { secrets?: unknown }).secrets, ["STRIPE_KEY"]);
});
