/**
 * A device job that stops — lease expiry, revoke, or a finished outcome —
 * must not leave its Needs me card pending, its task in progress, or its run open.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export async function expireDeviceDecisions(db: Db, jobIds: string[]): Promise<void> {
  if (!jobIds.length) return;
  await db.agentDecision.updateMany({
    where: { sessionId: { in: jobIds }, status: "pending" },
    data: { status: "expired" },
  });
}

/** Same task move as the lease sweep: an agent task still in progress becomes blocked. */
export async function blockInProgressTasks(db: Db, taskIds: string[]): Promise<void> {
  const ids = [...new Set(taskIds)];
  if (!ids.length) return;
  await db.task.updateMany({
    where: { id: { in: ids }, status: "in_progress", owner: "agent" },
    data: { status: "blocked" },
  });
}

/** The runs of jobs that stopped without finishing end with them, so the Runs page stops showing them as running. */
export async function endOpenRuns(db: Db, jobIds: string[], error: string): Promise<void> {
  if (!jobIds.length) return;
  const jobs = await db.workspaceJob.findMany({ where: { id: { in: jobIds }, runId: { not: null } }, select: { runId: true } });
  const runIds = jobs.map((job) => job.runId).filter((id): id is string => Boolean(id));
  if (!runIds.length) return;
  await db.run.updateMany({ where: { id: { in: runIds }, endedAt: null }, data: { endedAt: new Date(), outcome: "cancelled", error } });
}
