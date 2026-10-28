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
import { OCCUPIED, queueWaitReason } from "../workspace/queue-policy.js";
import { canUseHostCredentials, requireHostAccess } from "../lib/hosted-access.js";
import { declareModule } from "../lib/module-gate.js";
import { deviceOnline, serverRunnerEnabled } from "../devices/constants.js";
import { currentDevice, currentDevices } from "../devices/successor.js";
import { earlierRuns } from "../devices/earlier.js";
import { jobOrigin } from "../remote/origin.js";
import { repeatAssignment, resumeOf } from "../workspace/repeat.js";
import { MAX_AUTO_RESUMES } from "../remote/contract.js";
import { Assign, createJob } from "../workspace/assign.js";
import { blockedReason, resolveWorkFolder, sandboxAvailable, ENSEMBLE_SOURCE, within, workspaceRoot } from "../workspace/guard.js";
import { liveLog } from "../workspace/live-log.js";
import { capabilities, prepareSandbox, setupSandbox } from "../workspace/sandbox/spawn.js";
import { contextTierOf, fastOf, outsideAccessOf, PATH_RULE_SOURCE, PATH_RULE_TOOL } from "../workspace/trust.js";
import { pullRequestOf } from "../workspace/pull-request.js";
import { listSessions, resolveSession, sessionOfJob } from "../workspace/sessions.js";
import { installedTrustTools, loadSharedTrust, setSharedTrust, TRUST_TOOLS, trustChanged, type SharedTrustState } from "../workspace/trust-share.js";
import { resume, stopEverything, stopJob } from "../workspace/worker.js";
import { actorFor } from "../sharing/context.js";
import { jobFileRoutes } from "./job-files.js";

const run = promisify(execFile);

type JobRow = Awaited<ReturnType<FastifyInstance["prisma"]["workspaceJob"]["findMany"]>>[number] & {
  task: { id: string; title: string; priority: string; status: string };
  device?: { name: string; lastSeenAt: Date | null; revokedAt: Date | null } | null;
};

/**
 * Whose computer a job runs on. In a shared space only that person sees which computer it is;
 * everyone else sees "<name>'s computer" (the web resolves the name from runnerAccountId).
 */
function yours(job: { userId: string; runnerAccountId: string | null }): boolean {
  return (job.runnerAccountId ?? null) === actorFor(job.userId);
}

/** Only the person whose computer runs a job may stop it or run it again. */
export async function runnerRefusal(app: FastifyInstance, job: { userId: string; runnerAccountId: string | null }): Promise<string | null> {
  if (yours(job)) return null;
  const id = job.runnerAccountId ?? (await app.prisma.user.findUnique({ where: { id: job.userId }, select: { ownerId: true } }))?.ownerId ?? job.userId;
  const row = await app.prisma.user.findUnique({ where: { id }, select: { name: true } });
  const first = row?.name.trim().split(/\s+/)[0];
  return `Only ${first && !first.includes("@") ? first : "the person running it"} can do this. It runs on their computer.`;
}

type DeviceShown = { name: string; lastSeenAt: Date | null; revokedAt: Date | null };

/** Runs on a computer that was paired again show, and open, on its current pairing (devices/successor.ts). */
async function onCurrentDevices<T extends { deviceId: string | null; device?: DeviceShown | null }>(prisma: FastifyInstance["prisma"], jobs: T[]): Promise<T[]> {
  const revoked = [...new Set(jobs.filter((job) => job.deviceId && job.device?.revokedAt).map((job) => job.deviceId!))];
  if (!revoked.length) return jobs;
  const current = await currentDevices(prisma, await prisma.device.findMany({ where: { id: { in: revoked } } }));
  for (const job of jobs) {
    const next = job.deviceId ? current.get(job.deviceId) : null;
    if (!next) continue;
    job.deviceId = next.id;
    job.device = { name: next.name, lastSeenAt: next.lastSeenAt, revokedAt: null };
  }
  return jobs;
}

/** What a finished run reported: the model that answered, its cost estimate, the files it changed (names and line counts). */
function evidenceOf(job: JobRow): { modelUsed: string | null; costUsd: number | null; files: Array<{ path: string; added: number; removed: number }>; deviceReviewId: string | null } {
  const evidence = (job.evidence && typeof job.evidence === "object" && !Array.isArray(job.evidence) ? job.evidence : {}) as Record<string, unknown>;
  return {
    modelUsed: typeof evidence.model === "string" && evidence.model ? evidence.model : null,
    costUsd: typeof evidence.costUsd === "number" && Number.isFinite(evidence.costUsd) ? evidence.costUsd : null,
    files: (Array.isArray(evidence.files) ? evidence.files : []).slice(0, 200) as Array<{ path: string; added: number; removed: number }>,
    // The run's review on the computer that ran it (protocol 4): the web's Code tab opens it through that computer.
    deviceReviewId: job.deviceId && typeof evidence.reviewId === "string" ? evidence.reviewId : null,
  };
}

function card(job: JobRow, position?: number, options: { paths?: boolean } = {}) {
  const mine = yours(job);
  // A run on this server keeps its folder path to itself unless the caller may see this server's folders.
  const paths = options.paths !== false || Boolean(job.deviceId);
  return {
    ...evidenceOf(job),
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
    // A run that ends in a pull request (docs/24 §5.1); Run again keeps it.
    pullRequest: pullRequestOf(job.context),
    contextTier: contextTierOf(job.context),
    fast: fastOf(job.context),
    maxTurns: job.maxTurns,
    folder: job.folderLabel ?? (paths ? job.externalRoot ?? job.repoPath ?? "" : ""),
    runId: job.runId,
    deviceId: mine ? job.deviceId : null,
    deviceName: mine ? (job.device?.name ?? null) : null,
    runnerAccountId: job.runnerAccountId,
    yours: mine,
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
    // Carrying on a run cut off when its computer restarted (devices/recover.ts).
    resume: resumeOf(job.context) ? { ...resumeOf(job.context)!, of: MAX_AUTO_RESUMES } : null,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    origin: jobOrigin(job.context),
  };
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  declareModule(app, "workspace");
  // The board is the person's own job rows (their paired computers' work included), so it is open to
  // everyone; the routes under it that read this server's folders, branches and trust stay host-only.
  app.addHook("preHandler", async (request) => {
    if (request.routeOptions.url === "/api/workspace") return;
    if (request.url.split("?")[0]?.startsWith("/api/workspace")) await requireHostAccess(request.userId, "Host workspace filesystem");
  });
  const { prisma } = app;
  // A job's changed files and its folder, read live (job-files.ts).
  await jobFileRoutes(app);

  app.post("/api/agent/assign", async (request, reply) => {
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
    const refusal = await runnerRefusal(app, old);
    if (refusal) return reply.code(403).send({ error: refusal });
    if (!["interrupted", "failed", "cancelled", "blocked"].includes(old.status)) {
      return reply.code(409).send({ error: "Only a stopped job can be run again." });
    }
    if (old.deviceId && (await isPaused(app.redis, request.userId))) {
      return reply.code(409).send({ error: "The agent is paused. Resume it before assigning work to a computer." });
    }
    // A computer paired again since runs it again under its current pairing.
    const ranOn = old.deviceId ? await prisma.device.findUnique({ where: { id: old.deviceId } }) : null;
    const now = ranOn ? await currentDevice(prisma, ranOn) : null;
    const created = await createJob(
      prisma,
      request.userId,
      repeatAssignment(now && now.id !== old.deviceId ? { ...old, deviceId: now.id } : old),
      { retryOf: old.id },
    );
    return created ? reply.code(201).send(created) : reply.code(404).send({ error: "Task not found." });
  });

  app.get("/api/workspace", async (request) => {
    const userId = request.userId;
    const host = await canUseHostCredentials(userId);
    const since = new Date(Date.now() - 14 * 86_400_000);
    const [jobs, settings, paused] = await Promise.all([
      prisma.workspaceJob.findMany({
        where: { userId, OR: [{ finishedAt: null }, { finishedAt: { gte: since } }] },
        orderBy: { sequence: "asc" },
        take: 200,
        include: { task: { select: { id: true, title: true, priority: true, status: true, projectId: true, repoId: true } }, device: { select: { name: true, lastSeenAt: true, revokedAt: true } } },
      }),
      loadSettings(prisma, userId),
      isPaused(app.redis, userId),
    ]);
    await onCurrentDevices(prisma, jobs);
    const queued = jobs.filter((job) => job.status === "queued");
    const recent = (statuses: string[]) =>
      jobs
        .filter((job) => statuses.includes(job.status))
        .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0))
        .slice(0, 12)
        .map((job) => card(job, undefined, { paths: host }));
    return {
      // This server's own folder and sandbox only for whoever may use them (the operator, or the desktop app).
      root: host ? await workspaceRoot() : null,
      maxConcurrent: settings.orchestration.maxConcurrentJobs,
      paused,
      sandboxAvailable: host && sandboxAvailable(),
      serverRunner: serverRunnerEnabled(),
      // Why each one has not started: the pause, a running task it must wait for, or every slot in use.
      queued: queued.map((job, index) => ({ ...card(job, index + 1, { paths: host }), waitingFor: waitReason(job, jobs, settings.orchestration.maxConcurrentJobs, paused) })),
      running: jobs.filter((job) => job.status === "running" || job.status === "stopping" || job.status === "claimed").map((job) => card(job, undefined, { paths: host })),
      waiting: jobs.filter((job) => job.status === "waiting_approval").map((job) => card(job, undefined, { paths: host })),
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
    const host = await canUseHostCredentials(request.userId);
    await onCurrentDevices(prisma, jobs);
    return { jobs: jobs.map((job) => ({ ...card(job, undefined, { paths: host }), reviewId: job.review?.id ?? null })) };
  });

  app.get("/api/agent/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await prisma.workspaceJob.findFirst({
      where: { id, userId: request.userId },
      include: { task: { select: { id: true, title: true, priority: true, status: true } }, review: { select: { id: true } }, device: { select: { name: true, lastSeenAt: true, revokedAt: true } } },
    });
    if (!job) return reply.code(404).send({ error: "Job not found." });
    await onCurrentDevices(prisma, [job]);
    const events = await prisma.workspaceEvent.findMany({ where: { jobId: id }, orderBy: { sequence: "desc" }, take: 150 });
    const host = await canUseHostCredentials(request.userId);
    return {
      job: {
        ...card(job, undefined, { paths: host }),
        reviewId: job.review?.id ?? null,
        // The coding agent's session this run is part of (workspace/sessions.ts); null for Ensemble's own agent.
        session: await sessionOfJob(prisma, job),
        instructions: job.instructions,
        networkAccess: job.networkAccess,
        unattended: job.unattended,
        accessMode: job.accessMode,
        // A paired computer's own sandbox decides there; this server's sandbox says nothing about it.
        sandbox: job.deviceId
          ? { effective: job.executionMode === "sandbox", where: "device" as const }
          : host
            ? { ...capabilities(), effective: job.executionMode === "sandbox" && sandboxAvailable(), where: "server" as const }
            : { effective: false, where: "server" as const },
      },
      log: liveLog(job.id),
      events: events.reverse().map((event) => ({ id: event.id, kind: event.kind, data: event.data, at: event.createdAt.toISOString() })),
    };
  });

  app.post("/api/agent/jobs/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await prisma.workspaceJob.findFirst({ where: { id, userId: request.userId }, select: { userId: true, runnerAccountId: true } });
    const refusal = job ? await runnerRefusal(app, job) : null;
    if (refusal) return reply.code(403).send({ error: refusal });
    const ok = await stopJob(app, request.userId, id);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: "Job not found." });
  });

  app.get("/api/agent/jobs/:id/logs", async (request, reply) => {
    const { id } = request.params as { id: string };
    // Without `after`, the latest chunks (a live run shows its tail); with it, the chunks after that one.
    const { after } = z.object({ after: z.coerce.number().int().min(0).optional() }).parse(request.query);
    const job = await prisma.workspaceJob.findFirst({ where: { id, userId: request.userId }, select: { id: true } });
    if (!job) return reply.code(404).send({ error: "Job not found." });
    const chunks =
      after === undefined
        ? (await prisma.workspaceLogChunk.findMany({ where: { jobId: id }, orderBy: { seqFrom: "desc" }, take: 200 })).reverse()
        : await prisma.workspaceLogChunk.findMany({ where: { jobId: id, seqFrom: { gt: after } }, orderBy: { seqFrom: "asc" }, take: 200 });
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
    const { taskId } = z.object({ taskId: z.string().uuid().optional() }).parse(request.query);
    const jobs = await prisma.workspaceJob.findMany({
      where: { userId: request.userId, kind: "code", deviceId: null },
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
      rows.push({ jobId: job.id, taskId: job.taskId, title: job.task.title, status: job.status, folder, branch: job.branch, createdAt: job.createdAt.toISOString() });
    }
    // The task's own runs first: carrying on a run of this task is the usual reason to continue.
    const own = taskId ? rows.filter((row) => row.taskId === taskId) : [];
    return { checkouts: [...own, ...rows.filter((row) => !own.includes(row))] };
  });

  // The person's coding-agent sessions (workspace/sessions.ts), most recently active first: for the
  // assistant and Ensemble Node. Someone a space is shared with sees the sessions of the runs they started.
  app.get("/api/agent/sessions", async (request) => {
    const query = z
      .object({ taskId: z.string().uuid().optional(), deviceId: z.string().uuid().optional(), q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).optional() })
      .parse(request.query);
    const sessions = await listSessions(prisma, { space: request.userId, runner: actorFor(request.userId) }, { taskId: query.taskId, deviceIds: query.deviceId ? [query.deviceId] : null, query: query.q, limit: query.limit });
    return { sessions };
  });

  app.get("/api/agent/sessions/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const session = await resolveSession(prisma, { space: request.userId, runner: actorFor(request.userId) }, id);
    return session ? { session } : reply.code(404).send({ error: "Session not found." });
  });

  // Assign → "Continue an earlier task" on a paired computer (devices/earlier.ts). Not under
  // /api/workspace: it reads job rows only, never this server's folders.
  app.get("/api/agent/earlier-runs", async (request) => {
    const query = z.object({ deviceId: z.string().uuid(), taskId: z.string().uuid().optional() }).parse(request.query);
    const runner = actorFor(request.userId);
    const checkouts = await earlierRuns(prisma, { owner: runner ?? request.userId, space: request.userId, runner, deviceId: query.deviceId, taskId: query.taskId ?? null });
    return { checkouts };
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
    trustChanged(prisma, app.log);
    return reply.code(existing ? 200 : 201).send({ id: rule.id, path: real });
  });

  app.delete("/api/workspace/trust/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await prisma.decisionRule.deleteMany({
      where: { id, userId: request.userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL },
    });
    if (result.count) trustChanged(prisma, app.log);
    return result.count ? reply.code(204).send() : reply.code(404).send({ error: "That folder is not trusted." });
  });

  // Trusted folders also trusted in Claude Code, Codex, Copilot CLI, Cursor and Gemini CLI on this computer.
  app.get("/api/workspace/trust/sharing", async () => sharingReport(await loadSharedTrust()));

  app.put("/api/workspace/trust/sharing", async (request, reply) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    if (process.env.ENSEMBLE_DESKTOP !== "1") return reply.code(409).send({ error: "Trust is shared with other AI tools by Ensemble on your own computer." });
    return sharingReport((await setSharedTrust(prisma, enabled)) ?? (await loadSharedTrust()));
  });

  app.get("/api/workspace/guard", async () => ({
    root: await workspaceRoot(),
    ensembleSource: ENSEMBLE_SOURCE,
    sandboxAvailable: sandboxAvailable(),
    sandbox: capabilities(),
  }));

  // The computer's sandbox, shared by the CLI and the app (one runtime per computer).
  app.get("/api/sandbox", async (request) => {
    const query = z.object({ refresh: z.enum(["1", "true"]).optional() }).parse(request.query);
    return { sandbox: query.refresh ? await prepareSandbox({ refresh: true }) : capabilities() };
  });

  // Windows asks for admin permission once; elsewhere this re-checks. Only from this computer.
  app.post("/api/sandbox/setup", async (request, reply) => {
    const host = request.ip.replace(/^::ffff:/, "");
    if (process.env.ENSEMBLE_DESKTOP !== "1" || (host !== "127.0.0.1" && host !== "::1")) {
      return reply.code(403).send({ error: "The sandbox is set up on the computer itself, from the Ensemble app or `ensemble sandbox setup`." });
    }
    const result = await setupSandbox();
    await appendLedger({ userId: request.userId, actor: "me", action: "sandbox.setup", payload: { ok: result.ok, mechanism: result.caps.mechanism } });
    return reply.code(result.ok ? 200 : 409).send({ ok: result.ok, message: result.message, sandbox: result.caps });
  });

  // ── the top bar: what is running, and the kill switch ─────────────────────

  app.get("/api/agent/state", async (request) => {
    const userId = request.userId;
    const activities = await listActivities(app.redis, userId);
    const [paused, jobs, settings] = await Promise.all([
      isPaused(app.redis, userId),
      prisma.workspaceJob.findMany({
        where: { userId, status: { in: ["queued", "claimed", "running", "stopping", "waiting_approval"] } },
        orderBy: { sequence: "asc" },
        include: { task: { select: { id: true, title: true, priority: true, status: true, projectId: true, repoId: true } }, device: { select: { name: true, lastSeenAt: true, revokedAt: true } } },
      }),
      loadSettings(prisma, userId),
    ]);
    await onCurrentDevices(prisma, jobs);
    const jobIds = new Set(jobs.map((job) => `job:${job.id}`));
    const host = await canUseHostCredentials(userId);
    return {
      paused,
      calls: activities.filter((row) => !jobIds.has(row.id)).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
      running: jobs.filter((job) => job.status === "running" || job.status === "stopping" || job.status === "claimed").map((job) => card(job, undefined, { paths: host })),
      waiting: jobs.filter((job) => job.status === "waiting_approval").map((job) => card(job, undefined, { paths: host })),
      queued: jobs.filter((job) => job.status === "queued").map((job, index) => ({ ...card(job, index + 1, { paths: host }), waitingFor: waitReason(job, jobs, settings.orchestration.maxConcurrentJobs, paused) })),
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

type QueuedRow = { id: string; status: string; deviceId: string | null; repoUrl: string | null; resourceKeys: string[]; continueFromJobId: string | null; task: { title: string; projectId: string | null; repoId: string | null } };

/** Why a queued job has not started yet (`queueWaitReason`), from the person's other jobs. */
function waitReason(job: QueuedRow, jobs: QueuedRow[], limit: number, paused: boolean): string | null {
  const active = jobs.filter((row) => (OCCUPIED as readonly string[]).includes(row.status)).map((row) => ({ ...row, title: row.task.title }));
  return queueWaitReason({ candidate: job, active, limit, paused });
}

/** The switch, and per tool whether it is on this computer and how many folders Ensemble marked in it. */
function sharingReport(state: SharedTrustState) {
  const local = process.env.ENSEMBLE_DESKTOP === "1";
  const found = local ? installedTrustTools() : [];
  return {
    available: local,
    enabled: state.enabled,
    tools: TRUST_TOOLS.map((tool) => ({ id: tool.id, name: tool.name, found: found.includes(tool.id), marked: state.marks.filter((mark) => mark.tool === tool.id).length })),
  };
}
