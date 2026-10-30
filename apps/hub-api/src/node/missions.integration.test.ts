/**
 * Ensemble Node missions end to end (ensemble-node docs/design B0–B2, B4, B5, B15) against an in-memory
 * database with the model scripted: the reported incident (a failed check must never release the
 * next feature; the build is repaired and checked again); prose is not a result; a node keeps
 * answering while its own work runs; a newer message merges with a turn that has not acted; the
 * stop path needs no model; outbox effects apply once; a restart resumes; cards of ended work close.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns, recoverTurns } = await import("./queue.js");
const { pollRuns } = await import("./runs.js");
const { dispatchOutbox } = await import("./outbox.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
after(() => h.close());

type Call = { name: string; arguments: Record<string, unknown> };
type Step = { calls?: Call[]; text?: string; then?: string; wait?: Promise<void> };
type Seen = { slug: string; transcript: string; system: string; tools: string[] };
let script: (turn: Seen) => Step = () => ({ text: "ok" });
const seen: Seen[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(system)?.[1] ?? "?";
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current: Seen = { slug, transcript, system, tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name) };
  if (!second) seen.push(current);
  const step = script(current);
  if (step.wait && !second) {
    // A slow model: the turn is in flight until the test lets it go (or it is aborted).
    await Promise.race([step.wait, new Promise<void>((resolve) => args.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
    if (args.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
  }
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

async function post(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response).message as { id: string };
}

async function say(user: HttpUser, roomId: string, body: string) {
  const message = await post(user, roomId, body);
  await settleTurns();
  return message;
}

async function read(user: HttpUser, roomId: string) {
  const response = await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` });
  assert.equal(response.statusCode, 200, response.body);
  return json(response).messages as Array<{ id: string; kind: string; body: string; authorKind: string; authorNodeId: string | null; planId?: string | null; data: any }>;
}

async function laptopFor(user: HttpUser) {
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({
    data: { userId: user.id, name: "Laptop", platform: "macos", tokenId: key.id, capabilities: { folders: ["ensemble"], engines: ["claude-code", "codex"] }, lastSeenAt: new Date() },
  });
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "careful", name: "Careful", engine: "claude-code", mode: "ask", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "careful" });
  return laptop;
}

async function crewOf(user: HttpUser, templates: string[]) {
  const ids: string[] = [];
  for (const template of templates) ids.push((await createNode(user, template)).node.id);
  const made = await user.inject({ method: "POST", url: "/api/node/crews", payload: { title: `Crew ${randomBytes(3).toString("hex")}`, nodeIds: ids, leadNodeId: ids[0] } });
  assert.equal(made.statusCode, 201, made.body);
  return { ids, crew: json(made).room as { id: string } };
}

const report = (outcome: "done" | "pass" | "fail" | "blocked", summary: string, extra: Record<string, unknown> = {}): Step => ({ calls: [{ name: "node_step_report", arguments: { outcome, summary, ...extra } }], then: "(no reply)" });
const delegate = (to: string, brief: string, extra: Record<string, unknown> = {}): Call => ({ name: "node_delegate", arguments: { to, brief, ...extra } });
const planCard = async (user: HttpUser, roomId: string) => (await read(user, roomId)).filter((row) => row.kind === "plan").at(-1)!;

test("F1: a failed check never releases the next feature; the build is repaired, checked again, then the next feature runs", async () => {
  const kofi = await person("Kofi");
  const { crew } = await crewOf(kofi, ["manager", "feature-engineer", "tester", "feature-engineer"]);
  let tests = 0;
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("two features")) {
      return {
        calls: [
          delegate("builder", "Feature A: Markdown tables.", { kind: "build" }),
          delegate("tester", "Test feature A.", { after: ["builder"], kind: "verify", verifies: "builder" }),
          delegate("builder-2", "Feature B: expire Needs Me requests.", { after: ["tester"], kind: "build" }),
          delegate("tester", "Test feature B.", { after: ["builder-2"], kind: "verify", verifies: "builder-2" }),
        ],
        then: "Planned: A, its test, then B and its test.",
      };
    }
    if (turn.slug === "manager" && turn.transcript.includes("nothing left to run")) return { text: "Both features are in and pass their checks; A needed one repair." };
    if (turn.slug === "builder" && turn.transcript.includes("Repair, attempt 2")) return report("done", "Escaped pipes in cells.", { subject: { commit: "bbb2222" } });
    if (turn.slug === "builder") return report("done", "Tables render.", { subject: { commit: "aaa1111" } });
    if (turn.slug === "builder-2") return report("done", "Requests expire.", { subject: { commit: "ccc3333" } });
    if (turn.slug === "tester") {
      tests += 1;
      if (tests === 1) {
        assert.match(turn.transcript, /independently at commit aaa1111/);
        return report("fail", "FAIL: a title with | breaks the table.", { subject: { commit: "aaa1111" }, checks: [{ name: "pipe in record title", verdict: "fail", detail: "Row 3 lost a cell" }, { name: "plain table", verdict: "pass" }] });
      }
      if (tests === 2) {
        assert.match(turn.transcript, /Retest, attempt 2[\s\S]*commit bbb2222/);
        return report("pass", "Pass.", { subject: { commit: "bbb2222" }, checks: [{ name: "pipe in record title", verdict: "pass" }, { name: "plain table", verdict: "pass" }] });
      }
      return report("pass", "B passes.", { subject: { commit: "ccc3333" }, checks: [{ name: "expiry on task end", verdict: "pass" }] });
    }
    return { text: "unexpected" };
  };
  const asked = await say(kofi, crew.id, "@manager two features, A then B, each tested before the next");

  const order = seen.map((row) => row.slug);
  assert.deepEqual(order, ["manager", "builder", "tester", "builder", "tester", "builder-2", "tester", "manager"], "B starts only after A's retest passes");
  const repair = seen.filter((row) => row.slug === "builder")[1]!;
  assert.match(repair.transcript, /check of your work FAILED[\s\S]*pipe in record title: Row 3 lost a cell[\s\S]*Tested commit: aaa1111/);

  const plan = await planCard(kofi, crew.id);
  assert.equal(plan.data.status, "succeeded");
  const testA = plan.data.steps[1];
  assert.deepEqual(testA.attempts.map((row: { n: number; reason: string; outcome: string }) => [row.n, row.reason, row.outcome]), [[1, "first", "fail"], [2, "retest", "pass"]]);
  assert.deepEqual(plan.data.steps[0].attempts.map((row: { reason: string }) => row.reason), ["first", "repair"]);
  const visible = (await read(kofi, crew.id)).filter((row) => row.id !== asked.id && !row.planId);
  assert.deepEqual(visible.map((row) => row.kind), ["plan", "text"], "one plan card and one report, nothing else");
});

test("prose is not a result: the worker is asked once to report, then the step is unverified and holds what follows", async () => {
  const kofi = await person("Kofi");
  const { crew } = await crewOf(kofi, ["manager", "researcher", "docs-writer"]);
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("look into it")) return { calls: [delegate("researcher", "Research it.", { kind: "research" }), delegate("docs", "Write it up.", { after: ["researcher"], kind: "write" })], then: "Planned." };
    if (turn.slug === "manager") return { text: "The research was not reported, so the write-up waits." };
    if (turn.slug === "researcher") return { text: "I looked around and it seems fine." };
    return { text: "unexpected" };
  };
  await say(kofi, crew.id, "@manager look into it and write it up");
  assert.deepEqual(seen.map((row) => row.slug), ["manager", "researcher", "researcher", "manager"]);
  assert.match(seen[2]!.transcript, /not reported yet\. Report it now with node_step_report/);
  const plan = await planCard(kofi, crew.id);
  assert.deepEqual(plan.data.steps.map((row: { status: string; outcome: string }) => [row.status, row.outcome]), [["blocked", "unverified"], ["skipped", "unknown"]]);
  assert.equal(plan.data.status, "partially_completed");
  assert.match(seen[3]!.transcript, /held by @researcher's step/);
});

test("a verification that passes with a skipped check is refused, and the tool asks for a consistent report", async () => {
  const kofi = await person("Kofi");
  const { crew } = await crewOf(kofi, ["manager", "feature-engineer", "tester"]);
  let tries = 0;
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("check it")) return { calls: [delegate("builder", "Build.", { kind: "build" }), delegate("tester", "Check it.", { after: ["builder"], kind: "verify" })], then: "Planned." };
    if (turn.slug === "manager") return { text: "Reported." };
    if (turn.slug === "builder") return report("done", "Built.", { subject: { commit: "abc1234" } });
    if (turn.slug === "tester") {
      tries += 1;
      return tries === 1
        ? report("pass", "Looks fine.", { checks: [{ name: "live account", verdict: "skipped" }] })
        : report("blocked", "Cannot sign in to the live account.", { blockedBy: "login_required", checks: [{ name: "live account", verdict: "blocked" }] });
    }
    return { text: "unexpected" };
  };
  await say(kofi, crew.id, "@manager build it and check it");
  const plan = await planCard(kofi, crew.id);
  assert.deepEqual([plan.data.steps[1].status, plan.data.steps[1].outcome], ["blocked", "blocked"]);
  assert.equal(plan.data.steps[1].kind, "verify");
  assert.equal(plan.data.steps[1].verifies, plan.data.steps[0].id, "a check verifies the build it comes after");
});

test("the node keeps answering while its own work runs, and the work goes on", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { node, room } = await createNode(mira, "researcher");
  let release: () => void = () => undefined;
  const slow = new Promise<void>((resolve) => (release = resolve));
  let workTurns = 0;
  script = (turn) => {
    if (turn.transcript.includes("compare three note apps")) return { calls: [{ name: "node_work_start", arguments: { title: "Compare note apps", brief: "Compare three note apps and write a report.", kind: "research" } }], then: "(no reply)" };
    if (turn.transcript.includes("Your step in @researcher's plan (your own work")) {
      workTurns += 1;
      return { ...report("done", "Report: Obsidian, Notion and Bear compared."), wait: slow };
    }
    if (turn.transcript.includes("how is it going")) return { text: "Still comparing: the report is in progress." };
    if (turn.transcript.includes("Your own work ended")) return { text: "The comparison is ready: Obsidian, Notion and Bear compared." };
    return { text: "unexpected" };
  };
  await post(mira, room.id, "please compare three note apps for me");
  // The work turn is in flight (its model is slow); the owner asks something else.
  for (let i = 0; i < 50 && workTurns === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(workTurns, 1, "the work started in its own lane");
  await post(mira, room.id, "how is it going?");
  for (let i = 0; i < 100 && !(await read(mira, room.id)).some((row) => row.body.startsWith("Still comparing")); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const meanwhile = await read(mira, room.id);
  assert.ok(meanwhile.some((row) => row.body.startsWith("Still comparing")), "the conversation answered while the work ran");
  const question = seen.find((row) => row.transcript.includes("how is it going"))!;
  assert.match(question.transcript, /Your work board[\s\S]*Own work[\s\S]*working/);
  release();
  await settleTurns();
  const final = await read(mira, room.id);
  assert.ok(final.some((row) => row.body.startsWith("The comparison is ready")), "the result arrives once the work ends");
  const work = final.find((row) => row.kind === "plan")!;
  assert.equal(work.data.kind, "self");
  assert.equal(work.data.status, "succeeded");
  const nodeMessages = final.filter((row) => row.authorNodeId === node.id && row.kind === "text");
  assert.equal(nodeMessages.length, 2, "one answer to the question and one result: no chatter");
});

test("a newer message from the owner merges with a turn that has not acted yet", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  let release: () => void = () => undefined;
  const slow = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  script = (turn) => {
    if (first) {
      first = false;
      return { text: "Answering only the first message.", wait: slow };
    }
    return { text: turn.transcript.includes("also add milk") ? "Both: eggs and milk." : "Only one." };
  };
  await post(mira, room.id, "add eggs to the list");
  for (let i = 0; i < 50 && !seen.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  await post(mira, room.id, "also add milk");
  // The newer message's turn is queued (its dispatch runs in the background), which aborts the first.
  for (let i = 0; i < 100 && !(await h.prisma.nodeTurn.count({ where: { nodeId: node.id, status: "queued" } })); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await settleTurns();
  const replies = (await read(mira, room.id)).filter((row) => row.authorNodeId === node.id);
  assert.deepEqual(replies.map((row) => row.body), ["Both: eggs and milk."], "one answer covering both messages");
  const turns = await h.prisma.nodeTurn.findMany({ where: { nodeId: node.id }, orderBy: { createdAt: "asc" } });
  assert.match(turns[0]!.error ?? "", /Merged into the next turn/);
});

test("a newer message never stops a turn bound to something else (an approval); a merged turn's update goes on with the turn that answers", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  const { enqueueTurn } = await import("./queue.js");
  let release: () => void = () => undefined;
  let slow = new Promise<void>((resolve) => (release = resolve));
  script = (turn) => {
    if (turn.transcript.includes("Your owner approved the CSV export")) return { text: "The CSV export is applied.", wait: slow };
    return { text: turn.transcript.includes("how is it going") ? "Going well." : "unexpected" };
  };
  await enqueueTurn(h.app, { nodeId: node.id, roomId: room.id, reason: "approval", note: "Your owner approved the CSV export." });
  for (let i = 0; i < 50 && !seen.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  await post(mira, room.id, "how is it going");
  for (let i = 0; i < 100 && !(await h.prisma.nodeTurn.count({ where: { nodeId: node.id, status: "queued" } })); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await settleTurns();
  let replies = (await read(mira, room.id)).filter((row) => row.authorNodeId === node.id).map((row) => row.body);
  assert.deepEqual(replies, ["The CSV export is applied.", "Going well."], "the approval's turn finished; the message was answered next");

  // A message turn that took in a run's end is stopped by a newer message; the run's end is not lost.
  seen.length = 0;
  slow = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  script = (turn) => {
    if (first) {
      first = false;
      return { text: "Answering the first only.", wait: slow };
    }
    return { text: turn.transcript.includes("The build run ended: all tests pass.") && turn.transcript.includes("and the docs?") ? "Build done; docs next." : "lost the update" };
  };
  const firstMessage = await post(mira, room.id, "is the build done?");
  for (let i = 0; i < 50 && !seen.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const running = await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: node.id, triggerMessageId: firstMessage.id } });
  await h.prisma.nodeTurn.update({ where: { id: running.id }, data: { note: "The build run ended: all tests pass." } });
  await post(mira, room.id, "and the docs?");
  for (let i = 0; i < 100 && !(await h.prisma.nodeTurn.count({ where: { nodeId: node.id, status: "queued" } })); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await settleTurns();
  replies = (await read(mira, room.id)).filter((row) => row.authorNodeId === node.id).map((row) => row.body);
  assert.equal(replies.at(-1), "Build done; docs next.");
  assert.match((await h.prisma.nodeTurn.findUniqueOrThrow({ where: { id: running.id } })).error ?? "", /Merged into the next turn/);
});

test("in a conversation a bound turn keeps its own row: a message never merges into a disclosure being drafted, and a started room task never merges into a message", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira, "assistant");
  const { enqueueTurn } = await import("./queue.js");
  // Something bound runs slowly, so what comes next waits in the queue.
  let release: () => void = () => undefined;
  const slow = new Promise<void>((resolve) => (release = resolve));
  script = (turn) => (turn.transcript.includes("hold the lane") ? { text: "(no reply)", wait: slow } : { text: "(no reply)" });
  await enqueueTurn(h.app, { nodeId: node.id, roomId: room.id, reason: "approval", note: "Your owner approved: hold the lane." });
  for (let i = 0; i < 50 && !seen.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  // A disclosure to draft (another person's words), then the owner's own message.
  await enqueueTurn(h.app, { nodeId: node.id, roomId: room.id, reason: "disclose", operationId: `disclose:${randomBytes(4).toString("hex")}`, note: "Ben asked: what is the budget?" });
  await post(mira, room.id, "also, what's on my calendar?");
  for (let i = 0; i < 100 && (await h.prisma.nodeTurn.count({ where: { nodeId: node.id, status: "queued" } })) < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  // And a room task started from its card while the owner's message waits.
  const start = `room-task:${randomBytes(4).toString("hex")}:private:1`;
  try {
    await enqueueTurn(h.app, { nodeId: node.id, roomId: room.id, reason: "approval", operationId: start, note: "Start the task “Billing page”." });
    const queued = await h.prisma.nodeTurn.findMany({ where: { nodeId: node.id, status: "queued" }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(
      queued.map((row) => [row.reason, Boolean(row.operationId), Boolean(row.triggerMessageId)]),
      [["disclose", true, false], ["dm", false, true], ["approval", true, false]],
      "three turns: the disclosure still only drafts, the message is its own, the started task keeps its operation",
    );
    assert.equal(queued[2]!.operationId, start);
  } finally {
    release();
    await settleTurns();
  }
});

test("stop needs no model: it stops the conversation's work and says what stopped", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { node, room } = await createNode(mira, "assistant");
  script = (turn) => (turn.transcript.includes("fix the build") ? { calls: [{ name: "node_session_start", arguments: { title: "Fix the build", prompt: "Fix the build.", folder: "ensemble" } }], then: "(no reply)" } : { text: "unexpected" });
  await say(mira, room.id, "fix the build");
  const job = await h.prisma.workspaceJob.findFirstOrThrow({ where: { userId: mira.id } });
  await h.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "running", claimedAt: new Date(), startedAt: new Date() } });
  seen.length = 0;
  await say(mira, room.id, "stop");
  assert.equal(seen.length, 0, "no model turn");
  assert.ok((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } })).cancelRequestedAt, "the agent run is stopped");
  const status = (await read(mira, room.id)).at(-1)!;
  assert.equal(status.authorKind, "system");
  assert.match(status.body, /Stopped 1 agent run/);
  assert.equal((await h.prisma.nodeTurn.count({ where: { nodeId: node.id, status: "queued" } })), 0);

  // A reply in progress that had done nothing: the status line is the only answer, nothing from the node.
  let release: () => void = () => undefined;
  const slow = new Promise<void>((resolve) => (release = resolve));
  script = () => ({ text: "A long answer that never comes.", wait: slow });
  await post(mira, room.id, "tell me everything about pipes");
  for (let i = 0; i < 50 && !seen.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const before = (await read(mira, room.id)).length;
  await say(mira, room.id, "stop");
  release();
  await settleTurns();
  const after = (await read(mira, room.id)).slice(before);
  assert.deepEqual(after.map((row) => [row.authorKind, row.body]), [["human", "stop"], ["system", "Stopped the reply in progress. What was already done stays."]]);
});

test("an outbox effect delivered twice starts one turn; a restart re-runs a turn that had not acted and resumes one that had", async () => {
  const kofi = await person("Kofi");
  const { crew } = await crewOf(kofi, ["manager", "researcher"]);
  let holdResearch = true;
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("@manager research it")) return { calls: [delegate("researcher", "Research it.", { kind: "research" })], then: "Planned." };
    if (turn.slug === "researcher" && holdResearch) return { text: "(no reply)" };
    if (turn.slug === "researcher") return report("done", "Found it.");
    return { text: "Reported." };
  };
  await say(kofi, crew.id, "@manager research it");
  const plan = await planCard(kofi, crew.id);
  const turnsBefore = await h.prisma.nodeTurn.count({ where: { planId: plan.id, planStep: plan.data.steps[0].id } });
  // Redeliver every effect of this mission: nothing new happens.
  await h.prisma.nodeOutbox.updateMany({ where: { missionId: plan.id }, data: { deliveredAt: null, claimedUntil: null } });
  await dispatchOutbox(h.app);
  await settleTurns();
  assert.equal(await h.prisma.nodeTurn.count({ where: { planId: plan.id, planStep: plan.data.steps[0].id } }), turnsBefore, "a redelivered effect starts no new turn");

  // A step turn cut off by a restart before it acted runs again, and the step goes on (it does not end blocked).
  holdResearch = false;
  const step = plan.data.steps[0];
  const cut = await h.prisma.nodeTurn.create({
    data: { userId: kofi.id, nodeId: step.nodeId, roomId: crew.id, reason: "plan", status: "running", note: "Your step: research it.", planId: plan.id, planStep: step.id, lane: `work:${plan.id}:${step.id}` },
  });
  await h.prisma.nodeStep.update({ where: { missionId_id: { missionId: plan.id, id: step.id } }, data: { status: "working", outcome: "unknown", nudged: false, endedAt: null } });
  await h.prisma.nodeMission.update({ where: { id: plan.id }, data: { status: "running" } });
  await recoverTurns(h.app);
  await settleTurns();
  const rerun = await h.prisma.nodeTurn.findUniqueOrThrow({ where: { id: cut.id } });
  assert.equal(rerun.status, "done", "the same turn ran again");
  const after = await planCard(kofi, crew.id);
  assert.deepEqual([after.data.steps[0].status, after.data.steps[0].outcome], ["done", "done"]);

  // One that had acted is not run twice: a resume turn with what it did.
  const acted = await h.prisma.nodeTurn.create({
    data: { userId: kofi.id, nodeId: step.nodeId, roomId: crew.id, reason: "dm", status: "running", sideEffectsAt: new Date(), receipts: [{ name: "node_session_start", state: "ok", summary: "Started Build" }] },
  });
  seen.length = 0;
  script = (turn) => ({ text: turn.transcript.includes("cut off by a server restart") ? "Checked: the build session is already running." : "unexpected" });
  await recoverTurns(h.app);
  await settleTurns();
  assert.equal((await h.prisma.nodeTurn.findUniqueOrThrow({ where: { id: acted.id } })).status, "failed");
  assert.match(seen[0]?.transcript ?? "", /cut off by a server restart[\s\S]*node_session_start \(ok\): Started Build/);

  // A resumed turn keeps what it was for: its peer request, and through its first turn, its operation.
  const { turnOrigin } = await import("./peer-requests.js");
  const bound = await h.prisma.nodeTurn.create({
    data: { userId: kofi.id, nodeId: step.nodeId, roomId: crew.id, reason: "request", status: "running", private: true, operationId: `request:${randomBytes(4).toString("hex")}:accepted`, sideEffectsAt: new Date(), note: "Plan Ben's request." },
  });
  script = () => ({ text: "(no reply)" });
  await recoverTurns(h.app);
  await settleTurns();
  const resumed = await h.prisma.nodeTurn.findFirstOrThrow({ where: { originTurnId: bound.id } });
  assert.equal((await turnOrigin(h.prisma, resumed)).operationId, bound.operationId);
});

test("cards of ended work close: an answer after the step ended changes nothing", async () => {
  const kofi = await person("Kofi");
  await laptopFor(kofi);
  const { ids, crew } = await crewOf(kofi, ["manager", "feature-engineer"]);
  await h.prisma.nodeAgent.update({ where: { id: ids[1] }, data: { autonomy: { computerWork: "ask" } } });
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("build it")) return { calls: [delegate("builder", "Build it on the laptop.", { kind: "build" })], then: "Planned." };
    if (turn.slug === "builder") return { calls: [{ name: "node_session_start", arguments: { title: "Build it", prompt: "Build it.", folder: "ensemble" } }], then: "(no reply)" };
    return { text: "Stopped." };
  };
  await say(kofi, crew.id, "@manager build it");
  const card = (await read(kofi, crew.id)).find((row) => row.kind === "approval" && row.data.status === "pending")!;
  assert.ok(card, "the step's session waits for its card");
  const plan = await planCard(kofi, crew.id);
  assert.equal((await kofi.inject({ method: "POST", url: `/api/node/plans/${plan.id}/stop`, payload: {} })).statusCode, 200);
  await settleTurns();
  const closed = (await read(kofi, crew.id)).find((row) => row.id === card.id)!;
  assert.equal(closed.data.status, "expired");
  const late = await kofi.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision: "approve" } });
  assert.equal(late.statusCode, 409);
  assert.match(late.body, /ended with its work|already settled/);
  assert.equal(await h.prisma.workspaceJob.count({ where: { userId: kofi.id } }), 0, "nothing ran");
});

test("a run from an earlier attempt of its step changes nothing when it ends late", async () => {
  const kofi = await person("Kofi");
  await laptopFor(kofi);
  const { crew } = await crewOf(kofi, ["manager", "feature-engineer"]);
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("build it")) return { calls: [delegate("builder", "Build it.", { kind: "build" })], then: "Planned." };
    if (turn.slug === "builder" && turn.transcript.includes("This run was for your plan step")) return report("done", "Built.");
    if (turn.slug === "builder") return { calls: [{ name: "node_session_start", arguments: { title: "Build it", prompt: "Build it.", folder: "ensemble" } }], then: "(no reply)" };
    return { text: "Reported." };
  };
  await say(kofi, crew.id, "@manager build it");
  const plan = await planCard(kofi, crew.id);
  const job = await h.prisma.workspaceJob.findFirstOrThrow({ where: { userId: kofi.id } });
  // The step moved on to a new attempt (as a repair would) before this run ended.
  await h.prisma.nodeStep.update({ where: { missionId_id: { missionId: plan.id, id: plan.data.steps[0].id } }, data: { attempt: 2, startedAt: new Date(Date.now() + 1000) } });
  await h.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "succeeded", summary: "Old attempt done.", finishedAt: new Date() } });
  seen.length = 0;
  await pollRuns(h.app);
  await settleTurns();
  assert.deepEqual(seen, [], "nobody is woken for a run of an earlier attempt");
  const step = (await planCard(kofi, crew.id)).data.steps[0];
  assert.equal(step.status, "working");
});

test("a worker's structured report ends its step directly, without a node turn", async () => {
  const kofi = await person("Kofi");
  await laptopFor(kofi);
  const { crew } = await crewOf(kofi, ["manager", "feature-engineer"]);
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("build it")) return { calls: [delegate("builder", "Build it.", { kind: "build" })], then: "Planned." };
    if (turn.slug === "builder") return { calls: [{ name: "node_session_start", arguments: { title: "Build it", prompt: "Build it.", folder: "ensemble" } }], then: "(no reply)" };
    if (turn.slug === "manager") return { text: "Built: commit def5678." };
    return { text: "unexpected" };
  };
  await say(kofi, crew.id, "@manager build it");
  const job = await h.prisma.workspaceJob.findFirstOrThrow({ where: { userId: kofi.id } });
  await h.prisma.workspaceJob.update({
    where: { id: job.id },
    data: { status: "succeeded", summary: "Built.", finishedAt: new Date(), report: { outcome: "done", summary: "Built it; tests pass.", subject: { commit: "def5678" }, checks: [{ name: "unit tests", verdict: "pass" }] } },
  });
  seen.length = 0;
  await pollRuns(h.app);
  await settleTurns();
  assert.deepEqual(seen.map((row) => row.slug), ["manager"], "only the lead's report: the builder's node did not paraphrase the run");
  const plan = await planCard(kofi, crew.id);
  assert.deepEqual([plan.data.steps[0].outcome, plan.data.steps[0].attempts[0].candidate.commit], ["done", "def5678"]);
  const runCard = (await read(kofi, crew.id)).find((row) => row.kind === "run")!;
  assert.equal(runCard.data.report.subject.commit, "def5678");
});

const planCall = (plan: Record<string, unknown>): Call => ({ name: "node_plan", arguments: plan });

test("node_plan: an incomplete plan comes back to the lead; a valid one keeps every requirement, writes the constraints once and gates each feature on its check", async () => {
  const kofi = await person("Kofi");
  const { crew } = await crewOf(kofi, ["manager", "feature-engineer", "tester", "docs-writer"]);
  const constraints = { folder: "ensemble", branch: "live-testing", publish: "push", agent: "copilot-cli", model: "gpt-6.1-sol", context: "long_context", substitution: "forbid", order: "serial", notes: ["Web app only: no CLI or native changes."] };
  const requirements = [
    { id: "md", text: "Markdown tables in chat", acceptance: [{ id: "md.pipes", text: "A title with | keeps every cell" }] },
    { id: "expiry", text: "Expire Needs Me requests when their task ends", acceptance: [{ id: "exp.end", text: "Ending a task closes its requests" }] },
    { id: "resize", text: "Resizable page bar" },
  ];
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("first try")) {
      // Two of three requirements covered, nothing deferred: the plan comes back with what is missing.
      return { calls: [planCall({ goal: "Three web features", requirements, constraints, steps: [{ id: "b1", to: "builder", kind: "build", requirementIds: ["md"], brief: "Markdown tables." }, { id: "b2", to: "builder", kind: "build", requirementIds: ["expiry"], brief: "Expire requests." }] })], then: "Planning." };
    }
    if (turn.slug === "manager" && turn.transcript.includes("second try")) {
      return {
        calls: [
          planCall({
            goal: "Three web features",
            requirements,
            constraints,
            deferred: [{ requirementId: "resize", reason: "The owner said: no resizing yet." }],
            steps: [
              { id: "b1", to: "builder", kind: "build", requirementIds: ["md"], brief: "Markdown tables in chat messages." },
              { id: "t1", to: "tester", kind: "verify", requirementIds: ["md"], brief: "Check Markdown tables.", after: ["b1"], verifies: "b1" },
              { id: "b2", to: "builder", kind: "build", requirementIds: ["expiry"], brief: "Expire Needs Me requests when their task ends.", after: ["t1"] },
              { id: "t2", to: "tester", kind: "verify", requirementIds: ["expiry"], brief: "Check request expiry.", after: ["b2"], verifies: "b2" },
              { id: "d1", to: "docs", kind: "write", brief: "Document both features.", after: ["t2"] },
            ],
          }),
        ],
        then: "Planned: tables, then expiry, each checked; resizing deferred.",
      };
    }
    if (turn.slug === "manager") return { text: "Tables and expiry are in and checked; docs updated; resizing deferred as you asked." };
    if (turn.slug === "builder" && turn.transcript.includes("Markdown tables")) return report("done", "Tables render.", { subject: { commit: "aaa1111", branch: "live-testing" } });
    if (turn.slug === "builder") return report("done", "Requests expire.", { subject: { commit: "bbb2222", branch: "live-testing" } });
    if (turn.slug === "tester" && turn.transcript.includes("Check Markdown tables")) return report("pass", "Tables pass.", { subject: { commit: "aaa1111" }, checks: [{ id: "md.pipes", name: "pipe in a title", verdict: "pass" }] });
    if (turn.slug === "tester") return report("pass", "Expiry passes.", { subject: { commit: "bbb2222" }, checks: [{ id: "exp.end", name: "ending a task closes requests", verdict: "pass" }] });
    if (turn.slug === "docs") return report("done", "Docs updated.");
    return { text: "unexpected" };
  };
  await say(kofi, crew.id, "@manager first try: three features");
  assert.equal((await read(kofi, crew.id)).filter((row) => row.kind === "plan").length, 0, "an invalid plan is not made");
  const failedCall = await h.prisma.assistantMessage.findFirst({ where: { role: "assistant", toolCalls: { not: undefined } }, orderBy: { createdAt: "desc" } });
  assert.match(JSON.stringify(failedCall?.toolCalls ?? []), /No step covers requirement “resize”/);

  seen.length = 0;
  await say(kofi, crew.id, "@manager second try");
  const builderNote = seen.find((row) => row.slug === "builder")!.transcript;
  assert.match(builderNote, /Constraints from your owner[\s\S]*Branch: live-testing[\s\S]*commit and push[\s\S]*copilot-cli, gpt-6\.1-sol, long context[\s\S]*Never substitute[\s\S]*Web app only/);
  assert.match(builderNote, /It covers: Markdown tables in chat \(acceptance: md\.pipes/);
  assert.deepEqual(seen.map((row) => row.slug), ["manager", "builder", "tester", "builder", "tester", "docs", "manager"], "each feature waits for the previous one's check");
  const plan = await planCard(kofi, crew.id);
  assert.equal(plan.data.status, "succeeded");
  assert.deepEqual(plan.data.requirements.map((row: { id: string; status: string }) => [row.id, row.status]), [["md", "accepted"], ["expiry", "accepted"], ["resize", "deferred"]]);
  assert.deepEqual(plan.data.steps[0].run, { agent: "copilot-cli", model: "gpt-6.1-sol", context: "long_context" }, "agent settings come from the constraints");
});

test("a verification must report each mandatory acceptance criterion; one left out is asked for, not passed", async () => {
  const kofi = await person("Kofi");
  const { crew } = await crewOf(kofi, ["manager", "feature-engineer", "tester"]);
  let tries = 0;
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("@manager tables please")) {
      return {
        calls: [
          planCall({
            goal: "Tables",
            requirements: [{ id: "md", text: "Markdown tables", acceptance: [{ id: "md.pipes", text: "pipes" }, { id: "md.links", text: "links" }] }],
            steps: [
              { id: "b1", to: "builder", kind: "build", requirementIds: ["md"], brief: "Tables." },
              { id: "t1", to: "tester", kind: "verify", requirementIds: ["md"], brief: "Check tables.", after: ["b1"], verifies: "b1" },
            ],
          }),
        ],
        then: "Planned.",
      };
    }
    if (turn.slug === "manager") return { text: "Reported." };
    if (turn.slug === "builder") return report("done", "Built.", { subject: { commit: "abc1234" } });
    if (turn.slug === "tester") {
      tries = seen.filter((row) => row.slug === "tester").length;
      // First try leaves out the links criterion (refused by the tool); the nudge then gets both.
      return tries === 1
        ? report("pass", "Pipes fine.", { checks: [{ id: "md.pipes", name: "pipes", verdict: "pass" }] })
        : report("pass", "Both fine.", { checks: [{ id: "md.pipes", name: "pipes", verdict: "pass" }, { id: "md.links", name: "links", verdict: "pass" }] });
    }
    return { text: "unexpected" };
  };
  await say(kofi, crew.id, "@manager tables please");
  const plan = await planCard(kofi, crew.id);
  assert.equal(tries, 2, "the incomplete report was refused and asked for again");
  assert.deepEqual([plan.data.steps[1].outcome, plan.data.requirements[0].status, plan.data.status], ["pass", "accepted", "succeeded"]);
});

test("node_plan_revise: new constraints reach the next instructions; waiting steps can be cancelled and steps added", async () => {
  const kofi = await person("Kofi");
  await laptopFor(kofi);
  const { crew } = await crewOf(kofi, ["manager", "feature-engineer", "docs-writer"]);
  let planId = "";
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("build then docs")) {
      return {
        calls: [
          planCall({
            goal: "Build and document",
            constraints: { branch: "feature-x" },
            steps: [
              { id: "b1", to: "builder", kind: "build", brief: "Build it." },
              { id: "d1", to: "docs", kind: "write", brief: "Write docs.", after: ["b1"] },
              { id: "d2", to: "docs", kind: "write", brief: "Write a blog post.", after: ["b1"] },
            ],
          }),
        ],
        then: "Planned.",
      };
    }
    if (turn.slug === "manager" && turn.transcript.includes("use branch main-fix")) {
      const plan = seen.length ? planId : "";
      return { calls: [{ name: "node_plan_revise", arguments: { plan, constraints: { branch: "main-fix" }, cancel: [cancelId], add: [{ id: "c1", to: "docs", kind: "write", brief: "Changelog entry.", after: ["@builder"] }] } }], then: "Switched to main-fix." };
    }
    if (turn.slug === "manager") return { text: "Done." };
    if (turn.slug === "builder" && turn.transcript.includes("This run was for your plan step")) return report("done", "Built.", { subject: { commit: "abc1234" } });
    if (turn.slug === "builder") return { calls: [{ name: "node_session_start", arguments: { title: "Build it", prompt: "Build it.", folder: "ensemble" } }], then: "(no reply)" };
    if (turn.slug === "docs") return report("done", "Written.");
    return { text: "unexpected" };
  };
  let cancelId = "";
  await say(kofi, crew.id, "@manager build then docs");
  const before = await planCard(kofi, crew.id);
  planId = before.id;
  cancelId = before.data.steps[2].id;
  assert.equal(before.data.steps[0].status, "working", "the build's run is still going");
  await say(kofi, crew.id, "@manager use branch main-fix instead, drop the blog post, and add a changelog");
  const revised = await planCard(kofi, crew.id);
  assert.equal(revised.data.revision, 1);
  assert.equal(revised.data.constraints.branch, "main-fix");
  assert.deepEqual(revised.data.steps.map((row: { status: string }) => row.status), ["working", "waiting", "skipped", "waiting"]);
  const job = await h.prisma.workspaceJob.findFirstOrThrow({ where: { userId: kofi.id } });
  await h.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "succeeded", summary: "Built.", finishedAt: new Date() } });
  seen.length = 0;
  await pollRuns(h.app);
  await settleTurns();
  const docsNotes = seen.filter((row) => row.slug === "docs").map((row) => row.transcript);
  assert.equal(docsNotes.length, 2, "the docs step and the added changelog step ran; the cancelled one did not");
  assert.ok(docsNotes.every((note) => /Branch: main-fix/.test(note)), "later steps read the revised constraints");
  assert.equal((await planCard(kofi, crew.id)).data.status, "partially_completed", "a cancelled step means the plan did not do everything it first set out to");
});

test("a helper may run its own agent session when its parent grants it, and can be kept as a lasting node", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { node, room } = await createNode(mira, "assistant");
  script = (turn) => {
    if (turn.slug === node.slug && turn.transcript.includes("reproduce the bug")) return { calls: [{ name: "node_helper", arguments: { task: "Reproduce the login bug in the ensemble folder.", name: "Repro", can: "sessions" } }], then: "A helper is reproducing it." };
    if (turn.slug !== node.slug && turn.transcript.includes("Reproduce the login bug")) return { calls: [{ name: "node_session_start", arguments: { title: "Reproduce login bug", prompt: "Reproduce the login bug.", folder: "ensemble" } }], then: "(no reply)" };
    return { text: "(no reply)" };
  };
  await say(mira, room.id, "please reproduce the bug with a helper");
  const helper = await h.prisma.nodeAgent.findFirstOrThrow({ where: { parentNodeId: node.id } });
  const helperTurn = seen.find((row) => row.slug === helper.slug)!;
  assert.ok(helperTurn.tools.includes("node_session_start"), "a sessions grant gives the helper its own session tools");
  assert.match(helperTurn.system, /run the work on your owner's computer in one agent session of your own/);
  const run = await h.prisma.nodeRun.findFirstOrThrow({ where: { nodeId: helper.id } });
  assert.ok(run.jobId, "the helper's session runs on the owner's computer");

  const kept = await mira.inject({ method: "POST", url: `/api/node/nodes/${helper.id}/promote`, payload: {} });
  assert.equal(kept.statusCode, 201, kept.body);
  const promoted = await h.prisma.nodeAgent.findUniqueOrThrow({ where: { id: helper.id } });
  assert.equal(promoted.parentNodeId, null);
  assert.ok(await h.prisma.nodeRoom.findFirst({ where: { kind: "dm", members: { some: { nodeId: helper.id } } } }), "it gets its own chat");
  const plain = await createNode(mira, "researcher");
  assert.equal((await mira.inject({ method: "POST", url: `/api/node/nodes/${plain.node.id}/promote`, payload: {} })).statusCode, 409, "only helpers are promoted");
});

test("B18: two helpers in parallel report into one plan and their node tells its owner once; a computer grant gives folder-limited computer tools", async () => {
  const mira = await person("Mira");
  const { room } = await createNode(mira, "assistant");
  script = (turn) => {
    if (turn.slug === "assistant-alpha") return { calls: [{ name: "node_step_report", arguments: { outcome: "done", summary: "Alpha costs 10 a seat (alpha.example/pricing)." } }], then: "(no reply)" };
    if (turn.slug === "assistant-beta") {
      return {
        calls: [
          { name: "computer_run", arguments: { folder: "~/private/keys", command: "ls" } },
          { name: "node_step_report", arguments: { outcome: "done", summary: "Beta costs 12 a seat (beta.example/pricing)." } },
        ],
        then: "(no reply)",
      };
    }
    if (turn.slug === "assistant" && turn.transcript.includes("Alpha costs 10") && turn.transcript.includes("Beta costs 12")) return { text: "Alpha is cheaper: 10 a seat against 12." };
    if (turn.slug === "assistant" && turn.transcript.includes("compare the two vendors")) {
      return {
        calls: [
          { name: "node_helper", arguments: { task: "Find vendor Alpha's price per seat.", name: "Alpha" } },
          { name: "node_helper", arguments: { task: "Find vendor Beta's price per seat.", name: "Beta", can: "computer", folders: ["notes"] } },
        ],
        then: "Two helpers are on it.",
      };
    }
    return { text: "(no reply)" };
  };
  await say(mira, room.id, "compare the two vendors' prices");

  const messages = await read(mira, room.id);
  const card = messages.find((row) => row.kind === "plan")!;
  assert.equal(card.body, "Two helpers are on it.", "its first line opened the plan");
  assert.deepEqual(card.data.steps.map((step: { executor: string; status: string }) => [step.executor, step.status]), [["helper", "done"], ["helper", "done"]]);
  assert.deepEqual(
    messages.filter((row) => row.kind === "text" && row.authorKind === "node").map((row) => row.body),
    ["Alpha is cheaper: 10 a seat against 12."],
    "one message for both helpers",
  );
  assert.equal(seen.filter((turn) => turn.slug === "assistant").length, 2, "the node thought twice: to bring them in, and once with both results");

  const alpha = seen.find((turn) => turn.slug === "assistant-alpha")!;
  const beta = seen.find((turn) => turn.slug === "assistant-beta")!;
  assert.ok(!alpha.tools.includes("computer_run"), "a read helper has no computer tools");
  assert.ok(beta.tools.includes("computer_run") && !beta.tools.includes("node_session_start"), "a computer grant gives computer tools, not sessions");
  const betaNode = await h.prisma.nodeAgent.findFirstOrThrow({ where: { slug: "assistant-beta" } });
  const receipts = (await h.prisma.nodeTurn.findMany({ where: { nodeId: betaNode.id } })).flatMap((row) => (row.receipts as Array<{ name: string; summary: string | null }>) ?? []);
  assert.match(receipts.find((row) => row.name === "computer_run")?.summary ?? "", /only use “notes”/, "only in the folders it was given");

  // Each thread shows its brief and what the helper reported.
  const thread = await h.prisma.nodeRoom.findFirstOrThrow({ where: { kind: "task", members: { some: { nodeId: betaNode.id } } } });
  assert.deepEqual((await read(mira, thread.id)).map((row) => row.body), ["Find vendor Beta's price per seat.", "Beta costs 12 a seat (beta.example/pricing)."]);
});

/** What the node's last tool calls said back, from its conversation (refusals included). */
async function lastToolCalls(nodeId: string): Promise<string> {
  const rooms = await h.prisma.nodeRoomMember.findMany({ where: { nodeId }, select: { conversationId: true, privateConversationId: true } });
  const ids = rooms.flatMap((row) => [row.conversationId, row.privateConversationId]).filter((id): id is string => Boolean(id));
  const reply = await h.prisma.assistantMessage.findFirst({ where: { conversationId: { in: ids }, role: "assistant" }, orderBy: { createdAt: "desc" } });
  return JSON.stringify(reply?.toolCalls ?? []);
}

test("crews stay crews: work goes only to members; another node joins only on its owner's card, which wakes the lead", async () => {
  const kofi = await person("Kofi");
  const { crew } = await crewOf(kofi, ["manager", "feature-engineer"]);
  const outsider = await createNode(kofi, "assistant");
  const researcher = await createNode(kofi, "researcher");
  const lead = await h.prisma.nodeAgent.findFirstOrThrow({ where: { userId: kofi.id, slug: "manager" } });
  const releaseNotes = { goal: "Release notes", requirements: [{ id: "r1", text: "Release notes for 0.6" }], constraints: {}, steps: [{ id: "s1", to: "assistant", kind: "write", requirementIds: ["r1"], brief: "Write the release notes." }], deferred: [] };
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("hand it to the assistant")) return { calls: [delegate("assistant", "Write the release notes.")], then: "(no reply)" };
    if (turn.slug === "manager" && turn.transcript.includes("plan it")) return { calls: [planCall(releaseNotes)], then: "(no reply)" };
    if (turn.slug === "manager" && turn.transcript.includes("ask me to add")) return { calls: [{ name: "node_crew_add", arguments: { node: "assistant", reason: "It writes our release notes." } }], then: "(no reply)" };
    if (turn.slug === "manager" && turn.transcript.includes("ask about the researcher")) return { calls: [{ name: "node_crew_add", arguments: { node: "researcher", reason: "It could check the changelog." } }], then: "(no reply)" };
    if (turn.slug === "manager" && turn.transcript.includes("joined this crew")) return { calls: [delegate("assistant", "Write the release notes.")], then: "Planned." };
    if (turn.slug === "manager" && turn.transcript.includes("nothing left to run")) return { text: "The release notes are written." };
    if (turn.slug === "assistant" && turn.transcript.includes("Your step in")) return report("done", "Release notes written.");
    if (turn.slug === "researcher" && turn.transcript.includes("ask the builder")) return { calls: [delegate("builder", "Fix the build.")], then: "(no reply)" };
    return { text: "(no reply)" };
  };
  const members = () => h.prisma.nodeRoomMember.findMany({ where: { roomId: crew.id, nodeId: { not: null } }, select: { handle: true } }).then((rows) => rows.map((row) => row.handle).sort());

  // A delegation or a plan step for a node outside the crew is refused with what to do; nobody joins.
  await say(kofi, crew.id, "hand it to the assistant: the release notes");
  assert.match(seen.find((turn) => turn.slug === "manager")!.system, /Not in this crew \(node_crew_add asks your owner\): @assistant \(assistant\), @researcher \(researcher\)\./);
  assert.match(await lastToolCalls(lead.id), /@assistant is not in this crew\. Give it to a member \(@builder\), make a temporary helper \(node_helper\), or ask your owner to add @assistant \(node_crew_add\)\./);
  await say(kofi, crew.id, "plan it");
  assert.match(await lastToolCalls(lead.id), /The plan needs changes:[\s\S]*@assistant is not in this crew/);
  assert.deepEqual(await members(), ["builder", "manager"]);
  assert.equal((await read(kofi, crew.id)).filter((row) => row.kind === "plan").length, 0, "no plan was made");

  // The lead asks; its owner's card in this chat adds the node, and the lead goes on by itself.
  await say(kofi, crew.id, "ask me to add the assistant");
  const card = (await read(kofi, crew.id)).find((row) => row.kind === "approval" && row.data.type === "crew_add")!;
  assert.deepEqual(
    (({ type, status, nodeId, nodeSlug, nodeName, roomId, reason }) => ({ type, status, nodeId, nodeSlug, nodeName, roomId, reason }))(card.data),
    { type: "crew_add", status: "pending", nodeId: outsider.node.id, nodeSlug: "assistant", nodeName: "Assistant", roomId: crew.id, reason: "It writes our release notes." },
  );
  assert.deepEqual((await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: card.id } })).visibleTo, [kofi.id], "only its owner sees it");
  assert.match(await lastToolCalls(lead.id), /Stop here and say nothing about it/);
  assert.deepEqual(await members(), ["builder", "manager"], "nothing changes before the owner answers");
  seen.length = 0;
  const approved = await kofi.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision: "approve" } });
  assert.equal(approved.statusCode, 200, approved.body);
  await settleTurns();
  assert.equal(json(approved).message.data.status, "approved");
  assert.deepEqual(await members(), ["assistant", "builder", "manager"], "its handle there is its slug");
  assert.ok((await read(kofi, crew.id)).some((row) => row.kind === "status" && row.body === "@assistant joined."));
  assert.match(seen[0]!.transcript, /@assistant joined this crew \(“Crew [0-9a-f]+”\); continue/);
  const plan = await planCard(kofi, crew.id);
  assert.deepEqual([plan.data.status, plan.data.steps[0].handle, plan.data.steps[0].status], ["succeeded", "assistant", "done"]);
  assert.equal((await kofi.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision: "approve" } })).statusCode, 409, "a card is settled once");

  // Discarded: nothing joins, and the lead hears it.
  seen.length = 0;
  await say(kofi, crew.id, "ask about the researcher");
  const second = (await read(kofi, crew.id)).find((row) => row.kind === "approval" && row.data.type === "crew_add" && row.data.nodeSlug === "researcher")!;
  assert.equal((await kofi.inject({ method: "POST", url: `/api/node/approvals/${second.id}`, payload: { decision: "discard" } })).statusCode, 200);
  await settleTurns();
  assert.equal(((await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: second.id } })).data as { status: string }).status, "discarded");
  assert.deepEqual(await members(), ["assistant", "builder", "manager"]);
  assert.ok(seen.some((turn) => turn.slug === "manager" && /did not add @researcher to the crew/.test(turn.transcript)));

  // A node with no crew cannot pull one in from its own chat either, and no crew is made for the attempt.
  await say(kofi, researcher.room.id, "ask the builder to fix the build");
  const researcherId = (await h.prisma.nodeAgent.findFirstOrThrow({ where: { userId: kofi.id, slug: "researcher" } })).id;
  assert.match(await lastToolCalls(researcherId), /@builder is not in a crew with you\. Make a temporary helper \(node_helper\), or ask your owner to add @builder \(node_crew_add\)\./);
  assert.equal(await h.prisma.nodeRoom.count({ where: { userId: kofi.id, kind: "crew" } }), 1, "no crew was made");
  assert.equal(await h.prisma.nodeRoomMember.count({ where: { nodeId: (await h.prisma.nodeAgent.findFirstOrThrow({ where: { userId: kofi.id, slug: "builder" } })).id } }), 2, "the builder is still only in its chat and its crew");
});
