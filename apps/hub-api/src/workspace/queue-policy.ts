import type { Prisma, PrismaClient } from "@prisma/client";
import { loadSettings } from "../lib/settings.js";
import { within } from "./guard.js";
import { sessionTurn } from "./sessions.js";

export const NEEDS_ME_GRACE_MS = 60 * 60_000;
export const OCCUPIED = [
  "claimed",
  "running",
  "stopping",
  "waiting_approval",
] as const;

/** One extra slot, shared by all overdue questions, until the population returns below N. */
export function queueHasRoom(
  active: number,
  limit: number,
  overdue: boolean,
): boolean {
  return active < limit || (active === limit && overdue);
}

/** Match a repository reached through HTTPS or SSH without confusing local paths. */
function repositoryIdentity(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/^git@([^:]+):/, "ssh://git@$1/");
  try {
    const url = new URL(normalized);
    if (!url.hostname) return value;
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
    return `${url.host.toLowerCase()}${url.hostname.toLowerCase() === "github.com" ? path.toLowerCase() : path}`;
  } catch {
    return value;
  }
}

type QueueJob = {
  id: string;
  deviceId: string | null;
  repoUrl: string | null;
  resourceKeys: string[];
  continueFromJobId: string | null;
  task: { projectId: string | null; repoId: string | null };
};

export type QueueConflict = { jobId: string; reason: "continues" | "repository" | "project" | "folder" };

/**
 * The running job a queued one must wait for, and why: it continues that job, works in the same
 * repository (any computer), the same project, or the same folder on the same computer.
 */
export function queueConflict(candidate: QueueJob, active: QueueJob[]): QueueConflict | null {
  for (const job of active) {
    if (candidate.continueFromJobId === job.id) return { jobId: job.id, reason: "continues" };
    if (
      (candidate.repoUrl && repositoryIdentity(candidate.repoUrl) === repositoryIdentity(job.repoUrl)) ||
      candidate.resourceKeys.some((key) => key.startsWith("repo:") && job.resourceKeys.includes(key)) ||
      (candidate.task.repoId && candidate.task.repoId === job.task.repoId)
    )
      return { jobId: job.id, reason: "repository" };
    if (candidate.task.projectId && candidate.task.projectId === job.task.projectId) return { jobId: job.id, reason: "project" };
    // Paths and labels are local to a computer; repo identities above are account-wide.
    if (candidate.deviceId === job.deviceId && candidate.resourceKeys.some((key) => job.resourceKeys.some((held) => sameResource(key, held)))) return { jobId: job.id, reason: "folder" };
  }
  return null;
}

/** The same key, or two folders one inside the other (a running job holds every `dir:` folder it changes, folder-claims.ts). */
function sameResource(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith("dir:") && b.startsWith("dir:") && (within(a.slice(4), b.slice(4)) || within(b.slice(4), a.slice(4)));
}

const WAIT_WORDS: Record<QueueConflict["reason"], string> = {
  continues: "It continues",
  repository: "Same repository as",
  project: "Same project as",
  folder: "Same folder as",
};

/**
 * Why a queued job has not started, in words for the queue: the pause, a running job it must wait
 * for, or every slot in use. Null when it can start at the next claim.
 */
export function queueWaitReason(input: { candidate: QueueJob; active: Array<QueueJob & { title: string }>; limit: number; paused: boolean }): string | null {
  if (input.paused) return "Paused: nothing starts until you resume.";
  const conflict = queueConflict(input.candidate, input.active);
  if (conflict) {
    const title = input.active.find((job) => job.id === conflict.jobId)?.title ?? "a running task";
    return `${WAIT_WORDS[conflict.reason]} “${title.slice(0, 80)}”, which is running: it starts when that one ends.`;
  }
  if (input.active.length >= input.limit) return `All ${input.limit} slot${input.limit === 1 ? " is" : "s are"} in use.`;
  return null;
}

/** Claims on both the hosted and local queues serialize on the person's row. */
export async function claimQueuedJob(
  prisma: PrismaClient,
  jobId: string,
  data: Prisma.WorkspaceJobUpdateManyMutationInput,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.workspaceJob.findUnique({
      where: { id: jobId },
      include: { task: { select: { projectId: true, repoId: true } } },
    });
    if (!candidate || candidate.status !== "queued") return false;
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${candidate.userId} FOR UPDATE`;
    const settings = await loadSettings(tx, candidate.userId);
    const active = await tx.workspaceJob.findMany({
      where: { userId: candidate.userId, status: { in: [...OCCUPIED] } },
      include: { task: { select: { projectId: true, repoId: true } } },
    });
    const limit = settings.orchestration.maxConcurrentJobs;
    const overflowRow = await tx.preference.findUnique({
      where: {
        userId_key: { userId: candidate.userId, key: "hub.queue-overflow" },
      },
    });
    const state = (overflowRow?.value ?? {}) as {
      draining?: boolean;
      used?: string[];
    };
    const waiting = active.filter((job) => job.status === "waiting_approval");
    const pending = await tx.agentDecision.findMany({
      where: {
        userId: candidate.userId,
        status: "pending",
        sessionId: { in: waiting.map((job) => job.id) },
      },
      select: { id: true, requestedAt: true },
    });
    const approvals = await tx.approval.findMany({
      where: {
        userId: candidate.userId,
        decision: null,
        runId: { in: waiting.flatMap((job) => (job.runId ? [job.runId] : [])) },
      },
      select: { id: true, requestedAt: true },
    });
    const requests = [...pending, ...approvals];
    const used = Array.isArray(state.used)
      ? state.used.filter((id) => requests.some((request) => request.id === id))
      : [];
    const draining = state.draining === true && active.length >= limit;
    const overdue = requests
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
      .find(
        (request) =>
          Date.now() - request.requestedAt.getTime() >= NEEDS_ME_GRACE_MS &&
          !used.includes(request.id),
      );
    if (draining || !queueHasRoom(active.length, limit, Boolean(overdue)))
      return false;
    if (queueConflict(candidate, active)) return false;
    // A run in an agent session waits for its turn in the session's queue and continues the run that actually ran before it.
    const turn = await sessionTurn(tx, candidate);
    if (turn?.wait) return false;
    if (
      !turn &&
      candidate.continueFromJobId &&
      (await tx.workspaceJob.findFirst({
        where: {
          id: candidate.continueFromJobId,
          status: { in: ["queued", ...OCCUPIED] },
        },
        select: { id: true },
      }))
    )
      return false;
    const claimed = await tx.workspaceJob.updateMany({
      where: { id: jobId, status: "queued" },
      data: { ...data, ...(turn ? turn.links : {}) },
    });
    if (claimed.count !== 1) return false;
    const extra = active.length === limit;
    const value = {
      draining: extra,
      used: extra && overdue ? [...used, overdue.id] : used,
    };
    if (extra || state.draining || used.length !== (state.used?.length ?? 0))
      await tx.preference.upsert({
        where: {
          userId_key: { userId: candidate.userId, key: "hub.queue-overflow" },
        },
        create: {
          userId: candidate.userId,
          key: "hub.queue-overflow",
          value,
          source: "system",
        },
        update: { value, deletedAt: null },
      });
    return true;
  });
}
