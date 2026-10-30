/**
 * The worker's own result (docs/30 §9): `report_result` and `attach_evidence` on the run's `ensemble`
 * MCP server reach these through `/api/engine/tool` with the run's secret, and a worker without them
 * writes `.ensemble/result.json`, read here when the run ends (`collectRunResult`). A report is
 * validated (its shape, and that the candidate it names exists in the folder) and kept on the job;
 * an attached file is judged like a read by the run's rules, checked and copied into the run's
 * evidence folder (evidence/files.ts).
 */
import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { savedSecretValues } from "../lib/run-secrets.js";
import { redactText } from "../lib/redact.js";
import { parseReport, StepReport, type Candidate } from "../node/report.js";
import { EVIDENCE_KINDS, type EvidenceKind } from "../remote/contract.js";
import { expandHome, gitHardening, jailPath, within } from "../workspace/guard.js";
import { runCommand } from "../workspace/runner.js";
import type { JobContext } from "../workspace/tools.js";
import { judgeEngineCall } from "../workspace/engines/judge.js";
import { attachEvidence, dropEmptyEvidenceDir, evidenceDir, EvidenceError, readEvidenceFile, unrecordedEvidence } from "./files.js";
import { EVIDENCE_MAX_BYTES, evidenceLimit, kindFor } from "./limits.js";

/** The run tools on the `ensemble` MCP server for a task run (not Chat). */
export const RUN_TOOLS = ["report_result", "attach_evidence"] as const;
export type RunTool = (typeof RUN_TOOLS)[number];

/** Where a worker without the run tools writes its report, in its folder. */
export const RESULT_FILE = ".ensemble/result.json";
const RESULT_FILE_BYTES = 256 * 1024;

/** A refusal the worker reads and can fix: the tool's answer, not a failure of the run. */
export class RunToolError extends Error {
  readonly statusCode = 400;
  readonly expose = true;
}

const AttachInput = z
  .object({
    path: z.string().trim().min(1).max(4096),
    kind: z.enum(EVIDENCE_KINDS),
    caption: z.string().max(300).optional(),
    requirementId: z.string().max(80).optional(),
  })
  .strict();

type RunCtx = Pick<JobContext, "prisma" | "job" | "userId" | "root" | "sandboxed" | "signal" | "event">;

const issues = (error: z.ZodError) => error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");

/** A report written by hand may name its commit or content hash at the top, as the brief lists them: they belong in `subject`. */
function withSubject(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { commit, contentHash, ...rest } = value as Record<string, unknown>;
  if (commit === undefined && contentHash === undefined) return value;
  const subject = rest.subject && typeof rest.subject === "object" && !Array.isArray(rest.subject) ? (rest.subject as Record<string, unknown>) : {};
  return { ...rest, subject: { ...(commit === undefined ? {} : { commit }), ...(contentHash === undefined ? {} : { contentHash }), ...subject } };
}

/** Every string in a report with key shapes and saved secret values hidden. */
function redactReport<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactReport(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactReport(item)])) as T;
  return value;
}

async function git(ctx: RunCtx, args: string[], write = false) {
  return runCommand({
    userId: ctx.userId,
    argv: ["git", ...gitHardening(false), ...args],
    cwd: ctx.root,
    root: ctx.root,
    sandboxed: ctx.sandboxed,
    network: false,
    useCredentials: false,
    who: "agent",
    readOnly: write ? [] : [ctx.root],
    readWrite: write ? [ctx.root] : [],
    timeoutMs: 60_000,
    signal: ctx.signal,
    group: ctx.job.id,
  });
}

/** The working tree as a git tree id, through a throwaway index (the real staging area is untouched). */
async function workingTreeHash(ctx: RunCtx): Promise<string | null> {
  const index = join(ctx.root, ".git", `ensemble-report-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  const run = (args: string[]) =>
    runCommand({
      userId: ctx.userId,
      argv: ["git", ...gitHardening(false), ...args],
      cwd: ctx.root,
      root: ctx.root,
      sandboxed: ctx.sandboxed,
      network: false,
      useCredentials: false,
      who: "agent",
      readWrite: [ctx.root],
      timeoutMs: 120_000,
      signal: ctx.signal,
      group: ctx.job.id,
      extraEnv: env,
    });
  try {
    await run(["read-tree", "HEAD"]);
    if ((await run(["add", "-A"])).exitCode !== 0) return null;
    const tree = await run(["write-tree"]);
    return tree.exitCode === 0 ? tree.output.trim() : null;
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
  }
}

/**
 * Why the candidate a report names cannot be found here, or null: its commit must be in the folder's
 * repository, and its content hash must be the working tree's (or the last commit's) git tree.
 */
export async function candidateProblem(ctx: RunCtx, subject: Candidate | undefined): Promise<string | null> {
  if (!subject || (!subject.commit && !subject.contentHash)) return null;
  if (!ctx.root) return "This run has no folder, so it cannot name a commit or content hash.";
  const repo = await lstat(join(ctx.root, ".git")).then(() => true, () => false);
  if (!repo) return "This folder is not a git repository: leave commit and contentHash out of subject.";
  if (subject.commit) {
    const commit = subject.commit.trim();
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) return `subject.commit must be a commit id (hex), not “${commit.slice(0, 80)}”.`;
    const found = await git(ctx, ["cat-file", "-e", `${commit}^{commit}`]);
    if (found.exitCode !== 0) return `Commit ${commit} is not in this folder's repository. Report the commit you made (git rev-parse HEAD), or leave it out.`;
  }
  if (subject.contentHash) {
    const wanted = subject.contentHash.trim().toLowerCase();
    const head = await git(ctx, ["rev-parse", "HEAD^{tree}"]);
    if (head.exitCode === 0 && head.output.trim().toLowerCase() === wanted) return null;
    const tree = await workingTreeHash(ctx);
    if (!tree) return "The working tree's content hash could not be worked out here; leave contentHash out.";
    if (tree.toLowerCase() !== wanted) return `subject.contentHash does not match the working tree (its git tree is ${tree}). Report that, or the commit you made.`;
  }
  return null;
}

/** Keeps a report on the job: the worker's own result, later sent with the run's end. */
async function saveReport(ctx: RunCtx, report: StepReport, via: "tool" | "file"): Promise<StepReport> {
  const clean = redactReport(report);
  await ctx.prisma.workspaceJob.update({ where: { id: ctx.job.id }, data: { report: clean as unknown as Prisma.InputJsonValue } });
  await ctx.event("report", { outcome: clean.outcome, checks: clean.checks?.length ?? 0, via });
  return clean;
}

async function reportResult(ctx: RunCtx, input: unknown): Promise<string> {
  const parsed = StepReport.safeParse(withSubject(input));
  if (!parsed.success) throw new RunToolError(`Not recorded: ${issues(parsed.error)}. Fix the report and call report_result again.`);
  const problem = await candidateProblem(ctx, parsed.data.subject);
  if (problem) throw new RunToolError(`Not recorded: ${problem}`);
  const saved = await saveReport(ctx, parsed.data, "tool");
  const checks = saved.checks?.length ?? 0;
  return `Recorded your result: ${saved.outcome}${checks ? `, with ${checks} check${checks === 1 ? "" : "s"}` : ""}. Calling report_result again replaces it. Finish with your short summary as usual.`;
}

/** A path the worker named, with its folder's links resolved and its own name kept (so a link there is still refused). */
async function namedPath(ctx: RunCtx, path: string): Promise<string> {
  const full = resolve(ctx.root || process.cwd(), expandHome(path));
  const folder = await realpath(dirname(full)).catch(() => null);
  if (!folder) throw new RunToolError(`${path} does not exist.`);
  return join(folder, basename(full));
}

async function attach(ctx: RunCtx, input: unknown): Promise<string> {
  const parsed = AttachInput.safeParse(input);
  if (!parsed.success) throw new RunToolError(`Not attached: ${issues(parsed.error)}.`);
  const path = await namedPath(ctx, parsed.data.path);
  const own = within(evidenceDir(ctx.job.id), path);
  // Read like any file the run reads: inside its folder freely, elsewhere by the run's rules (which may ask the person).
  if (!own && !(ctx.root && within(ctx.root, path))) {
    const verdict = await judgeEngineCall(ctx as JobContext, { tool: "Read", input: { file_path: path } });
    if (verdict.decision !== "allow") throw new RunToolError(`Not attached: ${verdict.message ?? "the run may not read that file."}`);
  }
  try {
    const row = await attachEvidence(ctx.prisma, { userId: ctx.userId, jobId: ctx.job.id, cwd: ctx.root, secrets: await savedSecretValues(ctx.prisma, ctx.userId) }, { path, kind: parsed.data.kind, caption: parsed.data.caption, requirementId: parsed.data.requirementId });
    await ctx.event("evidence", { id: row.id, name: row.name, kind: row.kind, size: row.size });
    const size = row.size >= 1024 * 1024 ? `${(row.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(row.size / 1024))} KB`;
    return `Attached “${row.name}” (${row.kind}, ${size}). Your owner sees it with this run's result; refer to it in report_result as evidence id ${row.id}.`;
  } catch (error) {
    if (error instanceof EvidenceError) throw new RunToolError(`Not attached: ${error.message}`);
    throw error;
  }
}

/** One run tool call from the run's MCP server; the text goes back to the agent. */
export async function runRunTool(ctx: JobContext, name: string, input: unknown): Promise<string> {
  if (name === "report_result") return reportResult(ctx, input);
  if (name === "attach_evidence") return attach(ctx, input);
  throw new RunToolError(`Unknown tool ${name}.`);
}

type ResultFile = { report: StepReport } | { problem: string } | null;

/**
 * `.ensemble/result.json` in the run's folder, if the worker wrote one during this run: read by
 * descriptor without following links, a regular file with one name, at most 256 KB, changed since `since`.
 */
export async function readResultFile(root: string, since: Date): Promise<ResultFile> {
  let path: string;
  try {
    path = await jailPath(root, RESULT_FILE);
  } catch {
    return { problem: `${RESULT_FILE} leads outside the folder through a link, so it was not read.` };
  }
  const before = await lstat(path).catch(() => null);
  if (!before) return null;
  if (!before.isFile()) return { problem: `${RESULT_FILE} is not a regular file, so it was not read.` };
  // A report from an earlier run in the same folder is not this run's.
  if (before.mtimeMs < since.getTime() - 2000) return null;
  if (before.size > RESULT_FILE_BYTES) return { problem: `${RESULT_FILE} is larger than 256 KB, so it was not read.` };
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return { problem: `${RESULT_FILE} could not be opened (it may be a link).` };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || opened.ino !== before.ino || opened.size > RESULT_FILE_BYTES) return { problem: `${RESULT_FILE} changed or is linked, so it was not read.` };
    const text = (await handle.readFile()).toString("utf8").slice(0, RESULT_FILE_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { problem: `${RESULT_FILE} is not valid JSON.` };
    }
    const parsed = StepReport.safeParse(withSubject(value));
    return parsed.success ? { report: parsed.data } : { problem: `${RESULT_FILE} is not a valid report: ${issues(parsed.error)}.` };
  } finally {
    await handle.close();
  }
}

/** The evidence kind for an evidence reference in a report, when it names a file. */
function refKind(kind: string): EvidenceKind | null {
  if (kind === "screenshot" || kind === "video" || kind === "report" || kind === "log" || kind === "file") return kind;
  if (kind === "evidence") return "file";
  return null;
}

/**
 * At the end of a run (agent.ts): without a report from the tool, the worker's `.ensemble/result.json`
 * is read and validated; the files it lists as evidence, and files left in the run's evidence folder,
 * are attached under the same checks. Problems are noted on the run, never fatal.
 */
export async function collectRunResult(ctx: RunCtx, since: Date): Promise<void> {
  if (!ctx.root) return;
  const stored = await ctx.prisma.workspaceJob.findUnique({ where: { id: ctx.job.id }, select: { report: true } });
  let fromFile: StepReport | null = null;
  if (!parseReport(stored?.report)) {
    const found = await readResultFile(ctx.root, since);
    if (found && "problem" in found) await ctx.event("report_refused", { problem: found.problem });
    if (found && "report" in found) {
      const problem = await candidateProblem(ctx, found.report.subject);
      if (problem) await ctx.event("report_refused", { problem: `${RESULT_FILE}: ${problem}` });
      else fromFile = await saveReport(ctx, found.report, "file");
    }
  }
  const secrets = await savedSecretValues(ctx.prisma, ctx.userId).catch(() => [] as string[]);
  // A report from the file names its files as evidence; one from the tool attached them itself.
  for (const ref of fromFile?.evidence ?? []) {
    const kind = refKind(ref.kind);
    if (!kind || /^[a-z][a-z0-9+.-]*:\/\//i.test(ref.ref)) continue;
    try {
      const path = await namedPath(ctx, ref.ref);
      if (!within(ctx.root, path) && !within(evidenceDir(ctx.job.id), path)) {
        const verdict = await judgeEngineCall(ctx as JobContext, { tool: "Read", input: { file_path: path } });
        if (verdict.decision !== "allow") throw new EvidenceError(verdict.message ?? "the run may not read that file");
      }
      const row = await attachEvidence(ctx.prisma, { userId: ctx.userId, jobId: ctx.job.id, cwd: ctx.root, secrets }, { path, kind, caption: ref.caption });
      await ctx.event("evidence", { id: row.id, name: row.name, kind: row.kind, size: row.size, via: "file" });
    } catch (error) {
      await ctx.event("evidence_refused", { ref: ref.ref.slice(0, 300), reason: error instanceof Error ? error.message.slice(0, 300) : "refused" });
    }
  }
  for (const path of await unrecordedEvidence(ctx.prisma, ctx.job.id).catch(() => [] as string[])) {
    try {
      const probe = await readEvidenceFile(path, { kind: "file", secrets, limit: EVIDENCE_MAX_BYTES });
      const kind = kindFor(probe.mime);
      if (probe.size > evidenceLimit(kind)) throw new EvidenceError(`${basename(path)} is larger than a ${kind} may be.`);
      const row = await attachEvidence(ctx.prisma, { userId: ctx.userId, jobId: ctx.job.id, cwd: ctx.root, secrets }, { path, kind });
      await ctx.event("evidence", { id: row.id, name: row.name, kind: row.kind, size: row.size, via: "folder" });
    } catch (error) {
      await ctx.event("evidence_refused", { ref: basename(path), reason: error instanceof Error ? error.message.slice(0, 300) : "refused" });
    }
  }
  await dropEmptyEvidenceDir(ctx.job.id);
}
