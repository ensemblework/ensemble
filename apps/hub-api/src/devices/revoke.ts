/**
 * Unlist a computer, kill its key, and stop the jobs it still holds.
 * Revoking the device and revoking its key are the same action.
 */
import type { Device, PrismaClient } from "@prisma/client";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { DEVICE_REMOVED, LIVE_DEVICE_STATUSES } from "./constants.js";
import { publishBrowserDevice } from "./publish.js";
import { publishDeviceRevoked } from "./revoke-notify.js";
import { blockInProgressTasks, expireDeviceDecisions } from "./settle.js";

export async function revokePairedDevice(prisma: PrismaClient, userId: string, device: Device): Promise<void> {
  const now = new Date();
  const affected = await prisma.workspaceJob.findMany({
    where: { deviceId: device.id, status: { in: [...LIVE_DEVICE_STATUSES, "queued"] } },
    select: { id: true, taskId: true },
  });
  await prisma.device.update({ where: { id: device.id }, data: { revokedAt: now } });
  await prisma.apiToken.update({ where: { id: device.tokenId }, data: { revokedAt: now } });
  publishDeviceRevoked(device.id);
  await prisma.workspaceJob.updateMany({
    where: { deviceId: device.id, status: { in: [...LIVE_DEVICE_STATUSES] } },
    data: { status: "interrupted", finishedAt: now, progress: "Interrupted", error: DEVICE_REMOVED, leaseToken: null },
  });
  await prisma.workspaceJob.updateMany({
    where: { deviceId: device.id, status: "queued" },
    data: { status: "failed", finishedAt: now, progress: "Failed", error: DEVICE_REMOVED },
  });
  await expireDeviceDecisions(prisma, affected.map((job) => job.id));
  await blockInProgressTasks(prisma, affected.map((job) => job.taskId));
  await appendLedger({ userId, actor: "me", action: "device.revoke", payload: { deviceId: device.id } });
  publishBrowserDevice(userId, device.id);
  sseHub.publish(userId, { event: "workspace", data: { id: device.id } });
}
