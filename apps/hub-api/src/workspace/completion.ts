/**
 * How a coding agent's run ended, with each state kept apart (docs/16 §9, docs/30 §9): the
 * conversation (the engine returned, failed or was stopped), files changed, checks passed, accepted
 * and a pull request opened. A finished conversation is not done work, and a check the agent says
 * passed is a claim: Ensemble runs each check's `rerun` command from report_result again, in the run's
 * folder, under the run's own rules (the hard floor, the folder policy and the mode's asks), one at a
 * time with a time limit each, with the PATH and HOME the agent's own commands had, and the checks
 * state is what those runs showed.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { parseReport, type Check, type StepReport } from "../node/report.js";
import { redactText } from "../lib/redact.js";
import { agentEnv } from "../subscriptions/detect.js";
import { expandHome, holdsProtected, jailPath, within } from "./guard.js";
import { judgeEngineCall } from "./engines/judge.js";
import { runCommand, type RunResult } from "./runner.js";
import type { ChangedFile } from "./changed-files.js";
import type { JobContext } from "./tools.js";

export const COMPLETION_SCHEMA = "ensemble.completion.v1";
/** One check's rerun stops here and counts as failed. */
export const CHECK_TIMEOUT_MS = 10 * 60_000;
/** The end of a check's output kept with its result. */
const OUTPUT_TAIL = 1500;

export type TestCounts = { total: number | null; passed: number | null; failed: number };

const int = (value: string | undefined) => (value === undefined ? null : Number.parseInt(value, 10));

/**
 * What a test runner's own summary says, when the output has one: TAP and node:test (`# fail 1`,
 * `ℹ fail 1`), Jest, Vitest, pytest, Mocha, cargo test and go test. A run can end with exit 0 and
 * still report failures (a pipe into `tee`, `|| true`): the summary decides then.
 */
export function testCounts(output: string): TestCounts | null {
  const text = output.replace(/\u001b\[[0-9;]*m/g, "");
  const last = (pattern: RegExp) => [...text.matchAll(pattern)].at(-1);
  const tap = { tests: last(/^(?:#|ℹ)\s*tests\s+(\d+)\s*$/gm), pass: last(/^(?:#|ℹ)\s*pass\s+(\d+)\s*$/gm), fail: last(/^(?:#|ℹ)\s*fail\s+(\d+)\s*$/gm) };
  if (tap.fail || tap.pass) return { total: int(tap.tests?.[1]), passed: int(tap.pass?.[1]), failed: int(tap.fail?.[1]) ?? 0 };
  const jest = last(/^Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:\d+ todo, )?(?:(\d+) passed, )?(\d+) total/gm);
  if (jest) return { total: int(jest[3]), passed: int(jest[2]) ?? 0, failed: int(jest[1]) ?? 0 };
  const vitest = last(/^\s*Tests\s+(?:(\d+) failed\s*\|\s*)?(?:(\d+) passed)?(?:\s*\|\s*\d+ skipped)?\s*\((\d+)\)/gm);
  if (vitest) return { total: int(vitest[3]), passed: int(vitest[2]) ?? 0, failed: int(vitest[1]) ?? 0 };
  const pytest = last(/^=+ (?:(\d+) failed)?(?:, )?(?:(\d+) passed)?.*? in [\d.]+s(?: \([^)]*\))? =+\s*$/gm);
  if (pytest && (pytest[1] || pytest[2])) return { total: null, passed: int(pytest[2]) ?? 0, failed: int(pytest[1]) ?? 0 };
  const cargo = last(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/gm);
  if (cargo) return { total: null, passed: int(cargo[1]), failed: int(cargo[2]) ?? 0 };
  const mochaFail = last(/^\s*(\d+) failing\s*$/gm);
  const mochaPass = last(/^\s*(\d+) passing\b/gm);
  if (mochaPass || mochaFail) return { total: null, passed: int(mochaPass?.[1]), failed: int(mochaFail?.[1]) ?? 0 };
  const goFails = text.match(/^--- FAIL: /gm)?.length ?? 0;
  if (goFails || /^(?:ok|FAIL)\s+\S+\s+[\d.]+s\s*$/m.test(text)) return { total: null, passed: null, failed: goFails || (/^FAIL\s/m.test(text) ? 1 : 0) };
  return null;
}

/** A pattern with a quantified group that itself repeats can take exponential time: matched as plain text instead. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*{]/;

/** Whether the output shows what a check expects: the pattern as a regular expression, or as text when it is not a safe one. */
export function outputShows(pattern: string, output: string): boolean {
  if (!NESTED_QUANTIFIER.test(pattern)) {
    try {
      return new RegExp(pattern, "m").test(output);
    } catch {
      // Not a regular expression: matched as text below.
    }
  }
  return output.includes(pattern);
}

type Expects = NonNullable<Check["rerun"]>["expects"];

/** The shell's line for a program it could not find (`sh: 1: cargo: not found`, PowerShell's "is not recognized"). */
const NOT_FOUND = /^.*(?:command not found|: not found|is not recognized as (?:the name of )?a cmdlet).*$/m;

/**
 * A rerun's verdict: what it expects, failures a test runner reported, and a time limit that ran out.
 * A program the shell did not find here (exit 127) says nothing about the agent's work: not run.
 */
export function rerunVerdict(result: Pick<RunResult, "exitCode" | "timedOut" | "killed" | "output">, expects: Expects): { verdict: "pass" | "fail" | "not_run"; reason: string | null; counts: TestCounts | null } {
  const counts = testCounts(result.output);
  if (result.timedOut) return { verdict: "fail", reason: `It did not finish within ${CHECK_TIMEOUT_MS / 60_000} minutes.`, counts };
  if (result.killed) return { verdict: "fail", reason: "It was stopped before it finished.", counts };
  if (counts && counts.failed > 0) return { verdict: "fail", reason: `${counts.failed} of ${counts.total ?? (counts.passed ?? 0) + counts.failed} tests failed${result.exitCode === 0 ? ", though the command exited 0" : ""}.`, counts };
  const missing = NOT_FOUND.exec(result.output)?.[0].trim();
  if (result.exitCode === 127 || (process.platform === "win32" && result.exitCode !== 0 && missing)) {
    return { verdict: "not_run", reason: `A program it needs was not found here${missing ? ` (${missing.slice(0, 200)})` : ` (exit ${result.exitCode})`}.`, counts };
  }
  if (expects === "exit_0") return result.exitCode === 0 ? { verdict: "pass", reason: null, counts } : { verdict: "fail", reason: `It exited ${result.exitCode}.`, counts };
  return outputShows(expects.outputMatches, result.output) ? { verdict: "pass", reason: null, counts } : { verdict: "fail", reason: "Its output did not show what the check expects.", counts };
}

export type CheckRun = {
  name: string;
  id: string | null;
  command: string;
  cwd: string | null;
  expects: Expects;
  /** What the agent said. */
  claimed: Check["verdict"];
  /** What Ensemble's run showed; `not_run` when the run's rules did not let it run (with why). */
  verdict: "pass" | "fail" | "not_run";
  reason: string | null;
  exitCode: number | null;
  ms: number;
  counts: TestCounts | null;
  output: string;
};

export type RerunOptions = {
  signal: AbortSignal;
  timeoutMs?: number;
  /** Each check's progress line. */
  progress?: (text: string) => Promise<void>;
  /** Saved secret values to hide in the output kept. */
  secrets?: readonly string[];
  /** Asked before each check: a reason to run no more (the owner discarded the turn's changes), else null. */
  stopped?: () => Promise<string | null>;
  /** Tests replace the judge and the command runner. */
  judge?: typeof judgeEngineCall;
  run?: typeof runCommand;
};

/** Variables that say where a toolchain lives, which the agent's commands had with its PATH. */
const TOOLCHAIN_ENV = ["CARGO_HOME", "RUSTUP_HOME", "PYENV_ROOT", "NVM_DIR", "PNPM_HOME", "BUN_INSTALL", "VOLTA_HOME", "DENO_INSTALL", "GOPATH", "GOROOT", "JAVA_HOME", "ASDF_DIR", "ASDF_DATA_DIR", "SDKMAN_DIR"];

/**
 * The PATH and HOME (and toolchain folders) the agent's own commands ran with (`agentEnv`), in place
 * of the fixed PATH and scratch HOME of Ensemble's own commands: `cargo test`, nvm's npm, pnpm, bun
 * and pyenv's python are found as the agent found them. Folders inside the run's folder are left out.
 */
export function agentCommandEnv(root: string, source: NodeJS.ProcessEnv = agentEnv()): Record<string, string> {
  const out: Record<string, string> = {};
  const path = (source.PATH ?? source.Path ?? "").split(delimiter).filter((dir) => dir && isAbsolute(dir) && !within(root, dir)).join(delimiter);
  if (path) out.PATH = path;
  out.HOME = source.HOME || homedir();
  if (process.platform === "win32" && source.USERPROFILE) out.USERPROFILE = source.USERPROFILE;
  for (const key of TOOLCHAIN_ENV) if (source[key]) out[key] = source[key]!;
  return out;
}

/**
 * Where a check runs again: the run's folder or a folder in it (never through a link out of it), or a
 * folder the run was already let into (its grants, read-only ones read-only). Never a folder that holds
 * keys, Ensemble's data or its code. Anything else is not run, with why.
 */
export async function rerunFolder(ctx: Pick<JobContext, "root" | "grants" | "readGrants" | "accessMode">, cwd: string | null): Promise<{ cwd: string; readWrite: string[]; readOnly: string[] } | { refused: string }> {
  const root = await realpath(ctx.root).catch(() => null);
  if (!root) return { refused: "The run's folder is gone." };
  const review = ctx.accessMode === "review";
  const full = resolve(root, expandHome(cwd ?? "."));
  let real: string;
  if (within(root, full)) {
    try {
      real = await jailPath(root, full, true);
    } catch (error) {
      return { refused: error instanceof Error ? error.message : String(error) };
    }
  } else {
    const found = await realpath(full).catch(() => null);
    if (!found) return { refused: `${cwd} does not exist.` };
    real = found;
  }
  if (holdsProtected(real)) return { refused: `${cwd} holds keys, sign-ins or Ensemble's own files.` };
  const own = { readWrite: review ? [] : [root], readOnly: review ? [root] : [] };
  if (within(root, real)) return { cwd: real, ...own };
  const covers = async (folders: readonly string[] | undefined) => {
    for (const folder of folders ?? []) {
      if (holdsProtected(folder)) continue;
      if (within(folder, real) || within(await realpath(folder).catch(() => folder), real)) return true;
    }
    return false;
  };
  if (!review && (await covers(ctx.grants))) return { cwd: real, readWrite: [...own.readWrite, real], readOnly: own.readOnly };
  if ((await covers(ctx.readGrants)) || (review && (await covers(ctx.grants)))) return { cwd: real, readWrite: own.readWrite, readOnly: [...own.readOnly, real] };
  return { refused: `${cwd} is outside the run's folder, and the run was not let into it.` };
}

/** The shell a check's command line runs in: the one the agent's own shell commands use here. */
function shellArgv(command: string): string[] {
  return process.platform === "win32" ? ["powershell", "-NoProfile", "-NonInteractive", "-Command", command] : ["sh", "-c", command];
}

function keep(output: string, secrets: readonly string[]): string {
  let text = redactText(output);
  for (const secret of secrets) if (secret.length >= 6) text = text.split(secret).join("[hidden]");
  return text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text;
}

/**
 * Runs each check of the report that has a `rerun` again, as the agent's own command would run: judged
 * first (refused by the hard floor, asked about where the mode asks), then in the run's folder or one it
 * was let into (`rerunFolder`), with the agent's PATH and HOME and a time limit each. Checks without a
 * rerun are listed as the agent's claims only; after a discard (`stopped`) no more are run.
 */
export async function rerunChecks(ctx: JobContext, report: StepReport, options: RerunOptions): Promise<CheckRun[]> {
  const judge = options.judge ?? judgeEngineCall;
  const run = options.run ?? runCommand;
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const engineEnv = agentCommandEnv(ctx.root);
  // The run's saved secrets, as the agent had them: never the keys no agent gets.
  const allowed = agentEnv(ctx.secretEnv ?? {});
  const extraEnv = Object.fromEntries(Object.entries(ctx.secretEnv ?? {}).filter(([key]) => allowed[key] !== undefined));
  const runs: CheckRun[] = [];
  let stop: string | null = null;
  for (const check of report.checks ?? []) {
    if (!check.rerun) continue;
    const base = { name: check.name, id: check.id ?? null, command: check.rerun.command, cwd: check.rerun.cwd ?? null, expects: check.rerun.expects, claimed: check.verdict, exitCode: null, ms: 0, counts: null, output: "" };
    stop ??= options.signal.aborted ? "The run was stopped before this check ran." : ((await options.stopped?.().catch(() => null)) ?? null);
    if (stop) {
      runs.push({ ...base, verdict: "not_run", reason: stop });
      continue;
    }
    const where = await rerunFolder(ctx, check.rerun.cwd ?? null);
    if ("refused" in where) {
      runs.push({ ...base, verdict: "not_run", reason: where.refused });
      continue;
    }
    await options.progress?.(`Checking: ${check.name}`.slice(0, 200));
    const answer = await judge(ctx, { tool: process.platform === "win32" ? "PowerShell" : "Bash", input: { command: check.rerun.command, ...(where.cwd !== ctx.root ? { cwd: where.cwd } : {}) }, signal: options.signal }).catch((error: unknown) => ({ decision: "deny" as const, message: error instanceof Error ? error.message : String(error) }));
    if (answer.decision !== "allow") {
      runs.push({ ...base, verdict: "not_run", reason: answer.message ?? "The run's rules did not let it run." });
      continue;
    }
    let result: RunResult;
    try {
      result = await run({
        userId: ctx.userId,
        argv: shellArgv(check.rerun.command),
        cwd: where.cwd,
        root: ctx.root,
        sandboxed: ctx.sandboxed,
        network: ctx.network,
        useCredentials: false,
        who: "agent",
        readOnly: where.readOnly,
        readWrite: where.readWrite,
        timeoutMs,
        signal: options.signal,
        group: ctx.job.id,
        extraEnv,
        engineEnv,
      });
    } catch (error) {
      runs.push({ ...base, verdict: "not_run", reason: `Ensemble could not start it here: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000) });
      continue;
    }
    const verdict = rerunVerdict(result, check.rerun.expects);
    runs.push({ ...base, verdict: verdict.verdict, reason: verdict.reason, exitCode: result.exitCode, ms: result.ms, counts: verdict.counts, output: keep(result.output, options.secrets ?? []) });
  }
  return runs;
}

export type ConversationState = "finished" | "failed" | "stopped" | "interrupted";
export type ChecksState = "none" | "passed" | "failed" | "unverified";
export type AcceptedState = "pending" | "accepted" | "rejected";
export type PullRequestState = "none" | "opened" | "merged";

export type Completion = {
  schema: typeof COMPLETION_SCHEMA;
  at: string;
  conversation: { state: ConversationState };
  files: { state: "none" | "changed"; count: number; added: number; removed: number };
  checks: { state: ChecksState; passed: number; failed: number; notRun: number; claimed: number; runs: CheckRun[] };
  accepted: { state: AcceptedState; by: "owner" | "reviewer" | null; at: string | null };
  pr: { state: PullRequestState; url: string | null; source: "ensemble" | "observed" | null };
  /** The agent's own report_result outcome, as it said it. */
  claim: { outcome: StepReport["outcome"] | null };
};

const CheckRunSchema = z.object({
  name: z.string().max(200),
  id: z.string().max(80).nullable(),
  command: z.string().max(2000),
  cwd: z.string().max(1000).nullable(),
  expects: z.union([z.literal("exit_0"), z.object({ outputMatches: z.string().max(500) })]),
  claimed: z.enum(["pass", "fail", "blocked", "skipped"]),
  verdict: z.enum(["pass", "fail", "not_run"]),
  reason: z.string().max(2000).nullable(),
  exitCode: z.number().int().nullable(),
  ms: z.number().min(0),
  counts: z.object({ total: z.number().int().nullable(), passed: z.number().int().nullable(), failed: z.number().int() }).nullable(),
  output: z.string().max(OUTPUT_TAIL + 10),
});

/** A completion record as a computer sends it with a run's end; the web keeps it on the run. */
export const CompletionSchema = z.object({
  schema: z.literal(COMPLETION_SCHEMA),
  at: z.string().max(40),
  conversation: z.object({ state: z.enum(["finished", "failed", "stopped", "interrupted"]) }),
  files: z.object({ state: z.enum(["none", "changed"]), count: z.number().int().min(0), added: z.number().int().min(0), removed: z.number().int().min(0) }),
  checks: z.object({ state: z.enum(["none", "passed", "failed", "unverified"]), passed: z.number().int().min(0), failed: z.number().int().min(0), notRun: z.number().int().min(0), claimed: z.number().int().min(0), runs: z.array(CheckRunSchema).max(50) }),
  accepted: z.object({ state: z.enum(["pending", "accepted", "rejected"]), by: z.enum(["owner", "reviewer"]).nullable(), at: z.string().max(40).nullable() }),
  pr: z.object({ state: z.enum(["none", "opened", "merged"]), url: z.string().max(2000).nullable(), source: z.enum(["ensemble", "observed"]).nullable() }),
  claim: z.object({ outcome: z.enum(["done", "pass", "fail", "blocked"]).nullable() }),
});

export function parseCompletion(value: unknown): Completion | null {
  const parsed = CompletionSchema.safeParse(value);
  return parsed.success ? (parsed.data as Completion) : null;
}

/** The run's states from its outcome, the files it changed, the agent's report, Ensemble's reruns and the pull request. */
export function completionOf(input: {
  outcome: "success" | "failed" | "cancelled" | "blocked" | "interrupted";
  files: readonly Pick<ChangedFile, "added" | "removed">[];
  report: StepReport | null;
  runs: CheckRun[];
  pr: Completion["pr"];
  now?: Date;
}): Completion {
  const conversation: ConversationState = input.outcome === "success" ? "finished" : input.outcome === "failed" ? "failed" : input.outcome === "interrupted" ? "interrupted" : "stopped";
  const passed = input.runs.filter((row) => row.verdict === "pass").length;
  const failed = input.runs.filter((row) => row.verdict === "fail").length;
  const notRun = input.runs.filter((row) => row.verdict === "not_run").length;
  const claimed = input.report?.checks?.length ?? 0;
  const unrunnable = claimed - input.runs.length;
  const checks: ChecksState = failed ? "failed" : passed && !notRun && !unrunnable ? "passed" : claimed ? "unverified" : "none";
  return {
    schema: COMPLETION_SCHEMA,
    at: (input.now ?? new Date()).toISOString(),
    conversation: { state: conversation },
    files: {
      state: input.files.length ? "changed" : "none",
      count: input.files.length,
      added: input.files.reduce((sum, file) => sum + (file.added || 0), 0),
      removed: input.files.reduce((sum, file) => sum + (file.removed || 0), 0),
    },
    checks: { state: checks, passed, failed, notRun, claimed, runs: input.runs },
    accepted: { state: "pending", by: null, at: null },
    pr: input.pr,
    claim: { outcome: input.report?.outcome ?? null },
  };
}

const PR_URL = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|gitlab\.[\w.-]+\/[\w./-]+?\/-\/merge_requests\/\d+)/;
const OPENS_PR = /\b(?:gh\s+pr\s+create|hub\s+pull-request|glab\s+mr\s+create|create_pull_request)\b/i;

/**
 * The run's pull request: one Ensemble opened or merged (its `pull_request` events, a computer's
 * result links), else one the run's own command opened, seen in that command's output. A link the
 * agent only wrote in its reply does not count.
 */
export async function pullRequestOf(db: Pick<PrismaClient, "workspaceEvent" | "runStep">, jobId: string, runId: string | null, results: unknown = null): Promise<Completion["pr"]> {
  const events = await db.workspaceEvent.findMany({ where: { jobId, kind: "pull_request" }, orderBy: { sequence: "desc" }, take: 5, select: { data: true } });
  for (const event of events) {
    const data = (event.data ?? {}) as { url?: unknown; state?: unknown };
    if (typeof data.url === "string") return { state: data.state === "merged" ? "merged" : "opened", url: data.url, source: "ensemble" };
  }
  const linked = Array.isArray(results) ? (results as Array<{ kind?: unknown; url?: unknown }>).find((row) => row.kind === "pr" && typeof row.url === "string") : undefined;
  if (linked) return { state: "opened", url: linked.url as string, source: "ensemble" };
  if (!runId) return { state: "none", url: null, source: null };
  const steps = await db.runStep.findMany({ where: { runId }, orderBy: { index: "asc" }, select: { toolCalls: true } });
  for (const step of steps) {
    for (const call of (Array.isArray(step.toolCalls) ? step.toolCalls : []) as Array<{ name?: unknown; args?: unknown; output?: unknown }>) {
      const args = typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? "");
      const output = typeof call.output === "string" ? call.output : JSON.stringify(call.output ?? "");
      if (!OPENS_PR.test(`${String(call.name ?? "")} ${args}`)) continue;
      const url = PR_URL.exec(output)?.[0];
      if (url) return { state: "opened", url, source: "observed" };
    }
  }
  return { state: "none", url: null, source: null };
}

/**
 * A Code tab turn's completion record, when its run ends: the agent's report (report_result, or
 * `.ensemble/result.json`), its checks run again here when the conversation finished, the files it
 * changed and its pull request. Each check's progress shows on the run, and its result is an event.
 */
export async function verifyCodeTurn(ctx: JobContext, input: { outcome: Parameters<typeof completionOf>[0]["outcome"]; files: readonly Pick<ChangedFile, "added" | "removed">[] }, options: Partial<RerunOptions> = {}): Promise<Completion> {
  const job = await ctx.prisma.workspaceJob.findUnique({ where: { id: ctx.job.id }, select: { report: true, results: true } });
  const report = parseReport(job?.report);
  const runs =
    report && input.outcome === "success"
      ? await rerunChecks(ctx, report, {
          signal: ctx.signal,
          progress: (text) => ctx.progress(text),
          secrets: Object.values(ctx.secretEnv ?? {}),
          stopped: async () => ((await acceptedOf(ctx.prisma, ctx.runId ?? null)) === "rejected" ? "The owner discarded the turn's changes before this check ran." : null),
          ...options,
        })
      : [];
  for (const run of runs) {
    await ctx.event("check_rerun", { name: run.name, id: run.id, command: run.command.slice(0, 500), claimed: run.claimed, verdict: run.verdict, exitCode: run.exitCode, ms: run.ms, reason: run.reason });
  }
  const pr = await pullRequestOf(ctx.prisma, ctx.job.id, ctx.runId ?? null, job?.results);
  return completionOf({ outcome: input.outcome, files: input.files, report, runs, pr });
}

type Db = PrismaClient | Prisma.TransactionClient;

/** The owner's or a reviewer's accept or discard kept on the run so far; "pending" when there is none. */
export async function acceptedOf(db: Db, runId: string | null): Promise<AcceptedState> {
  if (!runId) return "pending";
  const run = await db.run.findUnique({ where: { id: runId }, select: { completion: true } });
  const state = (run?.completion as { accepted?: { state?: unknown } } | null)?.accepted?.state;
  return state === "accepted" || state === "rejected" ? state : "pending";
}

/**
 * Keeps the run's completion record. An accept or discard that came while its checks ran again
 * (`markAccepted`) stays: both are one statement each, so neither writes over the other.
 */
export async function saveCompletion(db: Db, runId: string, completion: Completion): Promise<void> {
  const value = JSON.stringify(completion);
  await db.$executeRaw`
    UPDATE "runs" SET "completion" = CASE
      WHEN jsonb_typeof("completion") = 'object' AND "completion" -> 'accepted' ->> 'state' IN ('accepted', 'rejected')
        THEN jsonb_set(${value}::jsonb, '{accepted}', "completion" -> 'accepted')
      ELSE ${value}::jsonb
    END
    WHERE "id" = ${runId}`;
}

/**
 * The owner accepted or rejected the run's work (its review: accept or discard), or a reviewer did.
 * Kept on the run's completion record; a run from before records, or one still running its checks,
 * gets one that holds only this until its record is written.
 */
export async function markAccepted(db: Db, jobId: string, state: Exclude<AcceptedState, "pending">, by: "owner" | "reviewer", now = new Date()): Promise<boolean> {
  const job = await db.workspaceJob.findUnique({ where: { id: jobId }, select: { runId: true } });
  if (!job?.runId) return false;
  const accepted = JSON.stringify({ state, by, at: now.toISOString() });
  const empty = JSON.stringify({ schema: COMPLETION_SCHEMA });
  await db.$executeRaw`
    UPDATE "runs" SET "completion" =
      (CASE WHEN jsonb_typeof("completion") = 'object' THEN "completion" ELSE ${empty}::jsonb END) || jsonb_build_object('accepted', ${accepted}::jsonb)
    WHERE "id" = ${job.runId}`;
  return true;
}
