/**
 * Follows the computer jobs nodes started (docs/35 §9). Ensemble's job queue does the work and
 * keeps the record; this only mirrors its status onto the run card and, when the job ends, wakes
 * the node to report the result.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { truncateText } from "../lib/text.js";
import { abortAllTurns, enqueueTurn, recoverTurns } from "./queue.js";
import { updateMessageData } from "./store.js";

export const RUN_ENDED = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const EVERY_MS = 15_000;

let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

export async function pollRuns(app: FastifyInstance): Promise<void> {
  if (polling) return;
  polling = true;
  const prisma = app.prisma;
  try {
    const runs = await prisma.nodeRun.findMany({ where: { reportedAt: null }, orderBy: { createdAt: "asc" }, take: 200 });
    for (const run of runs) {
      const job = await prisma.workspaceJob.findUnique({
        where: { id: run.jobId },
        select: { status: true, progress: true, summary: true, error: true, task: { select: { title: true } }, device: { select: { name: true } } },
      });
      const status = job?.status ?? "cancelled";
      const card = run.messageId ? await prisma.nodeMessage.findUnique({ where: { id: run.messageId } }) : null;
      const shown = (card?.data ?? {}) as Record<string, unknown>;
      const progress = job?.progress ?? null;
      if (card && (shown.status !== status || shown.progress !== progress || (RUN_ENDED.has(status) && shown.summary !== (job?.summary ?? null)))) {
        await updateMessageData(prisma, card, {
          status,
          progress,
          summary: job?.summary ?? null,
          error: job?.error ? truncateText(job.error, 500) : null,
          computer: job?.device?.name ?? (shown.computer as string | null) ?? null,
        });
      }
      const ended = RUN_ENDED.has(status);
      if (status !== run.status || ended) {
        await prisma.nodeRun.update({ where: { id: run.id }, data: { status, ...(ended ? { reportedAt: new Date() } : {}) } });
      }
      if (!ended) continue;
      const title = job?.task.title ?? card?.body ?? "the task";
      const words = status === "succeeded" ? "finished" : status === "failed" ? "failed" : status === "interrupted" ? "was interrupted" : "was cancelled";
      await enqueueTurn(app, {
        nodeId: run.nodeId,
        roomId: run.roomId,
        reason: "run",
        triggerMessageId: null,
        note: [
          `The computer run for [${title.replace(/[[\]]/g, "")}](ensemble://task/${run.taskId}) ${words}.`,
          job?.summary ? `Its summary: ${truncateText(job.summary, 3000)}` : "",
          job?.error ? `Error: ${truncateText(job.error, 800)}` : "",
          "Report the result to whoever asked (mention them if it was another node), and say what is next.",
        ].filter(Boolean).join("\n"),
        private: (shown as Prisma.JsonObject).private === true,
      });
    }
  } finally {
    polling = false;
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

/** Ensemble Node's background work on the hosted server: waiting turns after a restart, and run reports. */
export function startNode(app: FastifyInstance): () => void {
  void recoverTurns(app).catch((error: unknown) => app.log.error({ err: error }, "Could not resume node turns"));
  startNodeRuns(app);
  return () => {
    stopNodeRuns();
    abortAllTurns();
  };
}
