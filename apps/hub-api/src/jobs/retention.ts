/**
 * Trash purge, completed-item ageing, and completion records for a future skill miner.
 * The scheduler calls this on the daily slot and again on startup if a day was missed.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";
import { appendLedger } from "../lib/ledger.js";
import { purgeDeletedStandalonePages } from "../pages/store.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface RetentionCounts {
  completionRecords: number;
  completedSoftDeleted: number;
  purged: number;
  historyPurged: number;
  logChunksPurged: number;
}

/** Remote-task log chunks. Fixed, not a per-user setting. See docs/25 §3.3. */
const LOG_CHUNK_RETENTION_DAYS = 30;
const LOG_CHUNK_BATCH = 200;

/**
 * Delete this user's log chunks older than `cutoff`, a batch at a time.
 * The created_at index is what the scan uses. A short batch keeps one
 * daily tick from holding a lock across the whole table.
 */
export async function deleteOldLogChunks(
  prisma: PrismaClient,
  userId: string,
  cutoff: Date,
  batchSize = LOG_CHUNK_BATCH,
): Promise<number> {
  if (batchSize < 1) return 0;
  let deleted = 0;
  for (;;) {
    const rows = await prisma.workspaceLogChunk.findMany({
      where: { createdAt: { lt: cutoff }, job: { userId } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
      take: batchSize,
    });
    if (rows.length === 0) break;
    const result = await prisma.workspaceLogChunk.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    deleted += result.count;
    if (result.count === 0) break;
  }
  return deleted;
}

export function completionSummary(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

export async function runRetention(
  app: FastifyInstance,
  userId: string,
  options: { deletedDays: number; completedDays: number; historyDays?: number; logChunkBatchSize?: number },
): Promise<RetentionCounts> {
  const now = new Date();
  const deletedCutoff = new Date(now.getTime() - options.deletedDays * 86_400_000);
  const completedCutoff = new Date(now.getTime() - options.completedDays * 86_400_000);
  const counts: RetentionCounts = { completionRecords: 0, completedSoftDeleted: 0, purged: 0, historyPurged: 0, logChunksPurged: 0 };

  const tasks = await app.prisma.task.findMany({
    where: {
      userId,
      deletedAt: null,
      pinned: false,
      completedAt: { lt: completedCutoff },
      status: { in: ["done", "dropped"] },
    },
    include: { project: { select: { name: true } }, repo: { select: { fullName: true } } },
  });
  const deliverables = await app.prisma.deliverable.findMany({
    where: { userId, deletedAt: null, pinned: false, status: "completed", completedAt: { lt: completedCutoff } },
    include: { project: { select: { id: true, name: true } } },
  });

  if (tasks.length || deliverables.length) {
    await app.prisma.$transaction(async (tx) => {
      for (const task of tasks) {
        await tx.completionRecord.create({
          data: {
            userId,
            entityKind: task.status === "proposed" ? "todo" : "task",
            entityId: task.id,
            title: task.title,
            summary: completionSummary(task.description || task.notes),
            skillIds: task.skillIds,
            people: task.people,
            projectId: task.projectId,
            projectName: task.project?.name ?? null,
            repoId: task.repoId,
            repoFullName: task.repo?.fullName ?? null,
            outcome: task.status === "dropped" ? "dropped" : "done",
            completedAt: task.completedAt,
            sourceJson: {
              status: task.status,
              priority: task.priority,
              complexity: task.complexity,
              due: task.due?.toISOString() ?? null,
              notes: task.notes.slice(0, 280),
            },
          },
        });
        await tx.task.update({ where: { id: task.id }, data: { deletedAt: now } });
        counts.completionRecords += 1;
        counts.completedSoftDeleted += 1;
      }
      for (const row of deliverables) {
        await tx.completionRecord.create({
          data: {
            userId,
            entityKind: "deliverable",
            entityId: row.id,
            title: row.title,
            summary: completionSummary(row.notes),
            projectId: row.projectId,
            projectName: row.project?.name ?? null,
            outcome: "completed",
            completedAt: row.completedAt,
            sourceJson: { status: row.status, due: row.due?.toISOString() ?? null },
          },
        });
        await tx.deliverable.update({ where: { id: row.id }, data: { deletedAt: now } });
        counts.completionRecords += 1;
        counts.completedSoftDeleted += 1;
      }
    });
  }

  counts.purged += await hardPurge(app.prisma, userId, deletedCutoff);
  if (options.historyDays && options.historyDays > 0) {
    const historyCutoff = new Date(now.getTime() - options.historyDays * 86_400_000);
    const [ledger, transitions] = await app.prisma.$transaction([
      app.prisma.auditLedger.deleteMany({ where: { userId, ts: { lt: historyCutoff } } }),
      app.prisma.taskTransition.deleteMany({ where: { userId, at: { lt: historyCutoff } } }),
    ]);
    counts.historyPurged = ledger.count + transitions.count;
  }
  const logCutoff = new Date(now.getTime() - LOG_CHUNK_RETENTION_DAYS * 86_400_000);
  counts.logChunksPurged = await deleteOldLogChunks(app.prisma, userId, logCutoff, options.logChunkBatchSize);
  await appendLedger({
    userId,
    actor: "system",
    action: "retention.purged",
    payload: { ...counts, deletedDays: options.deletedDays, completedDays: options.completedDays, historyDays: options.historyDays ?? null },
  });
  return counts;
}

async function hardPurge(prisma: PrismaClient, userId: string, cutoff: Date): Promise<number> {
  const where = { userId, deletedAt: { lt: cutoff } };
  const pages = await purgeDeletedStandalonePages(prisma, userId, cutoff);
  const counts = await prisma.$transaction([
    prisma.task.deleteMany({ where }),
    prisma.project.deleteMany({ where }),
    prisma.person.deleteMany({ where }),
    prisma.skill.deleteMany({ where }),
    prisma.document.deleteMany({ where }),
    prisma.artifact.deleteMany({ where }),
    prisma.repo.deleteMany({ where }),
    prisma.deliverable.deleteMany({ where }),
    prisma.reminder.deleteMany({ where: { userId, OR: [{ deletedAt: { lt: cutoff } }, { dismissedAt: { lt: cutoff } }] } }),
    prisma.pageDiscussion.deleteMany({ where }),
    prisma.agentDecision.deleteMany({ where: { userId, requestedAt: { lt: cutoff }, status: { not: "pending" } } }),
    prisma.notification.deleteMany({ where: { userId, createdAt: { lt: cutoff } } }),
    prisma.meetingSession.deleteMany({ where }),
    prisma.blockDiagram.deleteMany({ where }),
  ]);
  return pages + counts.reduce((sum: number, row: { count: number }) => sum + row.count, 0);
}

/** Fire reminders whose nextNotificationAt is due, including ones missed while the process was down. */
export async function dispatchDueReminders(app: FastifyInstance, userId: string): Promise<number> {
  const due = await app.prisma.reminder.findMany({
    where: {
      userId,
      deletedAt: null,
      dismissedAt: null,
      nextNotificationAt: { lte: new Date() },
    },
    take: 50,
  });
  let sent = 0;
  for (const reminder of due) {
    const claimed = await app.prisma.$transaction(async (tx) => {
      const updated = await tx.reminder.updateMany({
        where: { id: reminder.id, nextNotificationAt: reminder.nextNotificationAt },
        data: { lastNotifiedAt: new Date(), nextNotificationAt: null, notificationSequence: { increment: 1 } },
      });
      if (updated.count !== 1) return false;
      await tx.notification.create({
        data: {
          userId,
          kind: "reminder",
          title: reminder.title,
          body: `${reminder.dueDate}${reminder.dueTime ? ` ${reminder.dueTime}` : ""}`,
          url: "/today",
        },
      });
      return true;
    });
    if (!claimed) continue;
    const { sseHub } = await import("../lib/sse.js");
    sseHub.publish(userId, { event: "reminder.due", data: { id: reminder.id, title: reminder.title } });
    sent += 1;
  }
  return sent;
}
