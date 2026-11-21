/**
 * The pure decision core of missions (ensemble-node docs/design build blocks B1, B2, B4; docs/35 §6.2):
 * given a mission and its steps, what starts, what is held, what is repaired, how a stuck step climbs the
 * escalation ladder (one re-plan turn of its lead, then a card for its owner), which results the lead has
 * not seen yet, and when the lead reports. No database and no clock: callers pass `now` and apply the
 * effects. Every rule here is tested in missions-core.test.ts without a database.
 */
import { candidateKey, CHECKING_KINDS, failureSignature, normalise, verdictOf, type Candidate, type Check, type Provenance, type StepOutcome, type StepReport } from "./report.js";

export type StepStatus = "waiting" | "working" | "done" | "blocked" | "skipped" | "stopped";
/** replanning: the lead's one re-plan turn for stuck steps; the mission goes on (running) when it ends. */
export type MissionStatus = "draft" | "running" | "replanning" | "reporting" | "succeeded" | "partially_completed" | "failed" | "stopped";
/**
 * first; repair (a check of it failed); retest (the work it checks was repaired or redone); nudge (asked
 * once to report); amend (what it works from changed: a new packet version); retry (its owner said try again).
 */
export type AttemptReason = "first" | "repair" | "retest" | "nudge" | "amend" | "retry";

/** An artifact whose hash changed after an attempt's packet named it: the attempt is not accepted until it is resolved. */
export type Conflict = { ref: string; label?: string; was: string; now: string; at: string };

/** How a stuck or conflicted attempt was settled, and by whom: its lead in a re-plan, or its owner on the card. */
export type Decision = { by: "lead" | "owner"; how: "retry" | "finish_without" | "forward" | "keep" | "replaced"; at: string; note?: string };

/** Why a step climbs the ladder: it cannot go on, a conflict holds its acceptance, or its failure keeps repeating. */
export type Stuck = "stuck" | "conflict" | "same_error";

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
  /** On a finished repair, amendment or retry: whether its checks were scheduled again, or the repair changed nothing. */
  retest?: "scheduled" | "no_progress";
  /** Why this attempt needs judgement, in words for its lead. */
  judgement?: string;
  /** From its report: what is left, the one decision only the owner can make, and who did it. */
  remaining?: string[];
  ownerDecision?: string;
  provenance?: Provenance;
  /** When its result was recorded: a second result for the same attempt is refused. */
  reportedAt?: string | null;
  /** The lead's turn that carried this result, and when: the lead's seen list. */
  deliveredTo?: string | null;
  deliveredAt?: string | null;
  /** The task packet this attempt was given (node/packet.ts). */
  packet?: { version: number; hash: string };
  /** Artifacts that changed after its packet named them. */
  conflicts?: Conflict[];
  /** How far up the ladder this attempt's failure went, and when. */
  escalation?: { replan?: string; owner?: string; why?: Stuck };
  /** How it was settled when it was stuck or in conflict. */
  decision?: Decision;
  /** What the watchdog did when it stopped moving (node/watchdog.ts): asked its worker once, then ended it. */
  stall?: { nudge?: string; block?: string };
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
  /** A re-plan replaced it with this step: it no longer counts for the plan. */
  supersededBy?: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

/** `ladder`: a stuck step climbs the escalation ladder before the lead reports (plans of contract 3, not a quiet routine's). */
export type MissionState = { id: string; contract: number; status: MissionStatus; reportedAt: string | null; ladder?: boolean };

export type Effect =
  | { kind: "turn"; stepId: string; attempt: number; reason: AttemptReason }
  /** `key`: the outbox operation it is delivered under (a resume for results the lead's turn did not carry). */
  | { kind: "report"; judgement: string[]; key?: string }
  | { kind: "replan"; steps: string[]; judgement: string[]; key?: string }
  | { kind: "decide"; stepId: string; attempt: number; why: Stuck; key?: string }
  | { kind: "expire_cards"; steps: string[] | null; why: string };

export type Draft = { mission: MissionState; steps: StepState[]; effects: Effect[]; dirty: Set<string>; missionDirty: boolean };

/** The ladder's settings (node/heuristics.ts `escalation`). */
export type Rules = { replanTurns: number };
export const DEFAULT_RULES: Rules = { replanTurns: 1 };

export const ENDED: ReadonlySet<StepStatus> = new Set(["done", "blocked", "skipped", "stopped"]);
/** Outcomes that let dependent steps start. */
const SATISFIED: ReadonlySet<StepOutcome> = new Set(["done", "pass"]);
/** Outcomes that hold dependent steps until a repair or a decision. */
const HOLDING: ReadonlySet<StepOutcome> = new Set(["fail", "blocked", "unverified", "partial", "uncertain", "stopped"]);

export function draftOf(mission: MissionState, steps: StepState[]): Draft {
  return {
    mission: { ...mission },
    steps: steps.map((step) => ({ ...step, after: [...step.after], attempts: step.attempts.map((row) => ({ ...row, ...(row.escalation ? { escalation: { ...row.escalation } } : {}), ...(row.stall ? { stall: { ...row.stall } } : {}) })) })),
    effects: [],
    dirty: new Set(),
    missionDirty: false,
  };
}

export function stepById(draft: Pick<Draft, "steps">, id: string | null | undefined): StepState | undefined {
  return id ? draft.steps.find((row) => row.id === id) : undefined;
}

function touch(draft: Draft, step: StepState): void {
  draft.dirty.add(step.id);
}

export function lastAttempt(step: Pick<StepState, "attempts">): Attempt | undefined {
  return step.attempts.at(-1);
}

/** Conflicts that still hold a finished step's acceptance: its latest attempt's, until the lead or owner decides. */
export function openConflicts(step: Pick<StepState, "status" | "attempts">): Conflict[] {
  const last = lastAttempt(step);
  return step.status === "done" && last?.conflicts?.length && !last.decision ? last.conflicts : [];
}

/** A step whose result the steps after it may use: done or passed, with no conflict open. */
export function satisfied(step: Pick<StepState, "status" | "outcome" | "attempts">): boolean {
  return step.status === "done" && SATISFIED.has(step.outcome) && !openConflicts(step).length;
}

/**
 * Why a step cannot go on by itself, or null: it ended blocked (also unverified, partial, uncertain), a
 * conflict holds its acceptance, or its check failed in a way the lead or owner must judge. A step that a
 * re-plan replaced is never stuck.
 */
export function stuck(step: StepState): Stuck | null {
  if (step.supersededBy) return null;
  if (openConflicts(step).length) return "conflict";
  if (step.status === "blocked") return "stuck";
  const last = lastAttempt(step);
  if (step.status === "done" && CHECKING_KINDS.has(step.kind) && step.outcome === "fail" && (last?.repair === "judgement" || last?.repair === "owner")) return "stuck";
  return null;
}

/**
 * Re-plan turns a step's lead already had for it, the steps it replaced included: a replacement takes over
 * the step's place on the ladder, so re-planning never starts over.
 */
function replans(draft: Pick<Draft, "steps">, step: StepState, seen: Set<string> = new Set()): number {
  if (seen.has(step.id)) return 0;
  seen.add(step.id);
  const own = step.attempts.filter((row) => row.escalation?.replan).length;
  return own + draft.steps.filter((row) => row.supersededBy === step.id).reduce((sum, row) => sum + replans(draft, row, seen), 0);
}

/** Whether every step this one comes after has an outcome that lets it start. */
export function ready(draft: Pick<Draft, "steps">, step: StepState): boolean {
  return step.after.every((id) => {
    const before = stepById(draft, id);
    return !before || satisfied(before);
  });
}

/** The step that holds a waiting one: an earlier step that failed, is blocked or unverified, holds a conflict, or never ran. Null when it may still start. */
export function heldBy(draft: Pick<Draft, "steps">, step: StepState, seen: Set<string> = new Set()): string | null {
  if (step.status !== "waiting" || seen.has(step.id)) return null;
  seen.add(step.id);
  for (const id of step.after) {
    const before = stepById(draft, id);
    if (!before) continue;
    if ((ENDED.has(before.status) && !satisfied(before)) || HOLDING.has(before.outcome)) return before.id;
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
  /** Every acceptance id a review judges. */
  judged?: readonly string[];
  /** Artifacts that changed after this attempt's packet named them (node/packet.ts `conflictsOf`). */
  conflicts?: readonly Conflict[];
};

/**
 * Ends a step's current attempt, once: its result is recorded with `reportedAt`, and a second result
 * for the same attempt changes nothing. The outcome comes from a report's checks when there is one
 * (report.ts verdictOf); otherwise from `outcome`; otherwise a finished step without a report is
 * unverified (contract 3) or done (contract 1, the old meaning). Returns false when nothing changed.
 */
export function finish(draft: Draft, stepId: string, input: Finish, now: string): boolean {
  const step = stepById(draft, stepId);
  if (!step || ENDED.has(step.status)) return false;
  if (input.attempt !== undefined && input.attempt !== step.attempt) return false;
  const current = lastAttempt(step);
  if (current && current.n === step.attempt && current.reportedAt) return false;
  let outcome: StepOutcome;
  let status: StepStatus = input.status;
  const ends = (value: StepOutcome, otherwise: StepStatus): StepStatus => (value === "stopped" ? "stopped" : value === "blocked" || value === "unverified" ? "blocked" : otherwise);
  if (input.status === "stopped") outcome = step.outcome === "unknown" ? "unknown" : step.outcome;
  else if (input.report) {
    outcome = verdictOf(step.kind, input.report, input.mandatory ?? [], input.judged ?? []).outcome;
    status = ends(outcome, "done");
  } else if (input.outcome) {
    outcome = input.outcome;
    status = ends(outcome, input.status);
  } else if (input.status === "blocked") outcome = "blocked";
  else outcome = draft.mission.contract < 3 ? "done" : "unverified";
  if (status === "done" && !SATISFIED.has(outcome) && outcome !== "fail") status = "blocked";
  step.status = status;
  step.outcome = outcome;
  step.result = input.result.trim() || (input.report?.summary ?? "Finished.");
  step.report = input.report ?? null;
  step.progress = null;
  step.endedAt = now;
  const conflicts = input.conflicts?.length ? { conflicts: [...input.conflicts] } : {};
  if (current && current.n === step.attempt) {
    current.outcome = outcome;
    current.summary = step.result;
    current.endedAt = now;
    current.reportedAt = now;
    if (input.report?.checks?.length) current.checks = input.report.checks;
    if (input.report?.subject) current.candidate = input.report.subject;
    if (input.report?.remaining?.length) current.remaining = input.report.remaining;
    if (input.report?.ownerDecision) current.ownerDecision = input.report.ownerDecision;
    if (input.report?.provenance) current.provenance = input.report.provenance;
    if (outcome === "fail" && input.report) current.signature = failureSignature(input.report);
    Object.assign(current, conflicts);
  } else {
    step.attempts.push({ n: step.attempt, reason: "first", outcome, summary: step.result, startedAt: step.startedAt, endedAt: now, reportedAt: now, ...(input.report?.subject ? { candidate: input.report.subject } : {}), ...conflicts });
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

function judge(draft: Draft, step: StepState, attempt: Attempt, repair: "judgement" | "owner", text: string, judgement: string[]): void {
  attempt.repair = repair;
  attempt.judgement = text;
  touch(draft, step);
  judgement.push(text);
}

/**
 * Applies the rules until nothing changes (B1, B2): failed checks reopen the work they check as a repair;
 * finished repairs, amendments and retries send their checks again; ready steps start. When nothing can
 * move, a stuck step climbs the ladder (a plan with `ladder`): its lead gets one re-plan turn for it, then
 * its owner gets a card with the one decision; only when nothing is stuck and undecided does the lead
 * report, once. Contract-1 missions only start ready steps and report.
 */
export function settle(draft: Draft, now: string, rules: Rules = DEFAULT_RULES): void {
  if (draft.mission.status !== "running") return;
  const judgement: string[] = [];
  for (let round = 0; round < 50; round += 1) {
    let moved = false;
    if (draft.mission.contract >= 3) {
      for (const check of draft.steps) {
        if (!CHECKING_KINDS.has(check.kind) || check.supersededBy || check.status !== "done" || check.outcome !== "fail") continue;
        const failed = lastAttempt(check);
        if (!failed || failed.repair) continue;
        const work = stepById(draft, check.verifies);
        if (!work || work.supersededBy || work.status !== "done" || !SATISFIED.has(work.outcome)) {
          judge(draft, check, failed, "judgement", `@${check.handle}'s check failed and there is no finished step to repair.`, judgement);
          continue;
        }
        const streak = sameFailures(check);
        if (streak >= 2) judge(draft, check, failed, "owner", `@${check.handle}'s check failed the same way ${streak + 1} times. Ask your owner what to do; do not repair it again.`, judgement);
        else if (streak === 1) judge(draft, check, failed, "judgement", `@${check.handle}'s check failed the same way twice after a repair. Decide: change the approach or the agent (a step that replaces it), ask your owner, or defer it.`, judgement);
        else {
          failed.repair = "scheduled";
          touch(draft, check);
          startAttempt(draft, work, "repair", now, { forVerify: check.id });
          moved = true;
        }
      }
      for (const work of draft.steps) {
        const repair = lastAttempt(work);
        if (work.status !== "done" || !SATISFIED.has(work.outcome) || repair?.reason !== "repair" || repair.retest || !repair.forVerify) continue;
        const check = stepById(draft, repair.forVerify);
        if (!check || check.status !== "done") continue;
        const before = previousCandidate(work);
        const after = candidateKey(repair.candidate);
        if (before && after && before === after) {
          repair.retest = "no_progress";
          touch(draft, work);
          const text = `@${work.handle}'s repair changed nothing (still ${after.slice(0, 12)}).`;
          const failed = lastAttempt(check);
          if (failed?.repair === "scheduled") judge(draft, check, failed, "judgement", text, judgement);
          else judgement.push(text);
          continue;
        }
        repair.retest = "scheduled";
        touch(draft, work);
        startAttempt(draft, check, "retest", now, repair.candidate ? { candidate: repair.candidate } : {});
        moved = true;
      }
      for (const work of draft.steps) {
        const redo = lastAttempt(work);
        if (!satisfied(work) || !redo || (redo.reason !== "amend" && redo.reason !== "retry") || redo.retest) continue;
        redo.retest = "scheduled";
        touch(draft, work);
        for (const check of draft.steps) {
          if (!CHECKING_KINDS.has(check.kind) || check.verifies !== work.id || check.supersededBy || (check.status !== "done" && check.status !== "blocked")) continue;
          startAttempt(draft, check, "retest", now, redo.candidate ? { candidate: redo.candidate } : {});
          moved = true;
        }
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
  if (working || startable) return;
  if (draft.mission.ladder && draft.mission.contract >= 3) {
    const open = draft.steps.filter((step) => stuck(step) && !lastAttempt(step)?.decision);
    const climbing = open.filter((step) => !lastAttempt(step)?.escalation?.owner);
    const replan = climbing.filter((step) => !lastAttempt(step)?.escalation?.replan && lastAttempt(step)?.repair !== "owner" && replans(draft, step) < rules.replanTurns);
    if (replan.length) {
      for (const step of replan) {
        const last = lastAttempt(step)!;
        last.escalation = { ...last.escalation, replan: now, why: stuck(step)! };
        touch(draft, step);
      }
      draft.mission.status = "replanning";
      draft.missionDirty = true;
      draft.effects.push({ kind: "replan", steps: replan.map((step) => step.id), judgement });
      return;
    }
    for (const step of climbing) escalate(draft, step, stuck(step)!, now);
    if (open.length) return;
  }
  draft.mission.status = "reporting";
  draft.missionDirty = true;
  draft.effects.push({ kind: "report", judgement });
}

/** The last rung: the owner gets a card with the one decision for this step (once per attempt). */
function escalate(draft: Draft, step: StepState, why: Stuck, now: string): boolean {
  const last = lastAttempt(step);
  if (!last || last.decision || last.escalation?.owner) return false;
  last.escalation = { ...last.escalation, owner: now, why: last.escalation?.why === "conflict" ? "conflict" : why };
  touch(draft, step);
  draft.effects.push({ kind: "decide", stepId: step.id, attempt: step.attempt, why: last.escalation.why! });
  return true;
}

/** Straight to the owner's card (the watchdog's same-error rule): only a stuck, undecided step. */
export function escalateToOwner(draft: Draft, stepId: string, why: Stuck, now: string): boolean {
  const step = stepById(draft, stepId);
  return Boolean(step && stuck(step) && escalate(draft, step, why, now));
}

/**
 * Settles a stuck or conflicted step, once per attempt: retry starts it again; forward starts it again
 * with what changed (an amendment); keep accepts its result as it is; finish_without leaves it, so the
 * plan ends without it; replaced is a re-plan's replacement step taking its part.
 */
export function decide(draft: Draft, stepId: string, decision: Decision): boolean {
  const step = stepById(draft, stepId);
  const last = step && lastAttempt(step);
  if (!step || !last || last.decision || step.supersededBy || step.status === "working" || step.status === "waiting") return false;
  last.decision = decision;
  touch(draft, step);
  if (decision.how === "retry") startAttempt(draft, step, "retry", decision.at);
  else if (decision.how === "forward") startAttempt(draft, step, "amend", decision.at);
  return true;
}

/**
 * A re-plan replaces a step with a new one (another worker, agent, model or brief): the old step no longer
 * counts, the steps after it wait for the new one instead, and a check of it checks the new one, again
 * from the start. Refused while the old step is still working.
 */
export function replaceStep(draft: Draft, oldId: string, newId: string, now: string): boolean {
  const old = stepById(draft, oldId);
  const next = stepById(draft, newId);
  if (!old || !next || old.id === next.id || old.supersededBy || old.status === "working") return false;
  old.supersededBy = next.id;
  const last = lastAttempt(old);
  if (last && !last.decision) last.decision = { by: "lead", how: "replaced", at: now };
  if (old.status === "waiting") {
    old.status = "skipped";
    old.result = `Replaced by step ${next.id}.`;
    old.endedAt = now;
  }
  touch(draft, old);
  for (const step of draft.steps) {
    if (step.id === old.id || step.id === next.id || step.supersededBy) continue;
    let changed = false;
    if (step.after.includes(old.id)) {
      step.after = [...new Set(step.after.map((id) => (id === old.id ? next.id : id)))];
      changed = true;
    }
    if (step.verifies === old.id) {
      step.verifies = next.id;
      changed = true;
      if (CHECKING_KINDS.has(step.kind) && (step.status === "done" || step.status === "blocked")) {
        const checked = lastAttempt(step);
        if (checked && !checked.decision) checked.decision = { by: "lead", how: "replaced", at: now, note: `The work it checked was replaced by step ${next.id}.` };
        step.status = "waiting";
        step.outcome = "unknown";
        step.progress = null;
        step.endedAt = null;
      }
    }
    if (changed) touch(draft, step);
  }
  return true;
}

/** Adds conflicts to a finished step's latest attempt (an artifact changed after its packet named it). */
export function raiseConflicts(draft: Draft, stepId: string, conflicts: readonly Conflict[]): boolean {
  const step = stepById(draft, stepId);
  const last = step && lastAttempt(step);
  if (!step || !last || step.status !== "done" || last.decision || !conflicts.length) return false;
  const known = new Set((last.conflicts ?? []).map((row) => `${row.ref}:${row.now}`));
  const fresh = conflicts.filter((row) => !known.has(`${row.ref}:${row.now}`));
  if (!fresh.length) return false;
  last.conflicts = [...(last.conflicts ?? []), ...fresh];
  touch(draft, step);
  return true;
}

/** Results the lead has not been given yet: attempts with a recorded result and no turn that carried it. */
export function unseen(steps: readonly Pick<StepState, "id" | "attempts">[]): Array<{ stepId: string; n: number }> {
  return steps.flatMap((step) => step.attempts.filter((row) => row.reportedAt && !row.deliveredAt).map((row) => ({ stepId: step.id, n: row.n })));
}

/** Marks every unseen result as carried by this turn of the lead (in the transaction that starts it). */
export function markDelivered(draft: Draft, turnId: string, now: string): Array<{ stepId: string; n: number }> {
  const carried = unseen(draft.steps);
  for (const { stepId, n } of carried) {
    const step = stepById(draft, stepId)!;
    const attempt = step.attempts.find((row) => row.n === n)!;
    attempt.deliveredAt = now;
    attempt.deliveredTo = turnId;
    touch(draft, step);
  }
  return carried;
}

/**
 * A working step that stopped moving (the watchdog): its worker is asked once to report (a nudge turn),
 * and if it still does not move, the attempt ends blocked, so the ladder takes it on. Each rung once per
 * attempt; null when neither applies.
 */
export function stallStep(draft: Draft, stepId: string, attempt: number, now: string, minutes: number): "nudge" | "block" | null {
  const step = stepById(draft, stepId);
  const last = step && lastAttempt(step);
  if (!step || !last || step.status !== "working" || step.attempt !== attempt || last.n !== attempt) return null;
  if (!step.nudged && !last.stall?.nudge) {
    last.stall = { ...last.stall, nudge: now };
    step.nudged = true;
    touch(draft, step);
    draft.effects.push({ kind: "turn", stepId: step.id, attempt: step.attempt, reason: "nudge" });
    return "nudge";
  }
  if (last.stall?.block) return null;
  last.stall = { ...last.stall, block: now };
  const summary = `No progress for ${minutes} minutes: nothing ran for this step and it was not reported.`;
  finish(draft, stepId, { status: "blocked", result: summary, report: { outcome: "blocked", summary, blockedBy: "no_progress" } }, now);
  return "block";
}

/** A failure's signature for the mission-wide rule: a failed check's, or a blocked result's words without numbers, paths or ids. */
function signatureOf(attempt: Attempt): string | null {
  if (attempt.signature) return attempt.signature;
  if (attempt.outcome === "blocked" || attempt.outcome === "unverified") {
    const words = normalise(attempt.summary ?? "");
    return words ? `blocked=${words}` : null;
  }
  return null;
}

/** Failures seen `min` times or more across a mission's steps, with the newest step that had it. */
export function sameErrors(steps: ReadonlyArray<Pick<StepState, "id" | "attempts">>, min: number): Array<{ signature: string; count: number; stepId: string }> {
  const seen = new Map<string, { count: number; stepId: string; at: string }>();
  for (const step of steps) {
    for (const attempt of step.attempts) {
      const signature = signatureOf(attempt);
      if (!signature) continue;
      const row = seen.get(signature) ?? { count: 0, stepId: step.id, at: "" };
      row.count += 1;
      if ((attempt.endedAt ?? "") >= row.at) {
        row.at = attempt.endedAt ?? "";
        row.stepId = step.id;
      }
      seen.set(signature, row);
    }
  }
  return [...seen.entries()].filter(([, row]) => row.count >= min).map(([signature, row]) => ({ signature, count: row.count, stepId: row.stepId }));
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

/** How a mission ended: a step a re-plan replaced does not count; a conflict left open, or nothing done, is not a success. */
export function finalStatus(steps: readonly StepState[]): MissionStatus {
  const counted = steps.filter((row) => !row.supersededBy);
  if (!counted.length) return "stopped";
  if (counted.every((row) => SATISFIED.has(row.outcome) && !openConflicts(row).length)) return "succeeded";
  if (counted.some((row) => row.outcome === "fail")) return "failed";
  if (counted.every((row) => row.status === "stopped")) return "stopped";
  return "partially_completed";
}

/** Whether a mission's status is final. */
export function missionEnded(status: string): boolean {
  return status === "succeeded" || status === "partially_completed" || status === "failed" || status === "stopped" || status === "done";
}

/** Statuses of a mission that still goes on (its card shows Stop). */
export const LIVE_MISSIONS = ["draft", "running", "replanning", "reporting"] as const;
