/**
 * The session watchdog (docs/35 §8.11): code rules over the runs of nodes' sessions, never a model. A run
 * that shows no progress for a while, keeps hitting the same error (its latest failures, not an agent
 * looking around), spends tokens without changing a file, or changes files outside its folder, and an
 * agent's question the node may answer, each give the run's node one attention turn with a note (a plan
 * step's run: in that step's own lane). That is a turn, not a chat message, and its advice is to leave a
 * working run alone. Each condition reaches the node once per run (`node_runs.watchdog`, claimed with a
 * compare-and-set).
 */
import type { FastifyInstance } from "fastify";
import type { NodeRun, Prisma, PrismaClient } from "@prisma/client";
import { truncateText } from "../lib/text.js";
import { enqueueTurn } from "./queue.js";
import { recordSessionEvent } from "./session-queue.js";
import { answersQuestions, questionRefusal } from "./session-questions.js";
import { runIsStale, stepLive } from "./plans.js";

const minutes = (value: number) => value * 60_000;
const fromEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** The rules' settings. Ensemble already restarts an engine that stays quiet for 10 minutes; the watchdog speaks after that. */
export const WATCHDOG = {
  /** How often `startWatchdog` checks. */
  intervalMs: fromEnv("ENSEMBLE_NODE_WATCHDOG_MS", 60_000),
  /** No progress for this long on a run that is working. */
  stallMs: fromEnv("ENSEMBLE_NODE_WATCHDOG_STALL_MS", minutes(15)),
  /** The same error this many times in the run… */
  repeats: fromEnv("ENSEMBLE_NODE_WATCHDOG_REPEATS", 5),
  /** …and as the run's latest failures, this many in a row (never more than `repeats`). */
  streak: fromEnv("ENSEMBLE_NODE_WATCHDOG_STREAK", 4),
  /** Tokens spent with no file changed. */
  tokens: fromEnv("ENSEMBLE_NODE_WATCHDOG_TOKENS", 2_000_000),
  /** Runs that ended this recently are still checked for files changed outside their folder. */
  endedMs: minutes(30),
};

/** Tests tighten the rules; the shipped values are the defaults above. */
export function setWatchdogForTests(overrides: Partial<typeof WATCHDOG>): void {
  Object.assign(WATCHDOG, overrides);
}

type Hit = { condition: string; note: string; detail?: Record<string, unknown> };

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** An error as its kind: numbers, ids and spacing taken out, so the same failure reads the same. */
export function errorSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "#")
    .replace(/\b[0-9a-f]{12,}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** A tool call that changes files, by the names the agents give them. */
const EDITS = /(edit|write|patch|create|delete|remove|move|rename|filechange|file_change|notebook|str_replace|insert)/i;

/** A tool that only looks (reading, viewing, listing, searching), by its name's words. */
const LOOKS = /(^|_)(read|view|cat|glob|grep|rg|ripgrep|search|find|list|ls|tree|stat|lookup|fetch)(_|$)/;
/** A tool that changes something, whatever else its name says. */
const CHANGES = /(edit|write|patch|create|delete|remove|move|rename|replace|insert|apply|update)/;
/** A tool that runs a command line. */
const SHELLS = /(bash|shell|exec|terminal|command|powershell|cmd|run)/;
/** Programs whose failure is how they say “not there” or “no match”: grep and rg exit 1 on no match, test on false. */
const LOOK_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "test", "[", "[[", "ls", "cat", "head", "tail", "stat", "file", "wc", "which", "type", "readlink", "realpath", "diff"]);
/** Words around a look in one command line that change nothing. */
const NEUTRAL_PROGRAMS = new Set(["cd", "pushd", "popd", "echo", "printf", "true", "set", "export", "sort", "uniq", "cut", "tr", "xargs"]);
/** What a look that found nothing says. */
const MISS = /path does not exist|no such file|not found|does not exist|doesn't exist|view_range|out of bounds|out of range|is a directory|not a directory|no matches|no files? (?:were )?found|nothing found|enoent|eisdir|enotdir|cannot find|can't find|could not find|couldn't find|cannot access/i;

/**
 * A failure's own words: a JSON output's `error` or `message` (a tool's result object), else its first
 * line with text in it, never a lone brace.
 */
export function failureText(output: string): string {
  const text = output.trim();
  if (/^[{[]/.test(text)) {
    try {
      const value = JSON.parse(text) as unknown;
      const found = messageIn(value);
      if (found) return found;
    } catch {
      // Cut off (outputs are previews): read the field as written.
      const field = /"(?:error|message|detail)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
      if (field) return field[1]!.replace(/\\n/g, " ").replace(/\\"/g, '"');
    }
  }
  return text.split("\n").map((line) => line.trim()).find((line) => line && !/^[\s{}[\](),;:"']*$/.test(line)) ?? "";
}

function messageIn(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const row = value as Record<string, unknown>;
  for (const key of ["error", "message", "detail", "reason"]) {
    const found = messageIn(row[key]);
    if (found) return found;
  }
  return "";
}

/** The programs a command line runs, one per part of a chain or pipe: each one's first word after any VAR=value, without a path. */
function programsOf(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((part) => {
      const words = part.trim().split(/\s+/).filter((word) => word && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
      const first = (words[0] ?? "").replace(/^["'(]+|["')]+$/g, "");
      return first.split("/").at(-1)?.toLowerCase() ?? "";
    })
    .filter(Boolean);
}

/** A command line that only looks: at least one search or read program, and nothing else that does anything. */
function looksOnly(command: string): boolean {
  const programs = programsOf(command);
  return programs.some((program) => LOOK_PROGRAMS.has(program)) && programs.every((program) => LOOK_PROGRAMS.has(program) || NEUTRAL_PROGRAMS.has(program));
}

/** A tool's name as words: “readFile”, “Read” and “mcp__fs__read_file” all read as read_file. */
const toolWords = (name: string) => name.replace(/^mcp__[^_]+__/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_");

/** The command a shell tool call ran, from its arguments (JSON, or the line itself). */
function commandOf(tool: string, args: unknown): string {
  if (typeof args !== "string" || !SHELLS.test(toolWords(tool))) return "";
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    if (typeof parsed.program === "string") return [parsed.program, ...(Array.isArray(parsed.args) ? parsed.args.map(String) : [])].join(" ");
    const command = parsed.command ?? parsed.cmd ?? parsed.script;
    return Array.isArray(command) ? command.map(String).join(" ") : typeof command === "string" ? command : "";
  } catch {
    return args;
  }
}

/**
 * An agent exploring: reading, viewing, listing or searching for something that is not there, or a
 * search command that found nothing (grep's exit 1). That is how agents look around, never a failure.
 */
export function explorationMiss(failure: { tool?: string; args?: string; command?: string; exitCode?: number; text: string }): boolean {
  if (failure.command && looksOnly(failure.command) && (failure.exitCode === undefined || failure.exitCode === 1 || failure.exitCode === 2)) return true;
  const tool = toolWords(failure.tool ?? "");
  // An editor tool asked only to view (Claude Code's and Copilot's `command: "view"`) is looking too.
  const viewing = /"command"\s*:\s*"(?:view|read|list)"/.test(failure.args ?? "");
  return (viewing || (Boolean(tool) && LOOKS.test(tool) && !CHANGES.test(tool))) && MISS.test(failure.text);
}

/** A changed file's path that is not inside the run's folder: absolute, in the home folder, or above it. */
export function outsidePath(path: string): boolean {
  return /^(\/|~|\.\.\/|[A-Za-z]:[\\/])/.test(path.trim());
}

type JobView = {
  id: string;
  status: string;
  kind: string;
  progress: string | null;
  startedAt: Date | null;
  claimedAt: Date | null;
  finishedAt: Date | null;
  cancelRequestedAt: Date | null;
  tokensIn: number;
  tokensOut: number;
  runId: string | null;
  evidence: unknown;
  task: { title: string };
};

const WORKING = new Set(["claimed", "running"]);
const LIVE = new Set(["claimed", "running", "waiting_approval", "stopping"]);

type Failure = { at: number; text: string };
type EventRow = { kind: string; data: unknown; createdAt: Date };
type StepRow = { toolCalls: unknown; startedAt: Date | null; endedAt: Date | null };

/** A run's failures, oldest first, without its exploration misses: its retries, failed commands and failed tool calls. */
export function failures(events: readonly EventRow[], steps: readonly StepRow[]): Failure[] {
  const found: Array<Failure & { order: number }> = [];
  let order = 0;
  const add = (at: number, text: string) => {
    if (text.trim()) found.push({ at, text: truncateText(text.replace(/\s+/g, " ").trim(), 200), order: order++ });
  };
  for (const event of [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const data = record(event.data);
    if (event.kind === "engine_retry" && typeof data.reason === "string") add(event.createdAt.getTime(), data.reason);
    if (event.kind === "command" && typeof data.exitCode === "number" && data.exitCode !== 0) {
      const command = String(data.command ?? "a command");
      const text = `\`${command}\` failed (exit ${data.exitCode})`;
      if (!explorationMiss({ command, exitCode: data.exitCode, text })) add(event.createdAt.getTime(), text);
    }
  }
  for (const step of steps) {
    const at = (step.startedAt ?? step.endedAt)?.getTime() ?? 0;
    for (const call of Array.isArray(step.toolCalls) ? step.toolCalls.map(record) : []) {
      if (call.ok !== false) continue;
      const tool = String(call.name ?? "a tool");
      const said = failureText(String(call.output || call.summary || "")) || "failed";
      const command = commandOf(tool, call.args);
      const exit = /exit(?:ed with)?(?: code|:)?\s*(\d+)/i.exec(String(call.output ?? ""))?.[1];
      if (explorationMiss({ tool, args: typeof call.args === "string" ? call.args : undefined, command, exitCode: exit === undefined ? undefined : Number(exit), text: said })) continue;
      add(at, `${tool}: ${said}`);
    }
  }
  return found.sort((a, b) => a.at - b.at || a.order - b.order).map(({ at, text }) => ({ at, text }));
}

/**
 * The same failure again and again: one kind at least `WATCHDOG.repeats` times, and the run's latest
 * `WATCHDOG.streak` failures all of that kind (an agent that moved past an error is not stuck on it).
 */
export function repeatedFailure(list: readonly Failure[]): { text: string; count: number; streak: number } | null {
  const need = Math.min(WATCHDOG.streak, WATCHDOG.repeats);
  if (list.length < need || !list.length) return null;
  const last = list.at(-1)!;
  const key = errorSignature(last.text);
  if (!key) return null;
  let streak = 0;
  for (let index = list.length - 1; index >= 0 && errorSignature(list[index]!.text) === key; index -= 1) streak += 1;
  const count = list.filter((row) => errorSignature(row.text) === key).length;
  return streak >= need && count >= WATCHDOG.repeats ? { text: last.text, count, streak } : null;
}

/** What the rules find on one run. Pure apart from reading its events, steps, files and questions. */
async function findings(prisma: PrismaClient, run: NodeRun, job: JobView, answers: boolean, now: number): Promise<Hit[]> {
  const hits: Hit[] = [];
  const title = job.task.title;
  const where = `the run “${truncateText(title, 120)}” in your session ${run.sessionId ?? run.jobId}`;
  const live = LIVE.has(job.status) && !job.cancelRequestedAt;
  const events = live ? await prisma.workspaceEvent.findMany({ where: { jobId: job.id }, orderBy: { sequence: "desc" }, take: 300, select: { kind: true, data: true, createdAt: true } }) : [];
  const steps = live && job.runId ? await prisma.runStep.findMany({ where: { runId: job.runId }, orderBy: { index: "asc" }, select: { toolCalls: true, tokensIn: true, tokensOut: true, startedAt: true, endedAt: true } }) : [];

  if (live && WORKING.has(job.status)) {
    // Progress is what the run did (its events, its output, its steps), not the computer's heartbeat:
    // a computer posts every half minute even when nothing changed.
    const output = await prisma.workspaceLogChunk.findFirst({ where: { jobId: job.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const times = [job.startedAt, job.claimedAt, events[0]?.createdAt, output?.createdAt, ...steps.flatMap((row) => [row.startedAt, row.endedAt])].filter((at): at is Date => Boolean(at)).map((at) => at.getTime());
    const last = times.length ? Math.max(...times) : null;
    if (last !== null && now - last >= WATCHDOG.stallMs) {
      const quiet = Math.round((now - last) / 60_000);
      hits.push({ condition: "stalled", note: `${where} has shown no progress for ${quiet} minutes${job.progress ? ` (its last word: “${truncateText(job.progress, 160)}”)` : ""}. Ensemble already restarts an agent that stops responding.`, detail: { minutes: quiet } });
    }
  }

  if (live) {
    const repeated = repeatedFailure(failures(events, steps));
    if (repeated && WORKING.has(job.status)) hits.push({ condition: "repeated_error", note: `${where} has hit the same error ${repeated.count} times, the last ${repeated.streak} in a row: “${repeated.text}”.`, detail: { count: repeated.count, streak: repeated.streak, error: repeated.text } });

    if (job.kind === "code") {
      const spent = Math.max(job.tokensIn + job.tokensOut, steps.reduce((sum, row) => sum + (row.tokensIn ?? 0) + (row.tokensOut ?? 0), 0));
      const edited =
        steps.some((row) => (Array.isArray(row.toolCalls) ? row.toolCalls.map(record) : []).some((call) => EDITS.test(String(call.name ?? "")))) ||
        events.some((event) => event.kind === "tool" && EDITS.test(String(record(event.data).name ?? ""))) ||
        (await prisma.jobFile.count({ where: { jobId: job.id } })) > 0;
      if (spent >= WATCHDOG.tokens && !edited) {
        hits.push({ condition: "no_changes", note: `${where} has used about ${Math.round(spent / 1000)}K tokens without changing a file.`, detail: { tokens: spent } });
      }
    }

    if (answers) {
      const questions = await prisma.agentDecision.findMany({ where: { sessionId: job.id, userId: run.userId, source: "ensemble", event: "question", status: "pending" }, orderBy: { requestedAt: "asc" }, take: 5 });
      // Only questions it may answer reach the node; the rest wait in Needs me for its owner.
      for (const question of questions.filter((row) => !questionRefusal(row))) {
        const options = Array.isArray(record(question.detail).options) ? (record(question.detail).options as unknown[]).filter((item): item is string => typeof item === "string") : [];
        hits.push({
          condition: `question:${question.id}`,
          note: [
            `The agent doing ${where} asks: “${truncateText(question.title, 300)}”${options.length ? ` (options: ${options.map((option) => `“${option}”`).join(", ")})` : ""}. It waits for your owner on the run's card in the chat (question ${question.id}).`,
            "If the mission, your step's brief, the mission's constraints or your owner's own message that started this work states the answer, answer it with node_answer_question, quoting those words exactly and naming the source.",
            "Never answer permissions, widening the scope, security, cost or anything destructive, and never from memory or a guess: leave those to your owner.",
          ].join(" "),
          detail: { decisionId: question.id, question: question.title },
        });
      }
    }
  }

  // Files changed outside the folder show once the computer sends the run's changes (at its end).
  const ended = !live && job.finishedAt && now - job.finishedAt.getTime() <= WATCHDOG.endedMs;
  if (live || ended) {
    const files = Array.isArray(record(job.evidence).files) ? (record(job.evidence).files as unknown[]).map((row) => String(record(row).path ?? "")) : [];
    const uploaded = (await prisma.jobFile.findMany({ where: { jobId: job.id }, select: { path: true }, take: 200 })).map((row) => row.path);
    const outside = [...new Set([...files, ...uploaded].filter(outsidePath))];
    if (outside.length) {
      hits.push({ condition: "outside_files", note: `${where} changed files outside its folder: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ` and ${outside.length - 5} more` : ""}.`, detail: { files: outside.slice(0, 20) } });
    }
  }
  return hits;
}

const ADVICE =
  "This note is from Ensemble's watchdog, not from your owner. Usually leave it: agents recover from errors by themselves. Steer only if the same failure keeps happening and you know the fix; never stop a run your owner asked for. Reply exactly (no reply) unless your owner needs to know.";

/** Takes the condition for this run, once: false when the watchdog already raised it. */
async function claim(prisma: PrismaClient, runId: string, condition: string): Promise<boolean> {
  const stamp = JSON.stringify({ [condition]: new Date().toISOString() });
  const won = await prisma.$executeRaw`UPDATE node_runs SET watchdog = watchdog || ${stamp}::jsonb WHERE id = ${runId} AND (watchdog ->> ${condition}) IS NULL`;
  return won === 1;
}

async function release(prisma: PrismaClient, runId: string, condition: string): Promise<void> {
  await prisma.$executeRaw`UPDATE node_runs SET watchdog = watchdog - ${condition}::text WHERE id = ${runId}`;
}

/**
 * One pass of the rules over the runs of nodes' sessions that are going (and those that ended in the
 * last half hour, for files changed outside their folder). Each new finding enqueues one attention turn
 * for the run's node and records it on the session. Returns how many turns it enqueued.
 */
export async function checkSessions(app: FastifyInstance, now = Date.now()): Promise<number> {
  const prisma = app.prisma;
  const runs = await prisma.nodeRun.findMany({
    where: { OR: [{ reportedAt: null }, { reportedAt: { gt: new Date(now - WATCHDOG.endedMs) } }] },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  let raised = 0;
  const nodes = new Map<string, boolean>();
  for (const run of runs) {
    const job = (await prisma.workspaceJob.findUnique({
      where: { id: run.jobId },
      select: { id: true, status: true, kind: true, progress: true, startedAt: true, claimedAt: true, finishedAt: true, cancelRequestedAt: true, tokensIn: true, tokensOut: true, runId: true, evidence: true, task: { select: { title: true } } },
    })) as JobView | null;
    if (!job) continue;
    if (!nodes.has(run.nodeId)) {
      const node = await prisma.nodeAgent.findUnique({ where: { id: run.nodeId }, select: { autonomy: true, status: true } });
      nodes.set(run.nodeId, Boolean(node && node.status === "active" && answersQuestions(node)));
    }
    const done = record(run.watchdog);
    const hits = (await findings(prisma, run, job, nodes.get(run.nodeId) ?? false, now)).filter((hit) => !(hit.condition in done));
    if (!hits.length) continue;
    const card = run.messageId ? await prisma.nodeMessage.findUnique({ where: { id: run.messageId }, select: { data: true } }) : null;
    // A plan step's run still going: its node hears it in the step's own lane, as the step's continuation.
    const step = run.planId && run.planStep && LIVE.has(job.status) && (await stepLive(prisma, run.planId, run.planStep)) && !(await runIsStale(prisma, run)) ? { planId: run.planId, planStep: run.planStep } : {};
    for (const hit of hits) {
      if (!(await claim(prisma, run.id, hit.condition))) continue;
      const queued = await enqueueTurn(app, {
        nodeId: run.nodeId,
        roomId: run.roomId,
        reason: "attention",
        note: hit.condition.startsWith("question:") ? `${hit.note} Otherwise reply exactly (no reply).` : `Attention: ${hit.note} ${ADVICE}`,
        private: record(card?.data).private === true,
        ...step,
      });
      // A paused or removed node hears nothing now; the finding stays open for when it is back.
      if (!queued) {
        await release(prisma, run.id, hit.condition);
        continue;
      }
      raised += 1;
      await recordSessionEvent(prisma, {
        userId: run.userId,
        nodeId: run.nodeId,
        sessionId: run.sessionId ?? run.jobId,
        jobId: run.jobId,
        action: "attention",
        actor: "watchdog",
        via: "watchdog",
        detail: { condition: hit.condition.split(":")[0], note: truncateText(hit.note, 500), ...(hit.detail ?? {}) } as Prisma.InputJsonObject,
      });
    }
  }
  return raised;
}

let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;

/** Checks every `WATCHDOG.intervalMs`; one pass at a time. */
export function startWatchdog(app: FastifyInstance, everyMs = WATCHDOG.intervalMs): void {
  if (timer) return;
  timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void checkSessions(app)
      .catch((error: unknown) => app.log.error({ err: error }, "Node session watchdog failed"))
      .finally(() => {
        checking = false;
      });
  }, everyMs);
  timer.unref?.();
}

export function stopWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
