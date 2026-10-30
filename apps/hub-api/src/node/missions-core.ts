/**
 * The pure decision core of missions (ensemble-node docs/design build blocks B1, B2, B4): given a
 * mission and its steps, what starts, what is held, what is repaired, and when the lead reports.
 * No database and no clock: callers pass `now` and apply the effects. Every rule here is tested in
 * missions-core.test.ts without a database.
 */
import { candidateKey, failureSignature, verdictOf, type Candidate, type Check, type StepOutcome, type StepReport } from "./report.js";

export type StepStatus = "waiting" | "working" | "done" | "blocked" | "skipped" | "stopped";
export type MissionStatus = "draft" | "running" | "reporting" | "succeeded" | "partially_completed" | "failed" | "stopped";
export type AttemptReason = "first" | "repair" | "retest" | "nudge";

export type Attempt = {
  n: number;
  reason: AttemptReason;
  outcome: StepOutcome;
  summary: string | null;
  checks?: Check[];
  candidate?: Candidate;
  /** A failed verification's signature (report.ts failureSignature). */
  signature?: string | null;
  /** For a repair: the verification whose failure it answers. */
  forVerify?: string;
  /** On a failed verification: what happened next. scheduled: a repair started; judgement: the lead decides; owner: the owner is asked. */
  repair?: "scheduled" | "judgement" | "owner";
  /** On a finished repair: whether its retest was scheduled, or the repair changed nothing. */
  retest?: "scheduled" | "no_progress";
  startedAt: string | null;
  endedAt: string | null;
};

export type StepState = {
  id: string;
  position: number;
  nodeId: string;
  handle: string;
  kind: string;
  executor: string;
  brief: string;
  after: string[];
  verifies: string | null;
  requirementIds: string[];
  status: StepStatus;
  outcome: StepOutcome;
  attempt: number;
  attempts: Attempt[];
  report: StepReport | null;
  result: string | null;
  progress: string | null;
  nudged: boolean;
  startedAt: string | null;
  endedAt: string | null;
};

export type MissionState = { id: string; contract: number; status: MissionStatus; reportedAt: string | null };

export type Effect =
  | { kind: "turn"; stepId: string; attempt: number; reason: AttemptReason }
  | { kind: "report"; judgement: string[] }
  | { kind: "expire_cards"; steps: string[] | null; why: string };

export type Draft = { mission: MissionState; steps: StepState[]; effects: Effect[]; dirty: Set<string>; missionDirty: boolean };

export const ENDED: ReadonlySet<StepStatus> = new Set(["done", "blocked", "skipped", "stopped"]);
/** Outcomes that let dependent steps start. */
const SATISFIED: ReadonlySet<StepOutcome> = new Set(["done", "pass"]);
/** Outcomes that hold dependent steps until a repair or a decision. */
const HOLDING: ReadonlySet<StepOutcome> = new Set(["fail", "blocked", "unverified"]);

export function draftOf(mission: MissionState, steps: StepState[]): Draft {
  return { mission: { ...mission }, steps: steps.map((step) => ({ ...step, after: [...step.after], attempts: step.attempts.map((row) => ({ ...row })) })), effects: [], dirty: new Set(), missionDirty: false };
}

export function stepById(draft: Pick<Draft, "steps">, id: string | null | undefined): StepState | undefined {
  return id ? draft.steps.find((row) => row.id === id) : undefined;
}

function touch(draft: Draft, step: StepState): void {
  draft.dirty.add(step.id);
}

function lastAttempt(step: StepState): Attempt | undefined {
  return step.attempts.at(-1);
}

/** Whether every step this one comes after has an outcome that lets it start. */
export function ready(draft: Pick<Draft, "steps">, step: StepState): boolean {
  return step.after.every((id) => {
    const before = stepById(draft, id);
    return !before || (before.status === "done" && SATISFIED.has(before.outcome));
  });
}

/** The step that holds a waiting one: an earlier step that failed, is blocked or unverified, or never ran. Null when it may still start. */
export function heldBy(draft: Pick<Draft, "steps">, step: StepState, seen: Set<string> = new Set()): string | null {
  if (step.status !== "waiting" || seen.has(step.id)) return null;
  seen.add(step.id);
  for (const id of step.after) {
    const before = stepById(draft, id);
    if (!before) continue;
    if ((ENDED.has(before.status) && !SATISFIED.has(before.outcome)) || HOLDING.has(before.outcome)) return before.id;
    const deeper = heldBy(draft, before, seen);
    if (deeper) return deeper;
  }
  return null;
}

/** Starts a step's attempt: working, with a fresh outcome, and a turn for its node. */
export function startAttempt(draft: Draft, step: StepState, reason: AttemptReason, now: string, extra: Partial<Attempt> = {}): void {
  step.attempt = step.attempts.length ? lastAttempt(step)!.n + 1 : 1;
  step.status = "working";
  step.outcome = "unknown";
  step.report = null;
  step.progress = null;
  step.nudged = false;
  step.startedAt = now;
  step.endedAt = null;
  step.attempts.push({ n: step.attempt, reason, outcome: "unknown", summary: null, startedAt: now, endedAt: null, ...extra });
  touch(draft, step);
  draft.effects.push({ kind: "turn", stepId: step.id, attempt: step.attempt, reason });
}

export type Finish = {
  status: "done" | "blocked" | "stopped";
  result: string;
  report?: StepReport | null;
  /** An explicit outcome, when there is no report (a run that ended without one, a decline). */
  outcome?: StepOutcome;
  /** Fencing: only this attempt may end. */
  attempt?: number;
  /** Mandatory acceptance ids for a verification (B6). */
  mandatory?: readonly string[];
};

/**
 * Ends a step's current attempt. The outcome comes from a report's checks when there is one
 * (report.ts verdictOf); otherwise from `outcome`; otherwise a finished step without a report is
 * unverified (contract 3) or done (contract 1, the old meaning). Returns false when nothing changed.
 */
export function finish(draft: Draft, stepId: string, input: Finish, now: string): boolean {
  const step = stepById(draft, stepId);
  if (!step || ENDED.has(step.status)) return false;
  if (input.attempt !== undefined && input.attempt !== step.attempt) return false;
  let outcome: StepOutcome;
  let status: StepStatus = input.status;
  if (input.status === "stopped") outcome = step.outcome === "unknown" ? "unknown" : step.outcome;
  else if (input.report) {
    outcome = verdictOf(step.kind, input.report, input.mandatory ?? []).outcome;
    status = outcome === "blocked" || outcome === "unverified" ? "blocked" : "done";
  } else if (input.outcome) {
    outcome = input.outcome;
    status = outcome === "blocked" || outcome === "unverified" ? "blocked" : input.status;
  } else if (input.status === "blocked") outcome = "blocked";
  else outcome = draft.mission.contract < 3 ? "done" : "unverified";
  if (status === "done" && !SATISFIED.has(outcome) && outcome !== "fail") status = "blocked";
  step.status = status;
  step.outcome = outcome;
  step.result = input.result.trim() || (input.report?.summary ?? "Finished.");
  step.report = input.report ?? null;
  step.progress = null;
  step.endedAt = now;
  const attempt = lastAttempt(step);
  if (attempt && attempt.n === step.attempt) {
    attempt.outcome = outcome;
    attempt.summary = step.result;
    attempt.endedAt = now;
    if (input.report?.checks?.length) attempt.checks = input.report.checks;
    if (input.report?.subject) attempt.candidate = input.report.subject;
    if (outcome === "fail" && input.report) attempt.signature = failureSignature(input.report);
  } else {
    step.attempts.push({ n: step.attempt, reason: "first", outcome, summary: step.result, startedAt: step.startedAt, endedAt: now, ...(input.report?.subject ? { candidate: input.report.subject } : {}) });
  }
  touch(draft, step);
  draft.effects.push({ kind: "expire_cards", steps: [step.id], why: "Its step ended." });
  return true;
}

/** The last earlier attempt of a build that finished with a candidate. */
function previousCandidate(step: StepState): string | null {
  const done = step.attempts.filter((row) => row.n < step.attempt && row.outcome === "done");
  return candidateKey(done.at(-1)?.candidate);
}

/** How many failed attempts of a verification in a row, before the current one, had its current signature. */
function sameFailures(step: StepState): number {
  const current = lastAttempt(step);
  if (!current?.signature) return 0;
  let streak = 0;
  for (const row of step.attempts.slice(0, -1).reverse()) {
    if (row.outcome !== "fail") break;
    if (row.signature !== current.signature) break;
    streak += 1;
  }
  return streak;
}

/**
 * Applies the rules until nothing changes (B1, B2): failed verifications reopen their build as a
 * repair; finished repairs reopen the verification as a retest; ready steps start; and when nothing
 * can move, the lead reports once. Contract-1 missions only start ready steps and report.
 */
export function settle(draft: Draft, now: string): void {
  if (draft.mission.status !== "running") return;
  const judgement: string[] = [];
  for (let round = 0; round < 50; round += 1) {
    let moved = false;
    if (draft.mission.contract >= 3) {
      for (const verify of draft.steps) {
        if (verify.kind !== "verify" || verify.status !== "done" || verify.outcome !== "fail") continue;
        const failed = lastAttempt(verify);
        if (!failed || failed.repair) continue;
        const build = stepById(draft, verify.verifies);
        if (!build || build.status !== "done" || !SATISFIED.has(build.outcome)) {
          failed.repair = "judgement";
          touch(draft, verify);
          judgement.push(`@${verify.handle}'s check failed and there is no finished build step to repair.`);
          continue;
        }
        const streak = sameFailures(verify);
        if (streak >= 2) {
          failed.repair = "owner";
          touch(draft, verify);
          judgement.push(`@${verify.handle}'s check failed the same way ${streak + 1} times. Ask your owner what to do; do not repair it again.`);
        } else if (streak === 1) {
          failed.repair = "judgement";
          touch(draft, verify);
          judgement.push(`@${verify.handle}'s check failed the same way twice after a repair. Decide: change the approach or the agent (node_delegate a new step), ask your owner, or defer it.`);
        } else {
          failed.repair = "scheduled";
          touch(draft, verify);
          startAttempt(draft, build, "repair", now, { forVerify: verify.id });
          moved = true;
        }
      }
      for (const build of draft.steps) {
        const repair = lastAttempt(build);
        if (build.status !== "done" || !SATISFIED.has(build.outcome) || repair?.reason !== "repair" || repair.retest || !repair.forVerify) continue;
        const verify = stepById(draft, repair.forVerify);
        if (!verify || verify.status !== "done") continue;
        const before = previousCandidate(build);
        const after = candidateKey(repair.candidate);
        if (before && after && before === after) {
          repair.retest = "no_progress";
          touch(draft, build);
          judgement.push(`@${build.handle}'s repair changed nothing (still ${after.slice(0, 12)}).`);
          continue;
        }
        repair.retest = "scheduled";
        touch(draft, build);
        startAttempt(draft, verify, "retest", now, repair.candidate ? { candidate: repair.candidate } : {});
        moved = true;
      }
    }
    for (const step of draft.steps) {
      if (step.status !== "waiting" || !ready(draft, step)) continue;
      startAttempt(draft, step, "first", now);
      moved = true;
    }
    if (!moved) break;
  }
  const working = draft.steps.some((row) => row.status === "working");
  const startable = draft.steps.some((row) => row.status === "waiting" && ready(draft, row));
  if (!working && !startable) {
    draft.mission.status = "reporting";
    draft.missionDirty = true;
    draft.effects.push({ kind: "report", judgement });
  }
}

/**
 * The lead's report turn ended without adding work: the mission ends. Steps that never started are
 * skipped with what held them; the status says how it went.
 */
export function conclude(draft: Draft, now: string): MissionStatus {
  for (const step of draft.steps) {
    if (step.status === "waiting") {
      const holder = stepById(draft, heldBy(draft, step));
      step.status = "skipped";
      step.result = holder ? `Not started: @${holder.handle}'s step ${holder.outcome === "fail" ? "failed its checks" : "did not finish"}.` : "Not started.";
      step.endedAt = now;
      touch(draft, step);
    }
  }
  draft.mission.status = finalStatus(draft.steps);
  draft.missionDirty = true;
  draft.effects.push({ kind: "expire_cards", steps: null, why: "Its plan ended." });
  return draft.mission.status;
}

export function finalStatus(steps: readonly StepState[]): MissionStatus {
  if (!steps.length) return "succeeded";
  if (steps.every((row) => SATISFIED.has(row.outcome))) return "succeeded";
  if (steps.some((row) => row.outcome === "fail")) return "failed";
  if (steps.every((row) => row.status === "stopped")) return "stopped";
  return "partially_completed";
}

/** Whether a mission's status is final. */
export function missionEnded(status: string): boolean {
  return status === "succeeded" || status === "partially_completed" || status === "failed" || status === "stopped" || status === "done";
}
