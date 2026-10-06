/**
 * Assigning work to the agent, the queue, and the kill switch.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { isPaused, listActivities, requestCancel } from "../lib/activity.js";
import { git } from "../lib/git.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { requireHostAccess } from "../lib/hosted-access.js";
import { declareModule } from "../lib/module-gate.js";
import { deviceOnline, serverRunnerEnabled } from "../devices/constants.js";
import { jobOrigin } from "../remote/origin.js";
import { Assign, createJob } from "../workspace/assign.js";
import { blockedReason, resolveWorkFolder, sandboxAvailable, ENSEMBLE_SOURCE, within, workspaceRoot } from "../workspace/guard.js";
import { liveLog } from "../workspace/live-log.js";
import { capabilities } from "../workspace/sandbox/spawn.js";
import { PATH_RULE_SOURCE, PATH_RULE_TOOL } from "../workspace/trust.js";
import { resume, stopEverything, stopJob } from "../workspace/worker.js";

const run = promisify(execFile);

type JobRow = Awaited<ReturnType<FastifyInstance["prisma"]["workspaceJob"]["findMany"]>>[number] & {
  task: { id: string; title: string; priority: string; status: string };
  device?: { name: string; lastSeenAt: Date | null; revokedAt: Date | null } | null;
};

function card(job: JobRow, position?: number) {
  return {
    id: job.id,
    taskId: job.taskId,
    title: job.task.title,
    priority: job.task.priority,
    kind: job.kind,
    status: job.status,
    position: position ?? null,
    executionMode: job.executionMode,
    delivery: job.delivery,
    useCredentials: job.useCredentials,
    askBeforePublish: job.askBeforePublish,
    unattended: job.unattended,
    accessMode: job.accessMode,
    markDone: job.markDone,
    instructions: job.instructions,
    branchMode: job.branchMode,
    reasoningEffort: job.reasoningEffort,
    networkAccess: job.networkAccess,
    maxTurns: job.maxTurns,
    folder: job.folderLabel ?? job.externalRoot ?? job.repoPath ?? "",
    deviceId: job.deviceId,
    deviceName: job.device?.name ?? null,
    deviceOnline: job.deviceId ? deviceOnline(job.device?.lastSeenAt ?? null) && !job.device?.revokedAt : null,
    deviceRevoked: Boolean(job.device?.revokedAt),
    folderLabel: job.folderLabel,
    results: Array.isArray(job.results) ? job.results : [],
    cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
    repoUrl: job.repoUrl,
    branch: job.branch,
    provider: job.provider,
    model: job.model,
    progress: job.progress,
    summary: job.summary,
    error: job.error,
    turns: job.turns,
    toolCalls: job.toolCalls,
    tokensIn: job.tokensIn,
    tokensOut: job.tokensOut,
    maxToolCalls: job.maxToolCalls,
    maxMinutes: job.maxMinutes,
    continueFromJobId: job.continueFromJobId,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    origin: jobOrigin(job.context),
  };
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  declareModule(app, "workspace");
  app.addHook("preHandler", async (request) => {
    if (request.url.split("?")[0]?.startsWith("/api/workspace")) await requireHostAccess(request.userId, "Host workspace filesystem");
  });
  const { prisma } = app;

  app.post("/api/agent/assign", async (request, reply) => {
    if (request.body && typeof request.body === "object" && "runBranchPush" in request.body) {
      return reply.code(403).send({ error: "Run-branch push is set on your computer. This page cannot change it." });
    }
    const body = Assign.parse(request.body);
    if (body.deviceId && (await isPaused(app.redis, request.userId))) {
      return reply.code(409).send({ error: "The agent is paused. Resume it before assigning work to a computer." });
    }
    const created = await createJob(prisma, request.userId, body);
    return created ? reply.code(201).send(created) : reply.code(404).send({ error: "Task not found." });
  });

  /**
   * Run again: a new job with the same settings. A workspace checkout
   * continues in the same folder, so partial work is kept; trust and
   * unattended are checked again as for a new assignment. A device job
   * is queued for that computer again, not run on this server.
   */
  app.post("/api/agent/jobs/:id/retry", async (request, reply) => {
    const { id } = request.params as { id: string };
    const old = await prisma.workspaceJob.findFirst({ where: { id, userId: request.userId } });
    if (!old) return reply.code(404).send({ error: "Job not found." });
    if (!["interrupted", "failed", "cancelled", "blocked"].includes(old.status)) {
      return reply.code(409).send({ error: "Only a stopped job can be run again." });
    }
    if (old.deviceId && (await isPaused(app.redis, request.userId))) {
      return reply.code(409).send({ error: "The agent is paused. Resume it before assigning work to a computer." });
    }
    const sameFolder = !old.deviceId && old.kind === "code" && !old.externalRoot && Boolean(old.repoPath);
    const created = await createJob(
      prisma,
      request.userId,
      Assign.parse({
        taskId: old.taskId,
        kind: old.kind,
        provider: old.provider ?? undefined,
        model: old.model,
        reasoningEffort: old.reasoningEffort ?? undefined,
        instructions: old.instructions,
        folder: old.deviceId ? undefined : old.externalRoot ?? undefined,
        folderLabel: old.deviceId ? old.folderLabel ?? undefined : undefined,
        deviceId: old.deviceId ?? undefined,
        continueFromJobId: old.deviceId || sameFolder ? old.id : old.continueFromJobId ?? undefined,
        repoUrl: old.deviceId || (!sameFolder && !old.externalRoot && !old.continueFromJobId) ? old.repoUrl ?? undefined : undefined,
        branchMode: sameFolder ? "as-is" : old.branchMode,
        branch: sameFolder || old.branchMode === "as-is" ? undefined : old.branch || undefined,
        delivery: old.delivery,
        askBeforePublish: old.askBeforePublish,
        useCredentials: old.useCredentials,
        sandbox: old.executionMode === "sandbox",
        network: old.networkAccess,
        markDone: old.markDone,
        unattended: old.deviceId ? false : old.unattended,
        accessMode: old.deviceId ? "read-write" : old.accessMode === "review" ? "review" : "read-write",
        maxMinutes: old.maxMinutes,
        maxToolCalls: old.maxToolCalls,
        maxTurns: old.maxTurns,
      }),
      { retryOf: old.id },
    );
    return created ? reply.code(201).send(created) : reply.code(404).send({ error: "Task not found." });
  });

  app.get("/api/workspace", async (request) => {
    const userId = request.userId;
    const since = new Date(Date.now() - 14 * 86_400_000);
    const [jobs, settings, paused] = await Promise.all([
      prisma.workspaceJob.findMany({
        where: { userId, OR: [{ finishedAt: null }, { finishedAt: { gte: since } }] },
        orderBy: { sequence: "asc" },
        take: 200,
        include: { task: { select: { id: true, title: true, priority: true, status: true } }, device: { select: { name: true, lastSeenAt: true, revokedAt: true } } },
      }),
      loadSettings(prisma, userId),
      isPaused(app.redis, userId),
    ]);
    const queued = jobs.filter((job) => job.status === "queued");
    const recent = (statuses: string[]) =>
      jobs
        .filter((job) => statuses.includes(job.status))
        .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0))
        .slice(0, 12)
        .map((job) => card(job));
    return {
      root: await workspaceRoot(),
      maxConcurrent: settings.orchestration.maxConcurrentJobs,
      paused,
      sandboxAvailable,
      serverRunner: serverRunnerEnabled(),
      queued: queued.map((job, index) => card(job, index + 1)),
      running: jobs.filter((job) => job.status === "running" || job.status === "stopping" || job.status === "claimed").map((job) => card(job)),
      waiting: jobs.filter((job) => job.status === "waiting_approval").map((job) => card(job)),
      stopped: recent(["interrupted", "blocked", "failed", "cancelled"]),
      completed: recent(["succeeded"]),
    };
  });

  app.get("/api/agent/jobs", async (request) => {
    const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.query);
    const jobs = await prisma.workspaceJob.findMany({
      where: { userId: request.userId, taskId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { task: { select: { id: true, title: true, priority: true, status: true } }, review: { select: { id: true } }, device: { select: { name: true, lastSeenAt: true, revokedAt: true } } },
    });
    return { jobs: jobs.map((job) => ({ ...card(job), reviewId: job.review?.id ?? null })) };
  });

  app.get("/api/agent/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await prisma.workspaceJob.findFirst({
      where: { id, userId: request.userId },
      include: { task: { select: { id: true, title: true, priority: true, status: true } }, review: { select: { id: true } }, device: { select: { name: true, lastSeenAt: true, revokedAt: true } } },
    });
    if (!job) return reply.code(404).send({ error: "Job not found." });
    const events = await prisma.workspaceEvent.findMany({ where: { jobId: id }, orderBy: { sequence: "desc" }, take: 150 });
    return {
      job: {
        ...card(job),
        reviewId: job.review?.id ?? null,
        instructions: job.instructions,
        networkAccess: job.networkAccess,
        unattended: job.unattended,
        accessMode: job.accessMode,
        sandbox: { ...capabilities(), effective: job.executionMode === "sandbox" && sandboxAvailable },
      },
      log: liveLog(job.id),
      events: events.reverse().map((event) => ({ id: event.id, kind: event.kind, data: event.data, at: event.createdAt.toISOString() })),
    };
  });

  app.post("/api/agent/jobs/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = await stopJob(app, request.userId, id);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: "Job not found." });
  });

  app.get("/api/agent/jobs/:id/logs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { after } = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    const job = await prisma.workspaceJob.findFirst({ where: { id, userId: request.userId }, select: { id: true } });
    if (!job) return reply.code(404).send({ error: "Job not found." });
    const chunks = await prisma.workspaceLogChunk.findMany({
      where: { jobId: id, seqFrom: { gt: after } },
      orderBy: { seqFrom: "asc" },
      take: 200,
    });
    return {
      chunks: chunks.map((chunk) => ({
        seqFrom: chunk.seqFrom,
        seqTo: chunk.seqTo,
        text: chunk.text,
        bytes: chunk.bytes,
        at: chunk.createdAt.toISOString(),
      })),
    };
  });

  app.get("/api/workspace/checkouts", async (request) => {
    const jobs = await prisma.workspaceJob.findMany({
      where: { userId: request.userId, kind: "code" },
      orderBy: { createdAt: "desc" },
      take: 40,
      include: { task: { select: { title: true } } },
    });
    const seen = new Set<string>();
    const rows = [];
    for (const job of jobs) {
      const folder = job.externalRoot ?? job.repoPath;
      const key = folder || `job:${job.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (folder && !(await stat(folder).then(() => true).catch(() => false))) continue;
      rows.push({ jobId: job.id, title: job.task.title, status: job.status, folder, branch: job.branch, createdAt: job.createdAt.toISOString() });
    }
    return { checkouts: rows };
  });

  app.post("/api/workspace/resolve-folder", async (request) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(request.body);
    const real = await resolveWorkFolder(path);
    const isGit = await stat(`${real}/.git`).then(() => true).catch(() => false);
    const branch = isGit ? (await git(real, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim() : null;
    return { path: real, git: isGit, branch };
  });

  /** The macOS folder dialog, on this Mac only. A browser cannot hand over an absolute path. */
  app.post("/api/workspace/pick-folder", async (request, reply) => {
    const ip = request.ip.replace(/^::ffff:/, "");
    if (!["127.0.0.1", "::1"].includes(ip)) return reply.code(403).send({ error: "The folder picker only opens on this computer." });
    if (process.platform !== "darwin") return reply.code(400).send({ error: "Type the folder path instead." });
    try {
      const { stdout } = await run("/usr/bin/osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose the folder the agent may work in")'], { timeout: 180_000 });
      const chosen = stdout.trim().replace(/\/$/, "");
      const reason = blockedReason(chosen);
      if (reason) return reply.code(403).send({ error: reason, path: chosen });
      const real = await resolveWorkFolder(chosen);
      const isGit = await stat(`${real}/.git`).then(() => true).catch(() => false);
      return { path: real, git: isGit };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/-128|User canceled/i.test(message)) return reply.code(204).send();
      throw error;
    }
  });

  app.get("/api/workspace/branches", async (request) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(request.query);
    const base = await workspaceRoot();
    const real = within(base, path) ? path : await resolveWorkFolder(path);
    const out = await git(real, ["branch", "-a", "--format=%(refname:short)"]).catch(() => "");
    const branches = [...new Set(out.split("\n").map((line) => line.trim().replace(/^origin\//, "")).filter((name) => name && name !== "HEAD" && name !== "origin"))];
    return { branches };
  });

  app.get("/api/workspace/trust", async (request) => {
    const rules = await prisma.decisionRule.findMany({
      where: { userId: request.userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL, decision: "allow", sessionId: null },
      orderBy: { createdAt: "desc" },
    });
    return { folders: rules.map((rule) => ({ id: rule.id, path: rule.pattern, createdAt: rule.createdAt.toISOString() })) };
  });

  app.post("/api/workspace/trust", async (request, reply) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(request.body);
    const real = await resolveWorkFolder(path);
    const existing = await prisma.decisionRule.findFirst({
      where: { userId: request.userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL, pattern: real, decision: "allow", sessionId: null },
    });
    const rule =
      existing ??
      (await prisma.decisionRule.create({
        data: { userId: request.userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL, pattern: real, decision: "allow", sessionId: null },
      }));
    return reply.code(existing ? 200 : 201).send({ id: rule.id, path: real });
  });

  app.delete("/api/workspace/trust/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await prisma.decisionRule.deleteMany({
      where: { id, userId: request.userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL },
    });
    return result.count ? reply.code(204).send() : reply.code(404).send({ error: "That folder is not trusted." });
  });

  app.get("/api/workspace/guard", async () => ({
    root: await workspaceRoot(),
    ensembleSource: ENSEMBLE_SOURCE,
    sandboxAvailable,
    sandbox: capabilities(),
  }));

  // ── the top bar: what is running, and the kill switch ─────────────────────

  app.get("/api/agent/state", async (request) => {
    const userId = request.userId;
    const activities = await listActivities(app.redis, userId);
    const [paused, jobs] = await Promise.all([
      isPaused(app.redis, userId),
      prisma.workspaceJob.findMany({
        where: { userId, status: { in: ["queued", "claimed", "running", "stopping", "waiting_approval"] } },
        orderBy: { sequence: "asc" },
        include: { task: { select: { id: true, title: true, priority: true, status: true } }, device: { select: { name: true, lastSeenAt: true, revokedAt: true } } },
      }),
    ]);
    const jobIds = new Set(jobs.map((job) => `job:${job.id}`));
    return {
      paused,
      calls: activities.filter((row) => !jobIds.has(row.id)).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
      running: jobs.filter((job) => job.status === "running" || job.status === "stopping" || job.status === "claimed").map((job) => card(job)),
      waiting: jobs.filter((job) => job.status === "waiting_approval").map((job) => card(job)),
      queued: jobs.filter((job) => job.status === "queued").map((job, index) => card(job, index + 1)),
    };
  });

  app.post("/api/agent/pause", async (request) => stopEverything(app, request.userId, { pause: true, cancelQueued: false }));
  app.post("/api/agent/stop-all", async (request) => stopEverything(app, request.userId, { pause: false, cancelQueued: true }));
  app.post("/api/agent/resume", async (request) => {
    await resume(app, request.userId);
    return { ok: true };
  });

  /** Stop one in-flight call: an assistant turn, a fetch, or a job. */
  app.post("/api/activity/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id.startsWith("job:")) await stopJob(app, request.userId, id.slice(4));
    else await requestCancel(app.redis, request.userId, id);
    await appendLedger({ userId: request.userId, actor: "me", action: "activity.stop", payload: { id } });
    return reply.code(204).send();
  });
}
