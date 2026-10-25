/**
 * A paired computer coming back after an outage (docs/25 §3). The server cannot tell a computer
 * that was switched off from one that only lost its connection, so it waits for the computer:
 * - reattach: the run is still going there, or finished while it was cut off. The interrupted run
 *   gets a new lease and goes on where it is; nothing runs twice.
 * - resume: the computer restarted and its run was cut off. A new run carries it on in the same
 *   folder and agent session, at most `MAX_AUTO_RESUMES` times per task chain and within
 *   `RESUME_WINDOW_MS`, unless the person stopped it, ran it again, or paused the agent.
 * Only a run interrupted by its lease running out qualifies, and only for the computer that ran it
 * (or the same computer paired again, devices/successor.ts).
 */
import { randomBytes } from "node:crypto";
import type { Device, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { isPaused } from "../lib/activity.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { MAX_AUTO_RESUMES, RESUME_WINDOW_MS } from "../remote/contract.js";
import { createJob } from "../workspace/assign.js";
import { repeatAssignment, resumeOf } from "../workspace/repeat.js";
import { isChatTurn } from "../workspace/trust.js";
import { INTERRUPTED_ERROR, LEASE_MS, LIVE_DEVICE_STATUSES } from "./constants.js";
import { publishBrowserDevice } from "./publish.js";
import { blockInProgressTasks, endOpenRuns, expireDeviceDecisions } from "./settle.js";
import { currentDevice } from "./successor.js";

type Refused = { ok: false; status: number; error: string };
const refuse = (status: number, error: string): Refused => ({ ok: false, status, error });
const live = (status: string) => (LIVE_DEVICE_STATUSES as readonly string[]).includes(status);

/** The job if this computer (or its earlier pairing) ran it. */
async function ranHere(prisma: PrismaClient, device: Device, jobId: string) {
  const job = await prisma.workspaceJob.findFirst({
    where: { id: jobId, OR: [{ userId: device.userId }, { runnerAccountId: device.userId }] },
    include: { device: true, task: { select: { id: true, status: true, owner: true } } },
  });
  if (!job?.device) return null;
  if (job.deviceId !== device.id && (await currentDevice(prisma, job.device))?.id !== device.id) return null;
  return job;
}

/** Why a run that is not live cannot be taken back, or null when its lease simply ran out. */
async function notRecoverable(prisma: PrismaClient, job: { id: string; status: string; error: string | null; cancelRequestedAt: Date | null }): Promise<string | null> {
  if (job.cancelRequestedAt || job.status === "cancelled") return "It was stopped on the web.";
  if (job.status !== "interrupted") return "It already ended on the web.";
  if (job.error !== INTERRUPTED_ERROR) return "It was interrupted for another reason; Run again to continue.";
  const after = await prisma.workspaceJob.findFirst({ where: { continueFromJobId: job.id, status: { not: "cancelled" } }, select: { id: true } });
  return after ? "It was run again on the web." : null;
}

export async function reattachJob(
  prisma: PrismaClient,
  device: Device,
  jobId: string,
  input: { leaseToken: string; status: "running" | "waiting_approval" | "finished" },
): Promise<{ ok: true; leaseToken: string; leaseUntil: Date } | Refused> {
  const job = await ranHere(prisma, device, jobId);
  if (!job) return refuse(404, "Job not found.");
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  if (live(job.status)) {
    if (job.leaseToken !== input.leaseToken) return refuse(409, "Another lease holds this run.");
    await prisma.workspaceJob.updateMany({ where: { id: job.id, leaseToken: input.leaseToken }, data: { leaseUntil, deviceId: device.id, leaseOwner: device.id } });
    return { ok: true, leaseToken: input.leaseToken, leaseUntil };
  }
  const why = await notRecoverable(prisma, job);
  if (why) return refuse(409, why);
  const leaseToken = randomBytes(24).toString("base64url");
  const won = await prisma.workspaceJob.updateMany({
    where: { id: job.id, status: "interrupted", error: INTERRUPTED_ERROR, cancelRequestedAt: null },
    data: {
      status: input.status === "waiting_approval" ? "waiting_approval" : "running",
      deviceId: device.id,
      leaseOwner: device.id,
      leaseToken,
      leaseUntil,
      lastProgressAt: now,
      finishedAt: null,
      error: null,
      progress: "Reconnected",
    },
  });
  if (won.count !== 1) return refuse(409, "The run changed on the web while this computer reconnected.");
  if (job.runId) await prisma.run.updateMany({ where: { id: job.runId }, data: { endedAt: null, outcome: null, error: null } });
  if (job.task.owner === "agent" && job.task.status === "blocked") await prisma.task.update({ where: { id: job.taskId }, data: { status: "in_progress", blockedQuestion: undefined } });
  const offlineSeconds = job.finishedAt ? Math.round((now.getTime() - job.finishedAt.getTime()) / 1000) : null;
  await prisma.workspaceEvent.create({ data: { jobId: job.id, kind: "reconnected", data: { offlineSeconds, finished: input.status === "finished" } } });
  await appendLedger({ userId: job.userId, actor: "system", action: "workspace.job.reattached", taskId: job.taskId, payload: { jobId: job.id, deviceId: device.id, offlineSeconds } });
  sseHub.publish(job.userId, { event: "workspace", data: { id: job.id } });
  sseHub.publish(job.userId, { event: "task", data: { id: job.taskId, action: "agent" } });
  publishBrowserDevice(device.userId, device.id);
  return { ok: true, leaseToken, leaseUntil };
}

export async function resumeJob(
  prisma: PrismaClient,
  redis: Redis,
  device: Device,
  jobId: string,
  input: { leaseToken: string; reason: string },
): Promise<{ ok: true; jobId: string } | Refused> {
  let job = await ranHere(prisma, device, jobId);
  if (!job) return refuse(404, "Job not found.");
  if (job.runnerAccountId) return refuse(409, "A run in a shared space is not carried on by itself. Run it again from the task.");
  if (isChatTurn(job.context)) return refuse(409, "A chat message is not carried on by itself.");
  const now = new Date();
  // Restarted before the lease ran out: the run ends here as interrupted, as the lease sweep would end it.
  if (live(job.status)) {
    if (job.leaseToken !== input.leaseToken) return refuse(409, "Another lease holds this run.");
    const ended = await prisma.workspaceJob.updateMany({
      where: { id: job.id, leaseToken: input.leaseToken, status: { in: [...LIVE_DEVICE_STATUSES] } },
      data: { status: "interrupted", finishedAt: now, error: INTERRUPTED_ERROR, progress: "Interrupted", leaseToken: null },
    });
    if (ended.count === 1) {
      await expireDeviceDecisions(prisma, [job.id]);
      await endOpenRuns(prisma, [job.id], INTERRUPTED_ERROR);
      await blockInProgressTasks(prisma, [job.taskId]);
      await prisma.workspaceEvent.create({ data: { jobId: job.id, kind: "interrupted", data: { reason: "computer_restarted" } } });
    }
    job = (await ranHere(prisma, device, jobId))!;
  }
  const why = await notRecoverable(prisma, job);
  if (why) return refuse(409, why);
  if (await isPaused(redis, job.userId)) return refuse(409, "The agent is paused on the web. Run it again after you resume it.");
  if (job.finishedAt && now.getTime() - job.finishedAt.getTime() > RESUME_WINDOW_MS) return refuse(409, "It was interrupted more than a day ago. Run it again to continue.");
  const attempt = (resumeOf(job.context)?.attempt ?? 0) + 1;
  if (attempt > MAX_AUTO_RESUMES) {
    const note = `${INTERRUPTED_ERROR} It was not carried on by itself: this task was cut off ${attempt} times in a row. Run again to continue.`;
    await prisma.workspaceJob.updateMany({ where: { id: job.id, status: "interrupted" }, data: { error: note } });
    sseHub.publish(job.userId, { event: "workspace", data: { id: job.id } });
    return refuse(409, note);
  }
  const reason = input.reason.trim().slice(0, 300) || "the computer restarted while it was running";
  const created = await createJob(prisma, job.userId, { ...repeatAssignment(job), deviceId: device.id }, { retryOf: job.id, actor: "system", context: { resumeOf: { reason, attempt } } });
  if (!created) return refuse(404, "The task is gone.");
  await prisma.workspaceEvent.create({ data: { jobId: job.id, kind: "resumed_as", data: { jobId: created.jobId, attempt, of: MAX_AUTO_RESUMES } } });
  await appendLedger({ userId: job.userId, actor: "system", action: "workspace.job.resumed", taskId: job.taskId, payload: { jobId: job.id, next: created.jobId, deviceId: device.id, attempt } });
  return { ok: true, jobId: created.jobId };
}
