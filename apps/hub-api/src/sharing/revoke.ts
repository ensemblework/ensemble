/**
 * What has to happen the moment someone loses access, beyond deleting the row: their open
 * event streams close, they leave the presence room, and agent runs they queued on their own
 * computer in that space are cancelled.
 */
import type { PrismaClient } from "@prisma/client";
import { publishDevice } from "../devices/publish.js";
import { sseHub } from "../lib/sse.js";
import { dropPresence } from "./presence.js";

const LIVE = ["claimed", "running", "waiting_approval", "stopping"] as const;

/** Cancels runs `accountId` started on their computer in these spaces. */
export async function cancelRunnerJobs(db: PrismaClient, spaceIds: string[], accountId: string): Promise<number> {
  const jobs = await db.workspaceJob.findMany({
    where: { userId: { in: spaceIds }, runnerAccountId: accountId, status: { in: ["queued", ...LIVE] } },
    select: { id: true, status: true, deviceId: true, userId: true },
  });
  const now = new Date();
  for (const job of jobs) {
    if (job.status === "queued") {
      await db.workspaceJob.updateMany({
        where: { id: job.id, status: "queued" },
        data: { status: "cancelled", finishedAt: now, error: "Removed from the shared space.", progress: "Cancelled" },
      });
    } else {
      await db.workspaceJob.updateMany({ where: { id: job.id }, data: { cancelRequestedAt: now, progress: "Cancel requested" } });
    }
    if (job.deviceId) publishDevice(job.deviceId, "job.cancel", job.id);
    sseHub.publish(job.userId, { event: "workspace", data: { id: job.id } });
  }
  return jobs.length;
}

/** A member left or was removed (or the contact was): everything live of theirs in these spaces stops. */
export async function revokeMember(db: PrismaClient, spaceIds: string[], accountId: string): Promise<void> {
  await cancelRunnerJobs(db, spaceIds, accountId);
  for (const spaceId of spaceIds) {
    sseHub.close(spaceId, (listener) => listener.accountId === accountId && !listener.owner);
    dropPresence(spaceId, accountId);
  }
}

/** One item stopped being shared with someone. */
export function revokeShare(spaceId: string, accountId: string, shareId: string): void {
  sseHub.close(spaceId, (listener) => listener.accountId === accountId && listener.share?.shareId === shareId);
  dropPresence(spaceId, accountId);
}
