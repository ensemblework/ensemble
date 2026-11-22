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
import { parseReport, REPORT_OUTCOMES, type Check, type StepReport } from "../node/report.js";
import { redactText } from "../lib/redact.js";
import { agentEnv } from "../subscriptions/detect.js";
import { acceptanceFolder, isCheckCommand, type AcceptanceCheck } from "./acceptance-checks.js";
import { expandHome, holdsProtected, jailPath, within } from "./guard.js";
import { judgeEngineCall } from "./engines/judge.js";
import { runCommand, type RunResult } from "./runner.js";
import type { ChangedFile } from "./changed-files.js";
import { askPerson, RUN_RULE_SOURCE, type JobContext } from "./tools.js";

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

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
/** Marks a reporter puts before a line (`# pass 4` in TAP, `ℹ pass 4` in Node's spec reporter, `✔`, `•`, `-`, `>`). */
const LEAD = /^[\s#ℹ✔✖✓✗×•·▶▸→>*\uFE0F-]+/u;

/** A line as no particular reporter prints it: no colours, no leading marks, one space between words, lower case. */
export function plainLine(line: string): string {
  return line.replace(ANSI, "").replace(LEAD, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const quoted = (text: string) => JSON.stringify(text.length > 200 ? `${text.slice(0, 199)}…` : text);

/** `want` in `text`, a number at either end of it whole: `pass 4` is not in `pass 40`. */
function holds(text: string, want: string): boolean {
  const digitAt = (index: number) => /\d/.test(text.charAt(index));
  for (let at = text.indexOf(want); at >= 0; at = text.indexOf(want, at + 1)) {
    if (/^\d/.test(want) && digitAt(at - 1)) continue;
    if (/\d$/.test(want) && digitAt(at + want.length)) continue;
    return true;
  }
  return false;
}

/** Characters that make what a check expects a regular expression rather than plain text. */
const PATTERN = /[\\^$|?*+()[\]{}]/;

/**
 * Whether the output shows what a check expects, leniently: as plain lines (`plainLine`), numbers whole,
 * on one line of the output or across them; else, when it is written as one, as a regular expression.
 * When it does not, the line it comes closest to: the same words with other numbers in it (`pass 3` for
 * `pass 4`), else the output's last line.
 */
export function outputMatch(expected: string, output: string): { shown: true } | { shown: false; saw: string | null } {
  const want = expected.split(/\r?\n/).map(plainLine).filter(Boolean).join(" ");
  if (!want) return { shown: true };
  const lines = output.split(/\r?\n/).map((line) => ({ raw: line.replace(ANSI, "").trim(), plain: plainLine(line) })).filter((line) => line.plain);
  if (lines.some((line) => holds(line.plain, want)) || holds(lines.map((line) => line.plain).join(" "), want)) return { shown: true };
  if (PATTERN.test(expected) && outputShows(expected, output)) return { shown: true };
  const shape = (text: string) => text.replace(/\d+(?:[.,]\d+)*/g, "0");
  return { shown: false, saw: (lines.find((line) => shape(line.plain).includes(shape(want))) ?? lines.at(-1))?.raw ?? null };
}

/** A test runner a check's command runs: its output depends on its reporter (TAP, spec, dots), its exit code does not. */
const TEST_RUNNERS = [
  /\b(?:node|tsx|bun|deno)\b[^;&|]*\s--test\b/,
  /\b(?:bun|deno)\s+test\b/,
  /\b(?:npm|pnpm|yarn|bun)\b(?:\s+--?[\w-]+(?:[= ][^\s;&|-]\S*)?)*\s+(?:run\s+)?(?:test|t)(?:[:-][\w:-]*)?(?=\s|$)/,
  /\b(?:pytest|py\.test)\b|\bpython3?\s+-m\s+pytest\b/,
  /\bcargo\s+(?:\+\S+\s+)?(?:test|nextest)\b/,
  /\bgo\s+test\b/,
  /\b(?:vitest|jest|mocha)\b/,
];

export function isTestRunner(command: string): boolean {
  return command.split(/&&|\|\||[;|\n]/).some((part) => TEST_RUNNERS.some((runner) => runner.test(part)));
}

/** The shell's line for a program it could not find (`sh: 1: cargo: not found`, PowerShell's "is not recognized"). */
const NOT_FOUND = /^.*(?:command not found|: not found|is not recognized as (?:the name of )?a cmdlet).*$/m;

export type CheckVerdict = "pass" | "fail" | "not_run" | "uncertain";

/**
 * A rerun's verdict. The exit code decides, with a test runner's own count of failures (a run can exit 0
 * and still report failures: a pipe into `tee`, `|| true`) and a time limit that ran out. A program the
 * shell did not find here (exit 127) says nothing about the agent's work: not run. What the output should
 * show is compared leniently (`outputMatch`), never for a test runner (`isTestRunner`), and a difference
 * after exit 0 makes the check uncertain, not failed.
 */
export function rerunVerdict(result: Pick<RunResult, "exitCode" | "timedOut" | "killed" | "output">, expects: Expects, command = ""): { verdict: CheckVerdict; reason: string | null; counts: TestCounts | null } {
  const counts = testCounts(result.output);
  if (result.timedOut) return { verdict: "fail", reason: `It did not finish within ${CHECK_TIMEOUT_MS / 60_000} minutes.`, counts };
  if (result.killed) return { verdict: "fail", reason: "It was stopped before it finished.", counts };
  if (counts && counts.failed > 0) return { verdict: "fail", reason: `${counts.failed} of ${counts.total ?? (counts.passed ?? 0) + counts.failed} tests failed${result.exitCode === 0 ? ", though the command exited 0" : ""}.`, counts };
  const missing = NOT_FOUND.exec(result.output)?.[0].trim();
  if (result.exitCode === 127 || (process.platform === "win32" && result.exitCode !== 0 && missing)) {
    return { verdict: "not_run", reason: `A program it needs was not found here${missing ? ` (${missing.slice(0, 200)})` : ` (exit ${result.exitCode})`}.`, counts };
  }
  if (result.exitCode !== 0) return { verdict: "fail", reason: `It exited ${result.exitCode}.`, counts };
  if (expects === "exit_0") return { verdict: "pass", reason: null, counts };
  if (isTestRunner(command)) return { verdict: "pass", reason: "Its output was not compared: a test runner's exit code decides.", counts };
  const match = outputMatch(expects.outputMatches, result.output);
  if (match.shown) return { verdict: "pass", reason: null, counts };
  return { verdict: "uncertain", reason: `Output differed: expected ${quoted(expects.outputMatches)}, saw ${match.saw ? quoted(match.saw) : "no output"}.`, counts };
}

export type CheckRun = {
  name: string;
  id: string | null;
  command: string;
  cwd: string | null;
  expects: Expects;
  /** What the agent said. */
  claimed: Check["verdict"];
  /**
   * What Ensemble's run showed; `not_run` when it could not run here (with why); `uncertain` when it
   * exited 0 but its output did not show what the agent said it would.
   */
  verdict: CheckVerdict;
  reason: string | null;
  exitCode: number | null;
  ms: number;
  /** `acceptance`: a command the task's or plan step's acceptance criteria name, run whether or not the agent reported it. */
  from?: "acceptance";
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
  /** The commands the run's task or plan step names in its acceptance criteria, run after the reported checks. */
  acceptance?: readonly AcceptanceCheck[];
  /** Tests replace the judge, the owner's card and the command runner. */
  judge?: typeof judgeEngineCall;
  ask?: typeof askPerson;
  run?: typeof runCommand;
};

/** The owner's card for the commands a task's criteria name: one per run, "Allow for this run" covers them all. */
export const ACCEPTANCE_TOOL = "run checks";
const NOT_A_CHECK = "Ensemble runs only a task's test, lint, build or typecheck commands, written plainly, as its checks; this one was not run.";
const DENIED = "You did not let Ensemble run the checks this task names.";
const UNANSWERED = "Nobody answered whether Ensemble may run the checks this task names.";

/** The owner's answer to running the commands a task's criteria name: an answer kept for this run, else one card for all of them. */
async function ownerAllows(ctx: JobContext, commands: readonly string[], options: RerunOptions): Promise<"allow" | "deny" | "expired"> {
  const rule = ctx.prisma
    ? await ctx.prisma.decisionRule.findFirst({ where: { userId: ctx.userId, source: RUN_RULE_SOURCE, sessionId: ctx.job.id, toolName: ACCEPTANCE_TOOL }, orderBy: { createdAt: "desc" } }).catch(() => null)
    : null;
  if (rule) return rule.decision === "deny" ? "deny" : "allow";
  await options.progress?.("Waiting for you: run this task's checks");
  const ask = options.ask ?? askPerson;
  const title = `Run this task's checks: ${commands.join(" · ")}`;
  const answer = await ask(ctx, { event: "permission", toolName: ACCEPTANCE_TOOL, title: title.length > 200 ? `${title.slice(0, 199)}…` : title, command: commands.join("\n") }).catch(() => ({ decision: "expired" as const, answer: null }));
  return answer.decision;
}

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
 * was let into (`rerunFolder`), with the agent's PATH and HOME and a time limit each. Then the commands
 * the task's or plan step's acceptance criteria name (`acceptance`), each once: one the agent's own
 * check already ran in the same folder is not run twice. Checks without a rerun are listed as the
 * agent's claims only; after a discard (`stopped`) no more are run.
 */
export async function rerunChecks(ctx: JobContext, report: StepReport | null, options: RerunOptions): Promise<CheckRun[]> {
  const judge = options.judge ?? judgeEngineCall;
  const run = options.run ?? runCommand;
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const engineEnv = agentCommandEnv(ctx.root);
  // The run's saved secrets, as the agent had them: never the keys no agent gets.
  const allowed = agentEnv(ctx.secretEnv ?? {});
  const extraEnv = Object.fromEntries(Object.entries(ctx.secretEnv ?? {}).filter(([key]) => allowed[key] !== undefined));
  const runs: CheckRun[] = [];
  const ran = new Set<string>();
  let stop: string | null = null;
  const once = async (base: Omit<CheckRun, "verdict" | "reason">, judgeCtx: JobContext = ctx): Promise<CheckRun> => {
    stop ??= options.signal.aborted ? "The run was stopped before this check ran." : ((await options.stopped?.().catch(() => null)) ?? null);
    if (stop) return { ...base, verdict: "not_run", reason: stop };
    const where = await rerunFolder(ctx, base.cwd);
    if ("refused" in where) return { ...base, verdict: "not_run", reason: where.refused };
    ran.add(`${where.cwd}\0${base.command.replace(/\s+/g, " ").trim()}`);
    await options.progress?.(`Checking: ${base.name}`.slice(0, 200));
    const answer = await judge(judgeCtx, { tool: process.platform === "win32" ? "PowerShell" : "Bash", input: { command: base.command, ...(where.cwd !== ctx.root ? { cwd: where.cwd } : {}) }, signal: options.signal }).catch((error: unknown) => ({ decision: "deny" as const, message: error instanceof Error ? error.message : String(error) }));
    if (answer.decision !== "allow") return { ...base, verdict: "not_run", reason: answer.message ?? "The run's rules did not let it run." };
    let result: RunResult;
    try {
      result = await run({
        userId: ctx.userId,
        argv: shellArgv(base.command),
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
      return { ...base, verdict: "not_run", reason: `Ensemble could not start it here: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000) };
    }
    const verdict = rerunVerdict(result, base.expects, base.command);
    return { ...base, verdict: verdict.verdict, reason: verdict.reason, exitCode: result.exitCode, ms: result.ms, counts: verdict.counts, output: keep(result.output, options.secrets ?? []) };
  };
  for (const check of report?.checks ?? []) {
    if (!check.rerun) continue;
    runs.push(await once({ name: check.name, id: check.id ?? null, command: check.rerun.command, cwd: check.rerun.cwd ?? null, expects: check.rerun.expects, claimed: check.verdict, exitCode: null, ms: 0, counts: null, output: "" }));
  }
  const planned: Array<Omit<CheckRun, "verdict" | "reason">> = [];
  for (const check of options.acceptance ?? []) {
    const cwd = await acceptanceFolder(ctx.root, check.folder);
    const where = await rerunFolder(ctx, cwd);
    if (!("refused" in where) && ran.has(`${where.cwd}\0${check.command.replace(/\s+/g, " ").trim()}`)) continue;
    const claimed = report?.checks?.find((row) => row.id === check.id)?.verdict ?? "skipped";
    planned.push({ name: check.text.slice(0, 200), id: check.id, command: check.command, cwd, expects: "exit_0", claimed, exitCode: null, ms: 0, counts: null, output: "", from: "acceptance" });
  }
  // Text anyone could have written: each command is held to the check forms again here, and the owner allows them
  // on one card unless the run is unattended. Once allowed they run as in Review only; a read-only run stays read-only.
  const runnable = planned.filter((row) => isCheckCommand(row.command));
  let judgeCtx = ctx;
  let refused: string | null = null;
  if (runnable.length && !ctx.job.unattended) {
    stop ??= options.signal.aborted ? "The run was stopped before this check ran." : ((await options.stopped?.().catch(() => null)) ?? null);
    if (!stop) {
      const answer = await ownerAllows(ctx, [...new Set(runnable.map((row) => row.command))], options);
      if (answer === "allow") judgeCtx = { ...ctx, accessMode: ctx.accessMode === "review" ? "review" : "auto" };
      else if (!options.signal.aborted) refused = answer === "deny" ? DENIED : UNANSWERED;
    }
  }
  for (const base of planned) {
    if (!isCheckCommand(base.command)) runs.push({ ...base, verdict: "not_run", reason: NOT_A_CHECK });
    else if (refused) runs.push({ ...base, verdict: "not_run", reason: refused });
    else runs.push(await once(base, judgeCtx));
  }
  return runs;
}

export type ConversationState = "finished" | "failed" | "stopped" | "interrupted";
export type ChecksState = "none" | "passed" | "failed" | "uncertain" | "unverified";
export type AcceptedState = "pending" | "accepted" | "rejected";
export type PullRequestState = "none" | "opened" | "merged";

export type Completion = {
  schema: typeof COMPLETION_SCHEMA;
  at: string;
  conversation: { state: ConversationState };
  files: { state: "none" | "changed"; count: number; added: number; removed: number };
  checks: { state: ChecksState; passed: number; failed: number; notRun: number; uncertain: number; claimed: number; runs: CheckRun[] };
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
  verdict: z.enum(["pass", "fail", "not_run", "uncertain"]),
  from: z.literal("acceptance").optional(),
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
  checks: z.object({ state: z.enum(["none", "passed", "failed", "uncertain", "unverified"]), passed: z.number().int().min(0), failed: z.number().int().min(0), notRun: z.number().int().min(0), uncertain: z.number().int().min(0).default(0), claimed: z.number().int().min(0), runs: z.array(CheckRunSchema).max(50) }),
  accepted: z.object({ state: z.enum(["pending", "accepted", "rejected"]), by: z.enum(["owner", "reviewer"]).nullable(), at: z.string().max(40).nullable() }),
  pr: z.object({ state: z.enum(["none", "opened", "merged"]), url: z.string().max(2000).nullable(), source: z.enum(["ensemble", "observed"]).nullable() }),
  claim: z.object({ outcome: z.enum(REPORT_OUTCOMES).nullable() }),
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
  const uncertain = input.runs.filter((row) => row.verdict === "uncertain").length;
  // The agent's checks, and the task's own commands it did not report: a reported check without a
  // command is covered when one of those ran under its id.
  const reported = input.report?.checks ?? [];
  const task = input.runs.filter((row) => row.from === "acceptance");
  const claimed = Math.max(reported.length + task.filter((row) => !row.id || !reported.some((check) => check.id === row.id)).length, input.runs.length);
  const unrunnable = reported.filter((check) => !check.rerun && !(check.id && task.some((row) => row.id === check.id))).length;
  const checks: ChecksState = failed ? "failed" : uncertain ? "uncertain" : passed && !notRun && !unrunnable ? "passed" : claimed ? "unverified" : "none";
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
    checks: { state: checks, passed, failed, notRun, uncertain, claimed, runs: input.runs },
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
 * A run's completion record, when it ends (a Code tab turn, or a run assigned to a coding agent): the
 * agent's report (report_result, or `.ensemble/result.json`), its checks and the commands its task's or
 * plan step's acceptance criteria name (`acceptance`) run again here when the conversation finished, the
 * files it changed and its pull request. Each check's progress shows on the run, and its result is an event.
 */
export async function verifyRun(ctx: JobContext, input: { outcome: Parameters<typeof completionOf>[0]["outcome"]; files: readonly Pick<ChangedFile, "added" | "removed">[]; acceptance?: readonly AcceptanceCheck[] }, options: Partial<RerunOptions> = {}): Promise<Completion> {
  const job = await ctx.prisma.workspaceJob.findUnique({ where: { id: ctx.job.id }, select: { report: true, results: true } });
  const report = parseReport(job?.report);
  const acceptance = input.acceptance ?? [];
  const runs =
    (report || acceptance.length) && input.outcome === "success"
      ? await rerunChecks(ctx, report, {
          signal: ctx.signal,
          progress: (text) => ctx.progress(text),
          secrets: Object.values(ctx.secretEnv ?? {}),
          stopped: async () => ((await acceptedOf(ctx.prisma, ctx.runId ?? null)) === "rejected" ? "The owner discarded the turn's changes before this check ran." : null),
          acceptance,
          ...options,
        })
      : [];
  for (const run of runs) {
    await ctx.event("check_rerun", { name: run.name, id: run.id, command: run.command.slice(0, 500), claimed: run.claimed, verdict: run.verdict, exitCode: run.exitCode, ms: run.ms, reason: run.reason, ...(run.from ? { from: run.from } : {}) });
  }
  const pr = await pullRequestOf(ctx.prisma, ctx.job.id, ctx.runId ?? null, job?.results);
  return completionOf({ outcome: input.outcome, files: input.files, report, runs, pr });
}

/** Whether Ensemble's runs of a run's checks confirm it: `passed`, `failed`, `not_verified` (uncertain or not run), or null when it had none. */
export type Verified = "passed" | "failed" | "not_verified";

/**
 * What Ensemble's own runs of a run's checks show, which decides its task and its plan step: failed when
 * one failed, passed when every one passed, not verified when one was uncertain or not run; null when
 * none ran. A check that came without a command stays the agent's word: listed, never holding the task
 * back nor confirming it.
 */
export function verifiedOf(checks: Pick<Completion["checks"], "runs"> | null | undefined): Verified | null {
  const runs = checks?.runs ?? [];
  if (!runs.length) return null;
  if (runs.some((run) => run.verdict === "fail")) return "failed";
  return runs.every((run) => run.verdict === "pass") ? "passed" : "not_verified";
}

/**
 * Where a task goes when its agent's run ends (docs/16 §9). With checks to run again (the agent's, or
 * commands its acceptance criteria name), the task is done only when Ensemble's runs of them passed: a
 * failure keeps it from done (blocked, with the failure), and checks it could not confirm (uncertain,
 * not run, or none run at all though the run had some: `hasChecks`) leave it finished, not verified
 * (waiting for the owner). Without them, as before: done when the run's `markDone` says so. The
 * conversation's own end (stopped, failed) decides as before.
 */
export function taskStatusAfter(input: { outcome: Parameters<typeof completionOf>[0]["outcome"]; markDone: boolean; checks: Completion["checks"] | null; hasChecks?: boolean }): { status: "done" | "waiting_approval" | "todo" | "blocked"; verified: Verified | null; question: string | null } {
  if (input.outcome === "cancelled") return { status: "todo", verified: null, question: null };
  if (input.outcome !== "success") return { status: "blocked", verified: null, question: null };
  const verified = verifiedOf(input.checks) ?? (input.hasChecks ? "not_verified" : null);
  if (verified === null || verified === "passed") return { status: input.markDone ? "done" : "waiting_approval", verified, question: null };
  if (verified === "failed") {
    const failing = (input.checks?.runs ?? []).filter((run) => run.verdict === "fail").slice(0, 3);
    const lines = failing.map((run) => `${run.id ? `${run.id} ` : ""}${run.command}: ${run.reason ?? "It failed."}`);
    return { status: "blocked", verified: "failed", question: `Its checks failed when Ensemble ran them again: ${lines.join("; ")}`.slice(0, 2000) };
  }
  return { status: "waiting_approval", verified: "not_verified", question: null };
}

type Db = PrismaClient | Prisma.TransactionClient;

/** The status a claimed run left its task in (kept on the job's context by the claim), or null for a job claimed without it. */
export function taskStatusAtStartOf(context: unknown): string | null {
  const value = typeof context === "object" && context !== null ? (context as { taskStatusAtStart?: unknown }).taskStatusAtStart : undefined;
  return typeof value === "string" && value ? value : null;
}

/**
 * Moves a run's task where its end puts it, only from the status the run left it in when it started
 * (`expected`), and only while the agent holds it: a status its owner chose meanwhile (a status edit
 * keeps the task with the agent) stands, and the run notes what it would have done and why (a
 * `task_kept` event, beside its completion record). True when the task moved.
 */
export async function settleTask(
  db: Db,
  input: { userId: string; taskId: string; jobId: string; runId: string; expected: string; status: string; question: string | null; reason: string; verified: Verified | null; now?: Date },
): Promise<boolean> {
  if (input.status === input.expected) return false;
  const now = input.now ?? new Date();
  const current = await db.task.findUnique({ where: { id: input.taskId }, select: { status: true, owner: true } });
  if (!current || current.owner !== "agent" || current.status === input.status) return false;
  if (current.status === input.expected) {
    const moved = await db.task.updateMany({
      where: { id: input.taskId, owner: "agent", status: input.expected },
      data: {
        status: input.status as never,
        completedAt: input.status === "done" ? now : null,
        ...(input.status === "blocked" ? { blockedQuestion: { question: input.question ?? "The agent stopped.", options: [] } as Prisma.InputJsonValue } : {}),
      },
    });
    if (moved.count === 1) {
      await db.taskTransition.create({ data: { userId: input.userId, taskId: input.taskId, fromStatus: input.expected as never, toStatus: input.status as never, fromOwner: "agent", toOwner: "agent", actor: "agent", reason: input.reason, runId: input.runId } });
      return true;
    }
  }
  const kept = (await db.task.findUnique({ where: { id: input.taskId }, select: { status: true } }))?.status ?? current.status;
  await db.workspaceEvent.create({ data: { jobId: input.jobId, kind: "task_kept", data: { status: kept, wanted: input.status, verified: input.verified, ...(input.question ? { question: input.question } : {}) } } });
  return false;
}

/** Why a task moved when its run finished: what Ensemble's runs of the run's checks showed. */
export function verifiedReason(verified: Verified | null): string {
  return verified === "passed" ? "Agent finished; its checks passed when Ensemble ran them again" : verified === "failed" ? "Agent finished; its checks failed when Ensemble ran them again" : verified === "not_verified" ? "Agent finished, not verified" : "Agent finished";
}

/**
 * A worker's report with Ensemble's own runs of its checks in place of its word: each rerun's verdict, the
 * acceptance commands it did not report, and the outcome they earn (a failure fails it; a check that
 * could not be confirmed leaves it uncertain). The report as it was when nothing ran again.
 */
export function verifiedReport(report: StepReport, completion: Completion | null): StepReport {
  const runs = completion?.checks.runs ?? [];
  if (!runs.length) return report;
  const verdictOf = (run: CheckRun): Check["verdict"] => (run.verdict === "pass" ? "pass" : run.verdict === "fail" ? "fail" : "skipped");
  const detailOf = (run: CheckRun) => `Ensemble ran it again: ${run.reason ?? (run.verdict === "pass" ? "it passed." : run.verdict)}`.slice(0, 2000);
  const used = new Set<CheckRun>();
  const checks: Check[] = (report.checks ?? []).map((check) => {
    const own = runs.find((run) => !used.has(run) && !run.from && run.name === check.name && run.command === check.rerun?.command);
    const task = own ? undefined : runs.find((run) => !used.has(run) && run.from === "acceptance" && check.id && run.id === check.id);
    const run = own ?? task;
    if (!run) return check;
    used.add(run);
    return { ...check, verdict: verdictOf(run), detail: detailOf(run) };
  });
  for (const run of runs) {
    if (used.has(run) || run.from !== "acceptance") continue;
    checks.push({ ...(run.id ? { id: run.id } : {}), name: run.name.slice(0, 200), verdict: verdictOf(run), detail: detailOf(run), rerun: { command: run.command.slice(0, 2000), expects: "exit_0" } });
  }
  const verified = verifiedOf(completion?.checks);
  const outcome: StepReport["outcome"] = verified === "failed" ? "fail" : verified === "not_verified" ? "uncertain" : report.outcome;
  return { ...report, outcome, checks: checks.slice(0, 50) };
}

/** A run's completion record as a computer sends it with the run's end: every text scrubbed (`scrub`); null when the run has none. */
export async function runCompletionOf(db: Db, job: { runId: string | null }, scrub: (text: string) => string): Promise<Completion | null> {
  if (!job.runId) return null;
  const completion = parseCompletion((await db.run.findUnique({ where: { id: job.runId }, select: { completion: true } }))?.completion);
  if (!completion) return null;
  const deep = (value: unknown): unknown => {
    if (typeof value === "string") return scrub(value);
    if (Array.isArray(value)) return value.map(deep);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item)]));
    return value;
  };
  return parseCompletion(deep(completion));
}

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
