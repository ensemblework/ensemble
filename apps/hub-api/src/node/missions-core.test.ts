import assert from "node:assert/strict";
import test from "node:test";
import { conclude, draftOf, finish, heldBy, settle, stepById, type Draft, type MissionState, type StepState } from "./missions-core.js";
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

function mission(steps: StepState[], contract = 3): Draft {
  const state: MissionState = { id: "m1", contract, status: "running", reportedAt: null };
  return draftOf(state, steps);
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
