/**
 * The durable agent queue (docs/06 A5).
 *
 * Postgres holds the queue; this process runs what it claims. Per person, at
 * most `maxConcurrentJobs` run at once. Jobs on the same folder, and a job that
 * continues an unfinished one, wait their turn; unrelated jobs pass them.
 * A job waiting on Needs me gives its slot back until it is answered.
 */
import type { FastifyInstance } from "fastify";
import type { WorkspaceJob } from "@prisma/client";
import { activityIds, isPaused, requestCancel, setPaused } from "../lib/activity.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { HostedAccessError, requireHostAccess } from "../lib/hosted-access.js";
import { sseHub } from "../lib/sse.js";
import { publishDevice } from "../devices/publish.js";
import { executeJob } from "./agent.js";
import { INTERRUPTED_MESSAGE, Interruption, SHUTDOWN } from "./lifecycle.js";
import { killGroup } from "./runner.js";

const DEVICE_LIVE = ["claimed", "running", "waiting_approval", "stopping"] as const;

function askDeviceToStop(userId: string, job: { id: string; deviceId: string }): void {
  sseHub.publish(`device:${job.deviceId}`, { event: "job.cancel", data: { id: job.id } });
  sseHub.publish(userId, { event: "device", data: { id: job.deviceId } });
}

const controllers = new Map<string, AbortController>();
const inFlight = new Map<string, Promise<void>>();

const ACTIVE = ["running", "stopping"] as const;
const UNFINISHED = ["queued", "running", "stopping", "waiting_approval"] as const;

let appRef: FastifyInstance | null = null;
let queueReady: Promise<void> = Promise.resolve();

/** Resolves once jobs left running by the previous process have been marked interrupted. */
export function whenQueueReady(): Promise<void> {
  return queueReady;
}
let ticking = false;
let timer: NodeJS.Timeout | null = null;
let recoverTimer: NodeJS.Timeout | null = null;
let queueStopped = false;
let postgresRetryAt = 0;
let postgresAnnounced = false;

function databaseUnreachable(error: unknown): boolean {
  return error instanceof Error && (error.name === "PrismaClientInitializationError" || /Can't reach database server|ECONNREFUSED/i.test(error.message));
}

/** One line when Postgres is down. The 1.5s queue poll must not reprint the stack. */
function notePostgresDown(app: FastifyInstance, error: unknown): void {
  postgresRetryAt = Date.now() + 10_000;
  if (postgresAnnounced) return;
  postgresAnnounced = true;
  app.log.error({ err: error }, "Postgres is not reachable. The API stays up and will retry.");
}

function notePostgresUp(): void {
  postgresAnnounced = false;
  postgresRetryAt = 0;
}

export function isRunningHere(jobId: string): boolean {
  return controllers.has(jobId);
}

async function claim(job: WorkspaceJob): Promise<boolean> {
  if (job.deviceId) return false;
  const app = appRef!;
  const claimed = await app.prisma.workspaceJob.updateMany({
    where: { id: job.id, status: "queued", deviceId: null },
    data: { status: "running", leaseOwner: String(process.pid), progress: "Starting" },
  });
  return claimed.count === 1;
}

async function slotFree(userId: string, jobId: string): Promise<boolean> {
  const app = appRef!;
  const settings = await loadSettings(app.prisma, userId);
  const running = await app.prisma.workspaceJob.count({ where: { userId, status: { in: [...ACTIVE] }, id: { not: jobId } } });
  return running < settings.orchestration.maxConcurrentJobs && !(await isPaused(app.redis, userId));
}

function start(job: WorkspaceJob): void {
  const app = appRef!;
  const controller = new AbortController();
  controllers.set(job.id, controller);
  const waitForPerson = async <T>(work: () => Promise<T>): Promise<T> => {
    await app.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "waiting_approval" } });
    sseHub.publish(job.userId, { event: "workspace", data: { id: job.id } });
    kick();
    try {
      return await work();
    } finally {
      while (!controller.signal.aborted && !(await slotFree(job.userId, job.id))) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!controller.signal.aborted) {
        await app.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "running" } });
        sseHub.publish(job.userId, { event: "workspace", data: { id: job.id } });
      }
    }
  };
  const done = executeJob(app, job.id, { signal: controller.signal, waitForPerson })
    .catch(async (error: unknown) => {
      app.log.error({ err: error, jobId: job.id }, "agent job crashed");
      await app.prisma.workspaceJob
        .update({ where: { id: job.id }, data: { status: "failed", finishedAt: new Date(), error: error instanceof Error ? error.message : String(error) } })
        .catch(() => undefined);
    })
    .finally(() => {
      controllers.delete(job.id);
      inFlight.delete(job.id);
      killGroup(job.id);
      sseHub.publish(job.userId, { event: "workspace", data: { id: job.id } });
      kick();
    });
  inFlight.set(job.id, done);
}

export async function tickServerQueue(bound?: FastifyInstance): Promise<boolean> {
  const app = bound ?? appRef;
  if (!app) return false;
  const scheduled = bound == null;
  if (scheduled && (ticking || Date.now() < postgresRetryAt)) return false;
  if (scheduled) ticking = true;
  try {
    const queued = (
      await app.prisma.workspaceJob.findMany({ where: { status: "queued", deviceId: null }, orderBy: { sequence: "asc" }, take: 200 })
    ).filter((job) => job.deviceId == null);
    const users = [...new Set(queued.map((job) => job.userId))];
    for (const userId of users) {
      try {
        await requireHostAccess(userId, "Background host workspace execution");
      } catch (error) {
        if (!(error instanceof HostedAccessError)) throw error;
        await app.prisma.workspaceJob.updateMany({
          where: { userId, status: "queued", deviceId: null },
          data: { status: "failed", finishedAt: new Date(), error: error.message },
        });
        app.log.warn({ userId, reason: error.message }, "hosted access denied for queued jobs");
        sseHub.publish(userId, { event: "workspace", data: { action: "access-denied" } });
        continue;
      }
      if (await isPaused(app.redis, userId)) continue;
      const settings = await loadSettings(app.prisma, userId);
      const busy = await app.prisma.workspaceJob.findMany({
        where: { userId, deviceId: null, status: { in: [...UNFINISHED] }, NOT: { status: "queued" } },
        select: { id: true, status: true, resourceKeys: true },
      });
      let running = busy.filter((job) => job.status === "running" || job.status === "stopping").length;
      const held = new Set(busy.flatMap((job) => job.resourceKeys));
      const unfinished = new Set((await app.prisma.workspaceJob.findMany({ where: { userId, status: { in: [...UNFINISHED] } }, select: { id: true } })).map((row) => row.id));
      for (const job of queued.filter((row) => row.userId === userId)) {
        if (running >= settings.orchestration.maxConcurrentJobs) break;
        if (job.continueFromJobId && unfinished.has(job.continueFromJobId)) continue;
        if (job.resourceKeys.some((key) => held.has(key))) continue;
        if (!(await claim(job))) continue;
        running += 1;
        for (const key of job.resourceKeys) held.add(key);
        unfinished.add(job.id);
        start(job);
      }
    }
    notePostgresUp();
    return true;
  } catch (error) {
    if (databaseUnreachable(error)) notePostgresDown(app, error);
    else app.log.error({ err: error }, "agent queue tick failed");
    return false;
  } finally {
    if (scheduled) ticking = false;
  }
}

function tick(): Promise<boolean> {
  return tickServerQueue();
}

export function kick(): void {
  setTimeout(() => void tick(), 10);
}

/**
 * Jobs this process was running when it quit or died cannot be resumed
 * mid-command. They become `interrupted` and wait for Run again; nothing
 * re-runs on its own. Device jobs are left alone: that computer still holds
 * them, and a restart must not fail them or run them with the server's keys.
 */
export async function recoverServerJobs(app: FastifyInstance): Promise<void> {
  const stale = await app.prisma.workspaceJob.findMany({
    where: { deviceId: null, status: { in: ["running", "stopping", "waiting_approval"] } },
    select: { id: true, taskId: true, userId: true, deviceId: true },
  });
  for (const job of stale) {
    if (job.deviceId) continue;
    await markInterrupted(app, job);
  }
}

async function markAllInterrupted(app: FastifyInstance, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const jobs = await app.prisma.workspaceJob.findMany({ where: { id: { in: ids } }, select: { id: true, taskId: true, userId: true } }).catch(() => []);
  for (const job of jobs) await markInterrupted(app, job).catch(() => undefined);
}

async function markInterrupted(app: FastifyInstance, job: { id: string; taskId: string; userId: string }, message = INTERRUPTED_MESSAGE, statuses: string[] = ["running", "stopping", "waiting_approval"]): Promise<void> {
  await app.prisma.workspaceJob.updateMany({
    where: { id: job.id, status: { in: statuses as never } },
    data: { status: "interrupted", finishedAt: new Date(), error: message, progress: "Interrupted" },
  });
  await app.prisma.task.updateMany({ where: { id: job.taskId, status: "in_progress", owner: "agent" }, data: { status: "blocked" } });
  await app.prisma.agentDecision.updateMany({ where: { sessionId: job.id, status: "pending" }, data: { status: "expired" } });
}

/**
 * Postgres being down, or still starting, must not take the API with it.
 * Node treats this rejection as fatal, `tsx watch` restarts, and the site
 * then reports ECONNREFUSED on :4000 for every request.
 */
function bootQueue(app: FastifyInstance, attempt = 0): void {
  queueReady = recoverServerJobs(app)
    .then(() => {
      if (queueStopped) return;
      notePostgresUp();
      kick();
    })
    .catch((error: unknown) => {
      if (databaseUnreachable(error)) notePostgresDown(app, error);
      else app.log.error({ err: error }, "agent queue recover failed");
      if (queueStopped) return;
      const delay = Math.min(200 * 2 ** attempt, 15_000);
      recoverTimer = setTimeout(() => bootQueue(app, attempt + 1), delay);
      recoverTimer.unref();
    });
}

export function startAgentQueue(app: FastifyInstance): () => Promise<void> {
  appRef = app;
  queueStopped = false;
  postgresRetryAt = 0;
  postgresAnnounced = false;
  bootQueue(app);
  timer = setInterval(() => void tick(), 1500);
  return () => {
    queueStopped = true;
    if (timer) clearInterval(timer);
    if (recoverTimer) clearTimeout(recoverTimer);
    recoverTimer = null;
    const running = [...controllers.keys()];
    for (const [id, controller] of controllers) {
      controller.abort(SHUTDOWN);
      killGroup(id);
    }
    const settled = Promise.allSettled([...inFlight.values()]);
    const grace = new Promise((resolve) => setTimeout(resolve, 5000).unref());
    return Promise.race([settled, grace]).then(() => markAllInterrupted(app, running));
  };
}

/**
 * Ends one job as `interrupted` with this message, the way a quit does: a
 * running job is aborted and wraps up, a queued one never starts. Nothing
 * re-runs it; the person uses Run again.
 */
export async function interruptJob(app: FastifyInstance, jobId: string, message: string): Promise<void> {
  const controller = controllers.get(jobId);
  if (controller) {
    controller.abort(new Interruption(message));
    killGroup(jobId);
    await inFlight.get(jobId)?.catch(() => undefined);
    return;
  }
  const job = await app.prisma.workspaceJob.findUnique({ where: { id: jobId }, select: { id: true, taskId: true, userId: true } });
  if (!job) return;
  await markInterrupted(app, job, message, [...UNFINISHED]);
  sseHub.publish(job.userId, { event: "workspace", data: { id: job.id } });
}

/** Stops one job now: a queued job is cancelled, a running one is aborted and its processes killed. */
export async function stopJob(app: FastifyInstance, userId: string, jobId: string): Promise<boolean> {
  const job = await app.prisma.workspaceJob.findFirst({ where: { id: jobId, userId } });
  if (!job) return false;
  if (job.deviceId) {
    if (job.status === "queued") {
      await app.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "cancelled", finishedAt: new Date(), error: "Removed from the queue.", progress: "Cancelled" } });
      await app.prisma.task.updateMany({ where: { id: job.taskId, owner: "agent", status: { in: ["todo", "in_progress"] } }, data: { status: "todo" } });
    } else if (DEVICE_LIVE.includes(job.status as (typeof DEVICE_LIVE)[number])) {
      await app.prisma.workspaceJob.update({
        where: { id: job.id },
        data: { cancelRequestedAt: job.cancelRequestedAt ?? new Date(), progress: "Cancel requested" },
      });
    }
    askDeviceToStop(userId, { id: job.id, deviceId: job.deviceId });
    await appendLedger({ userId, actor: "me", action: "workspace.job.stop", taskId: job.taskId, payload: { jobId: job.id, was: job.status, deviceId: job.deviceId } });
    sseHub.publish(userId, { event: "workspace", data: { id: job.id } });
    return true;
  }
  if (job.status === "queued") {
    await app.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "cancelled", finishedAt: new Date(), error: "Removed from the queue.", progress: "Cancelled" } });
    await app.prisma.task.updateMany({ where: { id: job.taskId, owner: "agent", status: { in: ["todo", "in_progress"] } }, data: { status: "todo" } });
  } else if (UNFINISHED.includes(job.status as (typeof UNFINISHED)[number])) {
    await app.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "stopping", cancelRequestedAt: new Date(), progress: "Stopping" } });
    await requestCancel(app.redis, userId, `job:${job.id}`);
    controllers.get(job.id)?.abort();
    killGroup(job.id);
    if (!controllers.has(job.id)) {
      await app.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "cancelled", finishedAt: new Date(), error: "Stopped." } });
    }
  }
  await appendLedger({ userId, actor: "me", action: "workspace.job.stop", taskId: job.taskId, payload: { jobId: job.id, was: job.status } });
  sseHub.publish(userId, { event: "workspace", data: { id: job.id } });
  kick();
  return true;
}

/**
 * The kill switch. Every in-flight call for this person is flagged and aborted,
 * running commands are killed, and nothing new starts until resume.
 * `cancelQueued` also empties the queue ("Stop everything").
 */
export async function stopEverything(app: FastifyInstance, userId: string, options: { pause: boolean; cancelQueued: boolean }): Promise<{ stopped: number; cancelled: number }> {
  if (options.pause) await setPaused(app.redis, userId, true);
  try {
    const ids = await activityIds(app.redis, userId);
    for (const id of ids) await requestCancel(app.redis, userId, id);
  } catch {
    // Redis down: local controllers below still stop.
  }
  const active = await app.prisma.workspaceJob.findMany({
    where: { userId, status: { in: ["claimed", "running", "stopping", "waiting_approval"] } },
    select: { id: true, deviceId: true },
  });
  for (const job of active) {
    if (job.deviceId) {
      await app.prisma.workspaceJob.update({ where: { id: job.id }, data: { cancelRequestedAt: new Date(), progress: "Cancel requested" } });
      askDeviceToStop(userId, { id: job.id, deviceId: job.deviceId });
      continue;
    }
    controllers.get(job.id)?.abort();
    killGroup(job.id);
    if (!controllers.has(job.id)) {
      await app.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "cancelled", finishedAt: new Date(), error: "Stopped by the kill switch." } });
    } else {
      await app.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "stopping", cancelRequestedAt: new Date() } });
    }
  }
  let cancelled = 0;
  if (options.cancelQueued) {
    const queued = await app.prisma.workspaceJob.findMany({ where: { userId, status: "queued" }, select: { id: true, deviceId: true } });
    for (const job of queued) {
      if (job.deviceId) askDeviceToStop(userId, { id: job.id, deviceId: job.deviceId });
    }
    const result = await app.prisma.workspaceJob.updateMany({
      where: { userId, status: "queued" },
      data: { status: "cancelled", finishedAt: new Date(), error: "Cancelled by Stop everything.", progress: "Cancelled" },
    });
    cancelled = result.count;
  }
  await appendLedger({ userId, actor: "me", action: options.pause ? "agent.pause" : "agent.stop_all", payload: { stopped: active.length, cancelled } });
  sseHub.publish(userId, { event: "workspace", data: { all: true } });
  sseHub.publish(userId, { event: "agent", data: { paused: options.pause } });
  return { stopped: active.length, cancelled };
}

export async function resume(app: FastifyInstance, userId: string): Promise<void> {
  await setPaused(app.redis, userId, false);
  await appendLedger({ userId, actor: "me", action: "agent.resume", payload: {} });
  sseHub.publish(userId, { event: "agent", data: { paused: false } });
  kick();
  // A paused claim returns nothing, and a computer on the event stream does not poll. Wake each computer that has work waiting.
  const waiting = await app.prisma.workspaceJob.findMany({ where: { userId, status: "queued", deviceId: { not: null } }, select: { id: true, deviceId: true } });
  for (const job of waiting) if (job.deviceId) publishDevice(job.deviceId, "job.queued", job.id);
}
