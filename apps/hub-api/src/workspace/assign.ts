/**
 * Creating an agent job. Assign, Run again, and a task claimed from Ensemble on
 * the web all come through here, so trust, folder, unattended and platform
 * checks are the same for every front door.
 */
import { stat } from "node:fs/promises";
import { z } from "zod";
import type { Actor, Prisma, PrismaClient } from "@prisma/client";
import { deviceAssignment } from "../devices/assign.js";
import { serverRunnerEnabled } from "../devices/constants.js";
import { publishBrowserDevice, publishDevice } from "../devices/publish.js";
import { appendLedger } from "../lib/ledger.js";
import { requireHostAccess, requireVerifiedUser } from "../lib/hosted-access.js";
import { createCappedJob } from "../lib/hosted-limits.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { GuardError, resolveWorkFolder, sandboxAvailable, within, workspaceRoot } from "./guard.js";
import { capabilities } from "./sandbox/spawn.js";
import { checkUnattended, isFolderTrusted, PATH_RULE_SOURCE, PATH_RULE_TOOL, rulesForJob, UnattendedAskModeError } from "./trust.js";
import { kick } from "./worker.js";

export const Assign = z.object({
  taskId: z.string().uuid(),
  kind: z.enum(["research", "code"]),
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  instructions: z.string().max(8000).default(""),
  repoUrl: z.string().max(500).optional(),
  folder: z.string().max(1000).optional(),
  continueFromJobId: z.string().uuid().optional(),
  branchMode: z.enum(["as-is", "existing", "new"]).default("as-is"),
  branch: z.string().max(200).optional(),
  delivery: z.enum(["local", "commit", "push"]).default("local"),
  askBeforePublish: z.boolean().default(true),
  useCredentials: z.boolean().default(false),
  sandbox: z.boolean().default(true),
  network: z.boolean().optional(),
  markDone: z.boolean().default(true),
  unattended: z.boolean().default(false),
  /** Outside the workspace this defaults to review (read-only, no network). */
  accessMode: z.enum(["review", "read-write"]).optional(),
  /** always saves a device path rule. task trusts only this job. none asks. */
  trust: z.enum(["always", "task", "none"]).optional(),
  maxMinutes: z.number().int().min(1).max(480).optional(),
  maxToolCalls: z.number().int().min(5).max(500).optional(),
  maxTurns: z.number().int().min(3).max(200).optional(),
  deviceId: z.string().uuid().optional(),
  folderLabel: z.string().max(200).optional(),
});
export type AssignInput = z.infer<typeof Assign>;

const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

export interface CreateJobOptions {
  retryOf?: string;
  /** Stored on `WorkspaceJob.context`. A job claimed from the web carries its hosted id here. */
  context?: Prisma.InputJsonValue;
  actor?: Actor;
}

type AssignTask = NonNullable<Awaited<ReturnType<PrismaClient["task"]["findFirst"]>>>;

/**
 * A job for a paired computer. The server stores the request and does not run it.
 * Trust, unattended, and the sandbox stay on that computer.
 */
async function createDeviceJob(
  prisma: PrismaClient,
  userId: string,
  task: AssignTask,
  body: AssignInput,
  provider: string,
  model: string,
  tierEffort: string | null,
  orchestration: { sandboxNetwork: boolean; maxMinutes: number; maxTurns: number },
  options: CreateJobOptions,
): Promise<{ jobId: string }> {
  if (body.kind === "code" && body.branchMode !== "as-is" && (!body.branch || !BRANCH.test(body.branch))) {
    throw new GuardError("Give a valid branch name.");
  }
  const assigned = await deviceAssignment(prisma, userId, {
    deviceId: body.deviceId!,
    kind: body.kind,
    folder: body.folder,
    folderLabel: body.folderLabel,
    repoUrl: body.repoUrl,
    continueFromJobId: body.continueFromJobId,
  });
  const job = await createCappedJob(prisma, userId, {
    data: {
      userId,
      taskId: task.id,
      kind: body.kind,
      executionMode: body.kind === "code" && !body.sandbox ? "native" : "sandbox",
      delivery: body.kind === "code" ? body.delivery : "local",
      askBeforePublish: body.askBeforePublish,
      useCredentials: body.kind === "code" && body.useCredentials,
      markDone: body.markDone,
      unattended: false,
      accessMode: "read-write",
      networkAccess: body.network ?? orchestration.sandboxNetwork,
      externalRoot: null,
      folderLabel: assigned.folderLabel,
      deviceId: assigned.deviceId,
      repoUrl: assigned.repoUrl,
      continueFromJobId: assigned.continueFrom,
      branchMode: body.branchMode,
      branch: body.branchMode === "as-is" ? "" : body.branch ?? "",
      createBranch: body.branchMode === "new",
      provider,
      model,
      reasoningEffort: body.reasoningEffort ?? (body.model ? null : tierEffort),
      instructions: body.instructions,
      resourceKeys: assigned.resourceKeys,
      maxMinutes: body.maxMinutes ?? orchestration.maxMinutes,
      maxTurns: body.maxTurns ?? orchestration.maxTurns,
      maxToolCalls: body.maxToolCalls ?? 80,
      ...(options.context === undefined ? {} : { context: options.context }),
    },
  });
  const nextStatus = ["proposed", "done", "dropped", "blocked", "waiting_approval"].includes(task.status) ? "todo" : task.status;
  await prisma.task.update({ where: { id: task.id }, data: { owner: "agent", status: nextStatus, completedAt: null, blockedQuestion: undefined } });
  if (task.owner !== "agent" || task.status !== nextStatus) {
    await prisma.taskTransition.create({
      data: { userId, taskId: task.id, fromStatus: task.status, toStatus: nextStatus, fromOwner: task.owner, toOwner: "agent", actor: options.actor ?? "me", reason: `Assigned to the agent (${body.kind})` },
    });
  }
  await appendLedger({
    userId,
    actor: options.actor ?? "me",
    action: "task.assign_agent",
    taskId: task.id,
    payload: {
      jobId: job.id,
      kind: body.kind,
      model,
      provider,
      sandbox: job.executionMode === "sandbox",
      delivery: job.delivery,
      useCredentials: job.useCredentials,
      folder: null,
      folderLabel: assigned.folderLabel,
      repoUrl: assigned.repoUrl,
      continueFrom: assigned.continueFrom,
      deviceId: assigned.deviceId,
      retryOf: options.retryOf ?? null,
    },
  });
  sseHub.publish(userId, { event: "task", data: { id: task.id, action: "assign" } });
  sseHub.publish(userId, { event: "workspace", data: { id: job.id } });
  publishDevice(assigned.deviceId, "job.queued", job.id);
  publishBrowserDevice(userId, assigned.deviceId);
  return { jobId: job.id };
}

export async function createJob(prisma: PrismaClient, userId: string, body: AssignInput, options: CreateJobOptions = {}): Promise<{ jobId: string } | null> {
  await requireVerifiedUser(userId);
  const task = await prisma.task.findFirst({ where: { id: body.taskId, userId, deletedAt: null } });
  if (!task) return null;
  const settings = await loadSettings(prisma, userId);
  const tier = settings.models[task.complexity];
  const provider = body.model ? body.provider ?? tier.provider : tier.provider;
  const model = body.model || tier.model;
  if (body.deviceId) return createDeviceJob(prisma, userId, task, body, provider, model, tier.effort, settings.orchestration, options);
  await requireHostAccess(userId, "Host workspace execution");

  if (provider === "cursor") throw new GuardError("Cursor cannot run tasks on this computer. Pick a chat model for the agent.");
  if (body.kind === "code" && !serverRunnerEnabled()) throw new GuardError("This Ensemble runs code on your computer. Pick a paired computer.");
  // The desktop still assigns on Linux and Windows: the job runs with the allow-list and shows "Not fully sandboxed".
  // Hosted Ensemble has no Seatbelt off macOS, so a sandboxed code job there has to name a paired computer or turn the sandbox off.
  if (body.kind === "code" && body.sandbox && !sandboxAvailable && process.env.ENSEMBLE_DESKTOP !== "1") {
    throw new GuardError("The sandbox needs macOS. Turn off the sandbox to run directly on this machine.");
  }
  if (body.kind === "code" && body.unattended && capabilities().strength === "ask") throw new UnattendedAskModeError();

  let externalRoot: string | null = null;
  let repoUrl: string | null = null;
  let continueFrom: string | null = null;
  const resourceKeys: string[] = [];
  if (body.kind === "code") {
    if (body.continueFromJobId) {
      const previous = await prisma.workspaceJob.findFirst({ where: { id: body.continueFromJobId, userId }, select: { id: true, kind: true, continueFromJobId: true, externalRoot: true } });
      if (!previous || previous.kind !== "code") throw new GuardError("Pick an earlier code task to continue from.");
      continueFrom = previous.id;
      let rootId = previous.id;
      let parent = previous.continueFromJobId;
      for (let hops = 0; parent && hops < 50; hops += 1) {
        rootId = parent;
        parent = (await prisma.workspaceJob.findUnique({ where: { id: parent }, select: { continueFromJobId: true } }))?.continueFromJobId ?? null;
      }
      resourceKeys.push(previous.externalRoot ? `dir:${previous.externalRoot}` : `chain:${rootId}`);
    } else if (body.folder?.trim()) {
      externalRoot = await resolveWorkFolder(body.folder);
      resourceKeys.push(`dir:${externalRoot}`);
    } else if (body.repoUrl?.trim()) {
      const value = body.repoUrl.trim();
      if (value.startsWith("/")) {
        const real = await resolveWorkFolder(value).catch(async (error) => {
          const base = await workspaceRoot();
          if (within(base, value)) return value;
          throw error;
        });
        await stat(`${real}/.git`).catch(() => {
          throw new GuardError("That folder is not a git repository.");
        });
        repoUrl = real;
      } else if (/^(https:\/\/|git@)[\w.@:/~-]+$/.test(value) || /^[\w.-]+\/[\w.-]+$/.test(value)) {
        repoUrl = /^[\w.-]+\/[\w.-]+$/.test(value) ? `https://github.com/${value}.git` : value;
      } else {
        throw new GuardError("Give a repository URL (https://github.com/owner/repo) or owner/repo.");
      }
    }
    if (body.branchMode !== "as-is") {
      if (!body.branch || !BRANCH.test(body.branch)) throw new GuardError("Give a valid branch name.");
    }
  }

  const outside = Boolean(externalRoot);
  const accessMode = body.kind === "code" ? (body.accessMode ?? (outside ? "review" : "read-write")) : "read-write";
  const review = accessMode === "review";
  const grantingNow = body.trust === "always" || body.trust === "task";
  if (body.kind === "code" && body.unattended) {
    const root = await workspaceRoot();
    const folder = externalRoot ?? root;
    const rows = await prisma.decisionRule.findMany({
      where: { userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL, decision: "allow" },
    });
    const trusted = isFolderTrusted({
      folder,
      workspaceRoot: root,
      rules: rulesForJob(rows, "assign"),
      grantingNow,
    });
    const rejection = checkUnattended({ unattended: true, trusted });
    if (rejection) throw rejection;
  }

  const job = await createCappedJob(prisma, userId, {
    data: {
      userId,
      taskId: task.id,
      kind: body.kind,
      executionMode: body.kind === "code" && !body.sandbox ? "native" : "sandbox",
      delivery: body.kind === "code" && !review ? body.delivery : "local",
      askBeforePublish: body.askBeforePublish,
      useCredentials: body.kind === "code" && body.useCredentials && !review,
      markDone: body.markDone,
      unattended: body.kind === "code" && body.unattended,
      accessMode,
      networkAccess: review ? false : (body.network ?? settings.orchestration.sandboxNetwork),
      externalRoot,
      repoUrl,
      continueFromJobId: continueFrom,
      branchMode: body.branchMode,
      branch: body.branchMode === "as-is" ? "" : body.branch ?? "",
      createBranch: body.branchMode === "new",
      provider,
      model,
      reasoningEffort: body.reasoningEffort ?? (body.model ? null : tier.effort),
      instructions: body.instructions,
      resourceKeys,
      maxMinutes: body.maxMinutes ?? settings.orchestration.maxMinutes,
      maxTurns: body.maxTurns ?? settings.orchestration.maxTurns,
      maxToolCalls: body.maxToolCalls ?? 80,
      ...(options.context === undefined ? {} : { context: options.context }),
    },
  });
  if (externalRoot && body.trust === "always") {
    await prisma.decisionRule.create({
      data: { userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL, pattern: externalRoot, decision: "allow", sessionId: null },
    });
  } else if (externalRoot && body.trust === "task") {
    await prisma.decisionRule.create({
      data: { userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL, pattern: externalRoot, decision: "allow", sessionId: job.id },
    });
  }
  const nextStatus = ["proposed", "done", "dropped", "blocked", "waiting_approval"].includes(task.status) ? "todo" : task.status;
  await prisma.task.update({ where: { id: task.id }, data: { owner: "agent", status: nextStatus, completedAt: null, blockedQuestion: undefined } });
  if (task.owner !== "agent" || task.status !== nextStatus) {
    await prisma.taskTransition.create({
      data: { userId, taskId: task.id, fromStatus: task.status, toStatus: nextStatus, fromOwner: task.owner, toOwner: "agent", actor: options.actor ?? "me", reason: `Assigned to the agent (${body.kind})` },
    });
  }
  await appendLedger({
    userId,
    actor: options.actor ?? "me",
    action: "task.assign_agent",
    taskId: task.id,
    payload: {
      jobId: job.id,
      kind: body.kind,
      model,
      provider,
      sandbox: job.executionMode === "sandbox",
      delivery: job.delivery,
      useCredentials: job.useCredentials,
      folder: externalRoot,
      repoUrl,
      continueFrom,
      retryOf: options.retryOf ?? null,
      sandboxed: job.executionMode === "sandbox" && sandboxAvailable,
      ...(options.context === undefined ? {} : { context: options.context }),
    },
  });
  sseHub.publish(userId, { event: "task", data: { id: task.id, action: "assign" } });
  sseHub.publish(userId, { event: "workspace", data: { id: job.id } });
  kick();
  return { jobId: job.id };
}
