/**
 * What a worker reports at the end of a plan step (docs/35 §6.2; ensemble-node docs/design build
 * blocks B1, B7): one shape whether the step's node reports it (node_step_report), a coding agent
 * reports it through the run's MCP server (report_result) or writes it to .ensemble/result.json.
 *
 * Execution and result are separate: a run that finished may have failed its checks. The verdict
 * is computed here from the checks, never read from prose, so "pass" means every check passed. A
 * partial or uncertain result never counts as done.
 */
import { z } from "zod";

/** review: an independent check of another node's build or writing, with a verdict per acceptance criterion. */
export const STEP_KINDS = ["build", "verify", "review", "write", "research", "other"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Kinds that check another step's work: a failure sends that work back for repair, then they check again. */
export const CHECKING_KINDS: ReadonlySet<string> = new Set(["verify", "review"]);

/** What a worker may report. partial: part of it is done (`remaining` says what is left); uncertain: it ran, but whether it worked is not known; stopped: it was stopped. */
export const REPORT_OUTCOMES = ["done", "pass", "fail", "blocked", "partial", "stopped", "uncertain"] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

/** A step's result: unknown until reported; unverified when the worker never reported. */
export const STEP_OUTCOMES = ["unknown", "done", "pass", "fail", "blocked", "unverified", "partial", "uncertain", "stopped"] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

/** How strong a piece of evidence is: A a file or record made and measured now, B output seen in the session, C recollection. */
export const EVIDENCE_STRENGTHS = ["A", "B", "C"] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export const BLOCKED_BY = ["needs_owner", "login_required", "missing_access", "environment", "no_report", "no_progress", "unknown"] as const;
export type BlockedBy = (typeof BLOCKED_BY)[number];

export const Check = z
  .object({
    /** The acceptance criterion it covers, when the mission has ids for them. */
    id: z.string().trim().min(1).max(80).optional(),
    name: z.string().trim().min(1).max(200),
    verdict: z.enum(["pass", "fail", "blocked", "skipped"]),
    detail: z.string().max(2000).optional(),
    /** Evidence ids (an attached file's id) or references (a URL, a path in the run's evidence). */
    evidence: z.array(z.string().max(500)).max(20).optional(),
    /** How strong the evidence for this verdict is (A, B or C). A review's pass needs A or B. */
    strength: z.enum(EVIDENCE_STRENGTHS).optional(),
    /** How to run the check again without a model (checks as code). */
    rerun: z
      .object({
        command: z.string().min(1).max(2000),
        cwd: z.string().max(1000).optional(),
        expects: z.union([z.literal("exit_0"), z.object({ outputMatches: z.string().min(1).max(500) }).strict()]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Check = z.infer<typeof Check>;

/** What a build produced and a verification tested: a commit, or a content hash when nothing was committed. */
export const Candidate = z
  .object({
    repo: z.string().max(300).optional(),
    folder: z.string().max(300).optional(),
    branch: z.string().max(300).optional(),
    commit: z.string().max(80).optional(),
    contentHash: z.string().max(128).optional(),
    url: z.string().max(1000).optional(),
  })
  .strict();
export type Candidate = z.infer<typeof Candidate>;

export const EvidenceRef = z
  .object({
    kind: z.enum(["commit", "file", "url", "log", "screenshot", "video", "report", "evidence"]),
    ref: z.string().min(1).max(1000),
    caption: z.string().max(300).optional(),
    strength: z.enum(EVIDENCE_STRENGTHS).optional(),
  })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/** Who did the work: the agent and model as asked, as sent and as the agent reported it, where and in which session. The harness fills what it observed. */
export const Provenance = z
  .object({
    agent: z.string().max(80).optional(),
    modelRequested: z.string().max(120).optional(),
    modelSent: z.string().max(120).optional(),
    modelReported: z.string().max(120).optional(),
    computer: z.string().max(120).optional(),
    session: z.string().max(120).optional(),
  })
  .strict();
export type Provenance = z.infer<typeof Provenance>;

export const StepReport = z
  .object({
    outcome: z.enum(REPORT_OUTCOMES),
    summary: z.string().trim().min(1).max(2000),
    checks: z.array(Check).max(50).optional(),
    subject: Candidate.optional(),
    evidence: z.array(EvidenceRef).max(30).optional(),
    blockedBy: z.enum(BLOCKED_BY).optional(),
    /** What is left, in order (a partial or blocked result). */
    remaining: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    /** The one decision only the owner can make, when there is one. */
    ownerDecision: z.string().trim().min(1).max(500).optional(),
    provenance: Provenance.optional(),
  })
  .strict();
export type StepReport = z.infer<typeof StepReport>;

/**
 * The report format a computer's runtime takes from its workers (`capabilities.reports`): 2 is this one;
 * an older runtime validates the first (outcomes done, pass, fail, blocked; checks without strength) and
 * refuses any newer field, so its packets ask for the first only (node/packet.ts).
 */
export function reportFormatOf(capabilities: unknown): 1 | 2 {
  const value = capabilities && typeof capabilities === "object" && !Array.isArray(capabilities) ? (capabilities as { reports?: unknown }).reports : undefined;
  return typeof value === "number" && value >= 2 ? 2 : 1;
}

/** The report with `strength` on every check and evidence item that has none. */
export function withStrength(report: StepReport, strength: EvidenceStrength): StepReport {
  return {
    ...report,
    ...(report.checks ? { checks: report.checks.map((check) => (check.strength ? check : { ...check, strength })) } : {}),
    ...(report.evidence ? { evidence: report.evidence.map((item) => (item.strength ? item : { ...item, strength })) } : {}),
  };
}

/** Parses a stored or reported value; null when it is not a valid report. */
export function parseReport(value: unknown): StepReport | null {
  const parsed = StepReport.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type Verdict = { outcome: Exclude<StepOutcome, "unknown">; problem: string | null };

/**
 * The outcome a report earns for a step of this kind. A check (verify or review) passes only when it
 * has at least one check, every check passed and every mandatory criterion (by id) has a passing
 * check; a failing check makes it fail; a blocked or skipped check, or a missing mandatory one, blocks
 * it. A review also gives a verdict for every criterion it judges (`judged`), and each of its passes
 * rests on evidence of strength A or B. Other kinds finish (done) or are blocked; a builder's own
 * failing checks block it. Partial, uncertain and stopped are taken as reported and never count as done.
 * `problem` says why the reported outcome was not taken as given (shown to the worker, or recorded).
 */
export function verdictOf(kind: string, report: StepReport, mandatory: readonly string[] = [], judged: readonly string[] = []): Verdict {
  const checks = report.checks ?? [];
  const failing = checks.filter((check) => check.verdict === "fail");
  const open = checks.filter((check) => check.verdict === "blocked" || check.verdict === "skipped");
  const passed = new Set(checks.filter((check) => check.verdict === "pass" && check.id).map((check) => check.id!));
  const missing = mandatory.filter((id) => !passed.has(id));
  if (report.outcome === "stopped") return { outcome: "stopped", problem: null };
  if (CHECKING_KINDS.has(kind)) {
    if (report.outcome === "blocked") return { outcome: "blocked", problem: null };
    if (failing.length) {
      return { outcome: "fail", problem: report.outcome === "fail" ? null : `It reported ${report.outcome}, but ${failing.map((check) => `“${check.name}”`).join(", ")} failed.` };
    }
    if (report.outcome === "fail") return { outcome: "fail", problem: "A fail needs at least one failing check, named." };
    if (report.outcome === "partial" || report.outcome === "uncertain") return { outcome: report.outcome, problem: null };
    const review = kind === "review";
    const unjudged = review ? judged.filter((id) => !checks.some((check) => check.id === id)) : [];
    const weak = review ? checks.filter((check) => check.verdict === "pass" && check.strength !== "A" && check.strength !== "B") : [];
    if (report.outcome === "done") {
      return checks.length && !open.length && !missing.length && !unjudged.length && !weak.length
        ? { outcome: "pass", problem: null }
        : { outcome: "blocked", problem: `A ${review ? "review" : "verification"} reports pass, fail or blocked, with its checks.` };
    }
    if (!checks.length) return { outcome: "blocked", problem: "A pass needs at least one check." };
    if (open.length) return { outcome: "blocked", problem: `Not every check ran: ${open.map((check) => `“${check.name}” (${check.verdict})`).join(", ")}.` };
    if (missing.length) return { outcome: "blocked", problem: `No passing check for ${missing.map((id) => `“${id}”`).join(", ")}.` };
    if (unjudged.length) return { outcome: "blocked", problem: `A review gives a verdict for every acceptance criterion it judges: none for ${unjudged.map((id) => `“${id}”`).join(", ")}.` };
    if (weak.length) {
      return {
        outcome: "blocked",
        problem: `A review's pass rests on evidence of strength A (a file or record made and measured now) or B (output seen in this session), never C (recollection): ${weak.map((check) => `“${check.name}” (${check.strength ?? "no strength"})`).join(", ")}.`,
      };
    }
    return { outcome: "pass", problem: null };
  }
  if (report.outcome === "blocked") return { outcome: "blocked", problem: null };
  if (report.outcome === "partial" || report.outcome === "uncertain") return { outcome: report.outcome, problem: null };
  if (report.outcome === "fail" || failing.length) {
    return { outcome: "blocked", problem: report.outcome === "fail" ? null : `It reported ${report.outcome}, but its own check ${failing.map((check) => `“${check.name}”`).join(", ")} failed.` };
  }
  return { outcome: "done", problem: null };
}

/**
 * The failure's signature, for spotting the same failure again (B2): the failing checks' ids or names
 * with a normalised hash of their detail. It never includes the commit, so an identical failure on a
 * new commit has the same signature.
 */
export function failureSignature(report: StepReport): string {
  const parts = (report.checks ?? [])
    .filter((check) => check.verdict === "fail")
    .map((check) => `${(check.id ?? check.name).toLowerCase().trim()}=${normalise(check.detail ?? "")}`)
    .sort();
  return parts.length ? parts.join("|") : `summary=${normalise(report.summary)}`;
}

/** Text with volatile parts removed: paths, hashes, numbers, times and whitespace. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/(?:[a-z]:)?(?:[\\/][\w.@-]+)+/g, "<path>")
    .replace(/\b[0-9a-f]{7,64}\b/g, "<hash>")
    .replace(/\b\d{1,4}[-/:.]\d{1,2}(?:[-/:.]\d{1,4})*(?:[t ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?z?)?\b/g, "<time>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/** The identity of a candidate for progress detection: its commit, else its content hash. */
export function candidateKey(candidate: Candidate | undefined | null): string | null {
  if (!candidate) return null;
  return candidate.commit?.trim() || candidate.contentHash?.trim() || null;
}
