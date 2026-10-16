import type { Prisma, PrismaClient } from "@prisma/client";
import { loadSettings } from "../lib/settings.js";

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
    const conflicts = active.some(
      (job) =>
        candidate.continueFromJobId === job.id ||
        (candidate.repoUrl &&
          repositoryIdentity(candidate.repoUrl) ===
            repositoryIdentity(job.repoUrl)) ||
        candidate.resourceKeys.some(
          (key) => key.startsWith("repo:") && job.resourceKeys.includes(key),
        ) ||
        (candidate.task.projectId &&
          candidate.task.projectId === job.task.projectId) ||
        (candidate.task.repoId && candidate.task.repoId === job.task.repoId) ||
        // Paths and labels are local to a computer; repo identities above are account-wide.
        (candidate.deviceId === job.deviceId &&
          candidate.resourceKeys.some((key) => job.resourceKeys.includes(key))),
    );
    if (conflicts) return false;
    if (
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
      data,
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
