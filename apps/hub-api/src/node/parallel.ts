/**
 * Parallel work in one repository (ensemble-node docs/design B13, plan §9.3). The mission chooses how its
 * builds share its folder (`constraints.parallel`):
 *
 * - serial (the default): one checkout, used by one step at a time; the others wait their turn;
 * - worktrees: each build works in its own git worktree of the folder, on a local branch named by the
 *   mission, and its check runs there; an integration step merges (or rebases, or applies) them into the
 *   folder's current branch, and a check after it tests the integrated result;
 * - snapshots: the same with a detached worktree each (no branch); integration applies each one's changes.
 *
 * Pure: names, where each step works, what its packet says about it, and which passing checks a later
 * change in the same place no longer covers (`staleChecks`). Claims and the computer do the rest.
 */
import { truncateText } from "../lib/text.js";
import { integrateHow, type Constraints } from "./plan-contract.js";
import { candidateKey, type Candidate, type Check } from "./report.js";

export type ParallelMode = "serial" | "worktrees" | "snapshots";

export function parallelMode(constraints: Pick<Constraints, "parallel"> | null | undefined): ParallelMode {
  return constraints?.parallel ?? "serial";
}

type AttemptShape = { n: number; outcome: string; summary?: string | null; candidate?: Candidate; checks?: Check[]; endedAt: string | null };
type StepShape = { id: string; kind: string; handle: string; brief?: string; verifies?: string | null; integrates?: readonly string[] | null; outcome?: string; attempts?: readonly AttemptShape[] };
export type MissionShape = { missionId: string; constraints: Constraints; steps: readonly StepShape[] };

/** A git worktree a build works in: its directory's name (under the computer's workspace), its branch (none for a snapshot). */
export type Worktree = { name: string; branch: string | null; detached: boolean; of: string };
/** Where a step works: the folder's own checkout, or a build's worktree (`reuse`: a check of that build, in it). */
export type Workplace = { kind: "checkout" } | ({ kind: "worktree"; reuse: boolean } & Worktree);

const CHECKOUT: Workplace = { kind: "checkout" };

export function shortMission(missionId: string): string {
  return missionId.replace(/[^0-9a-z]/gi, "").slice(0, 8).toLowerCase();
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

/** The mission's branch as the start of a branch name git accepts, or "" when it names none. */
export function branchBase(branch: string | null | undefined): string {
  return (branch ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .split("/")
    .map((part) => part.replace(/^[.-]+/, "").replace(/(\.lock|\.)+$/i, ""))
    .filter(Boolean)
    .join("/")
    .slice(0, 120);
}

/**
 * A build's local branch: `<mission branch>-<mission>/<step>`, or `ensemble/<mission>/<step>` when the
 * mission names no branch. (Git cannot keep `<branch>/…` beside a branch called `<branch>`.)
 */
export function worktreeBranch(constraints: Pick<Constraints, "branch">, missionId: string, stepId: string): string {
  const base = branchBase(constraints.branch);
  return base ? `${base}-${shortMission(missionId)}/${stepId}` : `ensemble/${shortMission(missionId)}/${stepId}`;
}

/** The worktree's directory name on the computer (`<workspace>/worktrees/<name>`): the folder's name, the mission and the step. */
export function worktreeName(folder: string | null | undefined, missionId: string, stepId: string): string {
  const last = (folder ?? "").trim().replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
  return `${slug(last) || "folder"}-${shortMission(missionId)}-${slug(stepId) || "step"}`.slice(0, 100);
}

const integrating = (step: Pick<StepShape, "integrates">) => Boolean(step.integrates?.length);

/** A build that works apart: in worktrees or snapshots mode, every build but an integration step. */
export function worksApartStep(mission: Pick<MissionShape, "constraints">, step: Pick<StepShape, "kind" | "integrates">): boolean {
  return parallelMode(mission.constraints) !== "serial" && step.kind === "build" && !integrating(step);
}

/** The worktree of a build that works apart. */
export function worktreeOf(mission: Pick<MissionShape, "missionId" | "constraints">, step: Pick<StepShape, "id" | "kind" | "integrates">): Worktree | null {
  if (!worksApartStep(mission, step)) return null;
  const detached = parallelMode(mission.constraints) === "snapshots";
  return { name: worktreeName(mission.constraints.folder, mission.missionId, step.id), branch: detached ? null : worktreeBranch(mission.constraints, mission.missionId, step.id), detached, of: step.id };
}

/**
 * Where a step works. A build that works apart: its own worktree; a check of it: that worktree, as it
 * is. Everything else (serial work, an integration step and its check, writing): the folder's checkout.
 */
export function workplaceOf(mission: MissionShape, stepId: string): Workplace {
  const step = mission.steps.find((row) => row.id === stepId);
  if (!step || parallelMode(mission.constraints) === "serial") return CHECKOUT;
  const own = worktreeOf(mission, step);
  if (own) return { kind: "worktree", reuse: false, ...own };
  if (step.kind === "verify") {
    const target = mission.steps.find((row) => row.id === step.verifies);
    const theirs = target ? worktreeOf(mission, target) : null;
    if (theirs) return { kind: "worktree", reuse: true, ...theirs };
  }
  return CHECKOUT;
}

/** What a step reports or tested: the latest finished attempt's candidate. */
function latestCandidate(step: StepShape | undefined, outcomes: readonly string[] = ["done", "pass"]): { candidate: Candidate; attempt: AttemptShape } | null {
  const attempt = [...(step?.attempts ?? [])].reverse().find((row) => outcomes.includes(row.outcome) && row.candidate);
  return attempt?.candidate ? { candidate: attempt.candidate, attempt } : null;
}

function candidateWords(candidate: Candidate | undefined): string {
  if (!candidate) return "";
  if (candidate.commit) return `commit ${candidate.commit}`;
  if (candidate.contentHash) return `uncommitted changes (git tree ${candidate.contentHash})`;
  return candidate.url ?? "";
}

/** Two candidates are the same when their commits (or content hashes) are, a short commit matching its long form. */
export function sameCandidate(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x));
}

export type Place = {
  workplace: Workplace;
  /** The development-server port the step holds, when its mission builds in parallel. */
  port: number | null;
  /** Why it works in the checkout though the mission builds apart (an older computer). */
  note: string | null;
};

/** Lines for a packet's Constraints: where the step works and the port it may use. Nothing in serial work. */
export function placeLines(mission: MissionShape, step: Pick<StepShape, "id" | "kind">, place: Place | null | undefined): string[] {
  if (!place) return [];
  const lines: string[] = [];
  const where = place.workplace;
  const folder = mission.constraints.folder ?? "the folder";
  const commits = mission.constraints.publish !== "none";
  if (where.kind === "worktree" && !where.reuse) {
    lines.push(
      where.detached
        ? `- Where you work: your own detached copy of ${folder}, the git worktree “${where.name}” (no branch; Ensemble made it from the folder's last commit). Other builds work in their own copies. Do not make branches; ${commits ? "commit your work there (it stays detached)" : "leave your changes uncommitted there"}. An integration step applies them to ${folder}.`
        : `- Where you work: your own git worktree of ${folder}, “${where.name}”, on the local branch ${where.branch} (Ensemble made it from the folder's last commit). Other builds work in their own worktrees. ${commits ? "Commit your work on this branch" : "Leave your changes uncommitted here"}, never push it, and report subject with this branch${commits ? " and your commit" : ""}.`,
    );
  } else if (where.kind === "worktree") {
    const target = mission.steps.find((row) => row.id === where.of);
    lines.push(`- Where you check: ${target ? `@${target.handle}'s` : "the build's"} ${where.detached ? "detached copy" : "git worktree"} of ${folder}, “${where.name}”${where.branch ? ` on ${where.branch}` : ""}. Check exactly what is there; change nothing.`);
  }
  if (place.note) lines.push(`- ${place.note}`);
  if (place.port) lines.push(`- Port: if you start a development server, use port ${place.port}. Other steps of this plan work at the same time.`);
  return lines;
}

function rerunLines(mission: MissionShape, buildIds: readonly string[]): string[] {
  const lines: string[] = [];
  for (const check of mission.steps.filter((row) => row.kind === "verify" && row.verifies && buildIds.includes(row.verifies))) {
    const passed = [...(check.attempts ?? [])].reverse().find((row) => row.outcome === "pass" || row.outcome === "fail");
    for (const item of passed?.checks ?? []) {
      if (item.rerun) lines.push(`  - ${item.id ? `${item.id} ` : ""}${truncateText(item.name, 120)}: \`${truncateText(item.rerun.command, 200)}\``);
    }
  }
  return lines.slice(0, 12);
}

/**
 * What an integration step is told to do, by code: each build it brings in (its worktree or snapshot and
 * candidate, and how its check went), how to combine them as the mission says, what to run again, and
 * what to report.
 */
export function integrationPart(mission: MissionShape, step: Pick<StepShape, "id" | "integrates">): string {
  const ids = step.integrates ?? [];
  if (!ids.length) return "";
  const how = integrateHow(mission.constraints);
  const folder = mission.constraints.folder ?? "the folder";
  const target = mission.constraints.branch ? `${folder}'s current branch (${mission.constraints.branch})` : `${folder}'s current branch`;
  const lines = [`Bring the parallel builds into ${target}, one at a time:`];
  for (const id of ids) {
    const build = mission.steps.find((row) => row.id === id);
    if (!build) continue;
    const tree = worktreeOf(mission, build);
    const done = latestCandidate(build, ["done"]);
    const check = mission.steps.find((row) => row.kind === "verify" && row.verifies === id);
    const where = tree ? (tree.detached ? `the detached worktree “${tree.name}”` : `branch ${tree.branch} (worktree “${tree.name}”)`) : "its folder";
    const what = candidateWords(done?.candidate) || "no candidate reported";
    lines.push(`- @${build.handle}: ${where}, ${what}${check ? `; its check (@${check.handle}): ${check.outcome ?? "not run"}` : ""}.`);
  }
  lines.push(
    how === "merge"
      ? "How: merge each branch into the current branch (`git merge --no-ff <branch>`)."
      : how === "rebase"
        ? "How: replay each branch's commits onto the current branch, one branch at a time (`git cherry-pick <base>..<branch>`), keeping a straight history."
        : "How: apply each one's changes as a patch: in its worktree, `git add -A && git diff --cached --binary $(git merge-base HEAD <current branch>)`, then `git apply --3way` here.",
    ...(how === "patch" ? [] : ["A build whose branch has no new commit left its changes uncommitted in its worktree: apply those as a patch instead (`git add -A && git diff --cached --binary HEAD` there, `git apply --3way` here)."]),
    "The worktrees are on this computer: `git worktree list` shows where. In a fresh clone of the folder, fetch the branches from the remote named local first.",
    "Resolve conflicts so every build's work keeps working; never drop one side to make a conflict go away. Then run the checks again on the result.",
  );
  const reruns = rerunLines(mission, ids);
  if (reruns.length) lines.push(`Checks to run again:\n${reruns.join("\n")}`);
  lines.push(
    mission.constraints.publish === "none"
      ? "Leave the result uncommitted (the publish rule is nothing) and report `git write-tree` as contentHash in subject."
      : "Commit the result and report the integrated commit (and branch) as subject. Publish only as the constraints say; never push the builds' branches.",
  );
  return lines.join("\n");
}

export type Stale = { step: string; handle: string; candidate: string; at: string };

/**
 * Passing checks a later change no longer covers (plan §13: a candidate changed after a passing test):
 * a check that passed for one candidate, after which another step reported a different commit (or
 * content) in the same place (the checkout, or the same worktree). The earliest such report is named.
 */
export function staleChecks(mission: MissionShape): Map<string, Stale> {
  const stale = new Map<string, Stale>();
  const placeOf = (id: string) => {
    const where = workplaceOf(mission, id);
    return where.kind === "checkout" ? "checkout" : `worktree:${where.name}`;
  };
  for (const check of mission.steps) {
    if (check.kind !== "verify" || check.outcome !== "pass") continue;
    const passed = [...(check.attempts ?? [])].reverse().find((row) => row.outcome === "pass");
    if (!passed?.endedAt) continue;
    const target = mission.steps.find((row) => row.id === check.verifies);
    const told = [...(target?.attempts ?? [])].reverse().find((row) => row.outcome === "done" && row.candidate && row.endedAt && row.endedAt <= passed.endedAt!);
    const tested = candidateKey(passed.candidate) ?? candidateKey(told?.candidate);
    if (!tested) continue;
    const place = placeOf(check.id);
    let first: Stale | null = null;
    for (const other of mission.steps) {
      if (other.id === check.id || placeOf(other.id) !== place) continue;
      for (const attempt of other.attempts ?? []) {
        const key = candidateKey(attempt.candidate);
        if (!key || !attempt.endedAt || attempt.endedAt <= passed.endedAt || sameCandidate(key, tested)) continue;
        if (!first || attempt.endedAt < first.at) first = { step: other.id, handle: other.handle, candidate: key, at: attempt.endedAt };
      }
    }
    if (first) stale.set(check.id, first);
  }
  return stale;
}
