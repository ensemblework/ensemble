/**
 * A device job that stops — lease expiry, revoke, or a finished outcome —
 * must not leave its Needs me card pending or its task in progress.
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
