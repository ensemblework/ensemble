/**
 * Ensemble Node orchestration (docs/35 §4.2, §5.1, §5.8, §5.9, §6.4, §8.3) against an in-memory database, with
 * the model scripted per node: the tool journal and what a restart does with a call that started and never
 * answered; the five steering cases (a follow-up, an amendment taken between steps, an interrupt, a replacement
 * that stops or keeps what it replaces, a stop with every child); independent views in a crew; Roles (beta).
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
const { turnJournal } = await import("./journal.js");
const { postMessage } = await import("./store.js");
const { openToolRun } = await import("../devices/tool-runs.js");
const { recordingStarted, recordingsOf } = await import("./recordings.js");
const { recoverRounds } = await import("./groups.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
after(() => h.close());

type Call = { name: string; arguments: Record<string, unknown> };
type Step = { calls?: Call[]; text?: string };
type Seen = { slug: string; transcript: string; messages: Array<{ role?: string; content?: unknown }> };
/** Each node's model calls, in order, by its handle: a step, or a function of what the call was given. Out of steps: "ok". */
const plans = new Map<string, Array<Step | ((seen: Seen) => Step | Promise<Step>)>>();
const seen: Seen[] = [];

const textOf = (content: unknown) =>
  Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(content ?? "");

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(system)?.[1] ?? "?";
  const current: Seen = { slug, transcript: textOf(messages.filter((row) => row.role === "user").at(-1)?.content), messages };
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

test("bot brakes: two nodes passing the same words back and forth, or one repeating itself, wake nobody, once said", async () => {
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
  plans.set(a.slug, [{ text: "(no reply)" }, { text: "(no reply)" }]);
  plans.set(b.slug, [{ text: "(no reply)" }, { text: "(no reply)" }]);
  const nodeSays = async (from: { id: string }, to: { id: string; slug: string }, body: string) => {
    const { message } = await postMessage(h.prisma, { roomId: room.id, userId: mira.id, authorKind: "node", authorNodeId: from.id, body: `@${to.slug} ${body}`, visibleTo: [], mentions: [{ kind: "node", id: to.id }] });
    await dispatchMessage(h.app, message);
    await settleTurns();
    return message;
  };
  await nodeSays(a, b, "can you check the file?");
  await nodeSays(b, a, "Checked. Over to you.");
  const looped = await nodeSays(a, b, "Can you check the file");
  const route = await h.prisma.nodeDecision.findFirstOrThrow({ where: { kind: "route", inputs: { path: ["messageId"], equals: looped.id } } });
  assert.deepEqual(route.choice, { reason: "none", brake: "cycle", woken: [] });
  assert.equal(await h.prisma.nodeTurn.count({ where: { triggerMessageId: looped.id } }), 0, "the node it named is not woken");
  const lines = await h.prisma.nodeMessage.findMany({ where: { roomId: room.id, authorKind: "system", kind: "status" } });
  assert.deepEqual(lines.map((row) => [row.body, (row.data as { brake: string }).brake]), [["Paused here: the nodes kept saying the same thing to each other. Ask the node that made this helper to continue.", "cycle"]]);

  const again = await nodeSays(b, a, "Checked. Over to you!");
  const repeated = await h.prisma.nodeDecision.findFirstOrThrow({ where: { kind: "route", inputs: { path: ["messageId"], equals: again.id } } });
  assert.equal((repeated.choice as { brake: string }).brake, "cycle");
  assert.equal(await h.prisma.nodeMessage.count({ where: { roomId: room.id, authorKind: "system", kind: "status" } }), 1, "said once until a person writes");
  assert.equal(await h.prisma.nodeTurn.count({ where: { roomId: room.id } }), 2, "only the first two messages woke a node");
});
