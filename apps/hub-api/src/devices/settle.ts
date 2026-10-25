/**
 * A device job that stops — lease expiry, revoke, or a finished outcome —
 * must not leave its Needs me card pending, its task in progress, or its run open.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { publishDevice } from "./publish.js";

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

/**
 * A run that ended frees one of the person's concurrent slots (`maxConcurrentJobs`). The server's
 * claim refuses past the limit, so computers with work still queued are woken to claim again.
 */
export async function wakeQueuedDevices(db: Db, userId: string): Promise<void> {
  const queued = await db.workspaceJob.findMany({ where: { userId, status: "queued", deviceId: { not: null } }, select: { id: true, deviceId: true }, orderBy: { sequence: "asc" }, take: 50 });
  const seen = new Set<string>();
  for (const job of queued) {
    if (!job.deviceId || seen.has(job.deviceId)) continue;
    seen.add(job.deviceId);
    publishDevice(job.deviceId, "job.queued", job.id);
  }
}

/** How long a computer has to confirm a Stop before Ensemble ends the run here. */
export const STOP_CONFIRM_MS = 3 * 60_000;

/**
 * Runs on a computer that is online but has not ended them within `STOP_CONFIRM_MS` of a Stop
 * (its runtime stuck on a command, say) end here as stopped: the slot frees, Needs me closes and
 * the task goes back to To do. The computer keeps getting the stop with each heartbeat, and a
 * result it sends later is not taken.
 */
export async function endUnconfirmedStops(db: Db, deviceId: string, deviceName: string, now = new Date()): Promise<string[]> {
  const late = await db.workspaceJob.findMany({
    where: { deviceId, cancelRequestedAt: { lt: new Date(now.getTime() - STOP_CONFIRM_MS) }, status: { in: ["claimed", "running", "waiting_approval", "stopping"] } },
    select: { id: true, taskId: true, userId: true },
  });
  if (!late.length) return [];
  const ids = late.map((job) => job.id);
  const error = `Stopped. ${deviceName} did not confirm the stop within ${Math.round(STOP_CONFIRM_MS / 60_000)} minutes, so Ensemble ended the run here.`;
  await db.workspaceJob.updateMany({ where: { id: { in: ids } }, data: { status: "cancelled", finishedAt: now, error, progress: "Stopped", leaseToken: null } });
  await expireDeviceDecisions(db, ids);
  await endOpenRuns(db, ids, error);
  await db.task.updateMany({ where: { id: { in: [...new Set(late.map((job) => job.taskId))] }, owner: "agent", status: "in_progress" }, data: { status: "todo" } });
  for (const userId of new Set(late.map((job) => job.userId))) await wakeQueuedDevices(db, userId);
  return ids;
}
