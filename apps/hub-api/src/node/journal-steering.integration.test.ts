/**
 * Ensemble Node orchestration (docs/35 §4.2, §5.1, §5.8, §5.9, §6.4, §8.3) against an in-memory database, with
 * the model scripted per node: the tool journal and what a restart does with a call that started and never
 * answered; the five steering cases (a follow-up, an amendment taken between steps, an interrupt, a replacement
 * that stops or keeps what it replaces, a stop with every child); independent views in a crew; Roles (beta); and
 * how steering, a stop and a restart meet a plan (node/plans.ts): a child's result reaches its lead once, a lead's
 * report or re-plan turn is never left waiting, and the watchdog never starts again what its owner replaced.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns, recoverTurns, queueTurn, dispatchMessage } = await import("./queue.js");
const { turnJournal, journalLabel } = await import("./journal.js");
const { readsOnly } = await import("../assistant/registry.js");
const { RuntimeError } = await import("../lib/runtime-error.js");
const { postMessage } = await import("./store.js");
const { openToolRun } = await import("../devices/tool-runs.js");
const { recordingStarted, recordingsOf } = await import("./recordings.js");
const { recoverRounds } = await import("./groups.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { beginPlanTurn, loadPlan, LIVE_MISSIONS } = await import("./plans.js");
const { checkWork } = await import("./watchdog.js");
const { dispatchOutbox } = await import("./outbox.js");
after(() => h.close());

type Call = { name: string; arguments: Record<string, unknown> };
type Step = { calls?: Call[]; text?: string };
type Seen = { slug: string; transcript: string; messages: Array<{ role?: string; content?: unknown }>; signal?: AbortSignal };
/** Each node's model calls, in order, by its handle: a step, or a function of what the call was given. Out of steps: "ok". */
const plans = new Map<string, Array<Step | ((seen: Seen) => Step | Promise<Step>)>>();
const seen: Seen[] = [];

const textOf = (content: unknown) =>
  Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(content ?? "");

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(system)?.[1] ?? "?";
  const current: Seen = { slug, transcript: textOf(messages.filter((row) => row.role === "user").at(-1)?.content), messages, signal: args.signal };
  if (slug !== "?") seen.push(current);
  const next = slug === "?" ? undefined : plans.get(slug)?.shift();
  const step = typeof next === "function" ? await next(current) : (next ?? { text: "ok" });
  const calls = step.calls ?? [];
  const text = calls.length ? "" : (step.text ?? "ok");
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
  plans.clear();
  seen.length = 0;
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

async function say(user: HttpUser, roomId: string, body: string, extra: Record<string, unknown> = {}) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body, ...extra } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
  return json(response).message as { id: string; seq: number };
}

/** Posts while a turn runs (from inside a scripted model call): the turn is not waited for. */
async function sayNow(user: HttpUser, roomId: string, body: string, extra: Record<string, unknown> = {}) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body, ...extra } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response).message as { id: string };
}

async function read(user: HttpUser, roomId: string) {
  const response = await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` });
  assert.equal(response.statusCode, 200, response.body);
  return json(response).messages as Array<{ id: string; seq: number; kind: string; body: string; authorKind: string; authorNodeId: string | null; data: any }>;
}

async function until<T>(probe: () => Promise<T | null | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const createTask = (title: string): Call => ({ name: "hub_create_tasks", arguments: { tasks: [{ title }] } });
const tasksCalled = (userId: string, title: string) => h.prisma.task.count({ where: { userId, title } });
/** What the tool calls of a turn's model call answered, in order. */
const toolAnswers = (turn: Seen) => turn.messages.filter((row) => row.role === "tool").map((row) => textOf(row.content));

test("the tool journal: a retried call gets the stored result, an identical call in flight waits for the first, a read-only call runs again", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  const running = () => h.prisma.nodeTurn.create({ data: { userId: mira.id, nodeId: node.id, roomId: room.id, reason: "dm", status: "running", outcome: "running", lane: `conv:${room.id}:s` } });
  const turn = await running();
  const call = { name: "hub_create_tasks", arguments: '{"tasks":[{"title":"A"}]}', sideEffect: true };

  const first = turnJournal(h.app, turn);
  const started = await first.begin(call);
  assert.ok("ticket" in started);
  await started.ticket.dispatched();
  await started.ticket.settle({ state: "ok", ran: true, summary: "Created 1 task." });
  // The same turn sent again (a provider's retry): the same call, written another way, is answered from the journal.
  const retry = turnJournal(h.app, turn);
  const again = await retry.begin({ ...call, arguments: '{ "tasks": [ { "title": "A" } ] }' });
  assert.ok("replay" in again, "nothing runs twice");
  assert.equal(again.replay.summary, "Created 1 task.");
  assert.equal(again.replay.forModel.replayed, true);
  assert.ok("ticket" in (await retry.begin(call)), "a second identical call after that one runs: its caller saw the first answer");
  const look = { name: "hub_list_tasks", arguments: "{}", sideEffect: false };
  const looked = await first.begin(look);
  assert.ok("ticket" in looked);
  await looked.ticket.settle({ state: "ok", ran: true, summary: "3 tasks." });
  assert.ok("ticket" in (await retry.begin(look)), "a call that only looks runs again");

  const other = turnJournal(h.app, await running());
  const one = await other.begin({ ...call, arguments: '{"tasks":[{"title":"B"}]}' });
  assert.ok("ticket" in one);
  const two = other.begin({ ...call, arguments: '{"tasks":[{"title":"B"}]}' });
  await one.ticket.dispatched();
  await one.ticket.settle({ state: "ok", ran: true, summary: "Created B." });
  const joined = await two;
  assert.ok("replay" in joined && joined.replay.summary === "Created B.", "the identical call sent while the first ran waits for it and gets its answer");

  const rows = await h.prisma.nodeToolJournal.findMany({ where: { turnId: turn.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(
    rows.map((row) => [row.tool, row.repeat, row.state, row.sideEffect]),
    [
      ["hub_create_tasks", 0, "succeeded", true],
      ["hub_create_tasks", 1, "recorded", true],
      ["hub_list_tasks", 0, "recorded", false],
    ],
  );
  assert.match(rows[0]!.callKey, /^hub_create_tasks:[0-9a-f]{64}:0$/);
  assert.equal(rows[0]!.label, '{"tasks":[{"title":"A"}]}', "a call that changes something keeps its input's short label");
  assert.equal(rows[2]!.label, null);
  await h.prisma.nodeTurn.updateMany({ where: { nodeId: node.id }, data: { status: "done", outcome: "done" } });
});

test("a restart between a call's dispatch and its result: the turn is not run from the start; it resumes told the call may have run, and does not repeat it blindly", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  const cut = await h.prisma.nodeTurn.create({ data: { userId: mira.id, nodeId: node.id, roomId: room.id, reason: "dm", status: "running", outcome: "running", lane: `conv:${room.id}:s` } });
  const venue = createTask("Book the venue");
  const ticket = await turnJournal(h.app, cut).begin({ name: venue.name, arguments: JSON.stringify(venue.arguments), sideEffect: true });
  assert.ok("ticket" in ticket);
  await ticket.ticket.dispatched();
  // The call acted, then the server stopped before its result was saved.
  await h.prisma.task.create({ data: { userId: mira.id, title: "Book the venue" } });

  plans.set(node.slug, [{ calls: [venue] }, { calls: [venue] }, { text: "The venue is booked." }]);
  await recoverTurns(h.app);
  await settleTurns();

  const before = await h.prisma.nodeTurn.findUniqueOrThrow({ where: { id: cut.id } });
  assert.equal(before.status, "failed");
  assert.equal(before.error, "Interrupted by a server restart after it had acted.");
  const resumed = await h.prisma.nodeTurn.findFirstOrThrow({ where: { originTurnId: cut.id } });
  assert.equal(resumed.status, "done");
  const calls = seen.filter((row) => row.slug === node.slug);
  assert.match(calls[0]!.transcript, /These calls started but their result was never saved, so they may already have happened[\s\S]*- hub_create_tasks \{"tasks":\[\{"title":"Book the venue"\}\]\}/);
  assert.match(toolAnswers(calls[1]!)[0]!, /may already have happened\. It was not run again/, "the same call again answers that it may have run");
  assert.equal(await tasksCalled(mira.id, "Book the venue"), 2, "it ran once before the restart and once more only when asked again after that answer");
  const rows = await h.prisma.nodeToolJournal.findMany({ where: { turnId: cut.id }, orderBy: { repeat: "asc" } });
  assert.deepEqual(rows.map((row) => [row.repeat, row.state, row.attemptTurnId]), [
    [0, "uncertain", cut.id],
    [1, "succeeded", resumed.id],
  ]);
});

test("a follow-up before the turn acted merges into the next turn, with its record", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  let second = "";
  plans.set(node.slug, [
    async () => {
      second = (await sayNow(mira, room.id, "and make it short")).id;
      await until(() => h.prisma.nodeSteer.findFirst({ where: { nodeId: node.id, kind: "follow_up" } }), "the follow-up's record");
      return { text: "A long answer." };
    },
    { text: "A short answer." },
  ]);
  await say(mira, room.id, "write the intro");
  const steer = await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: node.id } });
  assert.deepEqual([steer.kind, steer.operation, steer.outcome, steer.messageId], ["follow_up", "coalesce", "done", second]);
  const turns = await h.prisma.nodeTurn.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(turns.map((row) => row.outcome), ["coalesced", "done"]);
  assert.match(seen.at(-1)!.transcript, /write the intro[\s\S]*and make it short/, "the next turn answers both");
  const replies = (await read(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text");
  assert.deepEqual(replies.map((row) => row.body), ["A short answer."]);
});

test("an amendment after the turn acted is written first, taken between its steps, and never answered twice", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  let added = "";
  plans.set(node.slug, [
    { calls: [createTask("Draft the agenda")] },
    async () => {
      // The turn has acted: its owner's message is an amendment, offered to it.
      added = (await sayNow(mira, room.id, "also add a coffee break")).id;
      await until(() => h.prisma.nodeSteer.findFirst({ where: { nodeId: node.id, kind: "amendment" } }), "the amendment's record");
      return { calls: [{ name: "hub_list_tasks", arguments: {} }] };
    },
    (turn) => {
      assert.match(turn.transcript, /Mira added this while you were working on it:\n\[#\d+ Mira \(your owner\)\] also add a coffee break/);
      return { text: "The agenda is drafted, with a coffee break." };
    },
  ]);
  await say(mira, room.id, "draft the agenda");

  const steer = await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: node.id } });
  assert.deepEqual([steer.kind, steer.operation, steer.outcome, steer.version, steer.messageId], ["amendment", "inject", "accepted", 1, added]);
  assert.ok(steer.handedAt && steer.settledAt);
  const decision = await h.prisma.nodeDecision.findFirstOrThrow({ where: { nodeId: node.id, kind: "steer" } });
  assert.equal((decision.choice as { kind: string }).kind, "amendment");
  const turns = await h.prisma.nodeTurn.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(turns.map((row) => row.outcome), ["done", "skipped"], "the turn queued for the amendment finds it already read");
  const replies = (await read(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text");
  assert.deepEqual(replies.map((row) => row.body), ["The agenda is drafted, with a coffee break."]);
  const member = await h.prisma.nodeRoomMember.findFirstOrThrow({ where: { roomId: room.id, nodeId: node.id } });
  const kept = await h.prisma.assistantMessage.findMany({ where: { conversationId: member.conversationId!, role: "user" }, orderBy: { createdAt: "asc" } });
  assert.ok(kept.some((row) => row.content.includes("added this while you were working")), "the amendment stays in the node's conversation");
});

test("interrupt and continue: the turn going on stops where it is, and the same conversation goes on with the new message", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  plans.set(node.slug, [
    async () => {
      await sayNow(mira, room.id, "wait, make it Friday", { steering: "interrupt" });
      await until(() => h.prisma.nodeSteer.findFirst({ where: { nodeId: node.id, kind: "interrupt" } }), "the interrupt");
      return { calls: [createTask("Book Thursday")] };
    },
    (turn) => {
      assert.match(turn.transcript, /wait, make it Friday/);
      assert.match(turn.transcript, /Your owner's new message stopped your turn going on/);
      return { calls: [createTask("Book Friday")] };
    },
    { text: "Booked Friday." },
  ]);
  await say(mira, room.id, "book the room for Thursday");

  assert.equal(await tasksCalled(mira.id, "Book Thursday"), 0, "what the stopped turn was about to do did not run");
  assert.equal(await tasksCalled(mira.id, "Book Friday"), 1);
  const turns = await h.prisma.nodeTurn.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(turns.map((row) => row.outcome), ["cancelled", "done"]);
  const steer = await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: node.id } });
  assert.deepEqual([steer.kind, steer.operation, steer.target], ["interrupt", "interrupt", "conversation"]);
  assert.deepEqual((steer.children as { stopped: Array<{ kind: string; id: string }> }).stopped, [{ kind: "turn", id: turns[0]!.id }]);
  const member = await h.prisma.nodeRoomMember.findFirstOrThrow({ where: { roomId: room.id, nodeId: node.id } });
  const conversation = await h.prisma.assistantMessage.findMany({ where: { conversationId: member.conversationId! }, orderBy: { createdAt: "asc" } });
  assert.ok(conversation.some((row) => row.role === "assistant" && row.content.includes("Stopped here: Mira sent a new message")), "the same conversation keeps where it stopped");
  const replies = (await read(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text");
  assert.deepEqual(replies.map((row) => row.body), ["Booked Friday."]);
});

/** A command left running on a computer and a screen recording going on, both the node's, in this conversation. */
async function children(owner: HttpUser, nodeId: string, roomId: string) {
  const runId = randomUUID();
  await openToolRun(h.app.redis as never, runId, { deviceId: randomUUID(), deviceName: "Laptop", ownerId: owner.id, nodeId, roomId, private: false, planId: null, planStep: null, command: "npm run dev", folder: "/work", startedAt: new Date().toISOString() });
  const recording = { deviceId: randomUUID(), mission: `conversation:${roomId}:shared` };
  await recordingStarted(h.app.redis as never, nodeId, recording);
  return { runId, recording };
}

const quietOf = (runId: string) => h.app.redis.get(`ensemble:nodetool:quiet:${runId}`);

test("a replacement keeps what it replaces only on purpose, and says so; otherwise it stops it", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  const { runId, recording } = await children(mira, node.id, room.id);

  plans.set(node.slug, [(turn) => ({ text: /kept on purpose: screen recording \(recording [^)]+\); npm run dev \(command [0-9a-f-]+\)/.test(turn.transcript) ? "Noted what still runs." : "Missing the kept list." })]);
  await say(mira, room.id, "new plan: write the release notes", { steering: "replace", children: "keep" });
  const kept = await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: node.id, kind: "replacement" } });
  assert.equal(kept.operation, "new_run", "nothing was running: the new message is new work");
  assert.deepEqual(
    (kept.children as { kept: Array<{ kind: string; id: string }> }).kept.map((child) => child.kind),
    ["recording", "command"],
  );
  assert.equal(await quietOf(runId), null, "kept: the command goes on");
  assert.equal((await recordingsOf(h.app.redis as never, node.id)).length, 1);
  assert.equal((await read(mira, room.id)).filter((row) => row.authorNodeId === node.id).at(-1)!.body, "Noted what still runs.");

  plans.set(node.slug, [(turn) => ({ text: /Stopped for it: screen recording; npm run dev\./.test(turn.transcript) ? "Starting fresh." : "Missing the stopped list." })]);
  const message = await say(mira, room.id, "no, write the changelog instead", { steering: "replace" });
  const stopped = await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: node.id, kind: "replacement", messageId: message.id } });
  assert.deepEqual((stopped.children as { stopped: Array<{ kind: string; id: string }> }).stopped.map((child) => [child.kind, child.id]), [
    ["recording", `${recording.deviceId}:${recording.mission}`],
    ["command", runId],
  ]);
  assert.equal(await quietOf(runId), "stopped", "its end wakes nobody");
  assert.deepEqual(await recordingsOf(h.app.redis as never, node.id), [], "a recording on a computer that is gone is let go");
  assert.equal((await read(mira, room.id)).filter((row) => row.authorNodeId === node.id).at(-1)!.body, "Starting fresh.");
  const message2 = (await read(mira, room.id)).find((row) => row.id === message.id)!;
  assert.deepEqual(message2.data.steering, { kind: "replace", children: "stop" });
  const refused = await mira.inject({ method: "POST", url: `/api/node/rooms/${room.id}/messages`, payload: { body: "x", children: "keep" } });
  assert.equal(refused.statusCode, 400, "children goes with a replacement only");
});

test("a stop stops every child: turns, helpers' work, commands and recordings; what is done stays", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  const { runId } = await children(mira, node.id, room.id);
  const helper = await h.prisma.nodeAgent.create({ data: { userId: mira.id, slug: `helper-${randomBytes(3).toString("hex")}`, name: "Helper", parentNodeId: node.id } });
  const taskRoom = await h.prisma.nodeRoom.create({ data: { userId: mira.id, kind: "task", title: "Helper's task", settings: { originRoomId: room.id, parentNodeId: node.id, leadNodeIds: [node.id] } } });
  await h.prisma.nodeRoomMember.create({ data: { roomId: taskRoom.id, userId: mira.id, nodeId: helper.id, handle: helper.slug } });
  const waiting = await h.prisma.nodeTurn.create({ data: { userId: mira.id, nodeId: helper.id, roomId: taskRoom.id, reason: "work", status: "queued", outcome: "queued", lane: `conv:${taskRoom.id}:s` } });

  const response = await mira.inject({ method: "POST", url: `/api/node/rooms/${room.id}/stop`, payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  const body = json(response);
  assert.deepEqual([body.detail.helpers, body.detail.commands, body.detail.recordings], [1, 1, 1]);
  assert.equal(body.line, "Stopped the work of 1 helper, 1 screen recording and 1 command on a computer. What was already done stays.");
  await settleTurns();
  const helperTurn = await h.prisma.nodeTurn.findUniqueOrThrow({ where: { id: waiting.id } });
  assert.deepEqual([helperTurn.status, helperTurn.outcome], ["failed", "cancelled"]);
  assert.equal(await quietOf(runId), "stopped");
  const steer = await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: node.id, kind: "stop" } });
  assert.deepEqual([steer.operation, steer.target, steer.targetId, steer.outcome], ["stop", "conversation", room.id, "done"]);
  assert.deepEqual((steer.children as { stopped: Array<{ kind: string }> }).stopped.map((child) => child.kind), ["helper", "recording", "command"]);
  assert.ok(await h.prisma.nodeAgent.findUnique({ where: { id: helper.id } }), "the helper itself stays, with what it did");
});

async function crewOf(user: HttpUser, templates: string[]) {
  const nodes: Array<{ id: string; slug: string }> = [];
  for (const template of templates) nodes.push((await createNode(user, template)).node);
  const made = await user.inject({ method: "POST", url: "/api/node/crews", payload: { title: `Crew ${randomBytes(3).toString("hex")}`, nodeIds: nodes.map((row) => row.id), leadNodeId: nodes[0]!.id } });
  assert.equal(made.statusCode, 201, made.body);
  return { nodes, crew: json(made).room as { id: string } };
}

test("independent views: each node named answers from the room as it was asked, then the lead brings the answers together", async () => {
  const kofi = await person("Kofi");
  const { nodes, crew } = await crewOf(kofi, ["manager", "researcher", "assistant"]);
  const [lead, first, second] = nodes as [{ id: string; slug: string }, { id: string; slug: string }, { id: string; slug: string }];
  const patched = await kofi.inject({ method: "PATCH", url: `/api/node/rooms/${crew.id}`, payload: { mode: "independent" } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(json(patched).room.mode, "independent");

  plans.set(first.slug, [{ text: "A is better: it is faster." }]);
  plans.set(second.slug, [{ text: "B is better: it is cheaper." }]);
  plans.set(lead.slug, [{ text: "They disagree: A is faster, B is cheaper." }]);
  const asked = await say(kofi, crew.id, `@${first.slug} @${second.slug} which is better, A or B?`);

  const message = await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: asked.id } });
  const round = (message.data as { independent: { nodeIds: string[]; synthesizerId: string; deadlineAt: string } }).independent;
  assert.deepEqual([round.nodeIds, round.synthesizerId], [[first.id, second.id], lead.id]);
  const answers = await h.prisma.nodeTurn.findMany({ where: { triggerMessageId: asked.id, snapshotSeq: { not: null } }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(answers.map((row) => [row.nodeId, row.snapshotSeq, row.operationId, row.outcome]), [
    [first.id, message.seq, `independent:${asked.id}:${first.id}`, "done"],
    [second.id, message.seq, `independent:${asked.id}:${second.id}`, "done"],
  ]);
  assert.ok(answers.every((row) => row.deadlineAt && row.deadlineAt.getTime() > Date.now()));
  const own = seen.find((row) => row.slug === first.slug)!;
  assert.match(own.transcript, /Independent views: other nodes answer this too, each on its own[^\n]*@manager brings the answers together/);
  assert.match(own.transcript, /Who instructs you: Kofi \(your owner\), and @manager \(the crew's lead\) through the steps of its plans/);
  const synthesis = await h.prisma.nodeTurn.findUniqueOrThrow({ where: { operationId: `synthesis:${asked.id}` } });
  assert.deepEqual([synthesis.nodeId, synthesis.reason, synthesis.outcome], [lead.id, "synthesis", "done"]);
  const leadCall = seen.filter((row) => row.slug === lead.slug).at(-1)!;
  assert.match(leadCall.transcript, /A is better[\s\S]*B is better|B is better[\s\S]*A is better/);
  assert.match(leadCall.transcript, new RegExp(`Independent views on #${message.seq}: @${first.slug}, @${second.slug} answered it, each on their own\\. Bring the answers together for your owner`));
  const route = await h.prisma.nodeDecision.findFirstOrThrow({ where: { kind: "route", inputs: { path: ["messageId"], equals: asked.id } } });
  assert.equal((route.inputs as { mode: string }).mode, "independent");
  assert.deepEqual([(route.choice as { independent: boolean }).independent, (route.choice as { synthesizerId: string }).synthesizerId], [true, lead.id]);

  // The snapshot itself: a sibling's answer after the message is not read with it, and is read next.
  const later = await postMessage(h.prisma, { roomId: crew.id, userId: kofi.id, authorKind: "human", body: "and C?", visibleTo: [] });
  await postMessage(h.prisma, { roomId: crew.id, userId: kofi.id, authorKind: "node", authorNodeId: first.id, body: "C is worst.", visibleTo: [] });
  plans.set(second.slug, [{ text: "C is fine." }, { text: "Seen." }]);
  await queueTurn(h.app, { nodeId: second.id, roomId: crew.id, reason: "mentioned", triggerMessageId: later.message.id, snapshotSeq: later.message.seq, deadlineAt: new Date(Date.now() + 60_000), operationId: `independent:${later.message.id}:${second.id}` });
  await settleTurns();
  const snapshot = seen.filter((row) => row.slug === second.slug).at(-1)!;
  assert.match(snapshot.transcript, /and C\?/);
  assert.doesNotMatch(snapshot.transcript, /C is worst/, "the sibling's answer came after the snapshot");
  await queueTurn(h.app, { nodeId: second.id, roomId: crew.id, reason: "mentioned", note: "Read on." });
  await settleTurns();
  assert.match(seen.filter((row) => row.slug === second.slug).at(-1)!.transcript, /C is worst/, "its cursor stopped before the sibling's answer");
});

test("independent views after a restart: a round past its deadline is brought together with who did not answer", async () => {
  const kofi = await person("Kofi");
  const { nodes, crew } = await crewOf(kofi, ["manager", "researcher"]);
  const [lead, member] = nodes as [{ id: string; slug: string }, { id: string; slug: string }];
  const { message } = await postMessage(h.prisma, {
    roomId: crew.id,
    userId: kofi.id,
    authorKind: "human",
    body: "compare them",
    visibleTo: [],
    data: { independent: { nodeIds: [member.id], synthesizerId: lead.id, deadlineAt: new Date(Date.now() - 1000).toISOString() } },
  });
  const stuck = await h.prisma.nodeTurn.create({
    data: { userId: kofi.id, nodeId: member.id, roomId: crew.id, reason: "mentioned", triggerMessageId: message.id, status: "running", outcome: "running", snapshotSeq: message.seq, deadlineAt: new Date(Date.now() - 1000), lane: `conv:${crew.id}:s` },
  });
  plans.set(lead.slug, [{ text: "Only one view came in." }]);
  await recoverRounds(h.app);
  await settleTurns();
  const synthesis = await h.prisma.nodeTurn.findUniqueOrThrow({ where: { operationId: `synthesis:${message.id}` } });
  assert.match(synthesis.note ?? "", new RegExp(`none of the nodes asked answered it; @${member.slug} did not answer in time`));
  await h.prisma.nodeTurn.update({ where: { id: stuck.id }, data: { status: "failed", outcome: "failed" } });
});

test("Roles (beta): a plan step's run takes its role's model when Roles are on, as before when they are off; each resolution is recorded", async () => {
  const run = async (roles: boolean) => {
    const kofi = await person("Kofi");
    const key = await h.asToken(kofi, "device");
    const agents = [
      { id: "copilot-cli", via: "cli", version: "1.0", signedIn: true, checkedAt: new Date().toISOString(), models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["low", "medium", "high"] }] },
      { id: "claude-code", via: "cli", version: "1.0", signedIn: true, checkedAt: new Date().toISOString(), models: [] },
    ];
    const laptop = await h.prisma.device.create({
      data: { userId: kofi.id, name: "Laptop", platform: "macos", tokenId: key.id, appVersion: "cli-0.4.20", capabilities: { folders: ["ensemble"], engines: ["claude-code", "copilot-cli"], agents }, lastSeenAt: new Date() },
    });
    await saveSettings(h.prisma, kofi.id, {
      runProfiles: [RunProfile.parse({ id: "careful", name: "Careful", engine: "claude-code", mode: "ask", delivery: "local", deviceId: laptop.id })],
      defaultRunProfileId: "careful",
      node: { roles: { enabled: roles, global: { implementation: { agent: "copilot-cli", model: "gpt-6.1-sol" } } } },
    });
    const { nodes, crew } = await crewOf(kofi, ["manager", "feature-engineer"]);
    const [lead, builder] = nodes as [{ id: string; slug: string }, { id: string; slug: string }];
    plans.set(lead.slug, [{ calls: [{ name: "node_delegate", arguments: { to: builder.slug, brief: "Build the export button.", kind: "build" } }] }, { text: "Planned." }]);
    plans.set(builder.slug, [{ calls: [{ name: "node_session_start", arguments: { title: "Export button", prompt: "Add an export button.", folder: "ensemble" } }] }, { text: "Started." }]);
    await say(kofi, crew.id, "build the export button");
    await until(() => h.prisma.workspaceJob.findFirst({ where: { userId: kofi.id } }), "the step's run");
    const job = await h.prisma.workspaceJob.findFirstOrThrow({ where: { userId: kofi.id } });
    const decision = await h.prisma.nodeDecision.findFirst({ where: { userId: kofi.id, kind: "model" } });
    return { job, decision };
  };

  const on = await run(true);
  assert.deepEqual([on.job.provider, on.job.model], ["copilot-cli", "gpt-6.1-sol"], "the implementation role's agent and model");
  assert.deepEqual(on.decision?.choice, { reason: "global_role", agent: "copilot-cli", model: "gpt-6.1-sol", effort: null, knownAgent: true });
  assert.equal((on.decision?.inputs as { role: string }).role, "implementation");

  const off = await run(false);
  assert.equal(off.job.provider, "claude-code", "Roles off: the run profile's agent, as before");
  assert.equal(off.decision, null, "and no role is resolved");
});

/** A helper of `parent`, in its own task room (the parent and the owner are there too), made as node/helpers.ts makes one. */
async function helperOf(owner: HttpUser, parent: { id: string; slug: string }, originRoomId: string) {
  const helper = await h.prisma.nodeAgent.create({ data: { userId: owner.id, slug: `helper-${randomBytes(3).toString("hex")}`, name: "Helper", parentNodeId: parent.id } });
  const room = await h.prisma.nodeRoom.create({ data: { userId: owner.id, kind: "task", title: "Helper's task", settings: { leadNodeIds: [parent.id], parentNodeId: parent.id, helperNodeId: helper.id, originRoomId } } });
  await h.prisma.nodeRoomMember.createMany({
    data: [
      { roomId: room.id, userId: owner.id, handle: "owner" },
      { roomId: room.id, userId: owner.id, nodeId: parent.id, handle: parent.slug },
      { roomId: room.id, userId: owner.id, nodeId: helper.id, handle: helper.slug },
    ],
  });
  return { helper, room };
}

/** The same step for every model call of a node: it reads what the call was given. */
const always = (step: (seen: Seen) => Step | Promise<Step>) => Array.from({ length: 30 }, () => step);
const afterTool = (turn: Seen) => turn.messages.at(-1)?.role === "tool";

test("bot brakes: two nodes both saying again what they said, back and forth in one request, wake nobody; a new request starts a new chain", async () => {
  const mira = await person("Mira");
  const a = (await createNode(mira, "assistant")).node;
  const b = (await createNode(mira, "researcher")).node;
  const room = await h.prisma.nodeRoom.create({ data: { userId: mira.id, kind: "task", title: "Pair", settings: {} } });
  await h.prisma.nodeRoomMember.createMany({
    data: [
      { roomId: room.id, userId: mira.id, handle: "mira" },
      { roomId: room.id, userId: mira.id, nodeId: a.id, handle: a.slug },
      { roomId: room.id, userId: mira.id, nodeId: b.id, handle: b.slug },
    ],
  });
  plans.set(a.slug, always(() => ({ text: "(no reply)" })));
  plans.set(b.slug, always(() => ({ text: "(no reply)" })));
  const root = (await postMessage(h.prisma, { roomId: room.id, userId: mira.id, authorKind: "human", body: "work it out between you", visibleTo: [] })).message;
  let depth = 0;
  const nodeSays = async (from: { id: string }, to: { id: string; slug: string }, body: string, rootMessageId = root.id) => {
    depth += 1;
    const { message } = await postMessage(h.prisma, { roomId: room.id, userId: mira.id, authorKind: "node", authorNodeId: from.id, body: `@${to.slug} ${body}`, visibleTo: [], mentions: [{ kind: "node", id: to.id }], rootMessageId, botDepth: depth });
    await dispatchMessage(h.app, message);
    await settleTurns();
    return message;
  };
  const woke = async (message: { id: string }) => h.prisma.nodeTurn.count({ where: { triggerMessageId: message.id } });
  await nodeSays(a, b, "can you check the file?");
  await nodeSays(b, a, "Checked it. Over to you.");
  assert.equal(await woke(await nodeSays(a, b, "Can you check the file")), 1, "asking again after an answer is not a loop");
  const looped = await nodeSays(b, a, "Checked it. Over to you!");
  assert.equal(await woke(looped), 0, "both said again what they said: the second round wakes nobody");
  const route = await h.prisma.nodeDecision.findFirstOrThrow({ where: { kind: "route", inputs: { path: ["messageId"], equals: looped.id } } });
  assert.deepEqual(route.choice, { reason: "none", brake: "cycle", woken: [] });
  assert.deepEqual((route.inputs as { loop: unknown }).loop, { chain: 4, window: 12, ownerStarted: false });
  assert.equal(await woke(await nodeSays(a, b, "can you check the file?")), 0);
  const lines = await h.prisma.nodeMessage.findMany({ where: { roomId: room.id, authorKind: "system", kind: "status" } });
  assert.deepEqual(lines.map((row) => [row.body, (row.data as { brake: string }).brake]), [["Paused here: the nodes kept saying the same thing to each other. Ask the node that made this helper to continue.", "cycle"]], "said once for the request");
  const next = (await postMessage(h.prisma, { roomId: room.id, userId: mira.id, authorKind: "human", body: "once more, please", visibleTo: [] })).message;
  assert.equal(await woke(await nodeSays(a, b, "can you check the file?", next.id)), 1, "a new request is a new chain");
});

test("a brief its owner asks for again reaches the helper; a brief a loop repeats says honestly that the helper was not woken", async () => {
  const mira = await person("Mira");
  const { node: parent, room: dm } = await createNode(mira, "assistant");
  const { helper, room: taskRoom } = await helperOf(mira, parent, dm.id);
  const brief = "Draft the summary of the release.";
  plans.set(parent.slug, always((turn) => (afterTool(turn) ? { text: "Asked." } : /draft the summary|run it again/i.test(turn.transcript) ? { calls: [{ name: "node_delegate", arguments: { to: helper.slug, brief } }] } : { text: "(no reply)" })));
  plans.set(helper.slug, always(() => ({ text: `@${parent.slug} The summary is drafted.` })));
  await say(mira, dm.id, "have your helper draft the summary");
  await say(mira, dm.id, "run it again");
  const briefs = await h.prisma.nodeMessage.findMany({ where: { roomId: taskRoom.id, authorNodeId: parent.id }, orderBy: { seq: "asc" } });
  assert.equal(briefs.length, 2);
  assert.equal(await h.prisma.nodeTurn.count({ where: { nodeId: helper.id, triggerMessageId: briefs[1]!.id } }), 1, "the brief asked for again wakes the helper");
  assert.match(toolAnswers(seen.filter((row) => row.slug === parent.slug && afterTool(row)).at(-1)!)[0]!, /Asked @helper-/);

  // A loop of the parent's own turns, woken by its helper: the same brief again, after the same answer again.
  plans.set(helper.slug, always(() => ({ text: "(no reply)" })));
  const root = (await postMessage(h.prisma, { roomId: dm.id, userId: mira.id, authorKind: "human", body: "keep at it", visibleTo: [] })).message;
  let depth = 0;
  const posted = async (from: { id: string }, to: { slug: string; id: string }, body: string) => {
    depth += 1;
    return (await postMessage(h.prisma, { roomId: taskRoom.id, userId: mira.id, authorKind: "node", authorNodeId: from.id, body: `@${to.slug} ${body}`, visibleTo: [], mentions: [{ kind: "node", id: to.id }], rootMessageId: root.id, botDepth: depth })).message;
  };
  await posted(helper, parent, "I need the source file.");
  await posted(parent, helper, brief);
  const last = await posted(helper, parent, "I need the source file!");
  plans.set(parent.slug, always((turn) => (afterTool(turn) ? { text: "(no reply)" } : { calls: [{ name: "node_delegate", arguments: { to: helper.slug, brief } }] })));
  const before = await h.prisma.nodeTurn.count({ where: { nodeId: helper.id } });
  await queueTurn(h.app, { nodeId: parent.id, roomId: taskRoom.id, reason: "mentioned", triggerMessageId: last.id });
  await settleTurns();
  const answer = toolAnswers(seen.filter((row) => row.slug === parent.slug && afterTool(row)).at(-1)!)[0]!;
  assert.match(answer, /was not woken: it repeats what was already said there/);
  assert.equal(await h.prisma.nodeTurn.count({ where: { nodeId: helper.id } }), before, "the loop is stopped");
});

test("an interrupt never stops a plan's report: the plan ends with its report, and the new message is answered after it", async () => {
  const kofi = await person("Kofi");
  const { nodes, crew } = await crewOf(kofi, ["manager", "researcher"]);
  const [lead, member] = nodes as [{ id: string; slug: string }, { id: string; slug: string }];
  plans.set(lead.slug, [
    { calls: [{ name: "node_delegate", arguments: { to: member.slug, brief: "Find the three cheapest flights to Lisbon.", kind: "research" } }] },
    { text: "Planned." },
    async () => {
      await sayNow(kofi, crew.id, "wait, also check trains", { steering: "interrupt" });
      await until(() => h.prisma.nodeSteer.findFirst({ where: { nodeId: lead.id, kind: "interrupt" } }), "the interrupt");
      return { text: "Report: the three cheapest flights are in the plan." };
    },
    { text: "Checking trains too." },
  ]);
  plans.set(member.slug, [{ calls: [{ name: "node_step_report", arguments: { outcome: "done", summary: "Found three flights: 89, 95 and 120 euros." } }] }, { text: "(no reply)" }]);
  await say(kofi, crew.id, "find me the cheapest flights to Lisbon");

  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { leadNodeId: lead.id } });
  assert.ok(mission.reportedAt, "the report turn ran");
  assert.notEqual(mission.status, "reporting");
  const replies = (await read(kofi, crew.id)).filter((row) => row.authorNodeId === lead.id && row.kind === "text").map((row) => row.body);
  assert.ok(replies.some((body) => body.includes("Report: the three cheapest flights")), "the report is posted");
  assert.equal(replies.at(-1), "Checking trains too.", "the new message is answered after the report");
  const steer = await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: lead.id, kind: "interrupt" } });
  assert.deepEqual([steer.operation, steer.children], ["new_run", {}], "the plan's turn was not stopped");
});

test("independent views: an amendment to one node's answer hands over only its owner's words, never a sibling's answer, and its cursor stays before them", async () => {
  const kofi = await person("Kofi");
  const { nodes, crew } = await crewOf(kofi, ["manager", "researcher", "assistant"]);
  const [, first, second] = nodes as [{ id: string; slug: string }, { id: string; slug: string }, { id: string; slug: string }];
  assert.equal((await kofi.inject({ method: "PATCH", url: `/api/node/rooms/${crew.id}`, payload: { mode: "independent" } })).statusCode, 200);
  let amended = "";
  plans.set(second.slug, [{ text: "B is better: it is cheaper." }]);
  plans.set(first.slug, [
    { calls: [createTask("Compare A and B")] },
    async () => {
      await until(() => h.prisma.nodeMessage.findFirst({ where: { roomId: crew.id, authorNodeId: second.id, kind: "text" } }), "the sibling's answer");
      amended = (await sayNow(kofi, crew.id, `@${first.slug} also weigh the price`)).id;
      await until(() => h.prisma.nodeSteer.findFirst({ where: { nodeId: first.id, kind: "amendment" } }), "the amendment");
      return { calls: [{ name: "hub_list_tasks", arguments: {} }] };
    },
    (turn) => ({ text: turn.transcript.includes("cheaper") ? "LEAKED the sibling's answer." : turn.transcript.includes("also weigh the price") ? "A is better, price weighed." : "No amendment." }),
  ]);
  const asked = await say(kofi, crew.id, `@${first.slug} @${second.slug} which is better, A or B?`);

  const answers = (await read(kofi, crew.id)).filter((row) => row.authorNodeId === first.id && row.kind === "text").map((row) => row.body);
  assert.deepEqual(answers, ["A is better, price weighed."], "one answer, with the amendment and nothing of the sibling's");
  const steer = await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: first.id, kind: "amendment" } });
  assert.deepEqual([steer.outcome, steer.messageId], ["accepted", amended]);
  const followUp = await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: first.id, triggerMessageId: amended } });
  assert.equal(followUp.outcome, "skipped", "the amendment was answered in the turn that took it");
  const member = await h.prisma.nodeRoomMember.findFirstOrThrow({ where: { roomId: crew.id, nodeId: first.id } });
  assert.equal(member.seenSeq, asked.seq, "its cursor stays before the sibling's answer");
});

/** A room made by `owner` with their node (their lead), joined by `guest` with theirs. */
async function roomWith(owner: HttpUser, nodeId: string, guest: HttpUser, guestNodeId: string) {
  const made = await owner.inject({ method: "POST", url: "/api/node/rooms", payload: { title: `Room ${randomBytes(3).toString("hex")}`, nodeIds: [nodeId], leadNodeId: nodeId, invite: [guest.email] } });
  assert.equal(made.statusCode, 201, made.body);
  const room = json(made).room as { id: string };
  const invite = (json(await guest.inject({ method: "GET", url: "/api/node/invites" })).invites as Array<{ id: string; room: { id: string } }>).find((row) => row.room.id === room.id)!;
  assert.equal((await guest.inject({ method: "POST", url: `/api/node/invites/${invite.id}/accept`, payload: { nodeIds: [guestNodeId], leadNodeId: guestNodeId } })).statusCode, 201);
  await settleTurns();
  return room;
}

test("independent views in a room: the room's history an answer reads stops at the question", async () => {
  const mira = await person("Mira");
  const ben = await person("Ben");
  const mine = (await createNode(mira, "assistant")).node;
  const bens = (await createNode(ben, "researcher")).node;
  for (const [user, id] of [[mira, mine.id], [ben, bens.id]] as const) assert.equal((await user.inject({ method: "PATCH", url: `/api/node/nodes/${id}`, payload: { autonomy: { sharedRooms: "auto" } } })).statusCode, 200);
  const room = await roomWith(mira, mine.id, ben, bens.id);
  assert.equal((await mira.inject({ method: "PATCH", url: `/api/node/rooms/${room.id}`, payload: { mode: "independent" } })).statusCode, 200);
  const handles = (json(await mira.inject({ method: "GET", url: `/api/node/rooms/${room.id}` })).room.members as Array<{ kind: string; handle: string; node?: { id: string } }>).filter((row) => row.kind === "node");
  const handleOf = (id: string) => handles.find((row) => row.node?.id === id)!.handle;
  plans.set(bens.slug, [{ text: "Y is better: it lasts longer." }]);
  plans.set(mine.slug, [
    async () => {
      await until(() => h.prisma.nodeMessage.findFirst({ where: { roomId: room.id, authorNodeId: bens.id, kind: "text" } }), "the other lead's answer");
      return { calls: [{ name: "node_room_history", arguments: {} }] };
    },
    (turn) => ({ text: toolAnswers(turn).some((answer) => answer.includes("lasts longer")) ? "LEAKED the other answer." : "X is better: it is lighter." }),
    { text: "They differ." },
  ]);
  await say(mira, room.id, `@${handleOf(mine.id)} @${handleOf(bens.id)} compare X and Y`);
  const answer = (await read(mira, room.id)).find((row) => row.authorNodeId === mine.id && row.kind === "text");
  assert.equal(answer?.body, "X is better: it is lighter.");
});

test("an amendment whose model call fails is answered by the next turn, once", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  let added = "";
  plans.set(node.slug, [
    { calls: [createTask("Draft the agenda")] },
    async () => {
      added = (await sayNow(mira, room.id, "also add a coffee break")).id;
      await until(() => h.prisma.nodeSteer.findFirst({ where: { nodeId: node.id, kind: "amendment" } }), "the amendment's record");
      return { calls: [{ name: "hub_list_tasks", arguments: {} }] };
    },
    () => {
      throw new RuntimeError("The model could not read this request.", 400, false, "invalid");
    },
    (turn) => ({ text: /also add a coffee break/.test(turn.transcript) ? "Added a coffee break to the agenda." : "Nothing to add." }),
  ]);
  await say(mira, room.id, "draft the agenda");

  const steer = await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: node.id, kind: "amendment" } });
  assert.equal(steer.outcome, "rejected", "nothing ran on it");
  const turns = await h.prisma.nodeTurn.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(turns.map((row) => [row.outcome, row.triggerMessageId === added]), [["failed", false], ["done", true]]);
  const replies = (await read(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text");
  assert.deepEqual(replies.map((row) => row.body), ["Added a coffee break to the agenda."]);
  const member = await h.prisma.nodeRoomMember.findFirstOrThrow({ where: { roomId: room.id, nodeId: node.id } });
  const rows = await h.prisma.assistantMessage.findMany({ where: { conversationId: member.conversationId!, role: "user" } });
  assert.ok(!rows.some((row) => row.content.includes("added this while you were working")), "what was never answered leaves the conversation");
});

test("a computer tool that runs a command is never read-only, and every read-only flag on the computer tools is one checked by hand", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  const { deviceTools, captureTools } = await import("./device-tools.js");
  const { liveTools } = await import("./live-views.js");
  const { desktopTools } = await import("../desktop/control/node-tools.js");
  const full = await h.prisma.nodeAgent.findUniqueOrThrow({ where: { id: node.id } });
  const scope = { prisma: h.prisma, node: full, room: await h.prisma.nodeRoom.findUniqueOrThrow({ where: { id: room.id } }), lineage: { rootMessageId: null, botDepth: 1, fromNonOwner: false }, privateTo: null, ownerOnly: true, redis: h.app.redis, dispatch: async () => undefined, turnId: randomUUID(), plan: null, signal: undefined, ownerWords: "" } as never;
  const tools = [...new Map([...deviceTools(scope), ...captureTools(scope), ...liveTools(scope), ...desktopTools(scope)].map((tool) => [tool.name, tool])).values()];
  assert.equal(readsOnly(tools.find((tool) => tool.name === "computer_terminal_screenshot")), false, "it runs any command");
  const reads = tools.filter((tool) => readsOnly(tool)).map((tool) => tool.name).sort();
  assert.deepEqual(reads, [
    "browser_console", "browser_extract", "browser_fetch", "browser_login_check", "browser_network_errors", "browser_screenshot", "browser_shop", "browser_snapshot", "browser_tabs", "browser_view", "browser_wait",
    "capture_apps", "capture_check", "capture_screenshot", "capture_status",
    "computer_git", "computer_run_output",
    "desktop_apps", "desktop_observe", "desktop_status", "desktop_zoom",
    "terminal_read",
  ], "every read-only flag on the computer tools, checked by hand");
});

test("journal labels: secrets are taken out by key and in text, before the label is cut", () => {
  const label = (args: unknown) => journalLabel(JSON.stringify(args)) ?? "";
  for (const kept of [
    label({ command: "PGPASSWORD=hunter2secret psql -h db -c 'select 1'" }),
    label({ url: "https://api.example.test/v1", headers: { Authorization: "Bearer abcdefghijklmnop123456" } }),
    label({ body: JSON.stringify({ password: "hunter2secret", user: "mira" }) }),
    // Its value starts before the 240th character and ends after it.
    label({ command: `echo ${"x".repeat(201)} && API_TOKEN=hunter2secretvalue ./deploy` }),
    label({ env: { DB_PASSWORD: "hunter2secret" }, note: "curl -u mira:hunter2secret https://x.test -H 'Authorization: Basic aHVudGVyMnNlY3JldA=='" }),
  ]) {
    assert.ok(!/hunter|abcdefghijklmnop|aHVudGVy/.test(kept), kept);
    assert.ok(kept.length <= 240, kept);
  }
  assert.ok(!/API_TOKEN=[^[]/.test(label({ command: `echo ${"x".repeat(201)} && API_TOKEN=hunter2secretvalue ./deploy` })), "nothing of a secret across the cut");
  assert.match(label({ command: "PGPASSWORD=hunter2secret psql" }), /PGPASSWORD=\[redacted\]/);
  assert.match(label({ command: "psql -h db PGPASSWORD=hunter2secret --quiet" }), /psql -h db PGPASSWORD=\[redacted\] --quiet/, "the words around it stay");
  assert.match(label({ headers: { Authorization: "Bearer abcdefghijklmnop123456" } }), /"Authorization":"\[redacted\]"/);
  assert.match(label({ title: "Book the venue" }), /"title":"Book the venue"/, "the rest stays");
});

// Steering, a stop and a restart meeting a plan (node/plans.ts, node/outbox.ts, node/watchdog.ts).

/** A gate a scripted model call waits at until it is opened, or until the call is stopped (never past 15 s: a scenario that went wrong fails instead of hanging). */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const at = (turn: Seen) =>
    turn.signal?.aborted
      ? Promise.resolve()
      : Promise.race([
          opened,
          new Promise<void>((resolve) => {
            turn.signal?.addEventListener("abort", () => resolve(), { once: true });
            setTimeout(resolve, 15_000).unref();
          }),
        ]);
  return { open, at };
}
const delegate = (to: string, brief: string): Call => ({ name: "node_delegate", arguments: { to, brief, kind: "research" } });
const stepReport = (summary: string, outcome = "done", extra: Record<string, unknown> = {}): Call => ({ name: "node_step_report", arguments: { outcome, summary, ...extra } });
const leadPlanTurns = (planId: string) => h.prisma.nodeTurn.findMany({ where: { planId, planStep: null }, orderBy: { createdAt: "asc" } });
const times = (text: string, part: string) => text.split(part).length - 1;
const childrenOf = (row: { children: unknown }) => row.children as { stopped?: Array<{ kind: string; id: string }>; kept?: Array<{ kind: string; id: string }> };

/**
 * A crew whose researcher's result comes in while its lead answers something else; the owner then steers the
 * lead (`extra`: the message's steering) while the plan's report turn waits in line behind that answer.
 */
async function resultWhileSteered(extra: Record<string, unknown>) {
  const kofi = await person("Kofi");
  const { nodes, crew } = await crewOf(kofi, ["manager", "researcher"]);
  const [lead, member] = nodes as [{ id: string; slug: string }, { id: string; slug: string }];
  // Model calls of this crew only: another crew's nodes may have the same handles.
  const from = seen.length;
  const mine = () => seen.slice(from);
  const research = gate();
  let planId = "";
  let steering = "";
  plans.set(
    lead.slug,
    always(async (turn) => {
      if (turn.transcript.includes("nothing left to run")) return { text: "Report: three flights, 89 to 120 euros." };
      if (turn.transcript.includes("check trains instead")) return { text: /Done before the stop[\s\S]*89, 95 and 120 euros/.test(turn.transcript) ? "Trains instead; the flights found are noted." : "Trains instead." };
      if (turn.transcript.includes("how is it going")) {
        // The result comes in now: the plan's report turn waits in line behind this one, and the owner steers.
        research.open();
        await until(() => h.prisma.nodeTurn.findFirst({ where: { planId, planStep: null, reason: "plan", status: "queued" } }), "the report turn in line");
        steering = (await sayNow(kofi, crew.id, "wait, check trains instead", extra)).id;
        await until(() => h.prisma.nodeSteer.findFirst({ where: { nodeId: lead.id, messageId: steering } }), "the steering");
        return { text: "Still on it." };
      }
      if (turn.transcript.includes("cheapest flights")) return afterTool(turn) ? { text: "Planned." } : { calls: [delegate(member.slug, "Find the three cheapest flights to Lisbon.")] };
      return { text: "(no reply)" };
    }),
  );
  plans.set(
    member.slug,
    always(async (turn) => {
      if (afterTool(turn)) return { text: "(no reply)" };
      await research.at(turn);
      return { calls: [stepReport("Found three flights: 89, 95 and 120 euros.")] };
    }),
  );
  await sayNow(kofi, crew.id, `@${lead.slug} find the cheapest flights to Lisbon`);
  await until(async () => mine().some((turn) => turn.slug === member.slug), "the research step");
  planId = (await h.prisma.nodeMission.findFirstOrThrow({ where: { leadNodeId: lead.id } })).id;
  const asked = await sayNow(kofi, crew.id, `@${lead.slug} how is it going?`);
  await settleTurns();
  const turnFor = (messageId: string) => h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: lead.id, triggerMessageId: messageId } });
  return {
    planId,
    plan: (await loadPlan(h.prisma, planId))!.data,
    busy: await turnFor(asked.id),
    next: await turnFor(steering),
    planTurns: await leadPlanTurns(planId),
    steer: await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: lead.id, messageId: steering } }),
    calls: mine().filter((turn) => turn.slug === lead.slug),
    replies: (await read(kofi, crew.id)).filter((row) => row.authorNodeId === lead.id && row.kind === "text").map((row) => row.body),
  };
}

test("a child's result that comes in while its lead is interrupted reaches the lead once, in the plan's report turn; the new message is answered after it", async () => {
  const run = await resultWhileSteered({ steering: "interrupt" });
  assert.equal(run.busy.outcome, "cancelled", "the answer going on stopped");
  assert.deepEqual(run.planTurns.map((row) => row.outcome), ["done"], "the report turn was never stopped");
  assert.equal(run.plan.status, "succeeded");
  assert.equal(run.plan.steps[0]!.attempts[0]!.deliveredTo, run.planTurns[0]!.id, "carried by the report turn");
  const carried = run.calls.filter((turn) => turn.transcript.includes("89, 95 and 120 euros"));
  assert.equal(carried.length, 1, "the result reached the lead once");
  assert.match(carried[0]!.transcript, /nothing left to run/);
  assert.ok(!run.calls.find((turn) => turn.transcript.includes("nothing left to run"))!.transcript.includes("check trains instead"), "the report turn leaves the new message to its own turn");
  assert.deepEqual(run.replies.slice(-2), ["Report: three flights, 89 to 120 euros.", "Trains instead."]);
  assert.ok(!run.replies.includes("Still on it."));
  assert.equal(run.next.outcome, "done");
  assert.deepEqual(childrenOf(run.steer).stopped, [{ kind: "turn", id: run.busy.id }]);
});

test("a child's result that comes in during a replacement: work kept on purpose reports it once; stopped work keeps it, and its lead hears it once with the new work", async () => {
  const kept = await resultWhileSteered({ steering: "replace", children: "keep" });
  assert.deepEqual(kept.planTurns.map((row) => row.outcome), ["done"]);
  assert.equal(kept.plan.status, "succeeded");
  assert.equal(kept.plan.steps[0]!.attempts[0]!.deliveredTo, kept.planTurns[0]!.id);
  assert.equal(kept.calls.filter((turn) => turn.transcript.includes("89, 95 and 120 euros")).length, 1);
  assert.deepEqual(kept.replies.slice(-2), ["Report: three flights, 89 to 120 euros.", "Trains instead."]);
  assert.ok(childrenOf(kept.steer).kept!.some((child) => child.kind === "plan" && child.id === kept.planId));

  const stopped = await resultWhileSteered({ steering: "replace" });
  assert.equal(stopped.plan.status, "stopped");
  assert.deepEqual(stopped.planTurns.map((row) => row.outcome), ["cancelled"], "the report turn in line stopped with its plan before it began");
  assert.deepEqual([stopped.plan.steps[0]!.status, stopped.plan.steps[0]!.result], ["done", "Found three flights: 89, 95 and 120 euros."], "what was done stays");
  const carried = stopped.calls.filter((turn) => turn.transcript.includes("89, 95 and 120 euros"));
  assert.equal(carried.length, 1, "the result reached the lead once");
  assert.match(carried[0]!.transcript, /check trains instead[\s\S]*Done before the stop, and kept/);
  assert.equal(stopped.replies.at(-1), "Trains instead; the flights found are noted.");
  assert.ok(childrenOf(stopped.steer).stopped!.some((child) => child.kind === "plan" && child.id === stopped.planId));
});

test("a stop during a lead's report or re-plan turn ends its plan once: nothing is left reporting or re-planning, and nothing asks for it again", async () => {
  for (const stuck of [false, true]) {
    const kofi = await person("Kofi");
    const { nodes, crew } = await crewOf(kofi, ["manager", "researcher"]);
    const [lead, member] = nodes as [{ id: string; slug: string }, { id: string; slug: string }];
    const from = seen.length;
    const held = gate();
    plans.set(
      lead.slug,
      always(async (turn) => {
        if (/nothing left to run|one re-plan turn/.test(turn.transcript)) {
          await held.at(turn);
          return { text: "Report after the stop." };
        }
        if (turn.transcript.includes("find the sources")) return afterTool(turn) ? { text: "Planned." } : { calls: [delegate(member.slug, "Find the sources.")] };
        return { text: "(no reply)" };
      }),
    );
    plans.set(member.slug, always((turn) => (afterTool(turn) ? { text: "(no reply)" } : { calls: [stuck ? stepReport("No access to the archive.", "blocked", { blockedBy: "missing_access" }) : stepReport("One source: the archive index.")] })));
    await sayNow(kofi, crew.id, `@${lead.slug} find the sources`);
    await until(async () => seen.slice(from).some((turn) => turn.slug === lead.slug && /nothing left to run|one re-plan turn/.test(turn.transcript)), "the lead's plan turn");
    const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { leadNodeId: lead.id } });
    assert.equal(mission.status, stuck ? "replanning" : "reporting");

    const response = await kofi.inject({ method: "POST", url: `/api/node/rooms/${crew.id}/stop`, payload: {} });
    assert.equal(response.statusCode, 200, response.body);
    held.open();
    await settleTurns();
    // Ended (stopped, or concluded by the cut-off turn's end when that came first), never left waiting for its lead.
    const ended = (await h.prisma.nodeMission.findUniqueOrThrow({ where: { id: mission.id } })).status;
    assert.ok(!(LIVE_MISSIONS as readonly string[]).includes(ended), ended);
    const planTurns = await leadPlanTurns(mission.id);
    assert.deepEqual(planTurns.map((row) => row.outcome), ["cancelled"], "its one plan turn stopped, and none came after it");
    assert.equal(await h.prisma.nodeOutbox.count({ where: { missionId: mission.id, deliveredAt: null } }), 0, "no report or re-plan on its way");
    assert.deepEqual((await checkWork(h.app, Date.now() + 6 * 60 * 60_000)).filter((row) => row.missionId === mission.id), [], "the watchdog finds nothing to start again");
    const rows = await read(kofi, crew.id);
    assert.ok(!rows.some((row) => row.body === "Report after the stop."));
    assert.ok(!rows.some((row) => row.kind === "approval" && row.data.status === "pending"), "no card left asking");
    const stop = await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: lead.id, kind: "stop" } });
    assert.deepEqual(
      childrenOf(stop).stopped!.map((child) => [child.kind, child.id]),
      [
        ["turn", planTurns[0]!.id],
        ["plan", mission.id],
      ],
      "the record lists the plan, re-planning or reporting",
    );
  }
});

test("a replacement that stops the old work stops a plan in its re-plan turn too, and the watchdog never starts that work again", async () => {
  const kofi = await person("Kofi");
  const { nodes, crew } = await crewOf(kofi, ["manager", "researcher"]);
  const [lead, member] = nodes as [{ id: string; slug: string }, { id: string; slug: string }];
  const held = gate();
  plans.set(
    lead.slug,
    always(async (turn) => {
      if (turn.transcript.includes("one re-plan turn")) {
        await held.at(turn);
        return { text: "(no reply)" };
      }
      if (turn.transcript.includes("write the changelog")) return { text: /Stopped for it: /.test(turn.transcript) ? "On the changelog." : "Missing what stopped." };
      if (turn.transcript.includes("find the sources")) return afterTool(turn) ? { text: "Planned." } : { calls: [delegate(member.slug, "Find the sources.")] };
      return { text: "(no reply)" };
    }),
  );
  plans.set(member.slug, always((turn) => (afterTool(turn) ? { text: "(no reply)" } : { calls: [stepReport("No access to the archive.", "blocked", { blockedBy: "missing_access" })] })));
  await sayNow(kofi, crew.id, `@${lead.slug} find the sources`);
  await until(async () => seen.some((turn) => turn.slug === lead.slug && turn.transcript.includes("one re-plan turn")), "the lead's re-plan turn");
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { leadNodeId: lead.id } });
  assert.equal(mission.status, "replanning");

  const message = await sayNow(kofi, crew.id, "new plan: write the changelog instead", { steering: "replace" });
  await until(() => h.prisma.nodeSteer.findFirst({ where: { nodeId: lead.id, messageId: message.id } }), "the replacement");
  held.open();
  await settleTurns();
  assert.equal((await h.prisma.nodeMission.findUniqueOrThrow({ where: { id: mission.id } })).status, "stopped");
  assert.deepEqual((await leadPlanTurns(mission.id)).map((row) => row.outcome), ["cancelled"], "the re-plan turn stopped with its plan");
  const steer = await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: lead.id, messageId: message.id } });
  assert.ok(childrenOf(steer).stopped!.some((child) => child.kind === "plan" && child.id === mission.id), "the record lists the plan it stopped");
  const turnsBefore = await h.prisma.nodeTurn.count({ where: { nodeId: { in: [lead.id, member.id] } } });
  assert.deepEqual((await checkWork(h.app, Date.now() + 6 * 60 * 60_000)).filter((row) => row.missionId === mission.id), [], "no nudge, no re-plan again, no card");
  await settleTurns();
  assert.equal(await h.prisma.nodeTurn.count({ where: { nodeId: { in: [lead.id, member.id] } } }), turnsBefore, "nothing of the old work starts again");
  const rows = await read(kofi, crew.id);
  assert.ok(!rows.some((row) => row.kind === "approval" && row.data.status === "pending"), "no card for the stuck step");
  assert.equal(rows.filter((row) => row.authorNodeId === lead.id && row.kind === "text").at(-1)?.body, "On the changelog.");
});

test("an owner's message during a lead's re-plan turn is not taken into it: it waits, and its own turn answers it after", async () => {
  const kofi = await person("Kofi");
  const { nodes, crew } = await crewOf(kofi, ["manager", "researcher"]);
  const [lead, member] = nodes as [{ id: string; slug: string }, { id: string; slug: string }];
  let added = "";
  plans.set(
    lead.slug,
    always(async (turn) => {
      if (turn.transcript.includes("one re-plan turn")) {
        if (!afterTool(turn)) return { calls: [createTask("Ask for access to the archive")] };
        // The re-plan turn has acted: its owner writes now.
        added = (await sayNow(kofi, crew.id, `@${lead.slug} also try the library`)).id;
        await until(() => h.prisma.nodeSteer.findFirst({ where: { nodeId: lead.id, messageId: added } }), "the message's record");
        return { text: "(no reply)" };
      }
      if (turn.transcript.includes("also try the library")) return { text: "Trying the library too." };
      if (turn.transcript.includes("find the sources")) return afterTool(turn) ? { text: "Planned." } : { calls: [delegate(member.slug, "Find the sources.")] };
      return { text: "(no reply)" };
    }),
  );
  plans.set(member.slug, always((turn) => (afterTool(turn) ? { text: "(no reply)" } : { calls: [stepReport("No access to the archive.", "blocked", { blockedBy: "missing_access" })] })));
  await say(kofi, crew.id, `@${lead.slug} find the sources`);

  const steer = await h.prisma.nodeSteer.findFirstOrThrow({ where: { nodeId: lead.id, messageId: added } });
  assert.deepEqual([steer.kind, steer.operation, steer.outcome], ["follow_up", "queue", "done"], "queued for its own turn, not an amendment");
  const decided = await h.prisma.nodeDecision.findFirstOrThrow({ where: { nodeId: lead.id, kind: "steer", inputs: { path: ["messageId"], equals: added } } });
  assert.deepEqual((decided.inputs as { worker: unknown }).worker, { state: "running", acted: true, canSteer: false, mergeable: false }, "decided by the worker's state: a plan's turn that acted takes nothing");
  assert.equal(await h.prisma.nodeSteer.count({ where: { nodeId: lead.id, kind: "amendment" } }), 0);
  const replans = seen.filter((turn) => turn.slug === lead.slug && turn.transcript.includes("one re-plan turn"));
  assert.equal(replans.length, 2);
  assert.ok(replans.every((turn) => !turn.messages.some((row) => row.role === "user" && textOf(row.content).includes("also try the library"))), "nothing of it reached the re-plan turn");
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { leadNodeId: lead.id } });
  assert.notEqual(mission.status, "replanning", "the re-plan turn's end ended the re-plan");
  const answer = await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: lead.id, triggerMessageId: added } });
  assert.equal(answer.outcome, "done");
  const replies = (await read(kofi, crew.id)).filter((row) => row.authorNodeId === lead.id && row.kind === "text").map((row) => row.body);
  assert.equal(replies.at(-1), "Trying the library too.");
});

test("a restart with a run's end waiting in the outbox and a call of a lead's report turn left unsure: the resumed report says what may have run and carries each result once; the run's end comes once", async () => {
  const kofi = await person("Kofi");
  const { nodes, crew } = await crewOf(kofi, ["manager", "researcher"]);
  const [lead, member] = nodes as [{ id: string; slug: string }, { id: string; slug: string }];
  const research = gate();
  const chat = gate();
  const venue = createTask("Book the venue");
  plans.set(
    lead.slug,
    always(async (turn) => {
      if (turn.transcript.includes("nothing left to run")) return afterTool(turn) ? { text: "Report: one source found." } : { calls: [venue] };
      if (turn.transcript.includes("Check the build")) return { text: "The build check passed." };
      if (turn.transcript.includes("how is it going")) {
        await chat.at(turn);
        return { text: "Still on it." };
      }
      if (turn.transcript.includes("find the sources")) return afterTool(turn) ? { text: "Planned." } : { calls: [delegate(member.slug, "Find the sources.")] };
      return { text: "(no reply)" };
    }),
  );
  plans.set(
    member.slug,
    always(async (turn) => {
      if (afterTool(turn)) return { text: "(no reply)" };
      await research.at(turn);
      return { calls: [stepReport("One source: the archive index.")] };
    }),
  );
  await sayNow(kofi, crew.id, `@${lead.slug} find the sources`);
  await until(async () => seen.some((turn) => turn.slug === member.slug), "the research step");
  const planId = (await h.prisma.nodeMission.findFirstOrThrow({ where: { leadNodeId: lead.id } })).id;
  // The lead is busy in the room when the result comes in: its report turn waits in line.
  await sayNow(kofi, crew.id, `@${lead.slug} how is it going?`);
  await until(async () => seen.some((turn) => turn.slug === lead.slug && turn.transcript.includes("how is it going")), "the lead's answer");
  research.open();
  const cut = await until(() => h.prisma.nodeTurn.findFirst({ where: { planId, planStep: null, reason: "plan", status: "queued" } }), "the report turn in line");
  // It starts (carrying the result), calls a tool that acts, and the server stops before the call's result is saved.
  await h.prisma.nodeTurn.update({ where: { id: cut.id }, data: { status: "running", outcome: "running" } });
  assert.equal((await beginPlanTurn(h.app, planId, cut.id))?.kind, "report");
  const ticket = await turnJournal(h.app, cut).begin({ name: venue.name, arguments: JSON.stringify(venue.arguments), sideEffect: true });
  assert.ok("ticket" in ticket);
  await ticket.ticket.dispatched();
  await h.prisma.task.create({ data: { userId: kofi.id, title: "Book the venue" } });
  chat.open();
  await settleTurns();
  // A run of the lead's ended just before: its end was written to the outbox (node/runs.ts) and not delivered yet.
  const operationId = `run:${randomUUID()}:end`;
  const note = "The session run for “Check the build” finished.\nThe agent reported: done. All checks pass.";
  await h.prisma.nodeOutbox.create({ data: { operationId, kind: "wake", payload: { request: { nodeId: lead.id, roomId: crew.id, reason: "run", triggerMessageId: null, note }, status: "succeeded", summary: "All checks pass." } } });

  // The restart: turns are reconciled, then the outbox delivers what was left, and once more (a crash before its row was marked).
  await recoverTurns(h.app);
  await dispatchOutbox(h.app);
  await settleTurns();
  await h.prisma.nodeOutbox.update({ where: { operationId }, data: { deliveredAt: null, claimedUntil: null } });
  await dispatchOutbox(h.app);
  await settleTurns();

  assert.equal((await h.prisma.nodeTurn.findUniqueOrThrow({ where: { id: cut.id } })).error, "Interrupted by a server restart after it had acted.");
  const resumed = await h.prisma.nodeTurn.findFirstOrThrow({ where: { originTurnId: cut.id } });
  assert.equal(resumed.outcome, "done");
  const reports = seen.filter((turn) => turn.slug === lead.slug && turn.transcript.includes("nothing left to run"));
  assert.match(reports[0]!.transcript, /These calls started but their result was never saved[\s\S]*- hub_create_tasks \{"tasks":\[\{"title":"Book the venue"\}\]\}[\s\S]*nothing left to run/);
  assert.equal(times(reports[0]!.transcript, "One source: the archive index."), 1, "the result once, from the plan as it is now");
  assert.match(toolAnswers(reports.at(-1)!)[0]!, /may already have happened\. It was not run again/);
  assert.equal(await tasksCalled(kofi.id, "Book the venue"), 1, "not run again blindly");
  const plan = (await loadPlan(h.prisma, planId))!;
  assert.equal(plan.data.status, "succeeded");
  assert.equal(plan.data.steps[0]!.attempts[0]!.deliveredTo, cut.id, "carried once, by the turn that took it first");
  assert.equal((plan.mission.leadTurn as { id: string }).id, resumed.id, "the resumed turn's end ended the report");
  assert.equal(await h.prisma.nodeTurn.count({ where: { operationId } }), 1, "the run's end wakes the lead once");
  assert.equal(seen.filter((turn) => turn.slug === lead.slug && turn.transcript.includes("Check the build")).length, 1);
  const replies = (await read(kofi, crew.id)).filter((row) => row.authorNodeId === lead.id && row.kind === "text").map((row) => row.body);
  assert.equal(replies.filter((body) => body === "Report: one source found.").length, 1);
  assert.equal(replies.filter((body) => body === "The build check passed.").length, 1);
});
