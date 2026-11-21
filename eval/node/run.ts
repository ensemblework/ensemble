/**
 * Runs the Ensemble Node task suite against this checkout (eval/node/README.md).
 *
 *   pnpm --filter @ensemble/hub-api exec tsx ../../eval/node/run.ts --tasks suite:core \
 *        --agent copilot-cli --model gpt-6-luna --repeat 1 --label baseline-v1 [--judge-model gpt-6-luna]
 *   pnpm --filter @ensemble/hub-api exec tsx ../../eval/node/run.ts --regrade eval/node/results/<stamp>-<label>.json [--tasks ids]
 *   pnpm --filter @ensemble/hub-api exec tsx ../../eval/node/run.ts --combine <results.json>,<results.json> --label <label>
 *   pnpm --filter @ensemble/hub-api exec tsx ../../eval/node/run.ts --cleanup <ledger.jsonl>
 *
 * Options: --work-dir <dir> (scratch folders; default the system's temporary folder), --keep (keep the
 * scratch folder), --protect <ids> (agent sessions never to delete, besides every session that existed
 * before the run). Each task runs with a fresh owner, nodes and rooms; agent sessions the run made are
 * deleted at the end of each task and checked again at the end of the run.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, falseClaims, scoreOf } from "./lib/grade.js";
import { markdown, summaryTable } from "./lib/report.js";
import { redactor } from "./lib/redact.js";
import { copilotSessionIds, copilotSessionsIn, deleteSessions, SessionLedger, type LedgerEntry } from "./lib/sessions.js";
import { makeJudge } from "./lib/judge.js";
import { collectEvidence } from "./lib/evidence.js";
import { busy, finalSessions, runCleanups, say, startDrive, stopEverything, tick, traceFile, waitQuiet, waitUntil } from "./lib/drive.js";
import { bootWorld, hermetic, type World } from "./lib/world.js";
import { lastAnswer } from "./tasks/helpers.js";
import { selectTasks } from "./tasks/index.js";
import type { Check, CleanupEntry, Evidence, GradeInput, Judge, RunResult, Saved, Task } from "./lib/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const RESULTS = join(HERE, "results");
const CORE_MS = 10 * 60_000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** What every run of this harness says about itself in its results. */
const RUN_NOTES = [
  "The API runs in the eval process on an in-memory PGlite database. The owner's computer is a second process with its own in-memory database (lib/computer-main.ts), paired to each task's owner through the real remote loop (src/remote/loop.ts); it runs device tools, coding sessions and the browser on this machine.",
  "Subscription turns run in this process (ENSEMBLE_DESKTOP=1, as on a computer's own runtime), not relayed from a hosted API: the relay's limits (20 minutes per turn, 64 turns per spec) do not apply here.",
  "No agent runtime and no included models: Ensemble's own model calls (the turn checklist, picture checks, Ensemble's own agent) fail at once and cost nothing; the checklist model is off as in the HTTP test harness.",
  "Owner cards are answered by the harness: computer questions with This mission, coding-run permissions for the run, held writes and sessions approved; never Always. Cards that need a password, a secret or a sign-in are left and reported.",
  "The agent CLI runs with this machine's own configuration and sign-in, as on an owner's computer: MCP servers configured for the agent itself (for Copilot, in ~/.copilot) are offered to node turns too.",
];

type Args = { tasks: string; agent: string; model: string; repeat: number; label: string; judgeModel: string; regrade: string | null; combine: string | null; cleanup: string | null; workDir: string; keep: boolean; protect: string[] };

function parseArgs(argv: string[]): Args {
  const args: Args = { tasks: "all", agent: "copilot-cli", model: "gpt-6-luna", repeat: 1, label: "", judgeModel: "gpt-6-luna", regrade: null, combine: null, cleanup: null, workDir: tmpdir(), keep: false, protect: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--tasks") args.tasks = value();
    else if (flag === "--agent") args.agent = value();
    else if (flag === "--model") args.model = value();
    else if (flag === "--repeat") args.repeat = Math.max(1, Number(value()) || 1);
    else if (flag === "--label") args.label = value().replace(/[^\w.-]+/g, "-");
    else if (flag === "--judge-model") args.judgeModel = value();
    else if (flag === "--regrade") args.regrade = value();
    else if (flag === "--combine") args.combine = value();
    else if (flag === "--cleanup") args.cleanup = value();
    else if (flag === "--work-dir") args.workDir = resolve(value());
    else if (flag === "--keep") args.keep = true;
    else if (flag === "--protect") args.protect.push(...value().split(",").map((id) => id.trim()).filter(Boolean));
    else throw new Error(`Unknown argument ${flag}`);
  }
  args.protect.push(...(process.env.NODE_EVAL_PROTECT ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  return args;
}

const commit = () => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

function saveRun(file: string, saved: Saved): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, `${file}.json`), `${JSON.stringify(saved, null, 1)}\n`);
  writeFileSync(join(RESULTS, `${file}.md`), markdown(saved));
}

/** The text the owner sent, for the judge: every message of the task, in order. */
function askedText(task: Task, ev: Evidence): string {
  const said = ev.messages.filter((row) => row.author === "owner" && row.kind === "text").map((row) => row.body);
  return said.length ? said.join("\n\n") : task.title;
}

async function grade(task: Task, ev: Evidence, data: Record<string, unknown>, judge: Judge): Promise<{ checks: Check[]; claims: string[] }> {
  let truth: Record<string, string> = {};
  try {
    truth = task.truth ? await task.truth() : {};
  } catch (error) {
    return { checks: [check("ground truth", false, "truth", { note: error instanceof Error ? error.message : String(error) })], claims: falseClaims(ev, task.claims) };
  }
  try {
    const input: GradeInput = { ev, truth, judge, data };
    return { checks: await task.checks(input), claims: falseClaims(ev, task.claims) };
  } catch (error) {
    return { checks: [check("grading", false, "state", { note: error instanceof Error ? error.message : String(error) })], claims: falseClaims(ev, task.claims) };
  }
}

function result(task: Task, repeat: number, startedAt: string, status: RunResult["status"], ev: Evidence, graded: { checks: Check[]; claims: string[] }, errors: string[], wallMs: number, trace: string): RunResult {
  const { score, pass, verified } = scoreOf(graded.checks);
  const failedTurns = ev.turns.filter((turn) => turn.status === "failed");
  const turnErrors = failedTurns.map((turn) => `turn of @${turn.node} failed: ${turn.error ?? "no error given"}`);
  const roomErrors = ev.messages.filter((row) => row.kind === "error").map((row) => `error message in the chat: ${row.body.slice(0, 200)}`);
  const allErrors = [...errors, ...turnErrors, ...roomErrors];
  return {
    task: task.id,
    suite: task.suite,
    category: task.category,
    repeat,
    status,
    score,
    pass: pass && status !== "error",
    verifiedPass: verified && status !== "error",
    checks: graded.checks,
    falseClaims: graded.claims,
    metrics: {
      wallMs,
      turns: ev.usage.turns,
      failedTurns: failedTurns.length,
      modelCalls: ev.usage.modelCalls,
      tokensIn: ev.usage.tokensIn || ev.usage.ensembleTokensIn,
      tokensOut: ev.usage.tokensOut || ev.usage.ensembleTokensOut,
      credits: ev.usage.credits,
      ensembleCalls: ev.usage.ensembleCalls,
      ensembleTools: ev.tools.length,
      agentTools: ev.agentTools.length,
      approvals: ev.cards.length,
      unanswered: ev.cards.filter((card) => !card.answered).length,
      errors: allErrors.length,
    },
    tools: [...new Set(ev.tools.map((call) => call.name))],
    agentToolNames: [...new Set(ev.agentTools.map((call) => call.name))],
    models: ev.usage.models,
    cards: ev.cards,
    errors: allErrors,
    sessions: ev.sessions,
    trace,
    startedAt,
  };
}

async function runTask(world: World, task: Task, repeat: number, context: { label: string; ledger: SessionLedger; judge: ReturnType<typeof makeJudge>; cleanup: CleanupEntry[]; log: (line: string) => void; stopping: () => boolean }): Promise<RunResult> {
  const { ledger, log } = context;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const tracePath = join(RESULTS, "traces", context.label, `${task.id}--${repeat + 1}.jsonl`);
  const redact = redactor({ [world.dirs.root]: "<work>", [REPO]: "<repo>" });
  const trace = traceFile(tracePath, redact);
  const owner = await world.newOwner("Mira Chen");
  const device = await world.pair(owner);
  const dir = join(world.dirs.tasks, `${task.id}-${repeat + 1}`);
  mkdirSync(dir, { recursive: true });
  const drive = await startDrive({ world, owner, task, repeat, dir, deviceId: device.id, trace, ledger, log: (line) => log(`  ${line}`), timeoutMs: task.timeoutMs ?? (task.suite === "crew" ? 25 * 60_000 : CORE_MS) });
  const ctx = drive.ctx;
  ctx.data.timeZone = world.timeZone;
  let status: RunResult["status"] = "done";
  trace.write("start", { task: task.id, repeat, agent: world.agent, model: world.model, timeZone: world.timeZone });
  try {
    await task.setup(ctx);
    trace.write("setup", { data: ctx.data });
    for (const step of task.steps) {
      if (context.stopping()) throw new Error("stopped by the person running the eval");
      if (step.before) {
        const seen = await waitUntil(drive, step.before.until, step.before.timeoutMs ?? 10 * 60_000);
        trace.write("before", { what: step.before.what, seen });
        if (!seen) drive.notes.push(`Sent the next message without seeing: ${step.before.what}.`);
      }
      await say(drive, step.room ?? "main", typeof step.say === "function" ? step.say(ctx) : step.say);
      if (step.wait !== "none") {
        const outcome = await waitQuiet(drive, 6000, step.quietMs);
        trace.write("wait", { outcome, busy: await busy(drive) });
        if (outcome === "busy") drive.notes.push(`Still working ${Math.round(step.quietMs! / 60_000)} min after "${typeof step.say === "function" ? "the message" : step.say}": ${(await busy(drive)).join(", ")}.`);
        if (outcome === "timeout") {
          status = "timeout";
          drive.errors.push(`timed out after ${Math.round((Date.now() - started) / 60_000)} min (${(await busy(drive)).join(", ") || "nothing listed"})`);
          break;
        }
        if (outcome === "stalled") drive.notes.push(`Stalled: only a plan was open, with nothing running, for 5 minutes (${(await busy(drive)).join(", ")}).`);
      }
      if (step.holdMs) {
        const until = Date.now() + step.holdMs;
        while (Date.now() < until) {
          await tick(drive);
          await sleep(1500);
        }
      }
    }
  } catch (error) {
    status = "error";
    drive.errors.push(`harness: ${error instanceof Error ? error.message : String(error)}`);
  }
  await finalSessions(drive);
  const rooms = await world.prisma.nodeRoomMember.findMany({ where: { userId: owner.id }, select: { roomId: true } });
  const ev = await collectEvidence(world, { ownerId: owner.id, roomIds: [...new Set([...rooms.map((row) => row.roomId), ...Object.values(ctx.rooms)])], since: new Date(started), seededTasks: (ctx.data.seededTasks as string[]) ?? [], seededPages: (ctx.data.seededPages as string[]) ?? [] }, ledger, task.id, drive.cards);
  if (task.collect) {
    try {
      ev.extra = await task.collect(ctx, ev);
    } catch (error) {
      ev.extra = { collectError: error instanceof Error ? error.message : String(error) };
    }
  }
  const asked = askedText(task, ev);
  const judgeCalls: Array<{ rubric: string; score: number; reason: string }> = [];
  const judge: Judge = async (rubric, answer) => {
    const call = await context.judge(task.id, asked, rubric, answer ?? lastAnswer(ev));
    judgeCalls.push({ rubric: rubric.slice(0, 200), score: call.verdict.score, reason: call.verdict.reason });
    trace.write("judge", { score: call.verdict.score, reason: call.verdict.reason, tokensIn: call.tokensIn, tokensOut: call.tokensOut, model: call.model });
    return call.verdict;
  };
  const graded = await grade(task, ev, ctx.data, judge);
  const wallMs = Date.now() - started;
  // Leave nothing running, then end the pairing and delete this task's agent sessions.
  await stopEverything(drive).catch((error: unknown) => drive.errors.push(`harness: stop: ${error instanceof Error ? error.message : String(error)}`));
  await runCleanups(drive);
  await world.unpair().catch((error: unknown) => drive.errors.push(`harness: unpair: ${error instanceof Error ? error.message : String(error)}`));
  await finalSessions(drive);
  const done = await deleteSessions(ledger, ledger.entries(task.id).filter((row) => row.kind !== "judge"), log);
  context.cleanup.push(...done);
  const outcome = result(task, repeat, startedAt, status, ev, graded, [...drive.errors], wallMs, relative(REPO, tracePath));
  trace.write("checks", { checks: graded.checks, falseClaims: graded.claims, notes: drive.notes, judge: judgeCalls });
  trace.write("metrics", { ...outcome.metrics, models: outcome.models, tools: outcome.tools, agentTools: outcome.agentToolNames });
  trace.write("cleanup", { sessions: done.map((row) => ({ id: row.id, kind: row.kind, deleted: row.deleted })) });
  // The evidence a regrade reads: the last line of the trace.
  appendFileSync(tracePath, `${JSON.stringify({ kind: "evidence", data: redact.deep(ctx.data, 6000), ev: redact.deep(ev, 6000) })}\n`);
  if (drive.notes.length) outcome.errors.push(...drive.notes.map((note) => `note: ${note}`));
  return outcome;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string) => console.log(`[eval ${new Date().toISOString().slice(11, 19)}] ${line}`);
  if (args.cleanup) return cleanupLedger(args, log);
  if (args.regrade) return regrade(args, log);
  if (!args.label) throw new Error("Give the run a --label (for example baseline-v1).");
  if (args.combine) return combine(args, log);
  const tasks = selectTasks(args.tasks);
  const before = copilotSessionIds();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = `${stamp}-${args.label}`;
  const saved: Saved = { label: args.label, stamp, commit: commit(), agent: args.agent, model: args.model, judgeModel: args.judgeModel, tasks: tasks.map((task) => task.id), repeat: args.repeat, startedAt: new Date().toISOString(), finishedAt: null, results: [], cleanup: [], notes: [...RUN_NOTES] };
  log(`${tasks.length} tasks × ${args.repeat} on ${args.agent} ${args.model}, judge ${args.judgeModel}. Results: ${relative(REPO, join(RESULTS, file))}.{json,md}`);
  const world = await bootWorld({ workDir: args.workDir, agent: args.agent, model: args.model, log });
  const ledger = new SessionLedger(join(world.dirs.root, "ledger.jsonl"), before, new Set(args.protect));
  const judge = makeJudge({ model: args.judgeModel, ledger, root: world.dirs.root, log, cleanup: saved.cleanup });
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
    log("stopping after this task (press Ctrl+C again to quit at once)");
    process.once("SIGINT", () => process.exit(130));
  });
  try {
    for (let repeat = 0; repeat < args.repeat && !stopping; repeat += 1) {
      for (const task of tasks) {
        if (stopping) break;
        log(`${task.id} #${repeat + 1}: ${task.title}`);
        let outcome: RunResult;
        try {
          outcome = await runTask(world, task, repeat, { label: args.label, ledger, judge, cleanup: saved.cleanup, log, stopping: () => stopping });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`  harness error: ${message}`);
          await world.unpair().catch(() => undefined);
          const empty: Evidence = { replies: [], answers: [], messages: [], tools: [], agentTools: [], turns: [], tasks: [], pages: [], memories: [], routines: [], missions: [], runs: [], jobs: [], cards: [], sessions: [], usage: { turns: 0, modelCalls: 0, tokensIn: 0, tokensOut: 0, credits: 0, ensembleCalls: 0, ensembleTokensIn: 0, ensembleTokensOut: 0, models: [] }, extra: {} };
          outcome = result(task, repeat, new Date().toISOString(), "error", empty, { checks: [check("harness", false, "state", { note: message })], claims: [] }, [`harness: ${message}`], 0, "");
        }
        saved.results.push(outcome);
        saveRun(file, saved);
        const m = outcome.metrics;
        log(`${outcome.pass ? "PASS" : outcome.score > 0 ? "part" : "FAIL"} ${`${Math.round(outcome.score * 100)}%`.padStart(4)} ${task.id} · ${m.turns} turns · ${m.modelCalls} model calls · ${m.ensembleTools}+${m.agentTools} tools · ${m.tokensIn}/${m.tokensOut} tokens · ${Math.round(m.wallMs / 1000)} s · ${m.approvals} cards${outcome.status !== "done" ? ` · ${outcome.status}` : ""}${outcome.checks.some((row) => !row.pass) ? ` · failed: ${outcome.checks.filter((row) => !row.pass).map((row) => row.name).join("; ")}` : ""}`);
      }
    }
  } finally {
    // Anything the run made that is still there: recorded sessions not yet deleted, and Copilot sessions in the scratch folder.
    for (const id of copilotSessionsIn(world.dirs.root)) ledger.record({ agent: "copilot-cli", id, kind: "found", task: null, folder: null });
    const deleted = new Set(saved.cleanup.filter((row) => row.deleted).map((row) => `${row.agent}:${row.id}`));
    const left = ledger.entries().filter((row) => !deleted.has(`${row.agent}:${row.id}`));
    if (left.length) saved.cleanup.push(...(await deleteSessions(ledger, left, log)));
    const still = ledger.entries().filter((row) => row.agent === "copilot-cli" && copilotSessionIds().has(row.id));
    for (const row of still) {
      const entry = saved.cleanup.find((item) => item.id === row.id);
      if (entry) {
        entry.deleted = false;
        entry.note = `${entry.note ? `${entry.note}; ` : ""}still in ~/.copilot/session-state at the end`;
      }
    }
    saved.finishedAt = new Date().toISOString();
    saveRun(file, saved);
    await world.close();
    if (!args.keep) rmSync(world.dirs.root, { recursive: true, force: true });
    else log(`scratch folder kept: ${world.dirs.root}`);
  }
  console.log(`\n${summaryTable(saved.results, args.repeat)}\n\nSaved ${relative(REPO, join(RESULTS, file))}.{json,md}. Sessions: ${saved.cleanup.filter((row) => row.deleted).length} of ${saved.cleanup.length} deleted.`);
}

/** Grades a saved run again from the evidence its traces kept (no agent calls; the judge and live ground truth run again). */
async function regrade(args: Args, log: (line: string) => void): Promise<void> {
  const path = resolve(process.cwd(), args.regrade!);
  const file = existsSync(path) ? path : resolve(REPO, args.regrade!);
  const saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
  const wanted = args.tasks === "all" ? null : new Set(selectTasks(args.tasks).map((task) => task.id));
  const root = mkdtempSync(join(args.workDir, "ensemble-node-regrade-"));
  const dirs = { state: join(root, "state"), workspace: join(root, "workspace"), app: join(root, "app"), data: join(root, "data"), tmp: join(root, "tmp") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  hermetic(dirs);
  process.env.DATABASE_URL = "postgresql://regrade@127.0.0.1:1/ensemble_unused";
  const ledger = new SessionLedger(join(root, "ledger.jsonl"), copilotSessionIds(), new Set(args.protect));
  const judge = makeJudge({ model: args.judgeModel, ledger, root, log, cleanup: saved.cleanup });
  try {
    for (const row of saved.results) {
      if (wanted && !wanted.has(row.task)) continue;
      const task = selectTasks(row.task)[0]!;
      const lines = row.trace && existsSync(join(REPO, row.trace)) ? readFileSync(join(REPO, row.trace), "utf8").trim().split("\n") : [];
      const last = lines.length ? (JSON.parse(lines.at(-1)!) as { kind?: string; data?: Record<string, unknown>; ev?: Evidence }) : null;
      if (last?.kind !== "evidence" || !last.ev) {
        log(`skip ${row.task}: its trace kept no evidence`);
        continue;
      }
      const ev = last.ev;
      const asked = askedText(task, ev);
      const graded = await grade(task, ev, last.data ?? {}, async (rubric, answer) => (await judge(task.id, asked, rubric, answer ?? lastAnswer(ev))).verdict);
      const { score, pass, verified } = scoreOf(graded.checks);
      Object.assign(row, { checks: graded.checks, falseClaims: graded.claims, score, pass: pass && row.status !== "error", verifiedPass: verified && row.status !== "error" });
      log(`regraded ${row.task}: ${Math.round(score * 100)}%`);
    }
    saved.notes.push(`Regraded ${new Date().toISOString().slice(0, 16)} from the evidence in the traces${wanted ? ` (${[...wanted].join(", ")})` : ""}.`);
    const name = file.replace(/^.*\//, "").replace(/\.json$/, "");
    saveRun(name, saved);
    console.log(`\n${summaryTable(saved.results, saved.repeat)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** One result file from several runs on the same agent and model: a later run of a task replaces an earlier one. */
function combine(args: Args, log: (line: string) => void): void {
  const runs = args.combine!.split(",").map((name) => {
    const path = resolve(process.cwd(), name.trim());
    return JSON.parse(readFileSync(existsSync(path) ? path : resolve(REPO, name.trim()), "utf8")) as Saved;
  });
  const first = runs[0]!;
  for (const run of runs) if (run.agent !== first.agent || run.model !== first.model) throw new Error(`${run.stamp}-${run.label} ran ${run.agent} ${run.model}, not ${first.agent} ${first.model}.`);
  const byTask = new Map<string, RunResult>();
  for (const run of runs) for (const row of run.results) byTask.set(`${row.task}#${row.repeat}`, row);
  const results = [...byTask.values()];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const unique = (values: string[]) => [...new Set(values)];
  const saved: Saved = {
    label: args.label,
    stamp,
    commit: unique(runs.map((run) => run.commit)).join(", "),
    agent: first.agent,
    model: first.model,
    judgeModel: unique(runs.map((run) => run.judgeModel)).join(", "),
    tasks: unique(results.map((row) => row.task)),
    repeat: Math.max(...runs.map((run) => run.repeat)),
    startedAt: runs.map((run) => run.startedAt).sort()[0]!,
    finishedAt: runs.map((run) => run.finishedAt ?? "").sort().at(-1) || null,
    results,
    cleanup: runs.flatMap((run) => run.cleanup),
    notes: unique([...runs.flatMap((run) => run.notes), `Combined from ${runs.map((run) => `${run.stamp}-${run.label}`).join(", ")}; a later run of a task replaces an earlier one.`]),
  };
  saveRun(`${stamp}-${args.label}`, saved);
  log(`Saved ${relative(REPO, join(RESULTS, `${stamp}-${args.label}`))}.{json,md}`);
  console.log(`\n${summaryTable(saved.results, saved.repeat)}`);
}

/** Deletes the sessions a crashed run recorded in its ledger (the scratch folder's ledger.jsonl). */
async function cleanupLedger(args: Args, log: (line: string) => void): Promise<void> {
  const entries = readFileSync(resolve(args.cleanup!), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry);
  const root = mkdtempSync(join(args.workDir, "ensemble-node-cleanup-"));
  const dirs = { state: join(root, "state"), workspace: join(root, "workspace"), app: join(root, "app"), data: join(root, "data"), tmp: join(root, "tmp") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  hermetic(dirs);
  process.env.DATABASE_URL = "postgresql://cleanup@127.0.0.1:1/ensemble_unused";
  const ledger = new SessionLedger(join(root, "ledger.jsonl"), new Set(), new Set(args.protect));
  for (const entry of entries) ledger.record(entry);
  try {
    const done = await deleteSessions(ledger, ledger.entries(), log);
    console.log(JSON.stringify(done, null, 1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
