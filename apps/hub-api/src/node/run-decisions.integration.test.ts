/**
 * A node's runs ask in the chat (node/run-decisions.ts, docs/35 §8.6): when the agent of a run a node
 * started asks a question or a permission, its decision gets one owner-only card in the run card's
 * conversation and thread, and its notification opens it there. The Hub's Needs me leaves it out and
 * counts it as waiting in Node chats; the plain list (the CLI, Node) still has it. Answered with the
 * decide route the card says the owner answered; answered on the computer, by the node, by expiry or by
 * the run's end, the card follows. A run no node follows asks on the Hub's Needs me as before. The
 * computer is simulated with its device key.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const NODE_SITE = "https://node.example.test";
process.env.ENSEMBLE_NODE_WEB_ORIGIN = NODE_SITE;
const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { postMessage } = await import("./store.js");
const { pollRuns } = await import("./runs.js");
const { decisionBus } = await import("../lib/decisions.js");
const { sseHub } = await import("../lib/sse.js");
after(async () => {
  delete process.env.ENSEMBLE_NODE_WEB_ORIGIN;
  await h.close();
});

setAskRuntimeStreamForTests(async (args) => {
  const turn: RuntimeTurn = { text: "ok", toolCalls: [], model: "test-model", credits: 0, tokensIn: 1, tokensOut: 1, reasoning: "", raw: {}, finishReason: "stop", cutOff: false };
  args.onDelta?.("ok");
  return turn;
});
afterEach(() => settleTurns());

const json = (response: LightMyRequestResponse) => response.json() as any;

async function until<T>(check: () => Promise<T | null | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Mira, her computer (its device key), her node and their chat. */
async function setup() {
  const mira = await h.asUser();
  await h.prisma.user.update({ where: { id: mira.id }, data: { name: "Mira", emailVerifiedAt: new Date() } });
  const key = await h.asToken(mira, "device");
  const laptop = await h.prisma.device.create({ data: { userId: mira.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: { folders: ["app"], engines: ["copilot"] } as never } });
  const created = await mira.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(created.statusCode, 201, created.body);
  const { node, room } = json(created) as { node: { id: string; slug: string }; room: { id: string } };
  return { mira, key, laptop, node, room };
}

/** A job running on the laptop under a lease; with `node`, a node's run with its card in a thread of the chat. */
async function runningJob(env: Awaited<ReturnType<typeof setup>>, title: string, follow: boolean) {
  const task = await h.prisma.task.create({ data: { userId: env.mira.id, title } });
  const leaseToken = randomBytes(8).toString("hex");
  const job = await h.prisma.workspaceJob.create({
    data: { userId: env.mira.id, taskId: task.id, deviceId: env.laptop.id, kind: "code", executionMode: "sandbox", model: "copilot", provider: "copilot", status: "running", leaseOwner: env.laptop.id, leaseUntil: new Date(Date.now() + 600_000), leaseToken },
  });
  if (!follow) return { job, leaseToken, card: null, root: null };
  const { message: root } = await postMessage(h.prisma, { roomId: env.room.id, userId: env.mira.id, authorKind: "human", body: "fix the login bug with copilot" });
  const { message: card } = await postMessage(h.prisma, { roomId: env.room.id, userId: env.mira.id, authorKind: "node", authorNodeId: env.node.id, kind: "run", body: title, data: { jobId: job.id, status: "running", private: false }, rootMessageId: root.id });
  await h.prisma.nodeRun.create({ data: { userId: env.mira.id, nodeId: env.node.id, roomId: env.room.id, messageId: card.id, jobId: job.id, taskId: task.id, status: "running" } });
  return { job, leaseToken, card, root };
}

async function ask(env: Awaited<ReturnType<typeof setup>>, job: { id: string }, leaseToken: string, payload: Record<string, unknown>): Promise<string> {
  const asked = await env.key.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/ask`, payload: { leaseToken, ...payload } });
  assert.equal(asked.statusCode, 201, asked.body);
  return json(asked).decisionId as string;
}

async function decisionCard(decisionId: string) {
  return h.prisma.nodeMessage.findFirst({ where: { kind: "approval", AND: [{ data: { path: ["type"], equals: "run_decision" } }, { data: { path: ["decisionId"], equals: decisionId } }] } });
}

const cardWith = (decisionId: string, status: string) =>
  until(async () => {
    const card = await decisionCard(decisionId);
    return card && (card.data as { status?: string }).status === status ? card : null;
  }, `a ${status} card`);

test("a node run's permission is a card in the run's thread for its owner; the Hub counts it as waiting in Node, and the owner's answer settles it", async () => {
  const env = await setup();
  const { job, leaseToken, card: runCard, root } = await runningJob(env, "Fix the login bug", true);
  const id = await ask(env, job, leaseToken, { title: "Run `npm test` in app?", command: "npm test", event: "permission", tier: "ordinary" });
  const card = await decisionCard(id);
  assert.ok(card, "a card was posted");
  assert.equal(card.roomId, env.room.id);
  assert.equal(card.authorNodeId, env.node.id);
  assert.equal(card.kind, "approval");
  assert.deepEqual(card.visibleTo, [env.mira.id], "only the owner sees it");
  assert.equal(card.rootMessageId, root!.id, "in the run card's thread");
  assert.equal(card.planId, null);
  assert.deepEqual(card.data, {
    type: "run_decision",
    status: "pending",
    decisionId: id,
    jobId: job.id,
    runTitle: runCard!.body,
    event: "permission",
    title: "Run `npm test` in app?",
    command: "npm test",
    cwd: null,
    options: [],
    allowCustom: false,
    recommended: null,
    answer: null,
    decision: null,
    answeredAt: null,
    answeredBy: null,
    computer: "Mira's laptop",
    confirm: false,
    computerOnly: false,
    private: false,
  });
  const listed = json(await env.mira.inject({ method: "GET", url: "/api/node/messages/" + card.id }));
  assert.equal(listed.message.data.type, "run_decision", "its owner reads it in the chat");
  const notice = await h.prisma.notification.findFirstOrThrow({ where: { userId: env.mira.id, kind: "decision" }, orderBy: { createdAt: "desc" } });
  assert.equal(notice.url, `${NODE_SITE}/r/${env.room.id}#m-${card.id}`, "the notification opens the card in the Node chat");

  // A run no node follows asks on the Hub's Needs me as before.
  const other = await runningJob(env, "Bump the version", false);
  const hubOnly = await ask(env, other.job, other.leaseToken, { title: "Which version?", event: "question", options: ["1.2.0", "2.0.0"] });
  assert.equal(await decisionCard(hubOnly), null);
  assert.equal((await h.prisma.notification.findFirstOrThrow({ where: { userId: env.mira.id, kind: "decision" }, orderBy: { createdAt: "desc" } })).url, "/needs-me");

  const hub = json(await env.mira.inject({ method: "GET", url: "/api/decisions?surface=hub" }));
  assert.deepEqual(hub.decisions.map((row: { id: string }) => row.id), [hubOnly], "the Hub leaves the node's out");
  assert.deepEqual(hub.nodeChat, { count: 1, url: `${NODE_SITE}/r/${env.room.id}#m-${card.id}` });
  const everywhere = json(await env.mira.inject({ method: "GET", url: "/api/decisions" }));
  assert.deepEqual(everywhere.decisions.map((row: { id: string }) => row.id).sort(), [id, hubOnly].sort(), "the CLI and Node still list it");
  const shell = json(await env.mira.inject({ method: "GET", url: "/api/shell" }));
  assert.equal(shell.decisions, 1, "the Hub's count leaves it out");
  assert.equal(shell.nodeApprovals, 0, "nor is its card counted as one of the node's own");
  const approvals = json(await env.mira.inject({ method: "GET", url: "/api/node/approvals" })).approvals as Array<{ id: string }>;
  assert.ok(!approvals.some((row) => row.id === card.id), "nor listed with the node's cards on the Hub");
  const activity = json(await env.mira.inject({ method: "GET", url: "/api/node/activity" })).approvals as Array<{ id: string }>;
  assert.ok(activity.some((row) => row.id === card.id), "Node's own activity has it");

  // The owner answers on the card: the decide route, as from anywhere.
  const frames: string[] = [];
  const listen = sseHub.onFrame(({ userId, frame }) => {
    if (userId === `device:${env.laptop.id}`) frames.push(JSON.stringify(frame));
  });
  try {
    const decided = await env.mira.inject({ method: "POST", url: `/api/decisions/${id}/decide`, payload: { decision: "allow", scope: "once" } });
    assert.equal(decided.statusCode, 200, decided.body);
  } finally {
    listen();
  }
  const answered = await cardWith(id, "answered");
  const data = answered.data as Record<string, unknown>;
  assert.deepEqual([data.decision, data.answeredBy, data.answer], ["allow", "owner", null]);
  assert.match(String(data.answeredAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(frames.some((frame) => frame.includes("decision.answered") && frame.includes(id)), "the computer hears the answer");
  const after = json(await env.mira.inject({ method: "GET", url: "/api/decisions?surface=hub" }));
  assert.deepEqual(after.nodeChat, { count: 0, url: `${NODE_SITE}/activity` });
});

test("the card follows answers given elsewhere (the computer, the node), expiry and the run's end", async () => {
  const env = await setup();
  const { job, leaseToken } = await runningJob(env, "Release 2.0", true);
  const question = await ask(env, job, leaseToken, { title: "Which branch?", event: "question", options: ["main", "release"], allowCustom: true, recommended: "main" });
  const card = await decisionCard(question);
  assert.deepEqual([(card!.data as Record<string, unknown>).event, (card!.data as Record<string, unknown>).options, (card!.data as Record<string, unknown>).allowCustom, (card!.data as Record<string, unknown>).recommended], ["question", ["main", "release"], true, "main"]);
  // Answered on the computer.
  const closed = await env.key.inject({ method: "POST", url: `/api/devices/self/decisions/${question}/close`, payload: { decision: "allow", reason: "release" } });
  assert.equal(closed.statusCode, 204, closed.body);
  const fromComputer = (await cardWith(question, "answered")).data as Record<string, unknown>;
  assert.deepEqual([fromComputer.answer, fromComputer.decision, fromComputer.answeredBy], ["release", "allow", "elsewhere"]);
  const late = await env.mira.inject({ method: "POST", url: `/api/decisions/${question}/decide`, payload: { decision: "allow", scope: "once", reason: "main" } });
  assert.equal(late.statusCode, 409, "a late answer changes nothing");

  // Answered by the node (a question of fact it may answer, node/session-questions.ts).
  const fact = await ask(env, job, leaseToken, { title: "Which Node version?", event: "question", options: ["20", "22"] });
  const row = await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: fact } });
  await h.prisma.agentDecision.update({ where: { id: fact }, data: { status: "decided", decision: "allow", reason: "22", decidedAt: new Date(), detail: { ...(row.detail as object), answeredBy: { nodeId: env.node.id, handle: env.node.slug, source: "owner" } } } });
  decisionBus.emit(fact);
  const byNode = (await cardWith(fact, "answered")).data as Record<string, unknown>;
  assert.deepEqual([byNode.answer, byNode.answeredBy], ["22", "node"]);

  // Nobody answered in time.
  const slow = await ask(env, job, leaseToken, { title: "Push now?", command: "git push", event: "permission" });
  await h.prisma.agentDecision.update({ where: { id: slow }, data: { expiresAt: new Date(Date.now() - 1000) } });
  decisionBus.emit(slow);
  const expired = (await cardWith(slow, "expired")).data as Record<string, unknown>;
  assert.equal(expired.answeredBy, null);

  // The run ends: what it still asks closes with it.
  const open = await ask(env, job, leaseToken, { title: "Delete the cache?", command: "rm -rf .cache", event: "permission" });
  await h.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "succeeded", finishedAt: new Date() } });
  await pollRuns(h.app);
  await cardWith(open, "closed");
  assert.equal((await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: open } })).status, "expired");
  const hub = json(await env.mira.inject({ method: "GET", url: "/api/decisions?surface=hub" }));
  assert.equal(hub.nodeChat.count, 0);
});

test("without a Node site the Hub lists a node run's requests itself", async () => {
  const env = await setup();
  const { job, leaseToken } = await runningJob(env, "Docs", true);
  const id = await ask(env, job, leaseToken, { title: "Open a pull request?", event: "question", options: ["Yes", "No"] });
  process.env.ENSEMBLE_NODE_WEB_ORIGIN = "";
  try {
    const hub = json(await env.mira.inject({ method: "GET", url: "/api/decisions?surface=hub" }));
    assert.ok(hub.decisions.some((row: { id: string }) => row.id === id));
    assert.deepEqual(hub.nodeChat, { count: 0, url: null });
    assert.equal(json(await env.mira.inject({ method: "GET", url: "/api/shell" })).decisions, 1);
  } finally {
    process.env.ENSEMBLE_NODE_WEB_ORIGIN = NODE_SITE;
  }
});
