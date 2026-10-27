/**
 * Creating an agent job. Assign, Run again, and a task claimed from Ensemble on
 * the web all come through here, so trust, folder, unattended and platform
 * checks are the same for every front door.
 */
import { stat } from "node:fs/promises";
import { z } from "zod";
import type { Actor, Prisma, PrismaClient } from "@prisma/client";
import { CODE_ENGINES, ContextTier, ENGINE_LABELS, isCodeEngine, PullRequestPlan, pullRequestHeadRefusal, type CodeEngine, type ModelTier } from "@ensemble/shared-types";
import { deviceAssignment } from "../devices/assign.js";
import { serverRunnerEnabled } from "../devices/constants.js";
import { publishBrowserDevice, publishDevice } from "../devices/publish.js";
import { appendLedger } from "../lib/ledger.js";
import { requireHostAccess, requireVerifiedUser } from "../lib/hosted-access.js";
import { createCappedJob } from "../lib/hosted-limits.js";
import { ModelChoiceError, providerForModel } from "../lib/model-choice.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { GuardError, resolveWorkFolder, sandboxAvailable, sandboxRefusal, within, workspaceRoot } from "./guard.js";
import { PATH_RULE_SOURCE, PATH_RULE_TOOL, storedMode, type RunMode } from "./trust.js";
import { trustChanged } from "./trust-share.js";
import { kick } from "./worker.js";
import { actorFor, keysFor } from "../sharing/context.js";

export const Assign = z.object({
  taskId: z.string().uuid(),
  /** Unset: decided from who does the work and where (`autoKind`). */
  kind: z.enum(["research", "code"]).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  instructions: z.string().max(8000).default(""),
  repoUrl: z.string().max(500).optional(),
  folder: z.string().max(1000).optional(),
  continueFromJobId: z.string().uuid().optional(),
  branchMode: z.enum(["as-is", "existing", "new"]).default("as-is"),
  branch: z.string().max(200).optional(),
  /** `push`: no limits on git (commit, push any branch, pull requests). `local` and `commit` are limits the person picks. */
  delivery: z.enum(["local", "commit", "push"]).default("push"),
  askBeforePublish: z.boolean().default(false),
  useCredentials: z.boolean().default(false),
  sandbox: z.boolean().default(true),
  network: z.boolean().optional(),
  markDone: z.boolean().default(true),
  unattended: z.boolean().default(false),
  /** Ask, Review only (commands run without asking, only decisions are asked) or Run unattended. Wins over `unattended`. */
  mode: z.enum(["ask", "review", "unattended"]).optional(),
  /** `review` is the read-only grant (no writes, no network), for a folder shared read-only. */
  accessMode: z.enum(["review", "read-write"]).optional(),
  /** always saves a device path rule. task trusts only this job. none: the folder is not trusted (Ask asks there). */
  trust: z.enum(["always", "task", "none"]).optional(),
  maxMinutes: z.number().int().min(1).max(480).optional(),
  maxToolCalls: z.number().int().min(5).max(500).optional(),
  maxTurns: z.number().int().min(3).max(200).optional(),
  deviceId: z.string().uuid().optional(),
  folderLabel: z.string().max(200).optional(),
  /**
   * Who does the work: Ensemble's own agent (a model API with your key), or the person's own
   * Claude Code, Codex, Cursor agent or GitHub Copilot on their computer with their own sign-in.
   */
  engine: z.enum(["ensemble", ...CODE_ENGINES]).default("ensemble"),
  /** The model's context window where it offers more than one (GitHub Copilot's long_context). */
  contextTier: ContextTier.optional(),
  /** The model's fast mode (Claude Code, Codex): faster output, more of the plan's usage. */
  fast: z.boolean().optional(),
  /**
   * End the run in a pull request Ensemble opens into `base`, any branch (empty: the repository's
   * default branch). `branch`, when given, names the run's branch. docs/24 §5.1.
   */
  pullRequest: PullRequestPlan.optional(),
  /** In a sandboxed run, outside the work folder: read only, read and write, or nothing. Default: Settings. */
  outsideAccess: z.enum(["none", "read", "read-write"]).optional(),
  /**
   * A turn of Chat with the person's own agent: the instructions are their message, and with
   * `continueFromJobId` the agent's own session continues. Claude Code, Codex or Cursor only.
   */
  chat: z.boolean().optional(),
});

const ENGINE_NAME: Record<"ensemble" | CodeEngine, string> = { ensemble: "Ensemble's agent", ...ENGINE_LABELS, "cursor-agent": "Cursor's agent" };

/** The job's context with the run's outside-folder choice in it (a JSON column, so no migration). */
function contextWith(context: Prisma.InputJsonValue | undefined, outsideAccess: string, chat = false, contextTier?: string | null, pullRequest?: PullRequestPlan | null, fast = false): Prisma.InputJsonValue {
  const base = typeof context === "object" && context !== null && !Array.isArray(context) ? (context as Record<string, unknown>) : {};
  return { ...base, outsideAccess, ...(chat ? { chat: true } : {}), ...(contextTier === "long_context" ? { contextTier } : {}), ...(pullRequest ? { pullRequest } : {}), ...(fast ? { fast: true } : {}) } as Prisma.InputJsonValue;
}

/** A request that ends in a pull request, made consistent: a code task with commits, pushes and the internet. */
export function withPullRequest<T extends AssignInput>(body: T): T {
  const plan = body.pullRequest;
  if (!plan) return body;
  if (body.kind !== "code") throw new GuardError("A pull request comes from a code task.");
  if (body.chat) throw new GuardError("A chat message does not end in a pull request. Assign a task instead.");
  if (body.branchMode === "existing") throw new GuardError("A pull request starts its branch from the base. Name a new branch, or leave it to Ensemble.");
  if (body.accessMode === "review") throw new GuardError("A read-only run makes no commits, so it cannot open a pull request.");
  const named = body.branch?.trim() ?? "";
  const head = named ? pullRequestHeadRefusal(named, plan.base) : null;
  if (head) throw new GuardError(head);
  return { ...body, branchMode: named ? "new" : "as-is", branch: named || undefined, delivery: "push", network: true };
}
export type AssignInput = z.infer<typeof Assign>;
/** A request with its kind decided. */
export type ResolvedAssign = AssignInput & { kind: "research" | "code" };

/**
 * The kind of run when the request does not say. Work by a coding agent, on a paired computer, in a
 * folder, or on a server that runs code happens in a folder (`code`: the agent can research too);
 * otherwise Ensemble's agent researches and writes on the server.
 */
export function autoKind(body: Pick<AssignInput, "kind" | "engine" | "deviceId" | "folder" | "folderLabel" | "repoUrl" | "continueFromJobId" | "pullRequest" | "chat">, serverRunsCode: boolean): "research" | "code" {
  if (body.kind) return body.kind;
  const somewhere = Boolean(body.deviceId || body.folder?.trim() || body.folderLabel?.trim() || body.repoUrl?.trim() || body.continueFromJobId || body.pullRequest || body.chat);
  return body.engine !== "ensemble" || somewhere || serverRunsCode ? "code" : "research";
}

/**
 * A request that leaves the model to the task's tier, when that tier (Settings → Models) names one of
 * the person's own coding agents: the run uses that agent, with the tier's model, thinking level and
 * context window.
 */
export function withTierAgent(body: AssignInput, tier: Pick<ModelTier, "provider" | "model" | "effort" | "context">): AssignInput {
  if (body.engine !== "ensemble" || body.model?.trim() || !isCodeEngine(tier.provider)) return body;
  return {
    ...body,
    engine: tier.provider,
    model: tier.model && tier.model !== "default" ? tier.model : undefined,
    ...(body.reasoningEffort || tier.effort === "default" ? {} : { reasoningEffort: tier.effort }),
    ...(body.contextTier || tier.context !== "long_context" ? {} : { contextTier: "long_context" as const }),
  };
}

/** The stored mode for a request: `mode` when given, else the older `unattended` flag; a read-only grant stays read-only. */
export function requestedMode(body: Pick<AssignInput, "kind" | "mode" | "unattended" | "accessMode">): { accessMode: "review" | "read-write" | "auto"; unattended: boolean } {
  if (body.kind !== "code") return { accessMode: "read-write", unattended: false };
  const mode: RunMode = body.mode ?? (body.unattended ? "unattended" : "ask");
  const stored = storedMode(mode);
  return body.accessMode === "review" ? { accessMode: "review", unattended: stored.unattended } : stored;
}

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
  body: ResolvedAssign,
  provider: string,
  model: string,
  tierEffort: string | null,
  orchestration: { sandboxNetwork: boolean; maxMinutes: number; maxTurns: number; outsideAccess: string },
  options: CreateJobOptions,
): Promise<{ jobId: string }> {
  if (body.kind === "code" && body.branchMode !== "as-is" && (!body.branch || !BRANCH.test(body.branch))) {
    throw new GuardError("Give a valid branch name.");
  }
  // In a space shared with you, the job runs on your computer and counts against you.
  const runner = actorFor(userId);
  const owner = runner ?? userId;
  const assigned = await deviceAssignment(prisma, owner, {
    deviceId: body.deviceId!,
    kind: body.kind,
    folder: body.folder,
    folderLabel: body.folderLabel,
    repoUrl: body.repoUrl,
    continueFromJobId: body.continueFromJobId,
    engine: body.engine,
    pullRequest: Boolean(body.pullRequest),
  }, { space: userId, runner });
  // Trust is checked on that computer, where the folder is; Review only and unattended wait there for it.
  const mode = requestedMode(body);
  const job = await createCappedJob(prisma, owner, {
    data: {
      userId,
      runnerAccountId: runner,
      taskId: task.id,
      kind: body.kind,
      executionMode: body.kind === "code" && !body.sandbox ? "native" : "sandbox",
      delivery: body.kind === "code" && mode.accessMode !== "review" ? body.delivery : "local",
      askBeforePublish: body.askBeforePublish && !mode.unattended,
      useCredentials: body.kind === "code" && body.useCredentials,
      markDone: body.markDone,
      unattended: mode.unattended,
      accessMode: mode.accessMode,
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
      context: contextWith(options.context, body.outsideAccess ?? orchestration.outsideAccess, false, body.contextTier, body.pullRequest, body.fast === true),
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
  publishBrowserDevice(owner, assigned.deviceId);
  return { jobId: job.id };
}

export async function createJob(prisma: PrismaClient, userId: string, input: AssignInput, options: CreateJobOptions = {}): Promise<{ jobId: string } | null> {
  await requireVerifiedUser(keysFor(userId));
  const task = await prisma.task.findFirst({ where: { id: input.taskId, userId, deletedAt: null } });
  if (!task) return null;
  const settings = await loadSettings(prisma, userId);
  const tier = settings.models[task.complexity];
  const tiered = withTierAgent(input, tier);
  const body: ResolvedAssign = { ...withPullRequest({ ...tiered, kind: autoKind(tiered, serverRunnerEnabled() && !actorFor(userId)) }) };
  const claudeCode = body.engine !== "ensemble";
  const engineName = ENGINE_NAME[body.engine];
  if (claudeCode && body.kind !== "code") throw new GuardError(`${engineName} works on code tasks. Pick Ensemble's agent for research.`);
  if (body.chat && !claudeCode) throw new GuardError("Chat runs with your own coding agent (Claude Code, Codex, Cursor, GitHub Copilot, Grok Build, OpenCode, Gemini CLI or Antigravity) on your own sign-in. Ensemble's agent chats in Ensemble Code with a model key.");
  // The engine is stored as the run's provider; its model is the engine's own name for one, or its default.
  // A model named here keeps its own provider (never the tier's): see lib/model-choice.ts.
  let provider: string;
  try {
    provider = claudeCode ? body.engine : body.model ? providerForModel(settings, body.model, body.provider) : tier.provider;
  } catch (error) {
    if (error instanceof ModelChoiceError) throw new GuardError(error.message);
    throw error;
  }
  const model = claudeCode ? body.model?.trim() || "default" : body.model || tier.model;
  // A job on the tier's own model takes the tier's context window as it takes its thinking level (Settings → Models).
  if (!body.contextTier && !body.model && provider === tier.provider && model === tier.model && tier.context === "long_context") body.contextTier = "long_context";
  // The tier's thinking level belongs to its own provider: another engine or model family does not take it.
  const tierEffort = provider === tier.provider ? tier.effort : null;
  if (body.deviceId) return createDeviceJob(prisma, userId, task, body, provider, model, tierEffort, settings.orchestration, options);
  // This server's runner belongs to the space's owner. Someone it is shared with runs on their own computer.
  if (actorFor(userId)) throw new GuardError("In a shared space, the agent runs on your own computer. Pick one of your paired computers.");
  await requireHostAccess(userId, "Host workspace execution");

  if (provider === "cursor") throw new GuardError("Cursor cannot run tasks on this computer. Pick a chat model for the agent.");
  if (claudeCode && process.env.ENSEMBLE_DESKTOP !== "1") {
    throw new GuardError(`${engineName} runs on your own computer with your own sign-in. Pick one of your paired computers.`);
  }
  if (body.kind === "code" && !serverRunnerEnabled()) throw new GuardError("This Ensemble runs code on your computer. Pick a paired computer.");
  // A sandboxed run needs this computer's OS sandbox. Without one it is refused with the reason and the fix,
  // never run unsandboxed behind the person's back.
  if (body.kind === "code" && body.sandbox && !sandboxAvailable()) throw new GuardError(sandboxRefusal());

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

  const { accessMode, unattended } = requestedMode(body);
  const review = accessMode === "review";

  const job = await createCappedJob(prisma, userId, {
    data: {
      userId,
      taskId: task.id,
      kind: body.kind,
      executionMode: body.kind === "code" && !body.sandbox ? "native" : "sandbox",
      delivery: body.kind === "code" && !review ? body.delivery : "local",
      askBeforePublish: body.askBeforePublish && !unattended,
      useCredentials: body.kind === "code" && body.useCredentials && !review,
      markDone: body.markDone,
      unattended,
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
      reasoningEffort: body.reasoningEffort ?? (body.model ? null : tierEffort),
      instructions: body.instructions,
      resourceKeys,
      maxMinutes: body.maxMinutes ?? settings.orchestration.maxMinutes,
      maxTurns: body.maxTurns ?? settings.orchestration.maxTurns,
      maxToolCalls: body.maxToolCalls ?? 80,
      context: contextWith(options.context, body.outsideAccess ?? settings.orchestration.outsideAccess, body.chat === true, body.contextTier, body.pullRequest, body.fast === true),
    },
  });
  if (externalRoot && body.trust === "always") {
    await prisma.decisionRule.create({
      data: { userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL, pattern: externalRoot, decision: "allow", sessionId: null },
    });
    trustChanged(prisma);
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
      sandboxed: job.executionMode === "sandbox" && sandboxAvailable(),
      ...(options.context === undefined ? {} : { context: options.context }),
    },
  });
  sseHub.publish(userId, { event: "task", data: { id: task.id, action: "assign" } });
  sseHub.publish(userId, { event: "workspace", data: { id: job.id } });
  kick();
  return { jobId: job.id };
}
