/**
 * Follows the computer jobs nodes started (docs/35 §8). Ensemble's job queue does the work and
 * keeps the record; this only mirrors its status onto the run card and, when the job ends, wakes
 * the node to report the result, unless a newer call of the node took the run over (`quiet`).
 *
 * A worker that reported a structured result (the run's report_result tool, or .ensemble/result.json:
 * WorkspaceJob.report) ends its plan step directly with it: no node turn paraphrases it (B7, B8).
 * A run from an earlier attempt of its step changes nothing (B1 fencing).
 */
import type { FastifyInstance } from "fastify";
import type { NodeRun, Prisma } from "@prisma/client";
import { truncateText } from "../lib/text.js";
import { abortAllTurns, enqueueTurn, recoverTurns } from "./queue.js";
import { updateMessageData } from "./store.js";
import { sweepHelpers } from "./helpers.js";
import { finishStep, runIsStale, stepPending, stepRow } from "./plans.js";
import { startOutbox, stopOutbox } from "./outbox.js";
import { parseReport } from "./report.js";

export const RUN_ENDED = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
/** How often run states are mirrored: a run's end reaches its node within this time. */
const EVERY_MS = Number(process.env.ENSEMBLE_NODE_RUN_POLL_MS ?? 3_000) || 3_000;

let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

type JobView = {
  id: string;
  status: string;
  progress: string | null;
  summary: string | null;
  error: string | null;
  report: Prisma.JsonValue | null;
  task: { title: string } | null;
  device: { name: string } | null;
};

export async function pollRuns(app: FastifyInstance): Promise<void> {
  if (polling) return;
  polling = true;
  const prisma = app.prisma;
  try {
    const runs = await prisma.nodeRun.findMany({ where: { reportedAt: null }, orderBy: { createdAt: "asc" }, take: 200 });
    if (!runs.length) return;
    const jobs = await prisma.workspaceJob.findMany({
      where: { id: { in: runs.map((row) => row.jobId) } },
      select: { id: true, status: true, progress: true, summary: true, error: true, report: true, task: { select: { title: true } }, device: { select: { name: true } } },
    });
    const byId = new Map(jobs.map((row) => [row.id, row as JobView]));
    const cardIds = runs.map((row) => row.messageId).filter((id): id is string => Boolean(id));
    const cards = new Map((await prisma.nodeMessage.findMany({ where: { id: { in: cardIds } } })).map((row) => [row.id, row]));
    for (const run of runs) {
      await followRun(app, run, byId.get(run.jobId) ?? null, run.messageId ? cards.get(run.messageId) ?? null : null).catch((error: unknown) =>
        app.log.error({ err: error, runId: run.id }, "Could not follow a node run"),
      );
    }
  } finally {
    polling = false;
  }
}

async function followRun(app: FastifyInstance, run: NodeRun, job: JobView | null, card: Awaited<ReturnType<FastifyInstance["prisma"]["nodeMessage"]["findUnique"]>>): Promise<void> {
  const prisma = app.prisma;
  const status = job?.status ?? "cancelled";
  const shown = (card?.data ?? {}) as Record<string, unknown>;
  const progress = job?.progress ?? null;
  const report = parseReport(job?.report ?? null);
  if (card && (shown.status !== status || shown.progress !== progress || (RUN_ENDED.has(status) && (shown.summary !== (job?.summary ?? null) || (report && !shown.report))))) {
    await updateMessageData(prisma, card, {
      status,
      progress,
      summary: job?.summary ?? null,
      error: job?.error ? truncateText(job.error, 500) : null,
      computer: job?.device?.name ?? (shown.computer as string | null) ?? null,
      ...(report ? { report } : {}),
    });
  }
  const ended = RUN_ENDED.has(status);
  if (status !== run.status || ended) {
    await prisma.nodeRun.update({ where: { id: run.id }, data: { status, ...(ended ? { reportedAt: new Date() } : {}) } });
  }
  if (!ended) return;
  // A newer call took this run over (steer, replace, stop, pause): the node already knows.
  if (typeof shown.quiet === "string") return;
  // A run from an earlier attempt of its step: the step has moved on.
  if (await runIsStale(prisma, run)) return;
  const step = run.planId && run.planStep ? { planId: run.planId, planStep: run.planStep } : null;

  // The worker reported its result: the step ends with it, unless the run's session still has queued work.
  if (step && report && report.outcome !== "blocked" && status === "succeeded") {
    const row = await stepRow(prisma, step.planId, step.planStep);
    if (row && row.status === "working" && !(await stepPending(prisma, step.planId, step.planStep))) {
      await finishStep(app, step.planId, step.planStep, { status: "done", result: report.summary, report, attempt: row.attempt });
      return;
    }
  }

  const title = job?.task?.title ?? card?.body ?? "the task";
  const words = status === "succeeded" ? "finished" : status === "failed" ? "failed" : status === "interrupted" ? "was interrupted" : "was cancelled";
  const queued = run.sessionId
    ? await prisma.nodeRun.findMany({ where: { sessionId: run.sessionId, nodeId: run.nodeId, reportedAt: null, id: { not: run.id } }, orderBy: { createdAt: "asc" }, select: { jobId: true } })
    : [];
  const next = queued.length
    ? await prisma.workspaceJob.findMany({ where: { id: { in: queued.map((row) => row.jobId) }, status: { in: ["queued", "claimed", "running", "waiting_approval"] } }, select: { task: { select: { title: true } } } })
    : [];
  const named = run.direct ? `“${title.replace(/[“”]/g, "")}”` : `[${title.replace(/[[\]]/g, "")}](ensemble://task/${run.taskId})`;
  const queuedTurn = await enqueueTurn(app, {
    nodeId: run.nodeId,
    roomId: run.roomId,
    reason: "run",
    triggerMessageId: null,
    note: [
      `The ${run.sessionId ? "session" : "computer"} run for ${named} ${words}.${run.sessionId ? ` (Its session's id, for your tools only: ${run.sessionId}.)` : ""}`,
      report ? `The agent reported: ${report.outcome}. ${truncateText(report.summary, 1500)}${report.checks?.length ? `\nChecks: ${report.checks.map((check) => `${check.verdict} ${check.name}`).join("; ")}` : ""}` : "",
      job?.summary ? `Its summary: ${truncateText(job.summary, 3000)}` : "",
      job?.error ? `Error: ${truncateText(job.error, 800)}` : "",
      next.length ? `Still queued in this session: ${next.map((row) => `“${row.task.title}”`).join(", ")}; it goes on by itself.` : "",
      step
        ? "This run was for your plan step. If the step is finished, report it with node_step_report (outcome, summary, commit, checks). If it needs one more change, send your session the next message (node_session_send) and reply (no reply). If it cannot be done, report it blocked."
        : "Report the result to whoever asked (mention them if it was another node), and say what is next.",
    ].filter(Boolean).join("\n"),
    private: (shown as Prisma.JsonObject).private === true,
    ...(step ?? {}),
  });
  // Its node was paused or removed meanwhile: the step ends with what the run reported, or unverified.
  if (step && !queuedTurn) {
    await finishStep(app, step.planId, step.planStep, report ? { status: "done", result: report.summary, report } : { status: status === "succeeded" ? "done" : "stopped", result: job?.summary ?? job?.error ?? `The run ${words}.` });
  }
}

export function startNodeRuns(app: FastifyInstance, everyMs = EVERY_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    void pollRuns(app).catch((error: unknown) => app.log.error({ err: error }, "Node run watcher failed"));
  }, everyMs);
  timer.unref?.();
}

export function stopNodeRuns(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Ensemble Node's background work on the hosted server: waiting turns after a restart, the mission outbox, and run reports. */
export function startNode(app: FastifyInstance): () => void {
  void recoverTurns(app).catch((error: unknown) => app.log.error({ err: error }, "Could not resume node turns"));
  startOutbox(app);
  startNodeRuns(app);
  // Helpers whose task room went quiet (node/helpers.ts).
  const sweep = setInterval(() => {
    void sweepHelpers(app).catch((error: unknown) => app.log.error({ err: error }, "Could not remove idle node helpers"));
  }, 10 * 60_000);
  sweep.unref?.();
  return () => {
    clearInterval(sweep);
    stopNodeRuns();
    stopOutbox();
    abortAllTurns();
  };
}
