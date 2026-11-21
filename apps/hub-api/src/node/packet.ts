/**
 * The task packet a worker gets for a plan step (docs/35 §6.3; ensemble-node docs/design B8). Code
 * compiles it from the mission, so nothing is lost, repeated or invented between the owner's words and
 * the agent: a versioned header (which task, who asked, which role and instructions, what it works from
 * with hashes, the acceptance criteria with their proof, where it runs and where its result goes) and a
 * Markdown body (the step's own part, every constraint exactly once, what came before as short results
 * with links, the run settings as facts, and how to report). Each attempt's packet is stored on its step
 * (node_steps.packet); a later version names what changed and what stays, computed here by comparing the
 * two headers, never from anyone's summary. No model writes it.
 */
import { createHash } from "node:crypto";
import { assemble, renderSection, type SectionName as PromptSection } from "@ensemble/prompts";
import { truncateText } from "../lib/text.js";
import { renderConstraints } from "./plan-contract.js";
import type { AttemptReason, Conflict } from "./missions-core.js";
import { integrationPart, placeLines, sameCandidate, type Place } from "./parallel.js";
import type { PlanData, PlanStep } from "./plans.js";
import { candidateKey, CHECKING_KINDS, type Candidate, type Check } from "./report.js";

/** The longest prompt a session call takes (StartInput and SendInput in node/sessions.ts). */
export const PACKET_LIMIT = 6000;

/** The header's format: a reader that knows it can read every field below. */
export const PACKET_FORMAT = "ensemble.task/2" as const;

/** What a mission's steps work from (node_missions.artifacts): each ref with its current hash and the ones before. */
export type MissionArtifact = { ref: string; label?: string; hash: string | null; at: string; versions?: Array<{ hash: string | null; at: string }> };

/** An artifact as a packet names it. Authoritative: the step's result rests on this version, so a new one is a conflict. */
export type PacketArtifact = { ref: string; label?: string; hash: string | null; authoritative: boolean };
export type PacketAcceptance = { id: string; requirementId: string; text: string; proof: string | null; mandatory: boolean };
/** What started the mission: the owner's message (the lead's turn), a routine, a task on the room's board, or another person's request. */
export type PacketOrigin = { kind: "message" | "routine" | "task" | "peer"; id: string | null };

export type PacketHeader = {
  format: typeof PACKET_FORMAT;
  packetVersion: number;
  /** `<mission>/<step>`: the step is the task; its mission is its parent. */
  taskId: string;
  parentTaskId: string;
  rootTaskId: string;
  origin: PacketOrigin;
  role: { id: string; version: string };
  /** The version of the instruction sections the packet's fixed text comes from (@ensemble/prompts). */
  instructionVersion: string;
  kind: string;
  reason: AttemptReason;
  attempt: number;
  /** The step's own objective. */
  goal: string;
  artifacts: PacketArtifact[];
  constraints: string[];
  acceptance: PacketAcceptance[];
  /** The version this one follows (`<taskId>@v<n>`), with what changed and what stays. */
  amendmentOf: string | null;
  amendment: { changes: string[]; keeps: string[] } | null;
  provider: { agent: string | null; modelRequested: string | null; sessionId: string | null };
  target: { computerId: string | null; folder: string | null };
  returnChannel: { roomId: string; private: boolean };
  /** SHA-256 of the header without it and the body. */
  hash: string;
};

/** What node_steps.packet holds: the header and the prompt it went with. */
export type StoredPacket = { header: PacketHeader; title: string; prompt: string };

export type PacketWho = {
  ownerName: string;
  node: { name: string; handle: string; role?: string | null; templateId?: string | null; charter?: string | null };
  /** The run's agent and settings as Ensemble applies them. */
  settings?: { agent?: string | null; model?: string | null; effort?: string | null; context?: string | null } | null;
  /** Where the owner follows the plan (its room on the Node site): linked, never pasted. */
  planUrl?: string | null;
  /** Where the step works when its mission builds in parallel (B13): its worktree, its port. */
  place?: Place | null;
  /** What started the mission (node/plans.ts packetOrigin). */
  origin?: PacketOrigin;
  rootTaskId?: string;
  /** The agent session this attempt continues, and the computer and folder it runs in, when known. */
  sessionId?: string | null;
  computerId?: string | null;
  folder?: string | null;
  /** The mission's artifact registry. */
  artifacts?: readonly MissionArtifact[];
  /** The packet this step was given before: the new version's amendment is computed from it. */
  previous?: PacketHeader | null;
};

export type SectionName = "Changes" | "Goal" | "Your part" | "Constraints" | "Inputs" | "Settings" | "Who you are" | "Report" | "Task";
export type Packet = { title: string; prompt: string; sections: Array<{ name: SectionName; text: string }>; header: PacketHeader };

const KIND_WORD: Record<string, string> = { build: "Build", verify: "Check", review: "Review", write: "Write", research: "Research", other: "Work" };
const REASON_WORD: Partial<Record<AttemptReason, string>> = { repair: "Repair", retest: "Retest", amend: "Update", retry: "Retry" };

/** The mission says where the files are: a folder, or a repository. Without it, the step's node decides. */
function located(data: Pick<PlanData, "constraints">): boolean {
  const where = data.constraints ?? {};
  return Boolean(where.folder || where.repos?.length);
}

/**
 * Steps code hands straight to a coding agent: building, checking what was built, and writing files,
 * where the mission names the folder or repository. Research, other work, the node's own work and a
 * nudge are turns of their node.
 */
export function dispatchable(data: Pick<PlanData, "contract" | "constraints" | "steps">, step: Pick<PlanStep, "kind" | "executor" | "verifies">, reason: AttemptReason): boolean {
  if (data.contract < 3 || reason === "nudge" || step.executor !== "node" || !located(data)) return false;
  if (step.kind === "build" || step.kind === "write") return true;
  if (CHECKING_KINDS.has(step.kind)) {
    const target = data.steps.find((row) => row.id === step.verifies);
    return !target || target.kind === "build" || target.kind === "write";
  }
  return false;
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

function firstLine(value: string): string {
  const line = value.split(/\n|(?<=[.!?])\s/)[0] ?? value;
  return oneLine(line).replace(/[.:;,]$/, "");
}

/** The run card's title: what the agent does, in a few words. */
export function packetTitle(step: Pick<PlanStep, "kind" | "brief">, reason: AttemptReason): string {
  const word = REASON_WORD[reason] ?? KIND_WORD[step.kind] ?? "Work";
  const title = `${word}: ${firstLine(step.brief)}`;
  if (title.length <= 100) return title;
  const cut = truncateText(title, 99);
  const space = cut.lastIndexOf(" ");
  return `${space > 60 ? cut.slice(0, space) : cut}…`;
}

function checkLines(checks: readonly Check[] | undefined, verdicts: ReadonlySet<string> = new Set(["fail", "blocked", "skipped"])): string[] {
  return (checks ?? [])
    .filter((check) => verdicts.has(check.verdict))
    .map((check) => `- ${check.verdict.toUpperCase()}${check.id ? ` ${check.id}` : ""} ${oneLine(check.name)}${check.detail ? `: ${truncateText(oneLine(check.detail), 400)}` : ""}${check.rerun ? ` (re-run: \`${truncateText(check.rerun.command, 200)}\`)` : ""}`);
}

function candidateLine(candidate: { commit?: string; branch?: string; contentHash?: string; url?: string; folder?: string } | undefined): string {
  if (!candidate) return "";
  if (candidate.commit) return `commit ${candidate.commit}${candidate.branch ? ` on ${candidate.branch}` : ""}`;
  if (candidate.contentHash) return `the working tree with git tree ${candidate.contentHash}${candidate.folder ? ` in ${candidate.folder}` : ""}`;
  return candidate.url ?? "";
}

function goalSection(data: PlanData, step: PlanStep): string {
  const covered = data.requirements.filter((row) => step.requirementIds.includes(row.id)).map((row) => row.text);
  return truncateText(oneLine(data.goal ?? covered.join("; ") ?? "") || firstLine(step.brief), 400);
}

/** The acceptance criteria a step answers to: a check's are those it judges (its `acceptanceIds`, else all of its requirements'). */
export function acceptanceOf(data: Pick<PlanData, "requirements">, step: Pick<PlanStep, "requirementIds" | "acceptanceIds">): PacketAcceptance[] {
  const only = step.acceptanceIds?.length ? new Set(step.acceptanceIds) : null;
  return data.requirements
    .filter((row) => step.requirementIds.includes(row.id))
    .flatMap((row) =>
      row.acceptance.filter((item) => !only || only.has(item.id)).map((item) => ({ id: item.id, requirementId: row.id, text: truncateText(oneLine(item.text), 300), proof: item.proof ?? null, mandatory: item.mandatory !== false })),
    );
}

function acceptanceLine(item: PacketAcceptance): string {
  const notes = [item.mandatory ? "must pass" : "", item.proof ? `proof: ${item.proof}` : ""].filter(Boolean).join("; ");
  return `${item.id}${notes ? ` (${notes})` : ""}: ${item.text}`;
}

function coverLines(data: PlanData, step: PlanStep): string[] {
  const lines: string[] = [];
  const only = step.acceptanceIds?.length ? new Set(step.acceptanceIds) : null;
  for (const requirement of data.requirements.filter((row) => step.requirementIds.includes(row.id))) {
    lines.push(`- ${requirement.id}: ${truncateText(oneLine(requirement.text), 400)}`);
    for (const item of acceptanceOf({ requirements: [requirement] }, { requirementIds: [requirement.id], acceptanceIds: only ? [...only] : [] })) lines.push(`  - ${acceptanceLine(item)}`);
    if (requirement.evidence?.length) lines.push(`  - Evidence to attach: ${requirement.evidence.join(", ")}.`);
  }
  return lines;
}

/** The candidate a check or review works on: its attempt's own (a retest), else the checked step's latest finished one. */
function checkedCandidate(data: Pick<PlanData, "steps">, step: PlanStep): Candidate | undefined {
  const current = step.attempts.find((row) => row.n === step.attempt);
  const target = data.steps.find((row) => row.id === step.verifies);
  return current?.candidate ?? target?.attempts.filter((row) => row.outcome === "done").at(-1)?.candidate;
}

/** Commands that ran checks on this work before (its builder's own, earlier checks and reviews of it): a review runs them again. */
export function rerunLines(data: Pick<PlanData, "steps">, step: Pick<PlanStep, "verifies">): string[] {
  const target = data.steps.find((row) => row.id === step.verifies);
  if (!target) return [];
  const sources = [target, ...data.steps.filter((row) => CHECKING_KINDS.has(row.kind) && row.verifies === target.id)];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const source of sources) {
    for (const attempt of [...source.attempts].reverse()) {
      for (const check of attempt.checks ?? []) {
        if (!check.rerun || seen.has(check.rerun.command)) continue;
        seen.add(check.rerun.command);
        const expects = check.rerun.expects === "exit_0" ? "exit 0" : `output matching ${truncateText(check.rerun.expects.outputMatches, 80)}`;
        lines.push(`- \`${truncateText(check.rerun.command, 200)}\`${check.rerun.cwd ? ` in ${truncateText(check.rerun.cwd, 120)}` : ""}, expecting ${expects} (${check.id ? `${check.id} ` : ""}${truncateText(oneLine(check.name), 80)}, from @${source.handle})`);
      }
    }
  }
  return lines.slice(0, 12);
}

/**
 * A review's part, written by code: what it reviews and at which candidate, each acceptance id to judge
 * with its proof, and the commands that checked it before, to run again. Also a review step's update
 * when its node takes the turn (node/plans.ts stepNote).
 */
export function reviewPart(data: PlanData, step: PlanStep, reason: AttemptReason): string {
  const target = data.steps.find((row) => row.id === step.verifies);
  const candidate = candidateLine(checkedCandidate(data, step));
  const criteria = acceptanceOf(data, step);
  const previous = step.attempts.filter((row) => row.n < step.attempt && row.outcome === "fail").at(-1);
  const reruns = rerunLines(data, step);
  return [
    reason === "retest"
      ? `The work you reviewed was repaired. Review the new candidate${candidate ? `: ${candidate}` : ""}, and judge every criterion again.`
      : `You review ${target ? `@${target.handle}'s ${target.kind}` : "the work"} independently${candidate ? `, at ${candidate}` : ""}. Its builder's report and green tests are input, not proof.`,
    reason === "retest" && checkLines(previous?.checks).length ? `What failed last time:\n${checkLines(previous?.checks).join("\n")}` : "",
    criteria.length ? `Judge each of these, one check each named with its id:\n${criteria.map((item) => `- ${acceptanceLine(item)}`).join("\n")}` : "Judge the work against its brief, one check per thing you judged.",
    reruns.length ? `Run these again yourself:\n${reruns.join("\n")}` : "",
    reason === "retest" ? `Your part as first given, for reference: ${truncateText(oneLine(step.brief), 900)}` : truncateText(step.brief.trim(), 1500),
  ]
    .filter(Boolean)
    .join("\n");
}

function partSection(data: PlanData, step: PlanStep, reason: AttemptReason): string {
  const current = step.attempts.find((row) => row.n === step.attempt);
  const covers = coverLines(data, step);
  if (step.kind === "review" && reason !== "repair") return reviewPart(data, step, reason);
  if (reason === "repair") {
    const verify = data.steps.find((row) => row.id === current?.forVerify);
    const failed = verify?.attempts.filter((row) => row.outcome === "fail").at(-1);
    const tested = candidateLine(failed?.candidate);
    return [
      `An independent ${verify?.kind === "review" ? "review" : "check"} of your work FAILED. This is attempt ${step.attempt}: fix only what failed, and keep everything else as it is.`,
      failed?.summary ? `The ${verify?.kind === "review" ? "reviewer" : "checker"} reported: ${truncateText(oneLine(failed.summary), 1200)}` : "",
      checkLines(failed?.checks).length ? `Failing checks:\n${checkLines(failed?.checks).join("\n")}` : "",
      tested ? `Tested: ${tested}.` : "",
      `Your part as first given, for reference: ${truncateText(oneLine(step.brief), 900)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (reason === "retest") {
    const previous = step.attempts.filter((row) => row.n < step.attempt && row.outcome === "fail").at(-1);
    const candidate = candidateLine(checkedCandidate(data, step));
    return [
      `The work you checked was repaired. Check the new candidate${candidate ? `: ${candidate}` : ""}.`,
      "Run the same checks again (re-run each one you recorded), plus anything the repair could have broken. It passes only if every check passes. Do not fix what you test.",
      checkLines(previous?.checks).length ? `What failed last time:\n${checkLines(previous?.checks).join("\n")}` : "",
      covers.length ? `Acceptance criteria:\n${covers.join("\n")}` : "",
      `Your part as first given, for reference: ${truncateText(oneLine(step.brief), 900)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const lines = [truncateText(step.brief.trim(), 1500)];
  if (step.integrates?.length) lines.push(`\n${integrationPart(data, step)}`);
  if (covers.length) lines.push(`\nIt covers:\n${covers.join("\n")}`);
  if (step.kind === "verify") {
    const target = data.steps.find((row) => row.id === step.verifies);
    const candidate = candidateLine(checkedCandidate(data, step));
    lines.push(
      `\nYou check ${target ? `@${target.handle}'s work` : "the work"} independently${candidate ? `, at ${candidate}` : ""}. Do not fix what you test: report what fails and what you saw.`,
      covers.length ? "Report one check per acceptance criterion, named with its id." : "Report each check you ran, with its verdict.",
    );
  } else if (data.steps.some((row) => CHECKING_KINDS.has(row.kind) && row.verifies === step.id)) {
    lines.push("\nAn independent check follows your work. Make it checkable: commit it (unless the constraints say not to) and say how to run it.");
  }
  return lines.join("\n");
}

function inputLines(data: PlanData, step: PlanStep, who: PacketWho): string[] {
  const ids = new Set(step.after);
  if (step.verifies) ids.add(step.verifies);
  const lines: string[] = [];
  for (const row of data.steps.filter((candidate) => ids.has(candidate.id))) {
    const done = row.attempts.filter((attempt) => attempt.outcome === "done" || attempt.outcome === "pass").at(-1);
    const where = candidateLine(done?.candidate);
    const summary = done?.summary ?? row.result;
    lines.push(`- @${row.handle} (${row.kind}, ${row.outcome}): ${summary ? truncateText(oneLine(summary), 500) : "no report"}${where ? ` [${where}]` : ""}`);
  }
  if (who.planUrl) lines.push(`- The whole plan, with every step's report: ${who.planUrl}`);
  return lines;
}

function settingsSection(who: PacketWho): string {
  const settings = who.settings;
  if (!settings) return "";
  const parts = [settings.agent, settings.model ? `model ${settings.model}` : "", settings.effort ? `${settings.effort} thinking` : "", settings.context === "long_context" ? "long context" : ""].filter(Boolean);
  return parts.length ? `Ensemble started you with ${parts.join(", ")}. These are applied: do not check or change them.` : "";
}

function whoSection(data: PlanData, step: PlanStep, who: PacketWho): string {
  const index = data.steps.findIndex((row) => row.id === step.id);
  const where = data.kind === "self" ? "its own work" : `step ${index + 1} of ${data.steps.length} of a plan led by @${data.leadHandle}`;
  return [
    `You are the coding agent for ${who.ownerName}, working through their Ensemble node @${who.node.handle}${who.node.role ? ` (${oneLine(who.node.role)})` : ""} on ${where}.`,
    "Other agents may be working on other steps at the same time: stay within your part and do not undo their changes.",
    `For a decision only ${who.ownerName} can make, ask with the ask_person tool; decide everything else yourself and say what you decided in your report.`,
  ].join(" ");
}

/** The instruction sections a packet's fixed text comes from. */
function packetRules(step: Pick<PlanStep, "kind">): PromptSection[] {
  return step.kind === "review" ? ["node/85-task-review", "node/84-task-report"] : ["node/84-task-report"];
}

/** The version of those sections: the header's instructionVersion. */
export function instructionVersionOf(step: Pick<PlanStep, "kind">): string {
  return assemble({ surface: "node", sections: packetRules(step).map((name) => ({ name, tier: "volatile" as const })) }).version;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** JSON with sorted keys and no undefined values: the same header always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The step's latest finished candidate (a build's, a writing's), as an artifact key. */
function latestKey(step: Pick<PlanStep, "attempts"> | undefined): string | null {
  const done = step?.attempts.filter((row) => (row.outcome === "done" || row.outcome === "pass") && row.candidate).at(-1);
  return candidateKey(done?.candidate);
}

/**
 * What a step works from, with hashes: every artifact of the mission (authoritative), the candidate a
 * check or review works on (authoritative: its verdict is about that version), and what the steps before
 * it left (for information).
 */
export function artifactsFor(data: Pick<PlanData, "steps">, step: PlanStep, registry: readonly MissionArtifact[] = []): PacketArtifact[] {
  const list: PacketArtifact[] = registry.map((row) => ({ ref: row.ref, ...(row.label ? { label: row.label } : {}), hash: row.hash, authoritative: true }));
  if (CHECKING_KINDS.has(step.kind) && step.verifies) {
    const target = data.steps.find((row) => row.id === step.verifies);
    if (target) list.push({ ref: `candidate:${target.id}`, label: `@${target.handle}'s ${target.kind}`, hash: candidateKey(checkedCandidate(data, step)), authoritative: true });
  }
  for (const id of step.after) {
    if (id === step.verifies) continue;
    const row = data.steps.find((candidate) => candidate.id === id);
    const key = latestKey(row);
    if (row && key) list.push({ ref: `candidate:${row.id}`, label: `@${row.handle}'s ${row.kind}`, hash: key, authoritative: false });
  }
  return list.slice(0, 40);
}

/**
 * Conflicts: authoritative artifacts a packet named whose hash is different now (a new version in the
 * mission's registry, or a newer candidate of the work a check judged). Each holds the step's acceptance
 * until its lead or owner resolves it.
 */
export function conflictsOf(header: Pick<PacketHeader, "artifacts"> | null | undefined, registry: readonly MissionArtifact[], data: { steps: ReadonlyArray<Pick<PlanStep, "id" | "attempts">> }, now: string): Conflict[] {
  if (!header) return [];
  const conflicts: Conflict[] = [];
  for (const item of header.artifacts) {
    if (!item.authoritative || !item.hash) continue;
    const current = item.ref.startsWith("candidate:") ? latestKey(data.steps.find((row) => row.id === item.ref.slice("candidate:".length))) : (registry.find((row) => row.ref === item.ref)?.hash ?? null);
    if (current && !sameCandidate(current, item.hash)) conflicts.push({ ref: item.ref, ...(item.label ? { label: item.label } : {}), was: item.hash, now: current, at: now });
  }
  return conflicts;
}

const REASON_WORDS: Record<AttemptReason, string> = {
  first: "first attempt",
  repair: "a repair after a failed check",
  retest: "a retest of repaired work",
  nudge: "asked to report",
  amend: "an update: what it works from changed",
  retry: "tried again, as your owner or lead decided",
};

const short = (hash: string | null) => (hash ? hash.slice(0, 12) : "none");

function labelOf(line: string): string {
  const text = line.replace(/^-\s*/, "");
  const colon = text.indexOf(":");
  return colon > 0 && colon <= 30 ? text.slice(0, colon) : text;
}

/**
 * What changed from one version of a step's packet to the next and what stays, by comparing the two
 * headers field by field. The lead's or a worker's words are never used.
 */
export function amendmentBetween(previous: PacketHeader, next: Omit<PacketHeader, "hash" | "amendment" | "amendmentOf" | "packetVersion" | "format">): { changes: string[]; keeps: string[] } {
  const changes: string[] = [];
  const keeps: string[] = [];
  if (previous.attempt !== next.attempt || previous.reason !== next.reason) changes.push(`Attempt ${next.attempt}: ${REASON_WORDS[next.reason]} (version ${previous.packetVersion} was attempt ${previous.attempt}, ${REASON_WORDS[previous.reason]}).`);
  if (previous.goal !== next.goal) changes.push(`Your part: was “${truncateText(previous.goal, 200)}”; now “${truncateText(next.goal, 200)}”.`);
  else keeps.push("your part");

  const before = new Map(previous.constraints.map((line) => [labelOf(line), line]));
  const after = new Map(next.constraints.map((line) => [labelOf(line), line]));
  const keptRules: string[] = [];
  for (const [label, line] of after) {
    const old = before.get(label);
    if (old === undefined) changes.push(`New constraint: ${line.replace(/^-\s*/, "")}`);
    else if (old !== line) changes.push(`Constraint changed: ${line.replace(/^-\s*/, "")} (was: ${old.replace(/^-\s*/, "")})`);
    else keptRules.push(label);
  }
  for (const [label, line] of before) if (!after.has(label)) changes.push(`Constraint removed: ${line.replace(/^-\s*/, "")}`);
  if (keptRules.length) keeps.push(`constraints (${keptRules.map((label) => truncateText(label, 40)).join(", ")})`);

  const was = new Map(previous.acceptance.map((item) => [item.id, item]));
  const now = new Map(next.acceptance.map((item) => [item.id, item]));
  const keptCriteria: string[] = [];
  for (const [id, item] of now) {
    const old = was.get(id);
    if (!old) changes.push(`New acceptance criterion ${acceptanceLine(item)}`);
    else if (old.text !== item.text || old.proof !== item.proof || old.mandatory !== item.mandatory) changes.push(`Acceptance criterion changed: ${acceptanceLine(item)} (was: ${acceptanceLine(old)})`);
    else keptCriteria.push(id);
  }
  for (const [id] of was) if (!now.has(id)) changes.push(`Acceptance criterion ${id} no longer applies to this step.`);
  if (keptCriteria.length) keeps.push(`acceptance ${keptCriteria.join(", ")}`);

  const oldArtifacts = new Map(previous.artifacts.map((item) => [item.ref, item]));
  const newArtifacts = new Map(next.artifacts.map((item) => [item.ref, item]));
  const keptArtifacts: string[] = [];
  for (const [ref, item] of newArtifacts) {
    const old = oldArtifacts.get(ref);
    const name = item.label ?? ref;
    if (!old) changes.push(`New input: ${name}${item.hash ? ` (${short(item.hash)})` : ""}.`);
    else if ((old.hash ?? null) !== (item.hash ?? null)) changes.push(`${name} changed: ${short(old.hash)} is now ${short(item.hash)}.`);
    else keptArtifacts.push(name);
  }
  for (const [ref, item] of oldArtifacts) if (!newArtifacts.has(ref)) changes.push(`${item.label ?? ref} is no longer an input.`);
  if (keptArtifacts.length) keeps.push(`inputs ${keptArtifacts.map((name) => truncateText(name, 60)).join(", ")}`);

  if (previous.provider.agent !== next.provider.agent || previous.provider.modelRequested !== next.provider.modelRequested) {
    changes.push(`Agent: ${[next.provider.agent, next.provider.modelRequested].filter(Boolean).join(", ") || "its node's choice"} (was ${[previous.provider.agent, previous.provider.modelRequested].filter(Boolean).join(", ") || "its node's choice"}).`);
  } else if (previous.provider.agent || previous.provider.modelRequested) keeps.push("the agent and model");
  if (previous.provider.sessionId && previous.provider.sessionId === next.provider.sessionId) keeps.push("the same agent session");
  if (previous.target.computerId !== next.target.computerId || previous.target.folder !== next.target.folder) changes.push(`Where it runs: ${next.target.folder ?? "its node's choice"}${next.target.computerId ? ` on ${next.target.computerId}` : ""}.`);
  else keeps.push("where it runs");
  if (previous.returnChannel.roomId !== next.returnChannel.roomId || previous.returnChannel.private !== next.returnChannel.private) changes.push("Its result goes to a different conversation.");
  return { changes, keeps };
}

function render(sections: Array<{ name: SectionName; text: string }>): string {
  return sections
    .filter((section) => section.text.trim())
    .map((section) => `## ${section.name}\n${section.text.trim()}`)
    .join("\n\n");
}

/**
 * The header as the prompt carries it: which task and version this is, where it comes from, and what it
 * rests on. What the body already says (the part, constraints, criteria, agent, place) is stored, not repeated.
 */
function embedded(header: PacketHeader): string {
  const compact = {
    format: header.format,
    packetVersion: header.packetVersion,
    taskId: header.taskId,
    parentTaskId: header.parentTaskId,
    rootTaskId: header.rootTaskId,
    origin: header.origin,
    role: header.role,
    instructionVersion: header.instructionVersion,
    kind: header.kind,
    reason: header.reason,
    attempt: header.attempt,
    acceptance: header.acceptance.map((item) => item.id),
    artifacts: header.artifacts.filter((item) => item.authoritative).map((item) => ({ ref: truncateText(item.ref, 200), hash: item.hash })),
    amendmentOf: header.amendmentOf,
    hash: header.hash,
  };
  return `\`\`\`json ensemble-task\n${JSON.stringify(compact)}\n\`\`\``;
}

/** The "Changes" section of a later version: what changed since the last one, and what stays. */
function changesSection(header: Pick<PacketHeader, "packetVersion" | "amendment">): string {
  if (!header.amendment || header.packetVersion < 2) return "";
  return [
    `This is version ${header.packetVersion} of this task. Since version ${header.packetVersion - 1}:`,
    ...header.amendment.changes.map((line) => `- ${line}`),
    header.amendment.keeps.length ? `Unchanged: ${header.amendment.keeps.join("; ")}. Keep the work that rests on them as it is.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The header fields that come from the mission and the worker, before versioning and hashing. */
function headerOf(data: PlanData, step: PlanStep, reason: AttemptReason, who: PacketWho, constraints: string): Omit<PacketHeader, "hash" | "amendment" | "amendmentOf" | "packetVersion" | "format"> {
  const role = [who.node.role ?? "", who.node.charter ?? ""].join("\n");
  const run = step.run ?? {};
  return {
    taskId: `${data.missionId}/${step.id}`,
    parentTaskId: data.missionId,
    rootTaskId: who.rootTaskId ?? data.missionId,
    origin: who.origin ?? { kind: data.routine ? "routine" : "message", id: data.routine?.id ?? data.leadTurnId },
    role: { id: who.node.templateId ?? `node:${who.node.handle}`, version: sha256(role).slice(0, 12) },
    instructionVersion: instructionVersionOf(step),
    kind: step.kind,
    reason,
    attempt: step.attempt,
    goal: truncateText(oneLine(step.brief), 400),
    artifacts: artifactsFor(data, step, who.artifacts ?? []),
    constraints: constraints.split("\n").filter((line) => line.trim()),
    acceptance: acceptanceOf(data, step),
    provider: { agent: run.agent ?? data.constraints.agent ?? null, modelRequested: run.model ?? data.constraints.model ?? null, sessionId: who.sessionId ?? null },
    target: { computerId: who.computerId ?? data.constraints.computer ?? null, folder: who.folder ?? data.constraints.folder ?? null },
    returnChannel: { roomId: data.originRoomId, private: data.originPrivate },
  };
}

/**
 * Compiles a step's packet: its header (versioned after `who.previous`, with the amendment computed from
 * it, and hashed) and its prompt. The prompt stays within PACKET_LIMIT: what came before shrinks first
 * (it is linked), then the step's own part; the changes, constraints, settings, report rules and header
 * are never cut.
 */
export function compilePacket(data: PlanData, step: PlanStep, reason: AttemptReason, who: PacketWho): Packet {
  const constraints = [renderConstraints(data.constraints, { agentSettings: false }), ...placeLines(data, step, who.place)].filter(Boolean).join("\n");
  const fields = headerOf(data, step, reason, who, constraints);
  const previous = who.previous ?? null;
  const packetVersion = (previous?.packetVersion ?? 0) + 1;
  const amendment = previous ? amendmentBetween(previous, fields) : null;
  const base = { format: PACKET_FORMAT, packetVersion, ...fields, amendmentOf: previous ? `${previous.taskId}@v${previous.packetVersion}` : null, amendment };
  const sections: Array<{ name: SectionName; text: string }> = [
    { name: "Changes", text: changesSection(base) },
    { name: "Goal", text: goalSection(data, step) },
    { name: "Your part", text: partSection(data, step, reason) },
    { name: "Constraints", text: constraints || "None beyond your part." },
    { name: "Inputs", text: inputLines(data, step, who).join("\n") },
    { name: "Settings", text: settingsSection(who) },
    { name: "Who you are", text: whoSection(data, step, who) },
    { name: "Report", text: packetRules(step).map((name) => renderSection(name)).join("\n") },
  ];
  // The header block's size, before its hash is known (a hash is always 64 characters).
  const room = PACKET_LIMIT - embedded({ ...base, hash: "0".repeat(64) }).length - "\n\n## Task\n".length;
  let body = render(sections);
  const inputs = sections.find((section) => section.name === "Inputs")!;
  const part = sections.find((section) => section.name === "Your part")!;
  // Earlier results are linked from the plan: drop them, oldest first, before cutting the step's own part.
  while (body.length > room && inputs.text) {
    const lines = inputs.text.split("\n");
    const linked = lines.filter((line) => line.startsWith("- The whole plan"));
    const others = lines.filter((line) => !line.startsWith("- The whole plan"));
    others.shift();
    inputs.text = [...others, ...linked].join("\n");
    if (!others.length) inputs.text = linked.join("\n");
    body = render(sections);
    if (!others.length) break;
  }
  if (body.length > room) {
    part.text = truncateText(part.text, Math.max(500, part.text.length - (body.length - room) - 20)) + " …";
    body = render(sections);
  }
  body = truncateText(body, room);
  const header: PacketHeader = { ...base, hash: sha256(`${canonical(base)}\n${body}`) };
  const task = { name: "Task" as const, text: embedded(header) };
  return { title: packetTitle(step, reason), prompt: `${body}\n\n## Task\n${task.text}`, sections: [...sections.filter((section) => section.text.trim()), task], header };
}

/** A stored packet (node_steps.packet), or null when there is none or it is from before packets were versioned. */
export function storedPacket(value: unknown): StoredPacket | null {
  const row = value as Partial<StoredPacket> | null;
  return row && typeof row === "object" && row.header?.format === PACKET_FORMAT && typeof row.prompt === "string" ? (row as StoredPacket) : null;
}

/** Lines that tell a node which version of its step's task this is, and what changed (its step's update). */
export function versionLines(header: PacketHeader): string[] {
  if (header.packetVersion < 2 || !header.amendment) return [];
  return [changesSection(header)];
}
