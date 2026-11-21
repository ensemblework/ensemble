/**
 * Ensemble Node orchestration end to end (docs/35 §6.2-6.4) against an in-memory database with the model
 * scripted: task packets are versioned, hashed and stored, and a later version names what changed; an
 * artifact that changes after a step used it holds that step's acceptance until its lead resolves it;
 * reports carry partial results and what is left; a child's result enters its lead exactly once; an
 * independent review's rejection repairs the build in its own session, then reviews again; a plan whose
 * must-pass criteria no check judges is refused; a stuck step gets one re-plan turn, then its owner's
 * one-press card; the watchdog's stall rules act once.
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
const { pollRuns } = await import("./runs.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { finishStep, loadPlan } = await import("./plans.js");
const { checkWork } = await import("./watchdog.js");
after(() => h.close());

type Call = { name: string; arguments: Record<string, unknown> };
/** `holdAfter`: the turn stays in flight after its tool calls until the test lets it go. */
type Step = { calls?: Call[]; text?: string; then?: string; holdAfter?: Promise<void> };
type Seen = { slug: string; transcript: string };
let script: (turn: Seen) => Step = () => ({ text: "ok" });
const seen: Seen[] = [];
const toolResults: string[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(system)?.[1] ?? "?";
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current: Seen = { slug, transcript };
  if (!second) seen.push(current);
  else toolResults.push(String(messages.at(-1)?.content ?? ""));
  const step = script(current);
  if (second && step.holdAfter) await Promise.race([step.holdAfter, new Promise<void>((resolve) => args.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
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
  toolResults.length = 0;
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

async function crew(user: HttpUser, templates: string[]) {
  const ids: string[] = [];
  for (const templateId of templates) {
    const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId } });
    assert.equal(response.statusCode, 201, response.body);
    ids.push(json(response).node.id);
  }
  const made = await user.inject({ method: "POST", url: "/api/node/crews", payload: { title: `Crew ${randomBytes(3).toString("hex")}`, nodeIds: ids, leadNodeId: ids[0] } });
  assert.equal(made.statusCode, 201, made.body);
  return { ids, room: json(made).room as { id: string } };
}

async function laptopFor(user: HttpUser) {
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({
    data: { userId: user.id, name: "Laptop", platform: "linux", tokenId: key.id, capabilities: { folders: ["live-test"], engines: ["claude-code", "codex"] }, lastSeenAt: new Date() },
  });
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "careful", name: "Careful", engine: "claude-code", mode: "ask", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "careful" });
  return laptop;
}

async function post(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
}

async function read(user: HttpUser, roomId: string) {
  const response = await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` });
  assert.equal(response.statusCode, 200, response.body);
  return json(response).messages as Array<{ id: string; kind: string; body: string; authorKind: string; data: any }>;
}

/** The live run of a step (by kind), with what its agent was told. */
async function runOf(planId: string, kind: string, index = 0) {
  const step = await h.prisma.nodeStep.findFirstOrThrow({ where: { missionId: planId, kind } });
  const runs = await h.prisma.nodeRun.findMany({ where: { planId, planStep: step.id }, orderBy: { createdAt: "asc" } });
  const run = runs[index];
  assert.ok(run, `run ${index} of the ${kind} step`);
  const row = await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: run.jobId }, include: { task: { select: { description: true, title: true } } } });
  return { step, run, job: { ...row, instructions: [row.task?.description, row.instructions].filter(Boolean).join("\n\n") } };
}

async function finishJob(jobId: string, report: Record<string, unknown>) {
  await h.prisma.workspaceJob.update({ where: { id: jobId }, data: { status: "succeeded", summary: "Done.", startedAt: new Date(), finishedAt: new Date(), report: report as never } });
  await pollRuns(h.app);
  await settleTurns();
}

const stepOf = (planId: string, kind: string) => h.prisma.nodeStep.findFirstOrThrow({ where: { missionId: planId, kind } });
const packetOf = (row: { packet: unknown }) => row.packet as { header: any; title: string; prompt: string };
const reportCall = (arguments_: Record<string, unknown>): Call => ({ name: "node_step_report", arguments: arguments_ });

async function pressCard(user: HttpUser, roomId: string, decision: "approve" | "discard") {
  const card = (await read(user, roomId)).filter((row) => row.kind === "approval" && row.data.type === "plan_decision" && row.data.status === "pending").at(-1);
  assert.ok(card, "the owner has the card for the stuck step");
  const answered = await user.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision } });
  assert.equal(answered.statusCode, 200, answered.body);
  await settleTurns();
  return card;
}

test("a packet is versioned, hashed and stored; a new version of an artifact holds what used the old one until the lead resolves it, and the redo names what changed", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { room } = await crew(mira, ["manager", "feature-engineer", "tester"]);
  const plan = {
    goal: "Record titles render safely in tables",
    requirements: [{ id: "R1", text: "Titles containing | stay in one cell", acceptance: [{ id: "A1", text: "A title with | renders in one cell", proof: "test" }] }],
    constraints: { folder: "~/ensemble-workspace/live-test", branch: "live-testing", publish: "push", agent: "codex" },
    artifacts: [{ ref: "docs/spec.md", hash: "aaaa1111", label: "the spec" }],
    steps: [
      { id: "build", to: "builder", kind: "build", requirementIds: ["R1"], brief: "Escape | in record titles in Markdown tables." },
      { id: "check", to: "tester", kind: "verify", requirementIds: ["R1"], brief: "Check record titles with | in tables.", after: ["build"], verifies: "build" },
    ],
  };
  let planId = "";
  let buildId = "";
  script = (turn) => {
    if (turn.slug !== "manager") return { text: "(no reply)" };
    if (turn.transcript.includes("fix the tables")) return { calls: [{ name: "node_plan", arguments: plan }], then: "Planned." };
    if (turn.transcript.includes("the spec changed")) return { calls: [{ name: "node_plan_revise", arguments: { plan: planId, artifacts: [{ ref: "docs/spec.md", hash: "bbbb2222" }] } }], then: "Noted." };
    if (turn.transcript.includes("one re-plan turn")) return { calls: [{ name: "node_plan_revise", arguments: { plan: planId, resolve: [{ step: buildId, how: "forward" }] } }], then: "(no reply)" };
    if (turn.transcript.includes("nothing left to run")) return { text: "Fixed against the new spec, and checked." };
    return { text: "(no reply)" };
  };
  await post(mira, room.id, "Please fix the tables bug, then have it checked.");
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } });
  planId = mission.id;

  // Packet v2: the header is stored on the step with its hash, and the prompt carries it.
  const build = await runOf(planId, "build");
  buildId = build.step.id;
  const first = packetOf(build.step);
  assert.equal(build.step.packetVersion, 1);
  assert.equal(first.header.format, "ensemble.task/2");
  assert.equal(first.header.taskId, `${planId}/${buildId}`);
  assert.equal(first.header.parentTaskId, planId);
  assert.match(first.header.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.header.artifacts, [{ ref: "docs/spec.md", label: "the spec", hash: "aaaa1111", authoritative: true }]);
  assert.deepEqual(first.header.acceptance.map((item: { id: string; proof: string }) => [item.id, item.proof]), [["A1", "test"]]);
  assert.deepEqual(first.header.provider, { agent: "codex", modelRequested: null, sessionId: null });
  assert.equal(first.prompt, build.job.instructions, "the agent got exactly the stored packet");
  assert.equal(JSON.parse(/```json ensemble-task\n(.+)\n```$/.exec(build.job.instructions)![1]!).hash, first.header.hash);
  assert.deepEqual((build.step.attempts as any[])[0].packet, { version: 1, hash: first.header.hash });

  await finishJob(build.job.id, { outcome: "done", summary: "Escaped pipes.", subject: { branch: "live-testing", commit: "abc1234" } });
  const check = await runOf(planId, "verify");
  assert.deepEqual(
    packetOf(check.step).header.artifacts.map((item: { ref: string; hash: string }) => [item.ref, item.hash]),
    [
      ["docs/spec.md", "aaaa1111"],
      [`candidate:${buildId}`, "abc1234"],
    ],
    "a check names the candidate it judges",
  );

  // The owner's spec changes while the check runs: the finished build now holds a conflict.
  await post(mira, room.id, "@manager the spec changed: titles may also contain backslashes.");
  assert.match(toolResults.join("\n"), /1 finished step\(s\) now hold a conflict/);
  const registry = (await h.prisma.nodeMission.findUniqueOrThrow({ where: { id: planId } })).artifacts as any[];
  assert.deepEqual([registry[0].hash, registry[0].versions.map((row: { hash: string }) => row.hash)], ["bbbb2222", ["aaaa1111"]]);

  // The check passes, but its packet named the old spec: acceptance waits. The lead's re-plan turn
  // sees the conflict and redoes the build with the new version (forward).
  await finishJob(check.job.id, { outcome: "pass", summary: "One cell.", checks: [{ id: "A1", name: "pipe title in one cell", verdict: "pass" }], subject: { commit: "abc1234" } });
  const replan = seen.find((turn) => turn.slug === "manager" && turn.transcript.includes("one re-plan turn"));
  assert.ok(replan, "the lead had its re-plan turn");
  assert.match(replan.transcript, /What it worked from changed: the spec was aaaa1111, is now bbbb2222/);
  const checked = await stepOf(planId, "verify");
  assert.equal((checked.attempts as any[])[0].conflicts[0].now, "bbbb2222", "the pass is held by the conflict");
  assert.equal(seen.filter((turn) => turn.transcript.includes("nothing left to run")).length, 0, "the plan did not report on a held pass");

  // The redo: version 2 of the build's packet, in the builder's own session, says what changed and what stays.
  const redo = await runOf(planId, "build", 1);
  assert.equal(redo.run.sessionId, build.run.sessionId, "the update continues the builder's session");
  const second = packetOf(redo.step);
  assert.equal(redo.step.packetVersion, 2);
  assert.equal(second.header.amendmentOf, `${planId}/${buildId}@v1`);
  assert.equal(second.header.reason, "amend");
  assert.ok(second.header.amendment.changes.includes("the spec changed: aaaa1111 is now bbbb2222."), second.header.amendment.changes.join(" | "));
  assert.match(second.header.amendment.keeps.join("; "), /your part[\s\S]*acceptance A1/);
  assert.match(redo.job.instructions, /^## Changes\nThis is version 2 of this task\. Since version 1:/);
  assert.notEqual(second.header.hash, first.header.hash);

  await finishJob(redo.job.id, { outcome: "done", summary: "Escaped pipes and backslashes.", subject: { branch: "live-testing", commit: "def5678" } });
  const retest = await runOf(planId, "verify", 1);
  assert.equal(packetOf(retest.step).header.packetVersion, 2);
  await finishJob(retest.job.id, { outcome: "pass", summary: "One cell.", checks: [{ id: "A1", name: "pipe title in one cell", verdict: "pass", strength: "A" }], subject: { commit: "def5678" } });
  const ended = await loadPlan(h.prisma, planId);
  assert.equal(ended?.data.status, "succeeded");
  assert.deepEqual(ended?.data.steps[0]!.attempts.map((row) => [row.reason, row.decision?.how ?? null]), [["first", "forward"], ["amend", null]]);
});

test("report v2: a partial result is never done; its lead gets one re-plan turn, then its owner one card (reminded once), and a retry finishes it", async () => {
  const kofi = await person("Kofi");
  const { room } = await crew(kofi, ["manager", "researcher"]);
  let tries = 0;
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("compare the vendors")) return { calls: [{ name: "node_delegate", arguments: { to: "researcher", brief: "Compare the three vendors.", kind: "research" } }], then: "Planned." };
    if (turn.slug === "manager" && turn.transcript.includes("one re-plan turn")) return { text: "(no reply)" };
    if (turn.slug === "manager" && turn.transcript.includes("nothing left to run")) return { text: "All three vendors compared." };
    if (turn.slug === "researcher") {
      tries += 1;
      return tries === 1
        ? { calls: [reportCall({ outcome: "partial", summary: "Two of three vendors compared.", remaining: ["Vendor C's pricing"], ownerDecision: "May I sign up for Vendor C's trial to see its pricing?" })], then: "(no reply)" }
        : { calls: [reportCall({ outcome: "done", summary: "All three vendors compared." })], then: "(no reply)" };
    }
    return { text: "(no reply)" };
  };
  await post(kofi, room.id, "@manager compare the vendors for me");
  const planId = (await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } })).id;
  let plan = (await loadPlan(h.prisma, planId))!.data;
  const step = plan.steps[0]!;
  assert.deepEqual([step.status, step.outcome], ["blocked", "partial"], "partial is not done");
  assert.deepEqual([step.attempts[0]!.remaining, step.attempts[0]!.ownerDecision], [["Vendor C's pricing"], "May I sign up for Vendor C's trial to see its pricing?"]);
  const replans = seen.filter((turn) => turn.slug === "manager" && turn.transcript.includes("one re-plan turn"));
  assert.equal(replans.length, 1, "one re-plan turn");
  assert.match(replans[0]!.transcript, /Left to do: Vendor C's pricing[\s\S]*Needs your owner: May I sign up/);
  assert.equal(plan.status, "running", "the plan waits for its owner");

  const cards = (await read(kofi, room.id)).filter((row) => row.kind === "approval" && row.data.type === "plan_decision");
  assert.equal(cards.length, 1);
  assert.match(cards[0]!.body, /@researcher's step in @manager's plan is stuck\. Two of three vendors compared\. It needs you to decide: May I sign up for Vendor C's trial to see its pricing\? Try it again, or finish the plan without it\?/);

  // A card left waiting gets one reminder, however many passes the watchdog makes.
  await h.prisma.nodeMessage.update({ where: { id: cards[0]!.id }, data: { createdAt: new Date(Date.now() - 40 * 60_000) } });
  const passes = (await Promise.all([checkWork(h.app), checkWork(h.app)])).flat().concat(await checkWork(h.app));
  assert.deepEqual(passes.filter((row) => row.rule === "card_waiting").map((row) => row.action), ["remind"]);
  assert.equal((await read(kofi, room.id)).filter((row) => row.kind === "status" && row.body.startsWith("Still waiting for your answer on a decision for a stuck step")).length, 1);

  // One press: try again.
  await pressCard(kofi, room.id, "approve");
  plan = (await loadPlan(h.prisma, planId))!.data;
  assert.equal(plan.status, "succeeded");
  assert.deepEqual(plan.steps[0]!.attempts.map((row) => [row.n, row.reason, row.outcome, row.decision?.how ?? null]), [
    [1, "first", "partial", "retry"],
    [2, "retry", "done", null],
  ]);
  assert.equal(seen.filter((turn) => turn.slug === "manager" && turn.transcript.includes("one re-plan turn")).length, 1, "still one re-plan turn");
});

test("a child's result enters its lead once: a second report adds nothing, and one that arrives during the lead's turn brings exactly one more", async () => {
  const kofi = await person("Kofi");
  const { room } = await crew(kofi, ["manager", "researcher", "researcher"]);
  let planId = "";
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("find the sources")) return { calls: [{ name: "node_delegate", arguments: { to: "researcher", brief: "Find the sources.", kind: "research" } }], then: "Planned." };
    if (turn.slug === "manager" && turn.transcript.includes("nothing left to run")) {
      if (turn.transcript.includes("@researcher-2")) return { text: "Both findings are in." };
      // The lead adds one more step and is still thinking when that step's result comes in.
      return { calls: [{ name: "node_plan_revise", arguments: { plan: planId, add: [{ id: "more", to: "researcher-2", kind: "research", brief: "Find one more source.", requirementIds: [] }] } }], then: "Asked for one more.", holdAfter: gate };
    }
    if (turn.slug === "researcher") return { calls: [reportCall({ outcome: "done", summary: "First finding." }), reportCall({ outcome: "done", summary: "First finding, again." })], then: "(no reply)" };
    if (turn.slug === "researcher-2") return { calls: [reportCall({ outcome: "done", summary: "Second finding." })], then: "(no reply)" };
    return { text: "(no reply)" };
  };
  const posted = kofi.inject({ method: "POST", url: `/api/node/rooms/${room.id}/messages`, payload: { body: "@manager find the sources" } });
  assert.equal((await posted).statusCode, 201);
  for (let i = 0; i < 200 && !planId; i += 1) {
    planId = (await h.prisma.nodeMission.findFirst({ where: { originRoomId: room.id } }))?.id ?? "";
    if (!planId) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // The second step's result is recorded while the lead's first report turn is still in flight.
  for (let i = 0; i < 300; i += 1) {
    const more = await h.prisma.nodeStep.findFirst({ where: { missionId: planId, handle: "researcher-2" } });
    if (more?.status === "done") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const running = await h.prisma.nodeTurn.findFirstOrThrow({ where: { planId, planStep: null, status: "running" } });
  release();
  await settleTurns();

  const plan = (await loadPlan(h.prisma, planId))!.data;
  assert.equal(plan.status, "succeeded");
  const [firstStep, moreStep] = plan.steps;
  assert.equal(firstStep!.attempts.length, 1);
  assert.equal(firstStep!.result, "First finding.", "the second report changed nothing");
  assert.match(toolResults.join("\n"), /This step has already ended/);
  assert.equal(await finishStep(h.app, planId, firstStep!.id, { status: "done", result: "Late.", report: { outcome: "done", summary: "Late." }, attempt: 1 }), false, "a result for an attempt that has one is refused");
  // Each result was carried by exactly one of the lead's turns: the first by the turn in flight, the second by one more.
  assert.equal(firstStep!.attempts[0]!.deliveredTo, running.id);
  assert.ok(moreStep!.attempts[0]!.deliveredTo && moreStep!.attempts[0]!.deliveredTo !== running.id);
  const leadTurns = seen.filter((turn) => turn.slug === "manager" && turn.transcript.includes("nothing left to run"));
  assert.equal(leadTurns.length, 2, "exactly one more report turn");
  assert.match(leadTurns[1]!.transcript, /@researcher-2 \(research, done\): Second finding\./);
  assert.ok((await read(kofi, room.id)).some((row) => row.body === "Both findings are in."));
});

test("an independent review's rejection repairs the build in its own session; the reviewer then reviews the new candidate", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { room } = await crew(mira, ["manager", "feature-engineer", "tester"]);
  const plan = {
    goal: "An onboarding screen people can follow",
    requirements: [
      {
        id: "R1",
        text: "The onboarding screen",
        acceptance: [
          { id: "A1", text: "The steps show in order in a browser", proof: "browser" },
          { id: "A2", text: "Nothing animates with reduced motion", proof: "preference" },
        ],
      },
    ],
    constraints: { folder: "~/ensemble-workspace/live-test", branch: "live-testing", publish: "push", agent: "codex" },
    steps: [
      { id: "build", to: "builder", kind: "build", requirementIds: ["R1"], brief: "Build the onboarding screen." },
      { id: "review", to: "tester", kind: "review", requirementIds: ["R1"], brief: "Review the onboarding screen as a new user would.", after: ["build"], verifies: "build" },
    ],
  };
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("onboarding screen")) return { calls: [{ name: "node_plan", arguments: plan }], then: "Planned: build, then an independent review." };
    if (turn.slug === "manager" && turn.transcript.includes("nothing left to run")) return { text: "Built and reviewed." };
    return { text: "(no reply)" };
  };
  await post(mira, room.id, "Please build the onboarding screen and have someone review it.");
  const planId = (await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } })).id;
  const build = await runOf(planId, "build");
  await finishJob(build.job.id, {
    outcome: "done",
    summary: "Built it; 18 of 18 tests pass.",
    subject: { branch: "live-testing", commit: "abc1234" },
    checks: [{ name: "unit tests", verdict: "pass", strength: "B", rerun: { command: "pnpm test", expects: "exit_0" } }],
  });

  const review = await runOf(planId, "review");
  assert.notEqual(review.run.sessionId, build.run.sessionId, "a review runs in a session of its own");
  assert.match(review.job.task?.title ?? "", /^Review: /);
  for (const part of [
    "You review @builder's build independently, at commit abc1234 on live-testing. Its builder's report and green tests are input, not proof.",
    "- A1 (must pass; proof: browser): The steps show in order in a browser",
    "- A2 (must pass; proof: preference): Nothing animates with reduced motion",
    "- `pnpm test`, expecting exit 0 (unit tests, from @builder)",
    "A pass rests on evidence of strength A or B",
  ]) {
    assert.ok(review.job.instructions.includes(part), `the reviewer is told “${part}”`);
  }
  await finishJob(review.job.id, {
    outcome: "fail",
    summary: "Reduced motion is ignored.",
    subject: { commit: "abc1234" },
    checks: [
      { id: "A1", name: "steps in order", verdict: "pass", strength: "A" },
      { id: "A2", name: "reduced motion", verdict: "fail", strength: "A", detail: "the cards still slide in with reduced motion on" },
    ],
  });

  const repair = await runOf(planId, "build", 1);
  assert.equal(repair.run.sessionId, build.run.sessionId, "the repair goes back to the builder's own session");
  assert.match(repair.job.instructions, /An independent review of your work FAILED\. This is attempt 2/);
  assert.match(repair.job.instructions, /- FAIL A2 reduced motion: the cards still slide in with reduced motion on/);
  await finishJob(repair.job.id, { outcome: "done", summary: "Respects reduced motion.", subject: { branch: "live-testing", commit: "def5678" } });

  const again = await runOf(planId, "review", 1);
  assert.equal(again.run.sessionId, review.run.sessionId, "the reviewer reviews again in its own session");
  assert.match(again.job.instructions, /The work you reviewed was repaired\. Review the new candidate: commit def5678 on live-testing, and judge every criterion again\./);
  assert.match(again.job.instructions, /What failed last time:\n- FAIL A2 reduced motion/);
  await finishJob(again.job.id, {
    outcome: "pass",
    summary: "Both criteria hold.",
    subject: { commit: "def5678" },
    checks: [
      { id: "A1", name: "steps in order", verdict: "pass", strength: "A" },
      { id: "A2", name: "reduced motion", verdict: "pass", strength: "B" },
    ],
  });
  const ended = (await loadPlan(h.prisma, planId))!.data;
  assert.equal(ended.status, "succeeded");
  assert.deepEqual(ended.steps[1]!.attempts.map((row) => [row.reason, row.outcome]), [["first", "fail"], ["retest", "pass"]]);
  assert.deepEqual(ended.steps[0]!.attempts.map((row) => row.reason), ["first", "repair"]);
  assert.deepEqual(ended.requirements.map((row) => row.status), ["accepted"]);
  assert.deepEqual(seen.map((turn) => turn.slug), ["manager", "manager"], "only the lead thought: to plan and to report");
});

test("a plan whose must-pass criterion no check judges is refused before anything starts", async () => {
  const mira = await person("Mira");
  const { room } = await crew(mira, ["manager", "feature-engineer", "docs-writer"]);
  script = (turn) => {
    if (turn.slug !== "manager") return { text: "(no reply)" };
    return {
      calls: [
        {
          name: "node_plan",
          arguments: {
            goal: "Setup instructions people can follow",
            requirements: [{ id: "R1", text: "Setup instructions", acceptance: [{ id: "A1", text: "A new machine is set up by following them as written", proof: "route" }] }],
            constraints: {},
            steps: [
              { id: "build", to: "builder", kind: "build", requirementIds: ["R1"], brief: "Script the setup." },
              { id: "docs", to: "docs", kind: "write", requirementIds: ["R1"], brief: "Write the setup instructions.", after: ["build"] },
            ],
          },
        },
      ],
      then: "I will fix the plan.",
    };
  };
  await post(mira, room.id, "@manager write setup instructions for new machines");
  assert.match(toolResults.join("\n"), /Acceptance “A1” of “R1” must be checked, but no verify or review step judges it/);
  assert.equal(await h.prisma.nodeMission.count({ where: { originRoomId: room.id } }), 0, "nothing started");
});

test("the watchdog: a working step that stopped moving is asked once to report; a mission nobody moves is moved again, once", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { room } = await crew(mira, ["manager", "feature-engineer"]);
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("build the export")) return { calls: [{ name: "node_delegate", arguments: { to: "builder", brief: "Build the export.", kind: "build" } }], then: "Planned." };
    if (turn.slug === "manager" && turn.transcript.includes("nothing left to run")) return { text: "The export is built." };
    if (turn.slug === "builder" && turn.transcript.includes("not reported yet")) return { calls: [reportCall({ outcome: "done", summary: "Built the export." })], then: "(no reply)" };
    if (turn.slug === "builder") return { calls: [{ name: "node_session_start", arguments: { title: "Build the export", prompt: "Build the export.", folder: "live-test" } }], then: "(no reply)" };
    return { text: "(no reply)" };
  };
  await post(mira, room.id, "@manager build the export");
  const planId = (await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } })).id;
  const step = await stepOf(planId, "build");
  assert.equal(step.status, "working", "it waits for its run");
  // The run is lost, and nothing has touched the step for 20 minutes.
  await h.prisma.nodeRun.deleteMany({ where: { planId } });
  await h.prisma.$executeRaw`UPDATE node_steps SET updated_at = now() - interval '20 minutes' WHERE mission_id = ${planId}`;
  const found = (await Promise.all([checkWork(h.app), checkWork(h.app)])).flat();
  assert.deepEqual(found.map((row) => [row.rule, row.action]), [["step_stalled", "nudge"]], "asked once, however many passes");
  await settleTurns();
  assert.equal((await loadPlan(h.prisma, planId))!.data.status, "succeeded", "asked, it reported");
  assert.deepEqual(await checkWork(h.app), []);
  assert.equal(await h.prisma.nodeDecision.count({ where: { userId: mira.id, kind: "escalation" } }), 1);

  // A mission left waiting for a lead turn that never came: its report is asked for again, once.
  await h.prisma.nodeMission.update({ where: { id: planId }, data: { status: "reporting", endedAt: null, reportedAt: null } });
  await h.prisma.$executeRaw`UPDATE node_missions SET updated_at = now() - interval '20 minutes' WHERE id = ${planId}`;
  await h.prisma.$executeRaw`UPDATE node_steps SET updated_at = now() - interval '20 minutes' WHERE mission_id = ${planId}`;
  seen.length = 0;
  const again = (await Promise.all([checkWork(h.app), checkWork(h.app)])).flat();
  assert.deepEqual(again.map((row) => [row.rule, row.action]), [["mission_stalled", "report_again"]]);
  await settleTurns();
  assert.equal(seen.filter((turn) => turn.slug === "manager" && turn.transcript.includes("nothing left to run")).length, 1);
  assert.equal((await loadPlan(h.prisma, planId))!.data.status, "succeeded");
  assert.deepEqual(await checkWork(h.app), []);
});
