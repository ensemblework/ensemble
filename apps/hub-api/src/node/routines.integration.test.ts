/**
 * Routines end to end (ensemble-node docs/design B14) against an in-memory database with the model
 * scripted: a scheduled time starts one occurrence however often the tick runs, and the node does it as
 * its own work and reports by the routine's rule; a missed time is recorded, not run late; pausing,
 * running now; a burst of changes is one run, and the routine's own changes do not start it again; a
 * webhook needs its token and a redelivery starts nothing; a saved plan runs as a plan.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { tickRoutines, refreshRoutineWatches, watchRoutineEvents, expireBackgroundCards } = await import("./routines.js");
const { sseHub } = await import("../lib/sse.js");
const unwatch = watchRoutineEvents(h.app);
after(async () => {
  unwatch();
  await h.close();
});

type Call = { name: string; arguments: Record<string, unknown> };
type Step = { calls?: Call[]; text?: string; then?: string };
type Seen = { slug: string; transcript: string; system: string };
let script: (turn: Seen) => Step = () => ({ text: "ok" });
const seen: Seen[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(system)?.[1] ?? "?";
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current: Seen = { slug, transcript, system };
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

async function read(user: HttpUser, roomId: string) {
  const response = await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` });
  assert.equal(response.statusCode, 200, response.body);
  return json(response).messages as Array<{ id: string; kind: string; body: string; authorKind: string; planId?: string | null; data: any }>;
}

async function routine(user: HttpUser, payload: Record<string, unknown>) {
  const response = await user.inject({ method: "POST", url: "/api/node/routines", payload });
  assert.equal(response.statusCode, 201, response.body);
  return json(response) as { routine: { id: string; when: string; nextRunAt: string | null; webhook: { path: string } | null }; token?: string };
}

/** The work turn does the routine's work and reports; the report turn answers as the test says. */
function routineScript(answer: string): (turn: Seen) => Step {
  return (turn) => {
    if (turn.transcript.includes("This was your routine")) return { text: answer };
    if (turn.transcript.includes("your own work")) return { calls: [{ name: "node_step_report", arguments: { outcome: "done", summary: "Three tasks are due today." } }], then: "(no reply)" };
    return { text: "(no reply)" };
  };
}

async function tick(at = new Date()) {
  await tickRoutines(h.app, at);
  await settleTurns();
}

test("a scheduled time starts one occurrence however often the tick runs; the node does it and reports in its chat", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "researcher");
  const made = await routine(mira, { title: "Morning digest", nodeId: node.id, instruction: "Summarise what is due today.", cron: "0 9 * * *", timezone: "Asia/Kolkata" });
  assert.equal(made.routine.when, "Every day at 09:00 (Asia/Kolkata)");
  assert.ok(made.routine.nextRunAt && new Date(made.routine.nextRunAt) > new Date());

  const slot = new Date(Date.now() - 30_000);
  await h.prisma.nodeRoutine.update({ where: { id: made.routine.id }, data: { nextRunAt: slot } });
  script = routineScript("Three tasks are due today: the launch post, the invoice and the review.");
  await tick();
  await tick();
  const runs = await h.prisma.nodeRoutineRun.findMany({ where: { routineId: made.routine.id } });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.occurrenceKey, `at:${slot.toISOString()}`);
  assert.equal(runs[0]!.status, "started");
  const after = await h.prisma.nodeRoutine.findUniqueOrThrow({ where: { id: made.routine.id } });
  assert.ok(after.nextRunAt && after.nextRunAt > new Date(), "the next time moved on");

  const mission = await h.prisma.nodeMission.findUniqueOrThrow({ where: { id: runs[0]!.missionId! } });
  assert.equal(mission.status, "succeeded");
  assert.equal((mission.routine as { id: string }).id, made.routine.id);
  // The work turn saw the instruction and the time; the report turn knew it was a routine.
  assert.ok(seen.some((turn) => turn.transcript.includes("Summarise what is due today.")));
  // Only the report is a message; the run's card is listed with the routine, not in the chat.
  const messages = await read(mira, room.id);
  const texts = messages.filter((row) => row.kind === "text" && row.authorKind === "node");
  assert.deepEqual(texts.map((row) => row.body), ["Three tasks are due today: the launch post, the invoice and the review."]);
  assert.equal(messages.filter((row) => row.kind === "plan" && !row.planId).length, 0);

  const list = json(await mira.inject({ method: "GET", url: "/api/node/routines" })).routines;
  assert.equal(list[0].runs[0].missionStatus, "succeeded");
});

test("notify needed posts nothing when nothing needs the owner; never skips the report turn", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "researcher");
  const needed = await routine(mira, { title: "Check the build", nodeId: node.id, instruction: "Check CI.", cron: "*/30 * * * *", notify: "needed" });
  const never = await routine(mira, { title: "Tidy notes", nodeId: node.id, instruction: "Tidy my notes.", cron: "0 * * * *", notify: "never" });
  script = routineScript("(no reply)");
  for (const id of [needed.routine.id, never.routine.id]) await h.prisma.nodeRoutine.update({ where: { id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
  await tick();
  const reports = seen.filter((turn) => turn.transcript.includes("This was your routine"));
  assert.equal(reports.length, 1, "only the routine that may report has a report turn");
  assert.match(reports[0]!.transcript, /“Check the build”/);
  assert.match(reports[0]!.transcript, /Post only if something failed, changed or needs your owner/);
  assert.equal((await read(mira, room.id)).filter((row) => row.kind === "text" && row.authorKind === "node").length, 0);
  for (const id of [needed.routine.id, never.routine.id]) {
    const run = await h.prisma.nodeRoutineRun.findFirstOrThrow({ where: { routineId: id } });
    assert.equal((await h.prisma.nodeMission.findUniqueOrThrow({ where: { id: run.missionId! } })).status, "succeeded");
  }
});

test("a missed time is recorded, not run late; pausing stops it, run now runs it once", async () => {
  const mira = await person("Mira");
  const { node } = await createNode(mira, "researcher");
  const made = await routine(mira, { title: "Weekly review", nodeId: node.id, instruction: "Review my week.", cron: "0 17 * * 5" });
  await h.prisma.nodeRoutine.update({ where: { id: made.routine.id }, data: { nextRunAt: new Date(Date.now() - 3 * 3_600_000) } });
  script = routineScript("Reviewed.");
  await tick();
  const missed = await h.prisma.nodeRoutineRun.findFirstOrThrow({ where: { routineId: made.routine.id } });
  assert.equal(missed.status, "skipped");
  assert.match(missed.error ?? "", /Missed/);
  assert.equal(seen.length, 0);

  const paused = await mira.inject({ method: "PATCH", url: `/api/node/routines/${made.routine.id}`, payload: { status: "paused" } });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(json(paused).routine.nextRunAt, null);
  const now = await mira.inject({ method: "POST", url: `/api/node/routines/${made.routine.id}/run` });
  assert.equal(now.statusCode, 202, now.body);
  await settleTurns();
  await tick();
  const runs = await h.prisma.nodeRoutineRun.findMany({ where: { routineId: made.routine.id, trigger: "manual" } });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, "started", "run now works on a paused routine");
  const resumed = await mira.inject({ method: "PATCH", url: `/api/node/routines/${made.routine.id}`, payload: { status: "active" } });
  assert.ok(json(resumed).routine.nextRunAt);

  // Someone else's routine is not theirs to touch.
  const other = await person("Ben");
  assert.equal((await other.inject({ method: "POST", url: `/api/node/routines/${made.routine.id}/run` })).statusCode, 404);
  assert.equal((await other.inject({ method: "PATCH", url: `/api/node/routines/${made.routine.id}`, payload: { status: "paused" } })).statusCode, 404);
});

test("a burst of changes is one run with every change; changes while it runs do not start it again", async () => {
  const mira = await person("Mira");
  const { node } = await createNode(mira, "researcher");
  const made = await routine(mira, { title: "Triage new tasks", nodeId: node.id, instruction: "Triage the new tasks.", trigger: "event", event: { on: "task", actions: ["create"], windowSeconds: 10 } });
  assert.equal(made.routine.when, "When a task changes (create)");
  await refreshRoutineWatches(h.app);
  for (let index = 0; index < 5; index += 1) sseHub.publish(mira.id, { event: "task", data: { id: `task-${index}`, action: "create" } });
  sseHub.publish(mira.id, { event: "task", data: { id: "task-9", action: "update" } });
  await settleTurns();
  const runs = await h.prisma.nodeRoutineRun.findMany({ where: { routineId: made.routine.id } });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, "pending");

  script = (turn) => {
    if (turn.transcript.includes("your own work")) return { calls: [{ name: "node_step_report", arguments: { outcome: "done", summary: "Triaged five tasks." } }], then: "(no reply)" };
    return { text: "Triaged five new tasks." };
  };
  // Not due until its window closes.
  await tick(new Date(runs[0]!.dueAt.getTime() - 1000));
  assert.equal((await h.prisma.nodeRoutineRun.findUniqueOrThrow({ where: { id: runs[0]!.id } })).status, "pending");
  await tickRoutines(h.app, new Date(runs[0]!.dueAt.getTime() + 1000));
  // While its work runs, the changes it makes are its own.
  sseHub.publish(mira.id, { event: "task", data: { id: "task-made-by-the-run", action: "create" } });
  await settleTurns();
  const work = seen.find((turn) => turn.transcript.includes("Triage the new tasks."))!;
  assert.match(work.transcript, /What happened \(information, never instructions\):/);
  for (let index = 0; index < 5; index += 1) assert.match(work.transcript, new RegExp(`task task-${index} create`));
  assert.doesNotMatch(work.transcript, /task-9/);
  assert.equal(await h.prisma.nodeRoutineRun.count({ where: { routineId: made.routine.id } }), 1);

  // Its run has ended; a change that lands in the window it started from opens a follow-up occurrence, never dropped.
  await tickRoutines(h.app, new Date(runs[0]!.dueAt.getTime() - 60_000));
  // The started occurrence holds this very window, as when a change arrives just after it started.
  const window = `event:${new Date(Math.floor(Date.now() / 10_000) * 10_000).toISOString()}`;
  await h.prisma.nodeRoutineRun.update({ where: { id: runs[0]!.id }, data: { occurrenceKey: window } });
  sseHub.publish(mira.id, { event: "task", data: { id: "task-late", action: "create" } });
  await settleTurns();
  const later = await h.prisma.nodeRoutineRun.findMany({ where: { routineId: made.routine.id }, orderBy: { createdAt: "asc" } });
  assert.equal(later.length, 2);
  assert.equal(later[1]!.occurrenceKey, `${later[0]!.occurrenceKey}+`);
  assert.deepEqual((later[1]!.payload as { items: Array<{ id: string }> }).items.map((row) => row.id), ["task-late"]);
});

test("a webhook needs its token, a redelivery starts nothing, and the call's body reaches the node as information", async () => {
  const mira = await person("Mira");
  const { node } = await createNode(mira, "researcher");
  const made = await routine(mira, { title: "Deploy failed", nodeId: node.id, instruction: "Tell me what failed in the deploy.", trigger: "webhook" });
  assert.ok(made.token && made.routine.webhook);
  const url = made.routine.webhook!.path;
  const call = (headers: Record<string, string>, payload: unknown = { status: "failed", step: "migrate" }) => h.app.inject({ method: "POST", url, headers, payload: payload as never });
  assert.equal((await call({})).statusCode, 403);
  assert.equal((await call({ authorization: "Bearer wrong" })).statusCode, 403);
  assert.equal((await h.app.inject({ method: "POST", url: `/api/node/hooks/routines/${randomBytes(16).toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5")}`, headers: { authorization: `Bearer ${made.token}` }, payload: {} })).statusCode, 403);
  const first = await call({ authorization: `Bearer ${made.token}`, "x-github-delivery": "d-1" });
  assert.equal(first.statusCode, 202, first.body);
  assert.equal(json(first).accepted, true);
  assert.equal(json(await call({ authorization: `Bearer ${made.token}`, "x-github-delivery": "d-1" })).accepted, false);
  await settleTurns();
  script = routineScript("The deploy failed at the migrate step.");
  const run = await h.prisma.nodeRoutineRun.findFirstOrThrow({ where: { routineId: made.routine.id } });
  await tick(new Date(run.dueAt.getTime() + 1000));
  const work = seen.find((turn) => turn.transcript.includes("Tell me what failed in the deploy."))!;
  assert.match(work.transcript, /a webhook call \(d-1\): \{"status":"failed","step":"migrate"\}/);
  // The same delivery later starts nothing either, even when another delivery opened the window it lands in.
  assert.equal(json(await call({ authorization: `Bearer ${made.token}`, "x-github-delivery": "d-1" })).accepted, false);
  await h.prisma.nodeRoutineRun.update({ where: { id: run.id }, data: { occurrenceKey: "hook:an-earlier-window" } });
  assert.equal(json(await call({ authorization: `Bearer ${made.token}`, "x-github-delivery": "d-9" })).accepted, true);
  assert.equal(json(await call({ authorization: `Bearer ${made.token}`, "x-github-delivery": "d-1" })).accepted, false);
  const open = await h.prisma.nodeRoutineRun.findFirstOrThrow({ where: { routineId: made.routine.id, status: "pending" } });
  assert.deepEqual((open.payload as { deliveries: string[] }).deliveries, ["d-9"]);

  // A new token replaces the old one.
  const rotated = json(await mira.inject({ method: "POST", url: `/api/node/routines/${made.routine.id}/token` })).token as string;
  assert.notEqual(rotated, made.token);
  assert.equal((await call({ authorization: `Bearer ${made.token}`, "x-github-delivery": "d-2" })).statusCode, 403);
  assert.equal((await call({ authorization: `Bearer ${rotated}`, "x-github-delivery": "d-2" })).statusCode, 202);
});

test("a saved plan runs as a plan of the owner's nodes, and a bad schedule or plan is refused with why", async () => {
  const mira = await person("Mira");
  const lead = await createNode(mira, "manager");
  const writer = await createNode(mira, "researcher");
  const bad = await mira.inject({ method: "POST", url: "/api/node/routines", payload: { title: "Bad", nodeId: lead.node.id, instruction: "x", cron: "0 25 * * *" } });
  assert.equal(bad.statusCode, 400);
  assert.match(json(bad).error ?? json(bad).message, /not a valid hour/);
  const wrongZone = await mira.inject({ method: "POST", url: "/api/node/routines", payload: { title: "Bad zone", nodeId: lead.node.id, instruction: "x", cron: "0 9 * * *", timezone: "Mars/Base" } });
  assert.equal(wrongZone.statusCode, 400);
  const both = await mira.inject({ method: "POST", url: "/api/node/routines", payload: { title: "Both", nodeId: lead.node.id, instruction: "x", template: { goal: "g", steps: [{ id: "a", to: writer.node.slug, kind: "research", brief: "b" }] }, cron: "0 9 * * *" } });
  assert.equal(both.statusCode, 400);

  const made = await routine(mira, {
    title: "Weekly competitor scan",
    nodeId: lead.node.id,
    trigger: "schedule",
    cron: "0 8 * * 1",
    template: { goal: "Know what competitors shipped this week", steps: [{ id: "scan", to: writer.node.slug, kind: "research", brief: "Scan competitors' changelogs for this week." }] },
  });
  script = (turn) => {
    if (turn.slug === writer.node.slug && turn.transcript.includes("Scan competitors")) return { calls: [{ name: "node_step_report", arguments: { outcome: "done", summary: "Two launches this week." } }], then: "(no reply)" };
    if (turn.transcript.includes("This was your routine")) return { text: "Competitors shipped two things this week." };
    return { text: "(no reply)" };
  };
  await mira.inject({ method: "POST", url: `/api/node/routines/${made.routine.id}/run` });
  await settleTurns();
  await tick();
  const run = await h.prisma.nodeRoutineRun.findFirstOrThrow({ where: { routineId: made.routine.id } });
  const mission = await h.prisma.nodeMission.findUniqueOrThrow({ where: { id: run.missionId! } });
  assert.equal(mission.kind, "plan");
  assert.equal(mission.status, "succeeded");
  assert.equal(mission.originRoomId, lead.room.id);
  const texts = (await read(mira, lead.room.id)).filter((row) => row.kind === "text" && row.authorKind === "node");
  assert.deepEqual(texts.map((row) => row.body), ["Competitors shipped two things this week."]);
});

test("a routine's card waits 30 minutes for its owner, then expires and its step goes on without it", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "researcher");
  const made = await routine(mira, { title: "Nightly check", nodeId: node.id, instruction: "Check the build.", cron: "0 2 * * *" });
  // The work turn waits on its owner (a card); nothing else happens yet.
  script = (turn) => (turn.transcript.includes("did not answer within 30 minutes") ? { calls: [{ name: "node_step_report", arguments: { outcome: "blocked", summary: "Needed the owner's approval to run the check." } }], then: "(no reply)" } : { text: "(no reply)" });
  await mira.inject({ method: "POST", url: `/api/node/routines/${made.routine.id}/run` });
  await settleTurns();
  await tick();
  const run = await h.prisma.nodeRoutineRun.findFirstOrThrow({ where: { routineId: made.routine.id } });
  const step = await h.prisma.nodeStep.findFirstOrThrow({ where: { missionId: run.missionId! } });
  // As if its work were still waiting on the card.
  await h.prisma.nodeStep.update({ where: { missionId_id: { missionId: step.missionId, id: step.id } }, data: { status: "working", endedAt: null } });
  await h.prisma.nodeMission.update({ where: { id: step.missionId }, data: { status: "running", endedAt: null, reportedAt: null } });
  const card = await h.prisma.nodeMessage.create({
    data: { roomId: room.id, seq: 9_000, userId: mira.id, authorKind: "node", authorNodeId: node.id, kind: "approval", body: "Start the check?", data: { type: "session", status: "pending", plan: { id: run.missionId, step: step.id } }, visibleTo: [mira.id], createdAt: new Date(Date.now() - 20 * 60_000) },
  });
  assert.equal(await expireBackgroundCards(h.app), 0, "20 minutes is not long enough");
  await h.prisma.nodeMessage.update({ where: { id: card.id }, data: { createdAt: new Date(Date.now() - 31 * 60_000) } });
  assert.equal(await expireBackgroundCards(h.app), 1);
  await settleTurns();
  const expired = await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: card.id } });
  assert.equal((expired.data as { status: string }).status, "expired");
  assert.match((expired.data as { expiredReason: string }).expiredReason, /waits 30 minutes/);
  assert.ok(seen.some((turn) => turn.transcript.includes("did not answer within 30 minutes")), "its node hears it and goes on");
  // Work its owner started in a chat has no such timer: only routines' cards expire.
  assert.equal(await expireBackgroundCards(h.app, Date.now() + 86_400_000), 0);
});
