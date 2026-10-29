/**
 * The packet a coding agent gets for a plan step (ensemble-node docs/design B8, plan §8.4). Code
 * compiles it from the mission, so nothing is lost, repeated or invented between the owner's words and
 * the agent: the step's own part, every constraint exactly once, what came before as short results
 * with links, the run settings as facts, and how to report. No model writes it.
 */
import { truncateText } from "../lib/text.js";
import { renderConstraints } from "./plan-contract.js";
import type { AttemptReason } from "./missions-core.js";
import type { PlanData, PlanStep } from "./plans.js";
import type { Check } from "./report.js";

/** The longest prompt a session call takes (StartInput and SendInput in node/sessions.ts). */
export const PACKET_LIMIT = 6000;

export type PacketWho = {
  ownerName: string;
  node: { name: string; handle: string; role?: string | null };
  /** The run's agent and settings as Ensemble applies them. */
  settings?: { agent?: string | null; model?: string | null; effort?: string | null; context?: string | null } | null;
  /** Where the owner follows the plan (its room on the Node site): linked, never pasted. */
  planUrl?: string | null;
};

export type SectionName = "Goal" | "Your part" | "Constraints" | "Inputs" | "Settings" | "Who you are" | "Report";
export type Packet = { title: string; prompt: string; sections: Array<{ name: SectionName; text: string }> };

const KIND_WORD: Record<string, string> = { build: "Build", verify: "Check", write: "Write", research: "Research", other: "Work" };

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
  if (data.contract < 3 || reason === "nudge" || step.executor === "self" || !located(data)) return false;
  if (step.kind === "build" || step.kind === "write") return true;
  if (step.kind === "verify") {
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
  const word = reason === "repair" ? "Repair" : reason === "retest" ? "Retest" : (KIND_WORD[step.kind] ?? "Work");
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

function coverLines(data: PlanData, step: PlanStep): string[] {
  const lines: string[] = [];
  for (const requirement of data.requirements.filter((row) => step.requirementIds.includes(row.id))) {
    lines.push(`- ${requirement.id}: ${truncateText(oneLine(requirement.text), 400)}`);
    for (const item of requirement.acceptance) lines.push(`  - ${item.id}${item.mandatory ? " (must pass)" : ""}: ${truncateText(oneLine(item.text), 300)}`);
    if (requirement.evidence?.length) lines.push(`  - Evidence to attach: ${requirement.evidence.join(", ")}.`);
  }
  return lines;
}

function partSection(data: PlanData, step: PlanStep, reason: AttemptReason): string {
  const current = step.attempts.find((row) => row.n === step.attempt);
  const covers = coverLines(data, step);
  if (reason === "repair") {
    const verify = data.steps.find((row) => row.id === current?.forVerify);
    const failed = verify?.attempts.filter((row) => row.outcome === "fail").at(-1);
    const tested = candidateLine(failed?.candidate);
    return [
      `An independent check of your work FAILED. This is attempt ${step.attempt}: fix only what failed, and keep everything else as it is.`,
      failed?.summary ? `The checker reported: ${truncateText(oneLine(failed.summary), 1200)}` : "",
      checkLines(failed?.checks).length ? `Failing checks:\n${checkLines(failed?.checks).join("\n")}` : "",
      tested ? `Tested: ${tested}.` : "",
      `Your part as first given, for reference: ${truncateText(oneLine(step.brief), 900)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (reason === "retest") {
    const previous = step.attempts.filter((row) => row.n < step.attempt && row.outcome === "fail").at(-1);
    const target = data.steps.find((row) => row.id === step.verifies);
    const candidate = candidateLine(current?.candidate ?? target?.attempts.filter((row) => row.outcome === "done").at(-1)?.candidate);
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
  if (covers.length) lines.push(`\nIt covers:\n${covers.join("\n")}`);
  if (step.kind === "verify") {
    const target = data.steps.find((row) => row.id === step.verifies);
    const candidate = candidateLine(target?.attempts.filter((row) => row.outcome === "done").at(-1)?.candidate);
    lines.push(
      `\nYou check ${target ? `@${target.handle}'s work` : "the work"} independently${candidate ? `, at ${candidate}` : ""}. Do not fix what you test: report what fails and what you saw.`,
      covers.length ? "Report one check per acceptance criterion, named with its id." : "Report each check you ran, with its verdict.",
    );
  } else if (data.steps.some((row) => row.kind === "verify" && row.verifies === step.id)) {
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

const REPORT = [
  "When you finish, or cannot go on, call the Ensemble tool report_result once:",
  "- outcome: done (you built or wrote it), pass or fail (you checked something), or blocked (say why, with blockedBy).",
  "- summary: what changed and how you checked it.",
  "- subject: what you built or tested: repo, branch and commit; without a commit, `git write-tree` as contentHash.",
  "- checks: each check with its verdict (pass, fail, blocked, skipped), named with the acceptance criterion's id when there is one; a fail says what you saw; add rerun (command and expected result) when it can be run again.",
  "- evidence: attach screenshots, videos, logs or reports first with attach_evidence, then name their ids.",
  "Without the Ensemble tools, write the same JSON to .ensemble/result.json in your folder before you end.",
].join("\n");

function render(sections: Array<{ name: SectionName; text: string }>): string {
  return sections
    .filter((section) => section.text.trim())
    .map((section) => `## ${section.name}\n${section.text.trim()}`)
    .join("\n\n");
}

/**
 * Compiles a step's packet. It stays within PACKET_LIMIT: what came before shrinks first (it is
 * linked), then the step's own part; constraints, settings and the report rules are never cut.
 */
export function compilePacket(data: PlanData, step: PlanStep, reason: AttemptReason, who: PacketWho): Packet {
  const constraints = renderConstraints(data.constraints, { agentSettings: false });
  const sections: Array<{ name: SectionName; text: string }> = [
    { name: "Goal", text: goalSection(data, step) },
    { name: "Your part", text: partSection(data, step, reason) },
    { name: "Constraints", text: constraints || "None beyond your part." },
    { name: "Inputs", text: inputLines(data, step, who).join("\n") },
    { name: "Settings", text: settingsSection(who) },
    { name: "Who you are", text: whoSection(data, step, who) },
    { name: "Report", text: REPORT },
  ];
  let prompt = render(sections);
  const inputs = sections.find((section) => section.name === "Inputs")!;
  const part = sections.find((section) => section.name === "Your part")!;
  // Earlier results are linked from the plan: drop them, oldest first, before cutting the step's own part.
  while (prompt.length > PACKET_LIMIT && inputs.text) {
    const lines = inputs.text.split("\n");
    const linked = lines.filter((line) => line.startsWith("- The whole plan"));
    const others = lines.filter((line) => !line.startsWith("- The whole plan"));
    others.shift();
    inputs.text = [...others, ...linked].join("\n");
    if (!others.length) inputs.text = linked.join("\n");
    prompt = render(sections);
    if (!others.length) break;
  }
  if (prompt.length > PACKET_LIMIT) {
    part.text = truncateText(part.text, Math.max(500, part.text.length - (prompt.length - PACKET_LIMIT) - 20)) + " …";
    prompt = render(sections);
  }
  return { title: packetTitle(step, reason), prompt: truncateText(prompt, PACKET_LIMIT), sections };
}
