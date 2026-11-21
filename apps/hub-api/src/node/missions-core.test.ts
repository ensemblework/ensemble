import assert from "node:assert/strict";
import test from "node:test";
import {
  conclude,
  decide,
  draftOf,
  finalStatus,
  finish,
  heldBy,
  markDelivered,
  raiseConflicts,
  replaceStep,
  sameErrors,
  satisfied,
  settle,
  stallStep,
  stepById,
  unseen,
  type Draft,
  type MissionState,
  type StepState,
} from "./missions-core.js";
import type { StepReport } from "./report.js";

const NOW = "2026-11-01T10:00:00.000Z";

function step(id: string, kind: string, after: string[] = [], extra: Partial<StepState> = {}): StepState {
  return {
    id,
    position: Number(id.replace(/\D/g, "")) || 1,
    nodeId: `node-${id}`,
    handle: id,
    kind,
    executor: "node",
    brief: `Do ${id}`,
    after,
    verifies: null,
    requirementIds: [],
    status: "waiting",
    outcome: "unknown",
    attempt: 1,
    attempts: [],
    report: null,
    result: null,
    progress: null,
    nudged: false,
    startedAt: null,
    endedAt: null,
    ...extra,
  };
}

function mission(steps: StepState[], contract = 3, ladder = false): Draft {
  const state: MissionState = { id: "m1", contract, status: "running", reportedAt: null, ladder };
  return draftOf(state, steps);
}

function effects(draft: Draft, kind: string): Array<Record<string, unknown>> {
  return draft.effects.filter((effect) => effect.kind === kind) as unknown as Array<Record<string, unknown>>;
}

const pass = (summary = "All good.", commit?: string): StepReport => ({ outcome: "pass", summary, checks: [{ name: "renders", verdict: "pass" }], ...(commit ? { subject: { commit } } : {}) });
const fail = (detail = "Row 3 lost a cell", commit = "abc1234"): StepReport => ({ outcome: "fail", summary: "Table broke.", subject: { commit }, checks: [{ name: "pipe in title", verdict: "fail", detail }] });
const built = (commit: string): StepReport => ({ outcome: "done", summary: `Built ${commit}.`, subject: { commit } });

/** The reported incident: build A → test A → build B → test B, with B gated on A's test passing. */
function incident(): Draft {
  return mission([
    step("buildA", "build"),
    step("testA", "verify", ["buildA"], { verifies: "buildA" }),
    step("buildB", "build", ["testA"]),
    step("testB", "verify", ["buildB"], { verifies: "buildB" }),
  ]);
}

function turns(draft: Draft): string[] {
  return draft.effects.filter((effect) => effect.kind === "turn").map((effect) => `${effect.stepId}#${effect.attempt}:${effect.reason}`);
}

test("F1: a failed verification never releases the next feature; the build is repaired and retested", () => {
  const draft = incident();
  settle(draft, NOW);
  assert.deepEqual(turns(draft), ["buildA#1:first"]);
  draft.effects.length = 0;

  assert.ok(finish(draft, "buildA", { status: "done", result: "Built.", report: built("aaa1111") }, NOW));
  settle(draft, NOW);
  assert.deepEqual(turns(draft), ["testA#1:first"]);
  draft.effects.length = 0;

  // The tester's process finished normally but its report says FAIL.
  assert.ok(finish(draft, "testA", { status: "done", result: "FAIL: pipe in title", report: fail() }, NOW));
  assert.equal(stepById(draft, "testA")!.outcome, "fail");
  settle(draft, NOW);
  assert.equal(stepById(draft, "buildB")!.status, "waiting", "the next feature does not start");
  assert.equal(heldBy(draft, stepById(draft, "buildB")!), "testA");
  assert.deepEqual(turns(draft), ["buildA#2:repair"], "the builder repairs in a new attempt");
  draft.effects.length = 0;

  assert.ok(finish(draft, "buildA", { status: "done", result: "Escaped pipes.", report: built("bbb2222") }, NOW));
  settle(draft, NOW);
  assert.deepEqual(turns(draft), ["testA#2:retest"], "the tester checks the new candidate");
  assert.equal(stepById(draft, "testA")!.attempts.at(-1)!.candidate?.commit, "bbb2222");
  draft.effects.length = 0;

  assert.ok(finish(draft, "testA", { status: "done", result: "Pass.", report: pass("ok", "bbb2222") }, NOW));
  settle(draft, NOW);
  assert.deepEqual(turns(draft), ["buildB#1:first"], "only now does feature B start");
  draft.effects.length = 0;

  finish(draft, "buildB", { status: "done", result: "Built B.", report: built("ccc3333") }, NOW);
  settle(draft, NOW);
  finish(draft, "testB", { status: "done", result: "Pass.", report: pass() }, NOW);
  settle(draft, NOW);
  assert.equal(draft.mission.status, "reporting");
  assert.equal(conclude(draft, NOW), "succeeded", "a repaired-then-passed plan succeeds");
});

test("a repair that changes nothing goes to the lead instead of another retest", () => {
  const draft = incident();
  settle(draft, NOW);
  finish(draft, "buildA", { status: "done", result: "Built.", report: built("aaa1111") }, NOW);
  settle(draft, NOW);
  finish(draft, "testA", { status: "done", result: "FAIL", report: fail() }, NOW);
  settle(draft, NOW);
  draft.effects.length = 0;
  finish(draft, "buildA", { status: "done", result: "Tried.", report: built("aaa1111") }, NOW);
  settle(draft, NOW);
  assert.deepEqual(turns(draft), [], "no retest of an unchanged candidate");
  const report = draft.effects.find((effect) => effect.kind === "report");
  assert.ok(report && report.kind === "report");
  assert.match(report.judgement.join(" "), /changed nothing/);
  assert.equal(draft.mission.status, "reporting");
});

test("the same failure twice asks the lead to decide; three times asks the owner", () => {
  const draft = incident();
  settle(draft, NOW);
  finish(draft, "buildA", { status: "done", result: "Built.", report: built("c1") }, NOW);
  settle(draft, NOW);
  finish(draft, "testA", { status: "done", result: "FAIL", report: fail("Row 3 lost a cell", "c1") }, NOW);
  settle(draft, NOW);
  finish(draft, "buildA", { status: "done", result: "Fix 1", report: built("c2") }, NOW);
  settle(draft, NOW);
  draft.effects.length = 0;
  // Same failure on a new commit: same signature (commits and numbers are ignored).
  finish(draft, "testA", { status: "done", result: "FAIL", report: fail("Row 9 lost a cell", "c2") }, NOW);
  settle(draft, NOW);
  assert.deepEqual(turns(draft), []);
  const first = draft.effects.find((effect) => effect.kind === "report");
  assert.ok(first && first.kind === "report");
  assert.match(first.judgement.join(" "), /same way twice/);
  assert.equal(stepById(draft, "testA")!.attempts.at(-1)!.repair, "judgement");
});

test("a different failure after a repair is repaired again (no fixed round limit)", () => {
  const draft = incident();
  settle(draft, NOW);
  finish(draft, "buildA", { status: "done", result: "Built.", report: built("c1") }, NOW);
  settle(draft, NOW);
  finish(draft, "testA", { status: "done", result: "FAIL", report: fail("pipes", "c1") }, NOW);
  settle(draft, NOW);
  finish(draft, "buildA", { status: "done", result: "Fix 1", report: built("c2") }, NOW);
  settle(draft, NOW);
  draft.effects.length = 0;
  const other: StepReport = { outcome: "fail", summary: "Links broke.", subject: { commit: "c2" }, checks: [{ name: "links", verdict: "fail", detail: "link lost" }] };
  finish(draft, "testA", { status: "done", result: "FAIL", report: other }, NOW);
  settle(draft, NOW);
  assert.deepEqual(turns(draft), ["buildA#3:repair"]);
});

test("a blocked or unverified step holds its dependants and the lead reports once", () => {
  const draft = mission([step("research", "research"), step("write", "write", ["research"])]);
  settle(draft, NOW);
  draft.effects.length = 0;
  finish(draft, "research", { status: "done", result: "I looked around." }, NOW);
  assert.equal(stepById(draft, "research")!.outcome, "unverified", "prose without a report is not a result");
  settle(draft, NOW);
  assert.equal(heldBy(draft, stepById(draft, "write")!), "research");
  assert.equal(draft.effects.filter((effect) => effect.kind === "report").length, 1);
  assert.equal(conclude(draft, NOW), "partially_completed");
  assert.equal(stepById(draft, "write")!.status, "skipped");
  assert.match(stepById(draft, "write")!.result!, /@research/);
});

test("contract-1 missions keep the old meaning: a finished step releases the next", () => {
  const draft = mission([step("a", "other"), step("b", "other", ["a"])], 1);
  settle(draft, NOW);
  draft.effects.length = 0;
  finish(draft, "a", { status: "done", result: "Done." }, NOW);
  settle(draft, NOW);
  assert.deepEqual(turns(draft), ["b#1:first"]);
});

test("an attempt that is not current cannot end the step", () => {
  const draft = incident();
  settle(draft, NOW);
  assert.equal(finish(draft, "buildA", { status: "done", result: "late", report: built("x"), attempt: 2 }, NOW), false);
  assert.equal(finish(draft, "buildA", { status: "done", result: "now", report: built("x"), attempt: 1 }, NOW), true);
  assert.equal(finish(draft, "buildA", { status: "done", result: "again", report: built("y") }, NOW), false, "an ended step does not end twice");
});

test("a verification without checks, or with a skipped check, is blocked, not passed", () => {
  const draft = incident();
  settle(draft, NOW);
  finish(draft, "buildA", { status: "done", result: "Built.", report: built("c1") }, NOW);
  settle(draft, NOW);
  finish(draft, "testA", { status: "done", result: "Looks fine", report: { outcome: "pass", summary: "Looks fine", checks: [{ name: "live account", verdict: "skipped" }] } }, NOW);
  assert.equal(stepById(draft, "testA")!.outcome, "blocked");
  assert.equal(stepById(draft, "testA")!.status, "blocked");
  settle(draft, NOW);
  assert.equal(stepById(draft, "buildB")!.status, "waiting");
});

test("a result enters once: a second report for the same attempt changes nothing", () => {
  const draft = mission([step("b1", "build")]);
  settle(draft, NOW);
  assert.equal(finish(draft, "b1", { status: "done", result: "Built.", report: built("aaa1111") }, NOW), true);
  const reported = stepById(draft, "b1")!.attempts[0]!;
  assert.equal(reported.reportedAt, NOW);
  const again = { ...stepById(draft, "b1")!, status: "working" as const };
  const twice = draftOf(draft.mission, [again]);
  assert.equal(finish(twice, "b1", { status: "done", result: "Built again.", report: built("bbb2222") }, NOW), false, "the attempt already has its result");
  assert.equal(stepById(twice, "b1")!.result, "Built.");
});

test("the lead's seen list: results are delivered once, and one arriving later is unseen until the next turn", () => {
  const draft = mission([step("s1", "research"), step("s2", "research")]);
  settle(draft, NOW);
  finish(draft, "s1", { status: "done", result: "One.", report: { outcome: "done", summary: "One." } }, NOW);
  assert.deepEqual(unseen(draft.steps), [{ stepId: "s1", n: 1 }]);
  assert.deepEqual(markDelivered(draft, "turn-1", NOW), [{ stepId: "s1", n: 1 }]);
  assert.deepEqual(markDelivered(draft, "turn-2", NOW), [], "never carried twice");
  finish(draft, "s2", { status: "done", result: "Two.", report: { outcome: "done", summary: "Two." } }, NOW);
  assert.deepEqual(unseen(draft.steps), [{ stepId: "s2", n: 1 }]);
  assert.equal(stepById(draft, "s1")!.attempts[0]!.deliveredTo, "turn-1");
});

test("the ladder: a blocked step gets one re-plan turn of its lead, then its owner's card, and the mission waits", () => {
  const draft = mission([step("b1", "build"), step("t1", "verify", ["b1"], { verifies: "b1" })], 3, true);
  settle(draft, NOW);
  finish(draft, "b1", { status: "blocked", result: "No access to the repo.", report: { outcome: "blocked", summary: "No access to the repo.", blockedBy: "missing_access" } }, NOW);
  settle(draft, NOW);
  assert.equal(draft.mission.status, "replanning");
  assert.deepEqual(effects(draft, "replan").map((row) => row.steps), [["b1"]]);
  assert.equal(effects(draft, "report").length, 0, "the lead does not report yet");
  // The re-plan turn ended without a change: the owner gets the card, and the mission waits for it.
  draft.mission.status = "running";
  draft.effects = [];
  settle(draft, NOW);
  assert.equal(draft.mission.status, "running");
  assert.deepEqual(effects(draft, "decide").map((row) => [row.stepId, row.why]), [["b1", "stuck"]]);
  draft.effects = [];
  settle(draft, NOW);
  assert.deepEqual(draft.effects, [], "asked once");
  // Finish without it: the lead reports, and the check that never ran is skipped.
  assert.equal(decide(draft, "b1", { by: "owner", how: "finish_without", at: NOW }), true);
  settle(draft, NOW);
  assert.equal(draft.mission.status, "reporting");
  conclude(draft, NOW);
  assert.equal(draft.mission.status, "partially_completed");
});

test("without the ladder (a node's own work, a quiet routine) a blocked step goes straight to the lead's report", () => {
  const draft = mission([step("b1", "build")]);
  settle(draft, NOW);
  finish(draft, "b1", { status: "blocked", result: "No access.", report: { outcome: "blocked", summary: "No access." } }, NOW);
  settle(draft, NOW);
  assert.equal(draft.mission.status, "reporting");
});

test("the owner's retry starts the step again; a replacement takes over a stuck step and its check", () => {
  const draft = mission([step("b1", "build"), step("t1", "verify", ["b1"], { verifies: "b1" }), step("b2", "build", [])], 3, true);
  draft.steps = draft.steps.filter((row) => row.id !== "b2");
  settle(draft, NOW);
  finish(draft, "b1", { status: "blocked", result: "Stuck.", report: { outcome: "blocked", summary: "Stuck." } }, NOW);
  settle(draft, NOW);
  assert.equal(decide(draft, "b1", { by: "owner", how: "retry", at: NOW }), true);
  assert.equal(stepById(draft, "b1")!.status, "working");
  assert.deepEqual(turns(draft).at(-1), "b1#2:retry");

  const replaced = mission([step("b1", "build"), step("t1", "verify", ["b1"], { verifies: "b1" })], 3, true);
  settle(replaced, NOW);
  finish(replaced, "b1", { status: "done", result: "Built.", report: built("aaa1111") }, NOW);
  settle(replaced, NOW);
  finish(replaced, "t1", { status: "done", result: "Broke.", report: fail() }, NOW);
  settle(replaced, NOW);
  replaced.steps.push(step("b9", "build", [], { position: 9 }));
  assert.equal(replaceStep(replaced, "b1", "b9", NOW), false, "not while it is working (its repair started)");
  stepById(replaced, "b1")!.status = "blocked";
  assert.equal(replaceStep(replaced, "b1", "b9", NOW), true);
  const check = stepById(replaced, "t1")!;
  assert.equal(check.verifies, "b9");
  assert.deepEqual(check.after, ["b9"]);
  assert.equal(check.status, "waiting", "the check runs again, for the new build");
  assert.equal(stepById(replaced, "b1")!.supersededBy, "b9");
  settle(replaced, NOW);
  assert.equal(stepById(replaced, "b9")!.status, "working");
  finish(replaced, "b9", { status: "done", result: "Built.", report: built("ccc3333") }, NOW);
  settle(replaced, NOW);
  finish(replaced, "t1", { status: "done", result: "Fine.", report: pass("Fine.", "ccc3333") }, NOW);
  settle(replaced, NOW);
  assert.equal(replaced.mission.status, "reporting");
  assert.equal(finalStatus(replaced.steps), "succeeded", "a replaced step does not count");
});

test("a conflict holds a finished step's acceptance until it is resolved", () => {
  const draft = mission([step("w1", "write"), step("r1", "research", ["w1"])], 3, true);
  settle(draft, NOW);
  finish(draft, "w1", { status: "done", result: "Wrote it.", report: { outcome: "done", summary: "Wrote it." } }, NOW);
  assert.equal(raiseConflicts(draft, "w1", [{ ref: "spec.md", was: "aaaa1111", now: "bbbb2222", at: NOW }]), true);
  assert.equal(raiseConflicts(draft, "w1", [{ ref: "spec.md", was: "aaaa1111", now: "bbbb2222", at: NOW }]), false, "raised once");
  assert.equal(satisfied(stepById(draft, "w1")!), false);
  settle(draft, NOW);
  assert.equal(stepById(draft, "r1")!.status, "waiting");
  assert.equal(draft.mission.status, "replanning");
  assert.deepEqual(effects(draft, "replan").map((row) => row.steps), [["w1"]]);
  assert.equal(decide(draft, "w1", { by: "lead", how: "keep", at: NOW }), true);
  draft.mission.status = "running";
  settle(draft, NOW);
  assert.equal(stepById(draft, "r1")!.status, "working");
});

test("a stalled step is asked once, then ends blocked; the same failure across steps is found", () => {
  const draft = mission([step("s1", "research")], 3, true);
  settle(draft, NOW);
  assert.equal(stallStep(draft, "s1", 1, NOW, 15), "nudge");
  assert.equal(stallStep(draft, "s1", 1, NOW, 15), "block");
  assert.equal(stallStep(draft, "s1", 1, NOW, 15), null, "each rung once");
  const blocked = stepById(draft, "s1")!;
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.report?.blockedBy, "no_progress");
  const repeat = [1, 2, 3].map((n) => step(`x${n}`, "build", [], { status: "blocked", outcome: "blocked", attempts: [{ n: 1, reason: "first", outcome: "blocked", summary: `npm install failed: EACCES /tmp/run-${n}`, startedAt: NOW, endedAt: NOW }] }));
  assert.deepEqual(sameErrors(repeat, 3).map((row) => [row.count, row.stepId]), [[3, "x3"]]);
  assert.deepEqual(sameErrors(repeat, 4), []);
});

test("re-plan turns count along a replacement: a replacement that gets stuck too goes to the owner's card", () => {
  const draft = mission([step("b1", "build")], 3, true);
  settle(draft, NOW);
  finish(draft, "b1", { status: "blocked", result: "No access.", report: { outcome: "blocked", summary: "No access." } }, NOW);
  settle(draft, NOW);
  assert.equal(draft.mission.status, "replanning");
  // The lead's re-plan: another node takes the step over.
  draft.steps.push(step("b2", "build", [], { position: 2 }));
  assert.equal(replaceStep(draft, "b1", "b2", NOW), true);
  draft.mission.status = "running";
  draft.effects = [];
  settle(draft, NOW);
  assert.equal(stepById(draft, "b2")!.status, "working");
  finish(draft, "b2", { status: "blocked", result: "Still no access.", report: { outcome: "blocked", summary: "Still no access." } }, NOW);
  draft.effects = [];
  settle(draft, NOW);
  assert.equal(draft.mission.status, "running", "no second re-plan turn: the step's one was used");
  assert.deepEqual(effects(draft, "replan"), []);
  assert.deepEqual(effects(draft, "decide").map((row) => row.stepId), ["b2"]);
});

test("a mission with no step done is never a success", () => {
  assert.equal(finalStatus([]), "stopped");
  assert.equal(finalStatus([step("s1", "research", [], { status: "done", outcome: "done" })]), "succeeded");
});
