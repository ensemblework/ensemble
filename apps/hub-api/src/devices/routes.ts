/**
 * Device routes from docs/25 §4.3. Shapes here are the contract the desktop
 * client codes against. A device token reaches only `/api/devices/self/*`,
 * and only the device that token belongs to.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Device, Prisma } from "@prisma/client";
import { requireBrowserSession } from "../bridge/auth.js";
import { isPaused } from "../lib/activity.js";
import { newApiToken, sha256 } from "../lib/auth.js";
import { requireVerifiedUser } from "../lib/hosted-access.js";
import { publicDecision, waitFor } from "../lib/decisions.js";
import { appendLedger } from "../lib/ledger.js";
import { redactText } from "../lib/redact.js";
import { sseHandler, sseHub } from "../lib/sse.js";
import {
  DEVICE_EVENT_KINDS,
  LEASE_MS,
  LEASE_REJECTED,
  LIVE_DEVICE_STATUSES,
  LOG_TRUNCATED,
  LOG_TRUNCATED_SEQ,
  MAX_CHUNK_BYTES,
  MAX_JOB_LOG_BYTES,
  deviceOnline,
  serverRunnerEnabled,
} from "./constants.js";
import { finishDeviceJob, type DeviceResult } from "./finish.js";
import { folderLabels, rejectPathLabels, runBranchPushEnabled } from "./labels.js";
import { createDevicePairing } from "./pairing.js";
import { publishBrowserDevice, publishDevice } from "./publish.js";
import { revokePairedDevice } from "./revoke.js";

const Register = z.object({
  code: z.string().trim().min(8).max(8),
  name: z.string().min(1).max(80),
  platform: z.enum(["macos", "linux", "windows"]),
  appVersion: z.string().max(40).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

const Heartbeat = z.object({
  runningJobIds: z.array(z.string().uuid()).max(100).default([]),
  appVersion: z.string().max(40).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

const Progress = z.object({
  leaseToken: z.string().min(1).max(200),
  status: z.enum(["running"]).optional(),
  progress: z.string().max(200).default(""),
  events: z
    .array(z.object({ kind: z.enum(DEVICE_EVENT_KINDS), data: z.record(z.string(), z.unknown()).optional() }))
    .max(50)
    .default([]),
  logs: z
    .object({
      seqFrom: z.number().int().min(0).max(LOG_TRUNCATED_SEQ - 1),
      seqTo: z.number().int().min(0),
      text: z.string().max(MAX_CHUNK_BYTES * 4),
    })
    .optional(),
});

const Ask = z.object({
  leaseToken: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  toolName: z.string().max(80).optional(),
  command: z.string().max(2000).optional(),
  options: z.array(z.string().max(200)).max(12).optional(),
  tier: z.enum(["ordinary", "run_branch_push", "high_risk"]).default("ordinary"),
  event: z.enum(["question", "permission"]).optional(),
});

function httpsResult(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

const Result = z.object({
  kind: z.enum(["pr", "commit", "branch"]),
  url: z.string().min(1).max(2000).refine(httpsResult, "Result links must be https."),
  sha: z.string().max(80).optional(),
});

const Complete = z.object({
  leaseToken: z.string().min(1).max(200),
  outcome: z.enum(["succeeded", "failed", "cancelled", "blocked"]),
  summary: z.string().max(8000).default(""),
  results: z.array(Result).max(20).default([]),
});

function deviceJson(device: Device, now = Date.now()) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    appVersion: device.appVersion,
    capabilities: device.capabilities,
    folders: folderLabels(device.capabilities),
    runBranchPush: runBranchPushEnabled(device.capabilities),
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    createdAt: device.createdAt.toISOString(),
    online: device.revokedAt ? false : deviceOnline(device.lastSeenAt, now),
    revokedAt: device.revokedAt?.toISOString() ?? null,
  };
}

async function ownDevice(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<Device | null> {
  if (request.tokenScope !== "device" || !request.tokenId) {
    await reply.code(403).send({ error: "Only the paired computer can call this." });
    return null;
  }
  const device = await app.prisma.device.findUnique({ where: { tokenId: request.tokenId } });
  if (!device || device.revokedAt || device.userId !== request.userId) {
    await reply.code(401).send({ error: "This computer is no longer paired." });
    return null;
  }
  await requireVerifiedUser(device.userId);
  return device;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (typeof value === "string") return redactText(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) out[key] = redactValue(item, depth + 1);
    return out;
  }
  return value;
}

type HeldJob = NonNullable<Awaited<ReturnType<typeof loadHeldJob>>>;

type HeldLease = { ok: false; status: 404 | 409; message: string } | { ok: true; job: HeldJob; now: Date };

/** Jobs this computer runs: its owner's own, and theirs in spaces shared with them. */
function runsOn(device: Device) {
  return { deviceId: device.id, OR: [{ userId: device.userId }, { runnerAccountId: device.userId }] };
}

function loadHeldJob(app: FastifyInstance, device: Device, jobId: string) {
  return app.prisma.workspaceJob.findFirst({
    where: { id: jobId, ...runsOn(device) },
    include: { task: { select: { id: true, title: true, status: true, owner: true, complexity: true } } },
  });
}

/** A run in someone else's space only while its runner is still a member there. */
async function stillMember(app: FastifyInstance, job: { userId: string; runnerAccountId: string | null }): Promise<boolean> {
  if (!job.runnerAccountId) return true;
  return Boolean(await app.prisma.spaceMember.findUnique({ where: { spaceId_accountId: { spaceId: job.userId, accountId: job.runnerAccountId } }, select: { id: true } }));
}

async function holdLease(app: FastifyInstance, device: Device, jobId: string, leaseToken: string): Promise<HeldLease> {
  const now = new Date();
  const job = await loadHeldJob(app, device, jobId);
  if (!job || !(await stillMember(app, job))) return { ok: false, status: 404, message: "Job not found." };
  if (job.leaseToken !== leaseToken || !job.leaseUntil || job.leaseUntil <= now || !LIVE_DEVICE_STATUSES.includes(job.status as (typeof LIVE_DEVICE_STATUSES)[number])) {
    return { ok: false, status: 409, message: LEASE_REJECTED };
  }
  return { ok: true, job, now };
}

async function storeLog(app: FastifyInstance, jobId: string, logs: { seqFrom: number; seqTo: number; text: string }): Promise<{ stored: boolean; duplicate: boolean; truncated: boolean }> {
  const text = redactText(logs.text);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_CHUNK_BYTES) {
    const error = Object.assign(new Error("A log chunk can be at most 64 KB."), { statusCode: 413 });
    throw error;
  }
  const totals = await app.prisma.workspaceLogChunk.aggregate({ where: { jobId }, _sum: { bytes: true } });
  const used = totals._sum.bytes ?? 0;
  const marker = await app.prisma.workspaceLogChunk.findUnique({ where: { jobId_seqFrom: { jobId, seqFrom: LOG_TRUNCATED_SEQ } } });
  if (marker || used >= MAX_JOB_LOG_BYTES || used + bytes > MAX_JOB_LOG_BYTES) {
    if (!marker) {
      await app.prisma.workspaceLogChunk.create({
        data: { jobId, seqFrom: LOG_TRUNCATED_SEQ, seqTo: LOG_TRUNCATED_SEQ, text: LOG_TRUNCATED, bytes: Buffer.byteLength(LOG_TRUNCATED) },
      });
    }
    return { stored: false, duplicate: false, truncated: true };
  }
  try {
    await app.prisma.workspaceLogChunk.create({
      data: { jobId, seqFrom: logs.seqFrom, seqTo: Math.max(logs.seqTo, logs.seqFrom), text, bytes },
    });
    return { stored: true, duplicate: false, truncated: false };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002") {
      return { stored: false, duplicate: true, truncated: false };
    }
    throw error;
  }
}

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.post("/api/devices/pair", async (request, reply) => {
    requireBrowserSession(request);
    await requireVerifiedUser(request.userId);
    const { code, expiresAt } = await createDevicePairing(prisma, request.userId);
    return reply.code(201).send({ code, expiresAt: expiresAt.toISOString() });
  });

  app.post("/api/devices/register", async (request, reply) => {
    const body = Register.parse(request.body);
    const pathError = rejectPathLabels(body.capabilities ?? {});
    if (pathError) return reply.code(400).send({ error: pathError });
    const pairing = await prisma.devicePairing.findUnique({ where: { codeHash: sha256(body.code.trim().toUpperCase()) } });
    if (!pairing || pairing.usedAt || pairing.expiresAt <= new Date()) return reply.code(401).send({ error: "That pairing code is not valid." });
    await requireVerifiedUser(pairing.userId);
    const won = await prisma.devicePairing.updateMany({
      where: { id: pairing.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (won.count !== 1) return reply.code(401).send({ error: "That pairing code is not valid." });
    const minted = newApiToken();
    const capabilities = (body.capabilities ?? {}) as Prisma.InputJsonValue;
    const token = await prisma.apiToken.create({
      data: { userId: pairing.userId, name: `Device · ${body.name}`.slice(0, 80), tokenHash: minted.hash, prefix: minted.prefix, scope: "device" },
    });
    const device = await prisma.device.create({
      data: {
        userId: pairing.userId,
        name: body.name,
        platform: body.platform,
        appVersion: body.appVersion,
        tokenId: token.id,
        capabilities,
      },
    });
    await prisma.devicePairing.update({ where: { id: pairing.id }, data: { deviceId: device.id } });
    await appendLedger({ userId: pairing.userId, actor: "me", action: "device.pair", payload: { deviceId: device.id, name: device.name, platform: device.platform } });
    publishBrowserDevice(pairing.userId, device.id);
    return reply.code(201).send({ token: minted.token, device: { id: device.id, name: device.name, platform: device.platform } });
  });

  app.get("/api/devices", async (request) => {
    requireBrowserSession(request);
    const devices = await prisma.device.findMany({ where: { userId: request.userId, revokedAt: null }, orderBy: { createdAt: "asc" } });
    return { serverRunner: serverRunnerEnabled(), devices: devices.map((device) => deviceJson(device)) };
  });

  app.delete("/api/devices/:id", async (request, reply) => {
    requireBrowserSession(request);
    const { id } = request.params as { id: string };
    const device = await prisma.device.findFirst({ where: { id, userId: request.userId, revokedAt: null } });
    if (!device) return reply.code(404).send({ error: "Computer not found." });
    await revokePairedDevice(prisma, request.userId, device);
    return reply.code(204).send();
  });

  app.delete("/api/devices/self", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    await revokePairedDevice(prisma, request.userId, device);
    return reply.code(204).send();
  });

  app.post("/api/devices/self/heartbeat", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const body = Heartbeat.parse(request.body ?? {});
    const pathError = body.capabilities ? rejectPathLabels(body.capabilities) : null;
    if (pathError) return reply.code(400).send({ error: pathError });
    const now = new Date();
    await prisma.device.update({
      where: { id: device.id },
      data: {
        lastSeenAt: now,
        ...(body.appVersion ? { appVersion: body.appVersion } : {}),
        ...(body.capabilities ? { capabilities: body.capabilities as Prisma.InputJsonValue } : {}),
      },
    });
    if (body.runningJobIds.length) {
      await prisma.workspaceJob.updateMany({
        where: {
          id: { in: body.runningJobIds },
          deviceId: device.id,
          leaseOwner: device.id,
          status: { in: [...LIVE_DEVICE_STATUSES] },
          leaseUntil: { gt: now },
        },
        data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
      });
    }
    const cancelling = await prisma.workspaceJob.findMany({
      where: { deviceId: device.id, cancelRequestedAt: { not: null }, status: { in: ["queued", ...LIVE_DEVICE_STATUSES, "stopping"] } },
      select: { id: true },
    });
    publishBrowserDevice(device.userId, device.id);
    return { cancel: cancelling.map((job) => job.id) };
  });

  app.post("/api/devices/self/claim", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    if (await isPaused(app.redis, device.userId)) return reply.code(204).send();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const next = await prisma.workspaceJob.findFirst({
        where: { ...runsOn(device), status: "queued" },
        orderBy: { sequence: "asc" },
        include: { task: { select: { id: true, title: true } } },
      });
      if (!next) return reply.code(204).send();
      if (!(await stillMember(app, next))) {
        await prisma.workspaceJob.updateMany({ where: { id: next.id, status: "queued" }, data: { status: "cancelled", finishedAt: new Date(), error: "Removed from the shared space.", progress: "Cancelled" } });
        continue;
      }
      const now = new Date();
      const leaseToken = randomBytes(24).toString("base64url");
      const leaseUntil = new Date(now.getTime() + LEASE_MS);
      const won = await prisma.workspaceJob.updateMany({
        where: { id: next.id, deviceId: device.id, status: "queued" },
        data: {
          status: "claimed",
          leaseOwner: device.id,
          leaseUntil,
          leaseToken,
          claimedAt: now,
          lastProgressAt: now,
          attempt: { increment: 1 },
          progress: "Claimed",
        },
      });
      if (won.count !== 1) continue;
      await prisma.task.updateMany({ where: { id: next.taskId, owner: "agent", status: { in: ["todo", "proposed", "blocked"] } }, data: { status: "in_progress" } });
      sseHub.publish(next.userId, { event: "workspace", data: { id: next.id } });
      return {
        id: next.id,
        leaseToken,
        leaseUntil: leaseUntil.toISOString(),
        taskId: next.taskId,
        title: next.task.title,
        kind: next.kind,
        instructions: next.instructions,
        repoUrl: next.repoUrl,
        folderLabel: next.folderLabel,
        delivery: next.delivery,
        askBeforePublish: next.askBeforePublish,
        useCredentials: next.useCredentials,
        unattended: false,
        // Hint only, copied from this Ensemble's sandbox setting. The computer
        // enforces its own network setting and must ignore this or treat it as a hint.
        networkAccess: next.networkAccess,
        branchMode: next.branchMode,
        branch: next.branch,
        continueFromJobId: next.continueFromJobId,
        provider: next.provider,
        model: next.model,
        reasoningEffort: next.reasoningEffort,
        markDone: next.markDone,
        maxMinutes: next.maxMinutes,
        maxTurns: next.maxTurns,
        maxToolCalls: next.maxToolCalls,
        attempt: next.attempt + 1,
      };
    }
    return reply.code(204).send();
  });

  app.post("/api/devices/self/jobs/:id/progress", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const { id } = request.params as { id: string };
    const body = Progress.parse(request.body);
    if (body.logs && Buffer.byteLength(redactText(body.logs.text)) > MAX_CHUNK_BYTES) {
      return reply.code(413).send({ error: "A log chunk can be at most 64 KB." });
    }
    const held = await holdLease(app, device, id, body.leaseToken);
    if (!held.ok) return reply.code(held.status).send({ error: held.message });
    const nextStatus = body.status === "running" ? "running" : held.job.status;
    const extended = new Date(held.now.getTime() + LEASE_MS);
    const won = await prisma.workspaceJob.updateMany({
      where: {
        id: held.job.id,
        deviceId: device.id,
        leaseToken: body.leaseToken,
        status: { in: [...LIVE_DEVICE_STATUSES] },
        leaseUntil: { gt: held.now },
      },
      data: {
        status: nextStatus,
        progress: redactText(body.progress).slice(0, 200),
        lastProgressAt: held.now,
        leaseUntil: extended,
        ...(nextStatus === "running" && !held.job.startedAt ? { startedAt: held.now } : {}),
      },
    });
    if (won.count !== 1) return reply.code(409).send({ error: LEASE_REJECTED });
    if (nextStatus === "running" && !held.job.runId) {
      const run = await prisma.run.create({
        data: {
          taskId: held.job.taskId,
          userId: held.job.userId,
          worker: held.job.kind === "research" ? "research" : "workspace",
          requestedModel: held.job.model,
          complexity: held.job.task.complexity,
          assignmentInstructions: held.job.instructions || null,
        },
      });
      await prisma.workspaceJob.updateMany({ where: { id: held.job.id, runId: null }, data: { runId: run.id } });
    }
    for (const event of body.events) {
      await prisma.workspaceEvent.create({ data: { jobId: held.job.id, kind: event.kind, data: (redactValue(event.data ?? {}) ?? {}) as Prisma.InputJsonValue } });
    }
    const logs = body.logs ? await storeLog(app, held.job.id, body.logs) : { stored: false, duplicate: false, truncated: false };
    sseHub.publish(held.job.userId, { event: "workspace", data: { id: held.job.id } });
    return { ok: true, leaseUntil: extended.toISOString(), logs };
  });

  app.post("/api/devices/self/jobs/:id/ask", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const { id } = request.params as { id: string };
    const body = Ask.parse(request.body);
    const held = await holdLease(app, device, id, body.leaseToken);
    if (!held.ok) return reply.code(held.status).send({ error: held.message });
    const title = redactText(body.title).slice(0, 300);
    const command = body.command ? redactText(body.command).slice(0, 2000) : null;
    const event = body.event ?? (command ? "permission" : "question");
    const extended = new Date(held.now.getTime() + LEASE_MS);
    const won = await prisma.workspaceJob.updateMany({
      where: {
        id: held.job.id,
        deviceId: device.id,
        leaseToken: body.leaseToken,
        status: { in: [...LIVE_DEVICE_STATUSES] },
        leaseUntil: { gt: held.now },
      },
      data: { status: "waiting_approval", progress: title.slice(0, 200), lastProgressAt: held.now, leaseUntil: extended },
    });
    if (won.count !== 1) return reply.code(409).send({ error: LEASE_REJECTED });
    // The question shows in the job's space (everyone there sees it); only the person whose
    // computer runs the job may answer it (decisions.ts), and only they are notified.
    const row = await prisma.agentDecision.create({
      data: {
        userId: held.job.userId,
        source: "ensemble",
        event,
        toolName: body.toolName?.slice(0, 80) || (event === "question" ? "Question" : "Permission"),
        title,
        detail: {
          options: body.options ?? [],
          allowCustom: false,
          command,
          input: {},
          taskId: held.job.taskId,
          taskTitle: held.job.task.title,
          jobId: held.job.id,
          deviceId: device.id,
          deviceName: device.name,
          runnerAccountId: held.job.runnerAccountId,
          tier: body.tier,
        },
        sessionId: held.job.id,
        expiresAt: new Date(Date.now() + 24 * 3600_000),
      },
    });
    await prisma.notification.create({
      data: {
        userId: device.userId,
        kind: "decision",
        title: `Agent needs you: ${title}`.slice(0, 200),
        body: held.job.task.title,
        urgent: true,
        url: held.job.userId === device.userId ? "/needs-me" : `/needs-me?openSpace=${held.job.userId}`,
      },
    });
    await prisma.workspaceEvent.create({ data: { jobId: held.job.id, kind: "needs_me", data: { decisionId: row.id, title, tier: body.tier } } });
    sseHub.publish(held.job.userId, { event: "decision", data: { id: row.id, status: "pending", title, source: "ensemble", runnerAccountId: held.job.runnerAccountId } });
    sseHub.publish(held.job.userId, { event: "workspace", data: { id: held.job.id } });
    if (held.job.userId !== device.userId) sseHub.publish(device.userId, { event: "notification", data: { kind: "decision" } });
    return reply.code(201).send({ decisionId: row.id });
  });

  app.get("/api/devices/self/decisions/:id", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const { id } = request.params as { id: string };
    const { timeout } = z.object({ timeout: z.coerce.number().int().min(1).max(55).default(25) }).parse(request.query);
    // Asked by this computer: in its owner's space or in a space shared with them.
    const owned = await prisma.agentDecision.findFirst({ where: { id } });
    const detail = (owned?.detail ?? {}) as { deviceId?: string };
    if (!owned || detail.deviceId !== device.id) return reply.code(404).send({ error: "Decision not found." });
    const row = await waitFor(id, timeout * 1000);
    if (row && row.status === "pending" && row.expiresAt < new Date()) {
      const expired = await prisma.agentDecision.update({ where: { id }, data: { status: "expired" } });
      return publicDecision(expired);
    }
    return publicDecision(row!);
  });

  app.post("/api/devices/self/jobs/:id/complete", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const { id } = request.params as { id: string };
    const body = Complete.parse(request.body);
    const held = await holdLease(app, device, id, body.leaseToken);
    if (!held.ok) return reply.code(held.status).send({ error: held.message });
    const results: DeviceResult[] = body.results.map((result) => ({ kind: result.kind, url: result.url, ...(result.sha ? { sha: result.sha } : {}) }));
    const ok = await finishDeviceJob(prisma, held.job, { outcome: body.outcome, summary: body.summary, results });
    if (!ok) return reply.code(409).send({ error: LEASE_REJECTED });
    return { status: body.outcome };
  });

  app.get("/api/devices/self/events", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    await sseHandler(request, reply, `device:${device.id}`);
  });
}
