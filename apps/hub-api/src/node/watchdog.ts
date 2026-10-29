/**
 * The session watchdog (docs/35 §8.11): code rules over the runs of nodes' sessions, never a model. A run
 * that shows no progress for a while, hits the same error again and again, spends tokens without
 * changing a file, or changes files outside its folder, and an agent's question the node may answer,
 * each give the run's node one attention turn with a note. That is a turn, not a chat message: the node
 * decides whether to steer the session, ask its owner one short question, or leave it. Each condition
 * reaches the node once per run (`node_runs.watchdog`, claimed with a compare-and-set).
 */
import type { FastifyInstance } from "fastify";
import type { NodeRun, Prisma, PrismaClient } from "@prisma/client";
import { truncateText } from "../lib/text.js";
import { enqueueTurn } from "./queue.js";
import { recordSessionEvent } from "./session-queue.js";
import { answersQuestions, questionRefusal } from "./session-questions.js";

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
  /** The same error this many times. */
  repeats: fromEnv("ENSEMBLE_NODE_WATCHDOG_REPEATS", 3),
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

/** What the rules find on one run. Pure apart from reading its events, steps, files and questions. */
async function findings(prisma: PrismaClient, run: NodeRun, job: JobView, answers: boolean, now: number): Promise<Hit[]> {
  const hits: Hit[] = [];
  const title = job.task.title;
  const where = `the run “${truncateText(title, 120)}” in your session ${run.sessionId ?? run.jobId}`;
  const live = LIVE.has(job.status) && !job.cancelRequestedAt;
  const events = live ? await prisma.workspaceEvent.findMany({ where: { jobId: job.id }, orderBy: { sequence: "desc" }, take: 300, select: { kind: true, data: true, createdAt: true } }) : [];
  const steps = live && job.runId ? await prisma.runStep.findMany({ where: { runId: job.runId }, select: { toolCalls: true, tokensIn: true, tokensOut: true, startedAt: true, endedAt: true } }) : [];

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
    const seen = new Map<string, { count: number; text: string }>();
    const note = (text: string) => {
      const key = errorSignature(text);
      if (!key) return;
      seen.set(key, { count: (seen.get(key)?.count ?? 0) + 1, text: truncateText(text, 200) });
    };
    for (const event of events) {
      const data = record(event.data);
      if (event.kind === "engine_retry" && typeof data.reason === "string") note(data.reason);
      if (event.kind === "command" && typeof data.exitCode === "number" && data.exitCode !== 0) note(`\`${String(data.command ?? "a command")}\` failed (exit ${data.exitCode})`);
    }
    for (const step of steps) {
      for (const call of Array.isArray(step.toolCalls) ? step.toolCalls.map(record) : []) {
        if (call.ok === false) note(`${String(call.name ?? "a tool")}: ${String(call.output ?? call.summary ?? "failed").split("\n")[0]}`);
      }
    }
    const worst = [...seen.values()].sort((a, b) => b.count - a.count)[0];
    if (worst && worst.count >= WATCHDOG.repeats) hits.push({ condition: "repeated_error", note: `${where} has hit the same error ${worst.count} times: “${worst.text}”.`, detail: { count: worst.count, error: worst.text } });

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
            `The agent doing ${where} asks: “${truncateText(question.title, 300)}”${options.length ? ` (options: ${options.map((option) => `“${option}”`).join(", ")})` : ""}. It waits in your owner's Needs me (question ${question.id}).`,
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

const ADVICE = "This note is from Ensemble's watchdog, not from your owner. Decide: steer the session (node_session_send with delivery steer), stop it (node_session_stop), ask your owner one short question, or leave it. Reply exactly (no reply) unless your owner needs to know.";

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
    for (const hit of hits) {
      if (!(await claim(prisma, run.id, hit.condition))) continue;
      const queued = await enqueueTurn(app, {
        nodeId: run.nodeId,
        roomId: run.roomId,
        reason: "attention",
        note: hit.condition.startsWith("question:") ? `${hit.note} Otherwise reply exactly (no reply).` : `Attention: ${hit.note} ${ADVICE}`,
        private: record(card?.data).private === true,
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
