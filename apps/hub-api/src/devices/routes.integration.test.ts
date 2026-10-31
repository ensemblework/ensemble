/**
 * Device pairing, claim, lease, heartbeat, cancel, and token isolation
 * against Postgres. Skips when the database is down.
 *
 * The worker filter runs through recoverServerJobs and tickServerQueue, but
 * job reads are limited to the test user so a shared database is left alone.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";
import "../config.js";
import { deviceTokenRejected, readOnlyTokenRejected } from "../bridge/auth.js";
import { INTERRUPTED_ERROR, LOG_TRUNCATED, LOG_TRUNCATED_SEQ, MAX_CHUNK_BYTES, MAX_JOB_LOG_BYTES } from "./constants.js";
import { sweepExpiredDeviceLeases } from "./lease.js";
import { folderLabels } from "./labels.js";
import { identify, sha256 } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { memoryRedis } from "../lib/memory-redis.js";
import { sseHub } from "../lib/sse.js";
import { agentRoutes } from "../routes/agents.js";
import { authRoutes } from "../routes/auth.js";
import { decisionRoutes } from "../routes/decisions.js";
import "../types.js";
import { runRoutes } from "../routes/runs.js";
import { recoverServerJobs, tickServerQueue } from "../workspace/worker.js";
import { saveSettings } from "../lib/settings.js";
import { deviceRoutes } from "./routes.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function install(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({ error: message });
  });
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    const who = await identify(request);
    if (!who) {
      if (path === "/api/devices/register") return;
      return reply.code(401).send({ error: "Sign in to Ensemble first." });
    }
    request.userId = who.userId;
    request.authVia = who.via;
    request.tokenScope = who.tokenScope;
    request.tokenId = who.tokenId;
    request.modules = who.modules ?? "code,diagrams,metrics,runs,skills,workspace";
    const denied = readOnlyTokenRejected(who.tokenScope, request.method, path) ?? deviceTokenRejected(who.tokenScope, request.method, path);
    if (denied) return reply.code(403).send({ error: denied });
  });
}

async function sessionFor(userId: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      id: sha256(raw),
      userId,
      expiresAt: new Date(Date.now() + 86_400_000),
      modules: "code,diagrams,metrics,runs,skills,workspace",
    },
  });
  return raw;
}

function cookie(raw: string): { cookie: string } {
  return { cookie: `ensemble_session=${raw}` };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function cleanup(userId: string): Promise<void> {
  await prisma.agentDecision.deleteMany({ where: { userId } });
  await prisma.notification.deleteMany({ where: { userId } });
  await prisma.decisionRule.deleteMany({ where: { userId } });
  await prisma.taskTransition.deleteMany({ where: { userId } });
  await prisma.auditLedger.deleteMany({ where: { userId } });
  await prisma.task.deleteMany({ where: { userId } });
  await prisma.preference.deleteMany({ where: { userId } });
  await prisma.devicePairing.deleteMany({ where: { userId } });
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test("pairing, claim, lease sweep, heartbeat, cancel, and device isolation", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `device-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Device" },
  });
  const other = await prisma.user.create({
    data: { email: `device-other-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Other" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  await app.register(decisionRoutes);
  const session = await sessionFor(user.id);
  const task = await prisma.task.create({ data: { userId: user.id, title: "Remote task", createdBy: "me", status: "todo" } });
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    assert.equal(paired.statusCode, 201);
    const code = (paired.json() as { code: string }).code;
    assert.equal(code.length, 8);

    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code, name: "Office Mac", platform: "macos", appVersion: "0.1.0", capabilities: { folders: ["Notes"] } },
    });
    assert.equal(registered.statusCode, 201);
    const token = (registered.json() as { token: string; device: { id: string } }).token;
    const deviceId = (registered.json() as { device: { id: string } }).device.id;
    assert.match(token, /^ens_/);

    const again = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code, name: "Second", platform: "macos", capabilities: {} },
    });
    assert.equal(again.statusCode, 401);

    const listed = await app.inject({ method: "GET", url: "/api/devices", headers: cookie(session) });
    assert.equal(listed.statusCode, 200);
    const list = listed.json() as { devices: Array<{ id: string; online: boolean }> };
    assert.equal(list.devices[0]?.id, deviceId);
    assert.equal(list.devices[0]?.online, false);

    const path = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: "AAAAAAAA", name: "Nope", platform: "macos", capabilities: { folders: ["/tmp/keys"] } },
    });
    assert.equal(path.statusCode, 400);
    assert.match((path.json() as { error: string }).error, /path/);

    const otherSession = await sessionFor(other.id);
    const otherPair = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(otherSession) });
    const otherCode = (otherPair.json() as { code: string }).code;
    const otherReg = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: otherCode, name: "Other Mac", platform: "linux", capabilities: { folders: ["Other"] } },
    });
    const otherToken = (otherReg.json() as { token: string }).token;

    const trusted = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "code", deviceId, folder: "/tmp/secrets", instructions: "no" },
    });
    assert.equal(trusted.statusCode, 403);
    assert.match((trusted.json() as { error: string }).error, /Trust this folder on Office Mac first\./);

    const empty = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "code", deviceId, instructions: "Start from nothing" },
    });
    assert.equal(empty.statusCode, 201, "no repository and no shared folder: a new empty folder on that computer");
    await prisma.workspaceJob.delete({ where: { id: (empty.json() as { jobId: string }).jobId } });

    const assigned = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "code", deviceId, repoUrl: "octocat/Hello-World", instructions: "Say hello" },
    });
    assert.equal(assigned.statusCode, 201);
    const jobId = (assigned.json() as { jobId: string }).jobId;
    const queued = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(queued.status, "queued");
    assert.equal(queued.deviceId, deviceId);
    assert.equal(queued.unattended, false);

    const minted = await app.inject({ method: "POST", url: "/api/tokens", headers: bearer(token), payload: { name: "nope" } });
    assert.equal(minted.statusCode, 403);
    const assignDenied = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: bearer(token),
      payload: { taskId: task.id, kind: "research" },
    });
    assert.equal(assignDenied.statusCode, 403);
    const listDenied = await app.inject({ method: "GET", url: "/api/devices", headers: bearer(token) });
    assert.equal(listDenied.statusCode, 403);

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(token) }),
      app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(token) }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    assert.deepEqual(statuses, [200, 204]);
    const claimedBody = (first.statusCode === 200 ? first.json() : second.json()) as { id: string; leaseToken: string; repoUrl: string; unattended: boolean };
    assert.equal(claimedBody.id, jobId);
    assert.equal(claimedBody.unattended, false);
    assert.match(claimedBody.repoUrl, /Hello-World/);
    const claimed = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.leaseToken, claimedBody.leaseToken);
    assert.ok(claimed.leaseUntil && claimed.leaseUntil.getTime() > Date.now());

    const wrong = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${jobId}/progress`,
      headers: bearer(token),
      payload: { leaseToken: "nope", progress: "should not stick", logs: { seqFrom: 1, seqTo: 1, text: "secret sk-abcdefghijklmnop" } },
    });
    assert.equal(wrong.statusCode, 409);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } })).progress, "Claimed");
    assert.equal(await prisma.workspaceLogChunk.count({ where: { jobId } }), 0);

    const crossed = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${jobId}/progress`,
      headers: bearer(otherToken),
      payload: { leaseToken: claimedBody.leaseToken, progress: "other" },
    });
    assert.equal(crossed.statusCode, 404);

    const beat = await app.inject({
      method: "POST",
      url: "/api/devices/self/heartbeat",
      headers: bearer(token),
      payload: { runningJobIds: [jobId], appVersion: "0.1.1", capabilities: { folders: ["Notes"] } },
    });
    assert.equal(beat.statusCode, 200);
    assert.deepEqual((beat.json() as { cancel: string[] }).cancel, []);
    const afterBeat = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.ok(afterBeat.leaseUntil && claimed.leaseUntil && afterBeat.leaseUntil.getTime() >= claimed.leaseUntil.getTime());
    const seen = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    assert.equal(seen.appVersion, "0.1.1");
    assert.ok(seen.lastSeenAt);

    const progress = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${jobId}/progress`,
      headers: bearer(token),
      payload: {
        leaseToken: claimedBody.leaseToken,
        status: "running",
        progress: "Editing",
        events: [{ kind: "prepared", data: { root: "runs/job" } }],
        logs: { seqFrom: 1, seqTo: 2, text: "using sk-abcdefghijklmnop\n" },
      },
    });
    assert.equal(progress.statusCode, 200);
    const running = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(running.status, "running");
    const chunk = await prisma.workspaceLogChunk.findFirstOrThrow({ where: { jobId, seqFrom: 1 } });
    assert.match(chunk.text, /\[redacted\]/);
    assert.doesNotMatch(chunk.text, /sk-abcdefghijklmnop/);
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${jobId}/progress`,
      headers: bearer(token),
      payload: { leaseToken: claimedBody.leaseToken, progress: "Editing", logs: { seqFrom: 1, seqTo: 2, text: "again" } },
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal((duplicate.json() as { logs: { duplicate: boolean } }).logs.duplicate, true);
    assert.equal(await prisma.workspaceLogChunk.count({ where: { jobId, seqFrom: 1 } }), 1);

    const asked = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${jobId}/ask`,
      headers: bearer(token),
      payload: { leaseToken: claimedBody.leaseToken, title: "Run tests?", event: "question", tier: "ordinary" },
    });
    assert.equal(asked.statusCode, 201);
    const decisionId = (asked.json() as { decisionId: string }).decisionId;
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } })).status, "waiting_approval");
    const always = await app.inject({
      method: "POST",
      url: `/api/decisions/${decisionId}/decide`,
      headers: cookie(session),
      payload: { decision: "allow", scope: "always" },
    });
    assert.equal(always.statusCode, 400);
    const once = await app.inject({
      method: "POST",
      url: `/api/decisions/${decisionId}/decide`,
      headers: cookie(session),
      payload: { decision: "allow", scope: "once" },
    });
    assert.equal(once.statusCode, 200);
    assert.equal(await prisma.decisionRule.count({ where: { userId: user.id } }), 0);

    const stopped = await app.inject({ method: "POST", url: `/api/agent/jobs/${jobId}/stop`, headers: cookie(session) });
    assert.equal(stopped.statusCode, 204);
    const cancelling = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(cancelling.status, "waiting_approval");
    assert.ok(cancelling.cancelRequestedAt);
    const beatCancel = await app.inject({
      method: "POST",
      url: "/api/devices/self/heartbeat",
      headers: bearer(token),
      payload: { runningJobIds: [jobId] },
    });
    assert.deepEqual((beatCancel.json() as { cancel: string[] }).cancel, [jobId]);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } })).status, "waiting_approval", "a fresh stop waits for the computer");

    await prisma.workspaceJob.update({ where: { id: jobId }, data: { leaseUntil: new Date(Date.now() - 5_000) } });
    const swept = await sweepExpiredDeviceLeases(app);
    assert.equal(swept, 1);
    const interrupted = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.error, INTERRUPTED_ERROR);
    assert.equal(await prisma.workspaceEvent.count({ where: { jobId, kind: "interrupted" } }), 1);
    assert.equal(await sweepExpiredDeviceLeases(app), 0);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } })).status, "interrupted");

    const late = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${jobId}/complete`,
      headers: bearer(token),
      payload: { leaseToken: claimedBody.leaseToken, outcome: "succeeded", summary: "too late" },
    });
    assert.equal(late.statusCode, 409);

    // A computer that keeps checking in but never ends a stopped run (its runtime stuck on a command): the run ends here.
    const stuckTask = await prisma.task.create({ data: { userId: user.id, title: "Stuck", createdBy: "me", owner: "agent", status: "in_progress" } });
    const stuck = await prisma.workspaceJob.create({
      data: { userId: user.id, taskId: stuckTask.id, deviceId, kind: "code", status: "running", executionMode: "sandbox", model: "label", instructions: "stuck", leaseOwner: deviceId, leaseUntil: new Date(Date.now() + 60_000), cancelRequestedAt: new Date(Date.now() - 4 * 60_000) },
    });
    const forcedBeat = await app.inject({ method: "POST", url: "/api/devices/self/heartbeat", headers: bearer(token), payload: { runningJobIds: [stuck.id] } });
    assert.ok((forcedBeat.json() as { cancel: string[] }).cancel.includes(stuck.id), "the computer is still told to stop it");
    const forced = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: stuck.id } });
    assert.equal(forced.status, "cancelled");
    assert.match(forced.error ?? "", /did not confirm the stop within 3 minutes/);
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: stuckTask.id } })).status, "todo");

    const waiting = await prisma.task.create({ data: { userId: user.id, title: "Waits", createdBy: "me", status: "todo" } });
    const queuedJob = await prisma.workspaceJob.create({
      data: { userId: user.id, taskId: waiting.id, deviceId, kind: "code", executionMode: "sandbox", model: "label", instructions: "wait", repoUrl: "https://github.com/octocat/Hello-World.git" },
    });
    const runningJob = await prisma.workspaceJob.create({
      data: {
        userId: user.id,
        taskId: waiting.id,
        deviceId,
        kind: "code",
        executionMode: "sandbox",
        model: "label",
        status: "running",
        leaseOwner: deviceId,
        leaseUntil: new Date(Date.now() + 60_000),
        leaseToken: "held",
      },
    });
    const scoped = {
      log: { error() {}, info() {} },
      redis: { get: async () => null },
      prisma: new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop !== "workspaceJob") return Reflect.get(target, prop, receiver);
          return new Proxy(target.workspaceJob, {
            get(jobTarget, method, jobReceiver) {
              if (method === "findMany") {
                return (args: { where?: object }) =>
                  target.workspaceJob.findMany({ ...args, where: { AND: [args?.where ?? {}, { userId: user.id }] } });
              }
              const value = Reflect.get(jobTarget, method, jobReceiver) as unknown;
              return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(jobTarget) : value;
            },
          });
        },
      }),
    } as unknown as FastifyInstance;
    await recoverServerJobs(scoped);
    assert.equal(await tickServerQueue(scoped), true);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: queuedJob.id } })).status, "queued");
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: runningJob.id } })).status, "running");
    assert.notEqual((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: runningJob.id } })).error, "Interrupted: Ensemble restarted while this was running. Its folder and partial work are kept.");

    const removed = await app.inject({ method: "DELETE", url: `/api/devices/${deviceId}`, headers: cookie(session) });
    assert.equal(removed.statusCode, 204);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: queuedJob.id } })).status, "failed");
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: queuedJob.id } })).error, "Device removed");
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: runningJob.id } })).status, "interrupted");
    const dead = await app.inject({
      method: "POST",
      url: "/api/devices/self/heartbeat",
      headers: bearer(token),
      payload: { runningJobIds: [] },
    });
    assert.equal(dead.statusCode, 401);
  } finally {
    await app.close();
    await cleanup(user.id);
    await cleanup(other.id);
  }
});

test("the web cannot set run-branch push, and log caps hold", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `caps-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Caps" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  const session = await sessionFor(user.id);
  const task = await prisma.task.create({ data: { userId: user.id, title: "Caps", createdBy: "me", status: "todo" } });
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const windows = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Studio PC", platform: "windows", capabilities: { folders: ["Desk"] } },
    });
    assert.equal(windows.statusCode, 201);
    const win = windows.json() as { token: string; device: { id: string } };
    const linuxPair = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const linux = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (linuxPair.json() as { code: string }).code, name: "Build box", platform: "linux", capabilities: {} },
    });
    assert.equal(linux.statusCode, 201);
    const listed = await app.inject({ method: "GET", url: "/api/devices", headers: cookie(session) });
    const names = (listed.json() as { devices: Array<{ name: string; platform: string }> }).devices.map((device) => `${device.name}:${device.platform}`);
    assert.deepEqual(names.sort(), ["Build box:linux", "Studio PC:windows"]);

    // Only the computer publishes what it offers: a web session can neither send its heartbeat nor patch it.
    const webBeat = await app.inject({
      method: "POST",
      url: "/api/devices/self/heartbeat",
      headers: cookie(session),
      payload: { runningJobIds: [], capabilities: { folders: ["Hijack"] } },
    });
    assert.equal(webBeat.statusCode, 403);
    const webPatch = await app.inject({
      method: "PATCH",
      url: `/api/devices/${win.device.id}`,
      headers: cookie(session),
      payload: { capabilities: { folders: ["Hijack"] } },
    });
    assert.equal(webPatch.statusCode, 400);
    assert.deepEqual(folderLabels((await prisma.device.findUniqueOrThrow({ where: { id: win.device.id } })).capabilities), ["Desk"]);

    const published = await app.inject({
      method: "POST",
      url: "/api/devices/self/heartbeat",
      headers: bearer(win.token),
      payload: { runningJobIds: [], capabilities: { folders: ["Desk"] } },
    });
    assert.equal(published.statusCode, 200);

    const assigned = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "code", deviceId: win.device.id, repoUrl: "octocat/Hello-World", instructions: "logs" },
    });
    assert.equal(assigned.statusCode, 201);
    const claimed = await app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(win.token) });
    assert.equal(claimed.statusCode, 200);
    const leaseToken = (claimed.json() as { leaseToken: string; id: string }).leaseToken;
    const jobId = (claimed.json() as { id: string }).id;

    const before = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } });
    const tooBig = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${jobId}/progress`,
      headers: bearer(win.token),
      payload: {
        leaseToken,
        status: "running",
        progress: "too big",
        events: [{ kind: "prepared", data: { root: "nope" } }],
        logs: { seqFrom: 0, seqTo: 0, text: "x".repeat(MAX_CHUNK_BYTES + 1) },
      },
    });
    assert.equal(tooBig.statusCode, 413);
    const after = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(after.status, before.status);
    assert.equal(after.progress, before.progress);
    assert.equal(after.leaseUntil?.toISOString(), before.leaseUntil?.toISOString());
    assert.equal(await prisma.workspaceEvent.count({ where: { jobId } }), 0);
    assert.equal(await prisma.workspaceLogChunk.count({ where: { jobId } }), 0);

    const chunk = "y".repeat(MAX_CHUNK_BYTES);
    for (let i = 1; i <= MAX_JOB_LOG_BYTES / MAX_CHUNK_BYTES; i += 1) {
      const stored = await app.inject({
        method: "POST",
        url: `/api/devices/self/jobs/${jobId}/progress`,
        headers: bearer(win.token),
        payload: { leaseToken, progress: "logging", logs: { seqFrom: i, seqTo: i, text: chunk } },
      });
      assert.equal(stored.statusCode, 200, `chunk ${i}`);
      assert.equal((stored.json() as { logs: { stored: boolean } }).logs.stored, true);
    }
    const capped = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${jobId}/progress`,
      headers: bearer(win.token),
      payload: { leaseToken, progress: "capped", logs: { seqFrom: 900, seqTo: 900, text: "one more" } },
    });
    assert.equal(capped.statusCode, 200);
    assert.equal((capped.json() as { logs: { truncated: boolean; stored: boolean } }).logs.truncated, true);
    assert.equal((capped.json() as { logs: { stored: boolean } }).logs.stored, false);
    const again = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${jobId}/progress`,
      headers: bearer(win.token),
      payload: { leaseToken, progress: "capped", logs: { seqFrom: 901, seqTo: 901, text: "still more" } },
    });
    assert.equal((again.json() as { logs: { truncated: boolean } }).logs.truncated, true);
    const marker = await prisma.workspaceLogChunk.findUniqueOrThrow({ where: { jobId_seqFrom: { jobId, seqFrom: LOG_TRUNCATED_SEQ } } });
    assert.equal(marker.text, LOG_TRUNCATED);
    const totals = await prisma.workspaceLogChunk.aggregate({ where: { jobId, seqFrom: { not: LOG_TRUNCATED_SEQ } }, _sum: { bytes: true } });
    assert.equal(totals._sum.bytes, MAX_JOB_LOG_BYTES);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("two sweeps interrupt one expired lease once", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `sweep-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Sweep" },
  });
  const token = await prisma.apiToken.create({
    data: { userId: user.id, name: "Device · Build box", tokenHash: sha256(`ens_${randomBytes(8).toString("hex")}`), prefix: "ens_test", scope: "device" },
  });
  const device = await prisma.device.create({
    data: { userId: user.id, name: "Build box", platform: "linux", tokenId: token.id, capabilities: {} },
  });
  const task = await prisma.task.create({ data: { userId: user.id, title: "Sweep", createdBy: "me", status: "in_progress", owner: "agent" } });
  const expired = await prisma.workspaceJob.create({
    data: {
      userId: user.id,
      taskId: task.id,
      deviceId: device.id,
      kind: "code",
      executionMode: "sandbox",
      model: "label",
      status: "running",
      leaseOwner: device.id,
      leaseUntil: new Date(Date.now() - 5_000),
      leaseToken: "expired",
    },
  });
  const fresh = await prisma.workspaceJob.create({
    data: {
      userId: user.id,
      taskId: task.id,
      deviceId: device.id,
      kind: "code",
      executionMode: "sandbox",
      model: "label",
      status: "running",
      leaseOwner: device.id,
      leaseUntil: new Date(Date.now() + 60_000),
      leaseToken: "fresh",
    },
  });
  const app = { prisma, log: { error() {} } } as unknown as FastifyInstance;
  try {
    const [first, second] = await Promise.all([sweepExpiredDeviceLeases(app), sweepExpiredDeviceLeases(app)]);
    assert.equal(first + second, 1);
    const interrupted = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: expired.id } });
    assert.equal(interrupted.status, "interrupted");
    assert.ok(interrupted.finishedAt);
    assert.ok(Math.abs(interrupted.finishedAt.getTime() - Date.now()) < 60_000);
    assert.equal(await prisma.workspaceEvent.count({ where: { jobId: expired.id, kind: "interrupted" } }), 1);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: fresh.id } })).status, "running");
    assert.equal(await sweepExpiredDeviceLeases(app), 0);
    assert.equal(await prisma.workspaceEvent.count({ where: { jobId: expired.id, kind: "interrupted" } }), 1);
  } finally {
    await cleanup(user.id);
  }
});

test("revoke and complete clear pending decisions and the task", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `settle-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Settle" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  const session = await sessionFor(user.id);
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Studio PC", platform: "windows", capabilities: { folders: ["Desk"] } },
    });
    assert.equal(registered.statusCode, 201);
    const { token, device } = registered.json() as { token: string; device: { id: string } };

    const outcomes = [
      { outcome: "failed", task: "blocked" },
      { outcome: "cancelled", task: "todo" },
      { outcome: "succeeded", task: "done" },
      { outcome: "blocked", task: "blocked" },
    ] as const;
    for (const expected of outcomes) {
      const task = await prisma.task.create({ data: { userId: user.id, title: expected.outcome, createdBy: "me", status: "todo" } });
      const assigned = await app.inject({
        method: "POST",
        url: "/api/agent/assign",
        headers: cookie(session),
        payload: { taskId: task.id, kind: "code", deviceId: device.id, folderLabel: "Desk", instructions: expected.outcome, markDone: true },
      });
      assert.equal(assigned.statusCode, 201);
      const claimed = await app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(token) });
      assert.equal(claimed.statusCode, 200);
      const body = claimed.json() as { id: string; leaseToken: string };
      assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status, "in_progress");
      const asked = await app.inject({
        method: "POST",
        url: `/api/devices/self/jobs/${body.id}/ask`,
        headers: bearer(token),
        payload: { leaseToken: body.leaseToken, title: "Ship it?", event: "question" },
      });
      assert.equal(asked.statusCode, 201);
      const decisionId = (asked.json() as { decisionId: string }).decisionId;
      const finished = await app.inject({
        method: "POST",
        url: `/api/devices/self/jobs/${body.id}/complete`,
        headers: bearer(token),
        payload: { leaseToken: body.leaseToken, outcome: expected.outcome, summary: expected.outcome },
      });
      assert.equal(finished.statusCode, 200, expected.outcome);
      assert.equal((await prisma.agentDecision.findUniqueOrThrow({ where: { id: decisionId } })).status, "expired");
      assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status, expected.task);
      // Finished and stopped runs show on the board and in Runs; only a run that needs the person notifies.
      const notified = await prisma.notification.count({ where: { userId: user.id, kind: "agent", url: `/tasks/${task.id}` } });
      assert.equal(notified, expected.outcome === "succeeded" || expected.outcome === "cancelled" ? 0 : 1, expected.outcome);
    }

    const lingering = await prisma.task.create({ data: { userId: user.id, title: "Revoke me", createdBy: "me", status: "todo" } });
    const queued = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: lingering.id, kind: "code", deviceId: device.id, folderLabel: "Desk", instructions: "later" },
    });
    assert.equal(queued.statusCode, 201);
    const held = await app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(token) });
    const heldBody = held.json() as { id: string; leaseToken: string };
    const pending = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${heldBody.id}/ask`,
      headers: bearer(token),
      payload: { leaseToken: heldBody.leaseToken, title: "Still here?", event: "question" },
    });
    const pendingId = (pending.json() as { decisionId: string }).decisionId;
    const removed = await app.inject({ method: "DELETE", url: `/api/devices/${device.id}`, headers: cookie(session) });
    assert.equal(removed.statusCode, 204);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: heldBody.id } })).status, "interrupted");
    assert.equal((await prisma.agentDecision.findUniqueOrThrow({ where: { id: pendingId } })).status, "expired");
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: lingering.id } })).status, "blocked");
    const again = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: lingering.id, kind: "research", deviceId: device.id },
    });
    assert.equal(again.statusCode, 403);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("run again stores every setting from the original job", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `again-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Again" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  const session = await sessionFor(user.id);
  const task = await prisma.task.create({ data: { userId: user.id, title: "Again", createdBy: "me", status: "todo" } });
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Studio PC", platform: "windows", capabilities: { folders: ["Desk"] } },
    });
    const deviceId = (registered.json() as { device: { id: string } }).device.id;
    const first = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: {
        taskId: task.id,
        kind: "code",
        deviceId,
        folderLabel: "Desk",
        repoUrl: "octocat/Hello-World",
        instructions: "Keep the failing test.",
        provider: "anthropic",
        model: "custom-model",
        reasoningEffort: "high",
        branchMode: "existing",
        branch: "release",
        delivery: "push",
        askBeforePublish: false,
        useCredentials: true,
        sandbox: false,
        network: false,
        markDone: false,
        maxMinutes: 12,
        maxTurns: 7,
        maxToolCalls: 15,
      },
    });
    assert.equal(first.statusCode, 201);
    const original = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: (first.json() as { jobId: string }).jobId } });
    const second = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: {
        taskId: task.id,
        kind: original.kind,
        deviceId,
        continueFromJobId: original.id,
        folderLabel: original.folderLabel,
        repoUrl: original.repoUrl,
        instructions: original.instructions,
        provider: original.provider,
        model: original.model,
        reasoningEffort: original.reasoningEffort,
        branchMode: original.branchMode,
        branch: original.branch,
        delivery: original.delivery,
        askBeforePublish: original.askBeforePublish,
        useCredentials: original.useCredentials,
        sandbox: original.executionMode === "sandbox",
        network: original.networkAccess,
        markDone: original.markDone,
        maxMinutes: original.maxMinutes,
        maxTurns: original.maxTurns,
        maxToolCalls: original.maxToolCalls,
      },
    });
    assert.equal(second.statusCode, 201, JSON.stringify(second.json()));
    const copy = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: (second.json() as { jobId: string }).jobId } });
    assert.equal(copy.instructions, "Keep the failing test.");
    assert.equal(copy.model, "custom-model");
    assert.equal(copy.provider, "anthropic");
    assert.equal(copy.branch, "release");
    assert.equal(copy.branchMode, "existing");
    assert.equal(copy.useCredentials, true);
    assert.equal(copy.askBeforePublish, false);
    assert.equal(copy.markDone, false);
    assert.equal(copy.maxMinutes, 12);
    assert.equal(copy.maxTurns, 7);
    assert.equal(copy.maxToolCalls, 15);
    assert.equal(copy.reasoningEffort, "high");
    assert.equal(copy.executionMode, "native");
    assert.equal(copy.networkAccess, false);
    assert.equal(copy.delivery, "push");
    assert.equal(copy.continueFromJobId, original.id);
    assert.notEqual(copy.instructions, "");
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("Continue an earlier task lists that computer's runs (any pairing of it), the task's first, and refuses another computer's", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `earlier-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Earlier" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  const session = await sessionFor(user.id);
  const pair = async (name: string, installId: string) => {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name, platform: "linux", capabilities: { folders: ["Desk"] } },
    });
    const id = (registered.json() as { device: { id: string } }).device.id;
    await prisma.device.update({ where: { id }, data: { capabilities: { folders: ["Desk"], installId } } });
    return id;
  };
  const assign = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/agent/assign", headers: cookie(session), payload: { kind: "code", instructions: "go", ...payload } });
  const listed = async (deviceId: string, taskId?: string) => {
    const res = await app.inject({ method: "GET", url: `/api/agent/earlier-runs?deviceId=${deviceId}${taskId ? `&taskId=${taskId}` : ""}`, headers: cookie(session) });
    assert.equal(res.statusCode, 200);
    return (res.json() as { checkouts: Array<{ jobId: string }> }).checkouts.map((row) => row.jobId);
  };
  try {
    const logos = await prisma.task.create({ data: { userId: user.id, title: "Logos", createdBy: "me", status: "todo" } });
    const other = await prisma.task.create({ data: { userId: user.id, title: "Other", createdBy: "me", status: "todo" } });
    const before = await pair("Home server", "install-home");
    const laptop = await pair("Laptop", "install-laptop");
    const first = await assign({ taskId: logos.id, deviceId: before, folderLabel: "Desk" });
    assert.equal(first.statusCode, 201);
    const firstId = (first.json() as { jobId: string }).jobId;
    // The power went out and the computer was paired again: the same computer, a new device row.
    await prisma.device.update({ where: { id: before }, data: { revokedAt: new Date() } });
    const home = await pair("Home server", "install-home");

    assert.deepEqual(await listed(home, logos.id), [firstId]);
    assert.deepEqual(await listed(laptop, logos.id), []);
    const elsewhere = await assign({ taskId: logos.id, deviceId: laptop, continueFromJobId: firstId });
    assert.equal(elsewhere.statusCode, 403);
    assert.match((elsewhere.json() as { error: string }).error, /ran on Home server/);

    const carried = await assign({ taskId: logos.id, deviceId: home, continueFromJobId: firstId });
    assert.equal(carried.statusCode, 201, JSON.stringify(carried.json()));
    const carriedId = (carried.json() as { jobId: string }).jobId;
    const unrelated = await assign({ taskId: other.id, deviceId: home });
    const unrelatedId = (unrelated.json() as { jobId: string }).jobId;
    // One entry per chain (its newest step), this task's first.
    assert.deepEqual(await listed(home, logos.id), [carriedId, unrelatedId]);
    assert.deepEqual(await listed(home), [unrelatedId, carriedId]);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("pause stops new device claims and assignments", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `pause-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Pause" },
  });
  const store = new Map<string, string>();
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate(
    "redis",
    {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      },
      del: async (key: string) => (store.delete(key) ? 1 : 0),
      sadd: async () => 1,
      srem: async () => 1,
      smembers: async () => [],
    } as unknown as Redis,
  );
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  const session = await sessionFor(user.id);
  const task = await prisma.task.create({ data: { userId: user.id, title: "Paused", createdBy: "me", status: "todo" } });
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Studio PC", platform: "windows", capabilities: { folders: ["Desk"] } },
    });
    const { token, device } = registered.json() as { token: string; device: { id: string } };
    const assigned = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "code", deviceId: device.id, folderLabel: "Desk", instructions: "before pause" },
    });
    assert.equal(assigned.statusCode, 201);
    const jobId = (assigned.json() as { jobId: string }).jobId;
    const paused = await app.inject({ method: "POST", url: "/api/agent/pause", headers: cookie(session) });
    assert.equal(paused.statusCode, 200);
    const claimed = await app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(token) });
    assert.equal(claimed.statusCode, 204);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } })).status, "queued");
    const during = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "research", deviceId: device.id, instructions: "while paused" },
    });
    assert.equal(during.statusCode, 409);
    assert.equal(await prisma.workspaceJob.count({ where: { userId: user.id, instructions: "while paused" } }), 0);
    const resumed = await app.inject({ method: "POST", url: "/api/agent/resume", headers: cookie(session) });
    assert.equal(resumed.statusCode, 200);
    const after = await app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(token) });
    assert.equal(after.statusCode, 200);
    assert.equal((after.json() as { id: string }).id, jobId);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("parallel completes create one run", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `race-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Race" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  const session = await sessionFor(user.id);
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Studio PC", platform: "windows", capabilities: {} },
    });
    const { token, device } = registered.json() as { token: string; device: { id: string } };
    const task = await prisma.task.create({ data: { userId: user.id, title: "Once", createdBy: "me", status: "in_progress", owner: "agent" } });
    const job = await prisma.workspaceJob.create({
      data: {
        userId: user.id,
        taskId: task.id,
        deviceId: device.id,
        kind: "research",
        executionMode: "sandbox",
        model: "label",
        status: "claimed",
        leaseOwner: device.id,
        leaseUntil: new Date(Date.now() + 60_000),
        leaseToken: "once",
      },
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({
          method: "POST",
          url: `/api/devices/self/jobs/${job.id}/complete`,
          headers: bearer(token),
          payload: { leaseToken: "once", outcome: "succeeded", summary: "done" },
        }),
      ),
    );
    assert.equal(results.filter((result) => result.statusCode === 200).length, 1);
    assert.equal(results.filter((result) => result.statusCode === 409).length, 3);
    assert.equal(await prisma.run.count({ where: { taskId: task.id } }), 1);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } })).status, "succeeded");
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("a device key is not a personal token, and revoking it removes the computer", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `key-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Key" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  await app.register(authRoutes);
  const session = await sessionFor(user.id);
  const task = await prisma.task.create({ data: { userId: user.id, title: "Keyed", createdBy: "me", status: "todo" } });
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Studio PC", platform: "windows", capabilities: { folders: ["Desk"] } },
    });
    const { token, device } = registered.json() as { token: string; device: { id: string } };
    const personal = await app.inject({ method: "POST", url: "/api/tokens", headers: cookie(session), payload: { name: "Hooks" } });
    assert.equal(personal.statusCode, 200);
    const listed = await app.inject({ method: "GET", url: "/api/tokens", headers: cookie(session) });
    const names = (listed.json() as { tokens: Array<{ name: string; scope: string }> }).tokens.map((row) => row.name);
    assert.deepEqual(names, ["Hooks"]);
    assert.equal((listed.json() as { tokens: Array<{ scope: string }> }).tokens.some((row) => row.scope === "device"), false);
    const assigned = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "code", deviceId: device.id, folderLabel: "Desk", instructions: "held" },
    });
    const claimed = await app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(token) });
    const body = claimed.json() as { id: string; leaseToken: string };
    await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${body.id}/ask`,
      headers: bearer(token),
      payload: { leaseToken: body.leaseToken, title: "Ok?", event: "question" },
    });
    const deviceToken = await prisma.apiToken.findFirstOrThrow({ where: { userId: user.id, scope: "device" } });
    const revoked = await app.inject({ method: "DELETE", url: `/api/tokens/${deviceToken.id}`, headers: cookie(session) });
    assert.equal(revoked.statusCode, 204);
    assert.ok((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).revokedAt);
    const devices = await app.inject({ method: "GET", url: "/api/devices", headers: cookie(session) });
    assert.equal((devices.json() as { devices: unknown[] }).devices.length, 0);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: body.id } })).status, "interrupted");
    assert.equal(await prisma.agentDecision.count({ where: { sessionId: body.id, status: "pending" } }), 0);
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status, "blocked");
    const heartbeat = await app.inject({ method: "POST", url: "/api/devices/self/heartbeat", headers: bearer(token), payload: { runningJobIds: [] } });
    assert.equal(heartbeat.statusCode, 401);
    const next = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "research", deviceId: device.id },
    });
    assert.equal(next.statusCode, 403);
    assert.equal(assigned.statusCode, 201);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("result links must be https", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `url-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Url" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  const session = await sessionFor(user.id);
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Studio PC", platform: "windows", capabilities: {} },
    });
    const token = (registered.json() as { token: string; device: { id: string } }).token;
    const deviceId = (registered.json() as { device: { id: string } }).device.id;
    const task = await prisma.task.create({ data: { userId: user.id, title: "Link", createdBy: "me", status: "in_progress", owner: "agent" } });
    const job = await prisma.workspaceJob.create({
      data: {
        userId: user.id,
        taskId: task.id,
        deviceId,
        kind: "code",
        executionMode: "sandbox",
        model: "label",
        status: "running",
        leaseOwner: deviceId,
        leaseUntil: new Date(Date.now() + 60_000),
        leaseToken: "link",
      },
    });
    const script = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${job.id}/complete`,
      headers: bearer(token),
      payload: { leaseToken: "link", outcome: "succeeded", summary: "no", results: [{ kind: "pr", url: "javascript:alert(1)" }] },
    });
    assert.equal(script.statusCode, 400);
    assert.match(JSON.stringify(script.json()), /https/);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } })).status, "running");
    const plain = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${job.id}/complete`,
      headers: bearer(token),
      payload: { leaseToken: "link", outcome: "succeeded", summary: "ok", results: [{ kind: "pr", url: "http://github.com/octocat/Hello-World/pull/1" }] },
    });
    assert.equal(plain.statusCode, 400);
    const https = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${job.id}/complete`,
      headers: bearer(token),
      payload: { leaseToken: "link", outcome: "succeeded", summary: "ok", results: [{ kind: "pr", url: "https://github.com/octocat/Hello-World/pull/12" }] },
    });
    assert.equal(https.statusCode, 200);
    const stored = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(stored.status, "succeeded");
    assert.deepEqual(stored.results, [{ kind: "pr", url: "https://github.com/octocat/Hello-World/pull/12" }]);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("a device cannot post server-only event kinds", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `kind-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Kind" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  const session = await sessionFor(user.id);
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Studio PC", platform: "windows", capabilities: {} },
    });
    const token = (registered.json() as { token: string }).token;
    const deviceId = (registered.json() as { device: { id: string } }).device.id;
    const task = await prisma.task.create({ data: { userId: user.id, title: "Kinds", createdBy: "me", status: "todo" } });
    const job = await prisma.workspaceJob.create({
      data: {
        userId: user.id,
        taskId: task.id,
        deviceId,
        kind: "code",
        executionMode: "sandbox",
        model: "label",
        status: "running",
        leaseOwner: deviceId,
        leaseUntil: new Date(Date.now() + 60_000),
        leaseToken: "kind",
      },
    });
    for (const kind of ["interrupted", "needs_me", "job.cancel"]) {
      const rejected = await app.inject({
        method: "POST",
        url: `/api/devices/self/jobs/${job.id}/progress`,
        headers: bearer(token),
        payload: { leaseToken: "kind", progress: kind, events: [{ kind, data: { title: "no" } }] },
      });
      assert.equal(rejected.statusCode, 400, kind);
    }
    assert.equal(await prisma.workspaceEvent.count({ where: { jobId: job.id } }), 0);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } })).progress, null);
    const allowed = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${job.id}/progress`,
      headers: bearer(token),
      payload: {
        leaseToken: "kind",
        progress: "working",
        events: [
          { kind: "prepared", data: { root: "Desk" } },
          { kind: "tool", data: { name: "read" } },
          { kind: "command", data: { command: "npm test" } },
        ],
      },
    });
    assert.equal(allowed.statusCode, 200);
    const kinds = (await prisma.workspaceEvent.findMany({ where: { jobId: job.id }, orderBy: { sequence: "asc" } })).map((event) => event.kind);
    assert.deepEqual(kinds, ["prepared", "tool", "command"]);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("a computer's steps and totals become the run's trace, redacted, with the model that answered", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `trace-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Trace" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(runRoutes);
  const session = await sessionFor(user.id);
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Studio Mac", platform: "macos", capabilities: {} },
    });
    const token = (registered.json() as { token: string }).token;
    const deviceId = (registered.json() as { device: { id: string } }).device.id;
    const task = await prisma.task.create({ data: { userId: user.id, title: "Summarise rea", createdBy: "me", status: "in_progress", owner: "agent" } });
    const job = await prisma.workspaceJob.create({
      data: {
        userId: user.id,
        taskId: task.id,
        deviceId,
        kind: "code",
        executionMode: "sandbox",
        provider: "claude-code",
        model: "default",
        status: "running",
        leaseOwner: deviceId,
        leaseUntil: new Date(Date.now() + 60_000),
        leaseToken: "trace",
      },
    });
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const progress = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${job.id}/progress`,
      headers: bearer(token),
      payload: {
        leaseToken: "trace",
        status: "running",
        progress: "Cloning",
        events: [{ kind: "engine", data: { engine: "claude-code", model: "claude-sonnet-4-6" } }],
        steps: [
          { index: 0, title: "Thinking", status: "done", reasoning: "Clone it first.", startedAt: new Date().toISOString(), endedAt: new Date().toISOString() },
          {
            index: 1,
            title: "$ git clone https://github.com/morluto/rea",
            status: "done",
            output: `token ${secret}`,
            toolCalls: [{ id: "toolu_1", name: "Bash", args: `{"command":"echo ${secret}"}`, output: "Done", ok: true, ms: 2400, engine: "claude-code" }],
          },
        ],
      },
    });
    assert.equal(progress.statusCode, 200, progress.body);
    const runId = (await prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } })).runId;
    assert.ok(runId, "the first progress with steps makes the run");
    const steps = await prisma.runStep.findMany({ where: { runId: runId! }, orderBy: { index: "asc" } });
    assert.deepEqual(steps.map((step) => step.title), ["Thinking", "$ git clone https://github.com/morluto/rea"]);
    assert.equal(steps[0]!.reasoning, "Clone it first.");
    assert.doesNotMatch(JSON.stringify(steps), new RegExp(secret), "secret shapes are redacted on the server too");
    const tooMany = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${job.id}/progress`,
      headers: bearer(token),
      payload: { leaseToken: "trace", progress: "x", steps: [{ index: 2, title: "Bad", status: "exploded" }] },
    });
    assert.equal(tooMany.statusCode, 400, "a step's shape is checked");

    const done = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${job.id}/complete`,
      headers: bearer(token),
      payload: {
        leaseToken: "trace",
        outcome: "succeeded",
        summary: "## Summary\nWrote REA_SUMMARY.md",
        totals: { model: "claude-sonnet-4-6", turns: 7, toolCalls: 12, tokensIn: 5000, tokensOut: 900, costUsd: 0.21, files: [{ path: "REA_SUMMARY.md", added: 40, removed: 0 }] },
      },
    });
    assert.equal(done.statusCode, 200, done.body);
    const stored = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.deepEqual([stored.turns, stored.toolCalls, stored.tokensIn, stored.tokensOut], [7, 12, 5000, 900]);
    assert.deepEqual(stored.evidence, { files: [{ path: "REA_SUMMARY.md", added: 40, removed: 0 }], model: "claude-sonnet-4-6", costUsd: 0.21 });

    const run = await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: cookie(session) });
    assert.equal(run.statusCode, 200, run.body);
    const body = run.json() as { run: { result: string; steps: unknown[] }; job: { engineName: string; modelUsed: string; where: string; deviceName: string; costUsd: number; files: unknown[]; sandbox: boolean } };
    assert.equal(body.run.result, "## Summary\nWrote REA_SUMMARY.md");
    assert.equal(body.run.steps.length, 2);
    assert.equal(body.job.engineName, "Claude Code");
    assert.equal(body.job.modelUsed, "claude-sonnet-4-6");
    assert.equal(body.job.where, "device");
    assert.equal(body.job.deviceName, "Studio Mac");
    assert.equal(body.job.costUsd, 0.21);
    assert.equal(body.job.sandbox, true);
    assert.equal(body.job.files.length, 1);
    const list = await app.inject({ method: "GET", url: "/api/runs", headers: cookie(session) });
    const row = (list.json() as { runs: Array<{ id: string; model: string; engineName: string; costUsd: number }> }).runs.find((item) => item.id === runId);
    assert.deepEqual([row?.model, row?.engineName, row?.costUsd], ["claude-sonnet-4-6", "Claude Code", 0.21]);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("a run's changed files are stored and shown; its folder is read live through the computer", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `files-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Files" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", memoryRedis() as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  const session = await sessionFor(user.id);
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (frame.event !== "files.request" || !userId.startsWith("device:")) return;
    const request = frame.data as { id: string; kind: string; path: string };
    // The computer: answers a folder request with its entries.
    setTimeout(() => {
      void app.inject({
        method: "POST",
        url: `/api/devices/self/file-requests/${request.id}`,
        headers: bearer(deviceToken),
        payload: request.kind === "tree" ? { listing: { path: request.path, entries: [{ name: "usage.md", kind: "file", size: 6 }, { name: "rea", kind: "dir", size: null }], truncated: false, hidden: 1 } } : { error: "Not here." },
      });
    }, 10);
  });
  let deviceToken = "";
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Studio Mac", platform: "macos", capabilities: {} },
    });
    deviceToken = (registered.json() as { token: string }).token;
    const deviceId = (registered.json() as { device: { id: string } }).device.id;
    const task = await prisma.task.create({ data: { userId: user.id, title: "Write usage", createdBy: "me", status: "in_progress", owner: "agent" } });
    const job = await prisma.workspaceJob.create({
      data: { userId: user.id, taskId: task.id, deviceId, kind: "code", executionMode: "sandbox", provider: "cursor-agent", model: "default", status: "running", leaseOwner: deviceId, leaseUntil: new Date(Date.now() + 60_000), leaseToken: "files" },
    });
    const beat = (capabilities: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/devices/self/heartbeat", headers: bearer(deviceToken), payload: { runningJobIds: [job.id], appVersion: "cli-0.3.7", capabilities } });
    assert.equal((await beat({ browseFiles: true })).statusCode, 200);
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${job.id}/files`,
      headers: bearer(deviceToken),
      payload: {
        leaseToken: "files",
        files: [
          { path: "usage.md", status: "added", size: 30, content: "# Usage\nkey sk-abcdefghijklmnop12345\n" },
          { path: ".env", status: "added", size: 8, content: null, skipped: "Files that hold keys or secrets are not shown." },
        ],
      },
    });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const wrongLease = await app.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/files`, headers: bearer(deviceToken), payload: { leaseToken: "nope", files: [] } });
    assert.equal(wrongLease.statusCode, 409);
    // The server checks the computer's work again: a secrets file's text is never kept, whatever is sent.
    const sneaky = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${job.id}/files`,
      headers: bearer(deviceToken),
      payload: { leaseToken: "files", files: [{ path: "deploy/.env.production", status: "added", size: 9, content: "TOKEN=abc" }, { path: ".GIT/config", status: "modified", size: 9, content: "[core]" }] },
    });
    assert.equal(sneaky.statusCode, 200, sneaky.body);
    const kept = await prisma.jobFile.findMany({ where: { jobId: job.id, path: { in: ["deploy/.env.production", ".GIT/config"] } } });
    assert.deepEqual(kept.map((row) => row.content), [null, null]);
    assert.ok(kept.every((row) => row.skipped), "kept as names only, with the reason");
    // Ensemble on the web keeps no file text from a run; the web reads the computer when a file is opened.
    const environment = process.env.NODE_ENV;
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    process.env.NODE_ENV = "production";
    try {
      const hosted = await app.inject({
        method: "POST",
        url: `/api/devices/self/jobs/${job.id}/files`,
        headers: bearer(deviceToken),
        payload: { leaseToken: "files", files: [{ path: "notes/hosted.md", status: "added", size: 5, content: "hello" }] },
      });
      assert.equal(hosted.statusCode, 200, hosted.body);
      assert.deepEqual(hosted.json(), { stored: 0 });
      assert.equal(await prisma.jobFile.count({ where: { jobId: job.id, path: "notes/hosted.md" } }), 0);
    } finally {
      process.env.NODE_ENV = environment;
    }
    // At most UPLOAD_FILES_MAX files a run, whatever the computer sends.
    for (let batch = 0; batch < 5; batch += 1) {
      await app.inject({
        method: "POST",
        url: `/api/devices/self/jobs/${job.id}/files`,
        headers: bearer(deviceToken),
        payload: { leaseToken: "files", files: Array.from({ length: 25 }, (_, index) => ({ path: `bulk/${batch}-${index}.txt`, status: "added", size: 1, content: "x" })) },
      });
    }
    assert.equal(await prisma.jobFile.count({ where: { jobId: job.id } }), 100);
    const done = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${job.id}/complete`,
      headers: bearer(deviceToken),
      payload: { leaseToken: "files", outcome: "succeeded", summary: "Wrote usage.md", totals: { files: [{ path: "usage.md", added: 2, removed: 0, status: "added" }, { path: ".env", added: 1, removed: 0, status: "added" }] } },
    });
    assert.equal(done.statusCode, 200, done.body);

    const list = await app.inject({ method: "GET", url: `/api/agent/jobs/${job.id}/files`, headers: cookie(session) });
    assert.equal(list.statusCode, 200, list.body);
    const listed = list.json() as { files: Array<{ path: string; status: string; stored: boolean; skipped: string | null }>; live: { available: boolean } };
    assert.deepEqual(listed.files.slice(0, 2).map((file) => [file.path, file.status, file.stored]), [["usage.md", "added", true], [".env", "added", false]]);
    assert.equal(listed.live.available, true);
    const file = await app.inject({ method: "GET", url: `/api/agent/jobs/${job.id}/file?path=usage.md`, headers: cookie(session) });
    assert.equal(file.statusCode, 200, file.body);
    const body = file.json() as { source: string; file: { content: string } };
    assert.equal(body.source, "stored");
    assert.match(body.file.content, /# Usage/);
    assert.doesNotMatch(body.file.content, /sk-abcdefghijklmnop12345/, "redacted on the server too");
    const secret = await app.inject({ method: "GET", url: `/api/agent/jobs/${job.id}/file?path=.env&live=1`, headers: cookie(session) });
    assert.equal(secret.statusCode, 403, "a secrets file is never asked for");

    const tree = await app.inject({ method: "GET", url: `/api/agent/jobs/${job.id}/tree`, headers: cookie(session) });
    assert.equal(tree.statusCode, 200, tree.body);
    assert.deepEqual((tree.json() as { listing: { entries: Array<{ name: string }> } }).listing.entries.map((entry) => entry.name), ["usage.md", "rea"]);
    const missing = await app.inject({ method: "GET", url: `/api/agent/jobs/${job.id}/file?path=src/x.ts&live=1`, headers: cookie(session) });
    assert.equal(missing.statusCode, 422);
    assert.match(missing.body, /Not here/);

    assert.equal((await beat({ browseFiles: false })).statusCode, 200);
    const off = await app.inject({ method: "GET", url: `/api/agent/jobs/${job.id}/tree`, headers: cookie(session) });
    assert.equal(off.statusCode, 409);
    assert.match(off.body, /turned off on Studio Mac/);
    const offCopy = await app.inject({ method: "GET", url: `/api/agent/jobs/${job.id}/file?path=usage.md`, headers: cookie(session) });
    assert.equal(offCopy.statusCode, 409, "turned off hides the copies too");
    assert.equal((await beat({})).statusCode, 200);
    const old = await app.inject({ method: "GET", url: `/api/agent/jobs/${job.id}/tree`, headers: cookie(session) });
    assert.match(old.body, /Update Ensemble on Studio Mac/);
  } finally {
    stop();
    await app.close();
    await cleanup(user.id);
  }
});

test("a pairing code ignores spaces around it", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `pair-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Pair" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  const session = await sessionFor(user.id);
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const code = (paired.json() as { code: string }).code;
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: `  ${code.toLowerCase()}  `, name: "Studio PC", platform: "windows", capabilities: {} },
    });
    assert.equal(registered.statusCode, 201);
    const listed = await app.inject({ method: "GET", url: "/api/devices", headers: cookie(session) });
    assert.equal((listed.json() as { devices: Array<{ name: string }> }).devices[0]?.name, "Studio PC");
    const deviceId = (registered.json() as { device: { id: string } }).device.id;
    const token = (registered.json() as { token: string }).token;
    const task = await prisma.task.create({ data: { userId: user.id, title: "Hint", createdBy: "me", status: "todo" } });
    const assigned = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "research", deviceId, instructions: "no network field" },
    });
    assert.equal(assigned.statusCode, 201);
    const claimed = await app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(token) });
    assert.equal(claimed.statusCode, 200);
    const spec = claimed.json() as { id: string; leaseToken: string; networkAccess?: boolean };
    assert.equal(typeof spec.networkAccess, "boolean");
    const finished = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${spec.id}/complete`,
      headers: bearer(token),
      payload: { leaseToken: spec.leaseToken, outcome: "succeeded", summary: "ignored the hint" },
    });
    assert.equal(finished.statusCode, 200);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("a chosen option is reason on the device poll and the decision event", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `choice-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Choice" },
  });
  const frames: Array<{ channel: string; event: string; data: Record<string, unknown> }> = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    frames.push({ channel: userId, event: frame.event, data: frame.data as Record<string, unknown> });
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  await app.register(decisionRoutes);
  const session = await sessionFor(user.id);
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Build box", platform: "linux", capabilities: { folders: ["Desk"] } },
    });
    assert.equal(registered.statusCode, 201);
    const { token, device } = registered.json() as { token: string; device: { id: string } };
    const task = await prisma.task.create({ data: { userId: user.id, title: "Choose", createdBy: "me", status: "todo" } });
    const assigned = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "code", deviceId: device.id, folderLabel: "Desk", instructions: "pick one" },
    });
    assert.equal(assigned.statusCode, 201);
    const jobId = (assigned.json() as { jobId: string }).jobId;
    const claimed = await app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(token) });
    assert.equal(claimed.statusCode, 200);
    const body = claimed.json() as { id: string; leaseToken: string };
    const asked = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${body.id}/ask`,
      headers: bearer(token),
      payload: {
        leaseToken: body.leaseToken,
        title: "Which notes?",
        event: "question",
        options: ["Ship the notes", "Leave it"],
      },
    });
    assert.equal(asked.statusCode, 201);
    const decisionId = (asked.json() as { decisionId: string }).decisionId;
    const queued = frames.find((frame) => frame.event === "job.queued" && frame.channel === `device:${device.id}`);
    assert.deepEqual(queued?.data, { id: jobId });

    // A question the agent stopped waiting for is withdrawn by the computer, not left on Needs me.
    const second = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${body.id}/ask`,
      headers: bearer(token),
      payload: { leaseToken: body.leaseToken, title: "Which branch?", event: "question", options: ["main", "testing"] },
    });
    const secondId = (second.json() as { decisionId: string }).decisionId;
    const withdraw = () => app.inject({ method: "POST", url: `/api/devices/self/decisions/${secondId}/close`, headers: bearer(token), payload: { decision: "expired", reason: null } });
    assert.equal((await withdraw()).statusCode, 204);
    assert.equal((await prisma.agentDecision.findUniqueOrThrow({ where: { id: secondId } })).status, "expired");
    assert.equal((await withdraw()).statusCode, 409);

    const decided = await app.inject({
      method: "POST",
      url: `/api/decisions/${decisionId}/decide`,
      headers: cookie(session),
      payload: { decision: "allow", scope: "once", reason: "Ship the notes" },
    });
    assert.equal(decided.statusCode, 200);
    assert.equal((decided.json() as { decision: { reason: string } }).decision.reason, "Ship the notes");

    const polled = await app.inject({
      method: "GET",
      url: `/api/devices/self/decisions/${decisionId}?timeout=1`,
      headers: bearer(token),
    });
    assert.equal(polled.statusCode, 200);
    const row = polled.json() as { id: string; status: string; decision: string; scope: string; reason: string };
    assert.equal(row.id, decisionId);
    assert.equal(row.status, "decided");
    assert.equal(row.decision, "allow");
    assert.equal(row.scope, "once");
    assert.equal(row.reason, "Ship the notes");

    const waited = await app.inject({
      method: "GET",
      url: `/api/decisions/${decisionId}/wait?timeout=1`,
      headers: cookie(session),
    });
    assert.equal(waited.statusCode, 200);
    assert.equal((waited.json() as { reason: string }).reason, "Ship the notes");

    const answered = frames.filter((frame) => frame.event === "decision.answered" && frame.channel === `device:${device.id}`);
    assert.equal(answered.length, 1);
    assert.deepEqual(answered[0]?.data, {
      id: decisionId,
      status: "decided",
      decision: "allow",
      scope: "once",
      reason: "Ship the notes",
    });
  } finally {
    stop();
    await app.close();
    await cleanup(user.id);
  }
});

test("a device answer is once and must be an offered option", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `option-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Option" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  await app.register(decisionRoutes);
  const session = await sessionFor(user.id);
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Build box", platform: "linux", capabilities: { folders: ["Desk"] } },
    });
    const { token, device } = registered.json() as { token: string; device: { id: string } };
    const task = await prisma.task.create({ data: { userId: user.id, title: "Options", createdBy: "me", status: "todo" } });
    await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "code", deviceId: device.id, folderLabel: "Desk", instructions: "choose" },
    });
    const claimed = await app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(token) });
    const body = claimed.json() as { id: string; leaseToken: string };
    const asked = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${body.id}/ask`,
      headers: bearer(token),
      payload: { leaseToken: body.leaseToken, title: "Which notes?", event: "question", options: ["Ship the notes", "Leave it"] },
    });
    const decisionId = (asked.json() as { decisionId: string }).decisionId;
    const reject = async (payload: { decision: "allow" | "deny"; scope?: "once" | "session" | "always"; reason?: string }) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/decisions/${decisionId}/decide`,
        headers: cookie(session),
        payload: { scope: "once", ...payload },
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal((await prisma.agentDecision.findUniqueOrThrow({ where: { id: decisionId } })).status, "pending");
      assert.equal(await prisma.decisionRule.count({ where: { userId: user.id } }), 0);
    };
    await reject({ decision: "allow", reason: "trust me" });
    await reject({ decision: "allow", reason: "ship the notes" });
    await reject({ decision: "allow" });
    await reject({ decision: "allow", scope: "always", reason: "Ship the notes" });
    await reject({ decision: "allow", scope: "session", reason: "Ship the notes" });
    await reject({ decision: "deny", reason: "no thanks" });

    const chosen = await app.inject({
      method: "POST",
      url: `/api/decisions/${decisionId}/decide`,
      headers: cookie(session),
      payload: { decision: "allow", scope: "once", reason: "Ship the notes" },
    });
    assert.equal(chosen.statusCode, 200);
    const stored = chosen.json() as { decision: { scope: string; reason: string } };
    assert.equal(stored.decision.scope, "once");
    assert.equal(stored.decision.reason, "Ship the notes");
    assert.equal(await prisma.decisionRule.count({ where: { userId: user.id } }), 0);

    const open = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${body.id}/ask`,
      headers: bearer(token),
      payload: { leaseToken: body.leaseToken, title: "Continue?", event: "question" },
    });
    assert.equal(open.statusCode, 201);
    const openId = (open.json() as { decisionId: string }).decisionId;
    const typed = await app.inject({
      method: "POST",
      url: `/api/decisions/${openId}/decide`,
      headers: cookie(session),
      payload: { decision: "allow", scope: "once", reason: "my own words" },
    });
    assert.equal(typed.statusCode, 400);
    assert.equal((await prisma.agentDecision.findUniqueOrThrow({ where: { id: openId } })).status, "pending");
    const yes = await app.inject({
      method: "POST",
      url: `/api/decisions/${openId}/decide`,
      headers: cookie(session),
      payload: { decision: "allow", scope: "once" },
    });
    assert.equal(yes.statusCode, 200);
    assert.equal((yes.json() as { decision: { scope: string; reason: string | null } }).decision.scope, "once");
    assert.equal((yes.json() as { decision: { reason: string | null } }).decision.reason, null);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("a permission is answered for the whole run from the web when the computer keeps run rules", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `for-run-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "For run" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  await app.register(decisionRoutes);
  const session = await sessionFor(user.id);
  try {
    const permission = async (capabilities: Record<string, unknown>) => {
      const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
      const registered = await app.inject({
        method: "POST",
        url: "/api/devices/register",
        payload: { code: (paired.json() as { code: string }).code, name: "Build box", platform: "linux", capabilities: { folders: ["Desk"], ...capabilities } },
      });
      const { token, device } = registered.json() as { token: string; device: { id: string } };
      const task = await prisma.task.create({ data: { userId: user.id, title: "Run rules", createdBy: "me", status: "todo" } });
      await app.inject({ method: "POST", url: "/api/agent/assign", headers: cookie(session), payload: { taskId: task.id, kind: "code", deviceId: device.id, folderLabel: "Desk", instructions: "build" } });
      const claimed = (await app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(token) })).json() as { id: string; leaseToken: string };
      const asked = await app.inject({
        method: "POST",
        url: `/api/devices/self/jobs/${claimed.id}/ask`,
        headers: bearer(token),
        payload: { leaseToken: claimed.leaseToken, title: "Run npm test", event: "permission", toolName: "Bash", command: "npm test" },
      });
      return (asked.json() as { decisionId: string }).decisionId;
    };
    const decide = (id: string, scope: "once" | "session" | "always") => app.inject({ method: "POST", url: `/api/decisions/${id}/decide`, headers: cookie(session), payload: { decision: "allow", scope } });

    const older = await permission({});
    const refused = await decide(older, "session");
    assert.equal(refused.statusCode, 400);
    assert.match((refused.json() as { error: string }).error, /Update Ensemble on Build box/);
    assert.equal((await prisma.agentDecision.findUniqueOrThrow({ where: { id: older } })).status, "pending");

    const newer = await permission({ runAnswers: 1 });
    assert.equal((await decide(newer, "always")).statusCode, 400, "trust stays the computer's");
    const forRun = await decide(newer, "session");
    assert.equal(forRun.statusCode, 200);
    assert.equal((forRun.json() as { decision: { scope: string } }).decision.scope, "session");
    // The rule is kept on the computer, which reads the answer's scope; none is saved here.
    assert.equal(await prisma.decisionRule.count({ where: { userId: user.id } }), 0);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("the web cannot approve a run-branch push", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `push-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Push" },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  await app.register(decisionRoutes);
  const session = await sessionFor(user.id);
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Build box", platform: "linux", capabilities: { folders: ["Desk"] } },
    });
    assert.equal(registered.statusCode, 201);
    const { token, device } = registered.json() as { token: string; device: { id: string } };
    const task = await prisma.task.create({ data: { userId: user.id, title: "Push", createdBy: "me", status: "todo" } });
    const assigned = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "code", deviceId: device.id, folderLabel: "Desk", instructions: "push the branch" },
    });
    assert.equal(assigned.statusCode, 201);
    const claimed = await app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(token) });
    const body = claimed.json() as { id: string; leaseToken: string };
    const asked = await app.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${body.id}/ask`,
      headers: bearer(token),
      payload: { leaseToken: body.leaseToken, title: "Push the run branch?", event: "permission", toolName: "git push", tier: "run_branch_push" },
    });
    assert.equal(asked.statusCode, 201);
    const decisionId = (asked.json() as { decisionId: string }).decisionId;
    for (const decision of ["allow", "deny"] as const) {
      const refused = await app.inject({
        method: "POST",
        url: `/api/decisions/${decisionId}/decide`,
        headers: cookie(session),
        payload: { decision, scope: "once" },
      });
      assert.equal(refused.statusCode, 403, decision);
      assert.equal((refused.json() as { error: string }).error, "Approve this on Build box.");
    }
    assert.equal((await prisma.agentDecision.findUniqueOrThrow({ where: { id: decisionId } })).status, "pending");
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("resume wakes a computer that has a queued job", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `resume-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Resume" },
  });
  const frames: Array<{ channel: string; event: string; data: Record<string, unknown> }> = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    frames.push({ channel: userId, event: frame.event, data: frame.data as Record<string, unknown> });
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  const session = await sessionFor(user.id);
  try {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name: "Resume box", platform: "linux", capabilities: { folders: ["Desk"] } },
    });
    assert.equal(registered.statusCode, 201);
    const { device } = registered.json() as { device: { id: string } };
    const task = await prisma.task.create({ data: { userId: user.id, title: "Wait", createdBy: "me", status: "todo" } });
    const assigned = await app.inject({
      method: "POST",
      url: "/api/agent/assign",
      headers: cookie(session),
      payload: { taskId: task.id, kind: "code", deviceId: device.id, folderLabel: "Desk", instructions: "wait" },
    });
    assert.equal(assigned.statusCode, 201);
    const jobId = (assigned.json() as { jobId: string }).jobId;
    frames.length = 0;
    const resumed = await app.inject({ method: "POST", url: "/api/agent/resume", headers: cookie(session) });
    assert.equal(resumed.statusCode, 200);
    const queued = frames.filter((frame) => frame.event === "job.queued" && frame.channel === `device:${device.id}`);
    assert.deepEqual(queued.map((frame) => frame.data), [{ id: jobId }]);
  } finally {
    stop();
    await app.close();
    await cleanup(user.id);
  }
});

test("after an outage: a run that kept going reattaches, a run lost to a restart is carried on at most twice, a freed slot wakes the computer, and a computer paired again keeps its runs", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `recover-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Recover" },
  });
  const frames: Array<{ channel: string; event: string; data: Record<string, unknown> }> = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    frames.push({ channel: userId, event: frame.event, data: frame.data as Record<string, unknown> });
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  const session = await sessionFor(user.id);
  const pair = async (name: string, installId: string) => {
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({
      method: "POST",
      url: "/api/devices/register",
      payload: { code: (paired.json() as { code: string }).code, name, platform: "linux", capabilities: { installId } },
    });
    assert.equal(registered.statusCode, 201);
    return registered.json() as { token: string; device: { id: string } };
  };
  try {
    const home = await pair("Home server", "install-1");
    const task = await prisma.task.create({ data: { userId: user.id, title: "Outage", createdBy: "me", status: "todo" } });
    const assign = async () => {
      const assigned = await app.inject({ method: "POST", url: "/api/agent/assign", headers: cookie(session), payload: { taskId: task.id, kind: "code", deviceId: home.device.id, repoUrl: "octocat/Hello-World", instructions: "work" } });
      assert.equal(assigned.statusCode, 201);
      return (assigned.json() as { jobId: string }).jobId;
    };
    const claim = async () => {
      const claimed = await app.inject({ method: "POST", url: "/api/devices/self/claim", headers: bearer(home.token) });
      assert.equal(claimed.statusCode, 200);
      return claimed.json() as { id: string; leaseToken: string; continueFromJobId?: string | null; resume?: { reason: string; attempt: number } };
    };
    const expire = async (jobId: string) => {
      await prisma.workspaceJob.update({ where: { id: jobId }, data: { leaseUntil: new Date(Date.now() - 5_000) } });
      assert.equal(await sweepExpiredDeviceLeases(app), 1);
    };
    const post = (jobId: string, route: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/devices/self/jobs/${jobId}/${route}`, headers: bearer(home.token), payload });

    // The computer lost its connection while the run kept going: its next post is refused, it reattaches and finishes.
    const kept = await assign();
    const keptSpec = await claim();
    await expire(kept);
    assert.equal((await post(kept, "progress", { leaseToken: keptSpec.leaseToken, status: "running", progress: "late" })).statusCode, 409);
    const back = await post(kept, "reattach", { leaseToken: keptSpec.leaseToken, status: "running" });
    assert.equal(back.statusCode, 200, back.body);
    const lease = (back.json() as { leaseToken: string }).leaseToken;
    const revived = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: kept } });
    assert.equal(revived.status, "running");
    assert.equal(revived.error, null);
    assert.equal(revived.finishedAt, null);
    assert.equal(await prisma.workspaceEvent.count({ where: { jobId: kept, kind: "reconnected" } }), 1);
    frames.length = 0;
    const queuedMeanwhile = await assign();
    assert.equal((await post(kept, "complete", { leaseToken: lease, outcome: "succeeded", summary: "done offline" })).statusCode, 200);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: kept } })).status, "succeeded");
    assert.ok(frames.some((frame) => frame.event === "job.queued" && frame.channel === `device:${home.device.id}`), "a finished run wakes the computer for queued work");
    await prisma.workspaceJob.update({ where: { id: queuedMeanwhile }, data: { status: "cancelled", finishedAt: new Date() } });

    // A run stopped on the web is not taken back.
    const stopped = await assign();
    const stoppedSpec = await claim();
    await expire(stopped);
    await prisma.workspaceJob.update({ where: { id: stopped }, data: { cancelRequestedAt: new Date() } });
    const refusedBack = await post(stopped, "reattach", { leaseToken: stoppedSpec.leaseToken, status: "running" });
    assert.equal(refusedBack.statusCode, 409);
    assert.match((refusedBack.json() as { error: string }).error, /stopped on the web/);

    // The computer restarted before the lease ran out: the run is carried on, in the same chain, twice at most.
    const lost = await assign();
    const lostSpec = await claim();
    const first = await post(lost, "resume", { leaseToken: lostSpec.leaseToken, reason: "the computer restarted" });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: lost } })).status, "interrupted");
    const carried = await claim();
    assert.equal(carried.id, (first.json() as { jobId: string }).jobId);
    assert.equal(carried.continueFromJobId, lost);
    assert.deepEqual(carried.resume, { reason: "the computer restarted", attempt: 1 });
    await expire(carried.id);
    const second = await post(carried.id, "resume", { leaseToken: carried.leaseToken, reason: "power cut" });
    assert.equal(second.statusCode, 201, second.body);
    const again = await claim();
    assert.equal(again.resume?.attempt, 2);
    await expire(again.id);
    const third = await post(again.id, "resume", { leaseToken: again.leaseToken, reason: "power cut" });
    assert.equal(third.statusCode, 409);
    assert.match((third.json() as { error: string }).error, /cut off 3 times/);
    assert.equal((await prisma.workspaceJob.findUniqueOrThrow({ where: { id: again.id } })).status, "interrupted");
    assert.equal((await post(lost, "resume", { leaseToken: lostSpec.leaseToken, reason: "x" })).statusCode, 409, "an interrupted run already carried on is not carried on twice");

    // Signed out and paired again: the same installation is the same computer, and its earlier runs show on it.
    assert.equal((await app.inject({ method: "DELETE", url: `/api/devices/${home.device.id}`, headers: cookie(session) })).statusCode, 204);
    const elsewhere = await pair("Laptop", "install-2");
    const rehome = await pair("Home server (renamed)", "install-1");
    const shown = await app.inject({ method: "GET", url: `/api/agent/jobs/${kept}`, headers: cookie(session) });
    const card = (shown.json() as { job: { deviceId: string; deviceRevoked: boolean; deviceName: string } }).job;
    assert.equal(card.deviceId, rehome.device.id);
    assert.equal(card.deviceRevoked, false);
    assert.notEqual(card.deviceId, elsewhere.device.id);
  } finally {
    stop();
    await app.close();
    await cleanup(user.id);
  }
});

test("an assignment on a Settings tier's own model takes the tier's thinking level and context window; another engine takes neither", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({ data: { email: `tier-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Tier" } });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1, sadd: async () => 1 } as unknown as Redis);
  install(app);
  await app.register(deviceRoutes);
  await app.register(agentRoutes);
  const session = await sessionFor(user.id);
  try {
    await saveSettings(prisma, user.id, { models: { high: { provider: "copilot-cli", model: "gpt-6.1-sol", effort: "xhigh", context: "long_context" } } });
    const paired = await app.inject({ method: "POST", url: "/api/devices/pair", headers: cookie(session) });
    const registered = await app.inject({ method: "POST", url: "/api/devices/register", payload: { code: (paired.json() as { code: string }).code, name: "Box", platform: "linux", capabilities: { engines: ["claude-code", "codex", "cursor-agent", "copilot-cli"] } } });
    const device = (registered.json() as { device: { id: string } }).device;
    const task = await prisma.task.create({ data: { userId: user.id, title: "Tiered", createdBy: "me", status: "todo", complexity: "high" } });
    const onTier = await app.inject({ method: "POST", url: "/api/agent/assign", headers: cookie(session), payload: { taskId: task.id, kind: "code", deviceId: device.id, instructions: "x" } });
    assert.equal(onTier.statusCode, 201, onTier.body);
    const tiered = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: (onTier.json() as { jobId: string }).jobId } });
    assert.equal(tiered.provider, "copilot-cli");
    assert.equal(tiered.model, "gpt-6.1-sol");
    assert.equal(tiered.reasoningEffort, "xhigh");
    assert.equal((tiered.context as { contextTier?: string }).contextTier, "long_context");
    const other = await app.inject({ method: "POST", url: "/api/agent/assign", headers: cookie(session), payload: { taskId: task.id, kind: "code", deviceId: device.id, engine: "claude-code", instructions: "x" } });
    assert.equal(other.statusCode, 201, other.body);
    const claude = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: (other.json() as { jobId: string }).jobId } });
    assert.equal(claude.reasoningEffort, null, "a Copilot tier's level is not Claude Code's");
    assert.equal((claude.context as { contextTier?: string }).contextTier, undefined);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});
