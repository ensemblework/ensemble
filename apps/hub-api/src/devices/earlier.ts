/**
 * Assign → "Continue an earlier task" on a paired computer: the earlier code runs a new run there
 * can carry on, in the same folder with its uncommitted work. The computer maps the earlier run to
 * its own record (remote/accept.ts), so only runs that ran (or will run) on that computer count,
 * under its current pairing or an earlier one of the same computer (successor.ts).
 */
import type { Device, PrismaClient } from "@prisma/client";
import { currentDevice } from "./successor.js";

export type EarlierRun = {
  jobId: string;
  taskId: string;
  title: string;
  status: string;
  /** The shared folder's label; empty for the run's own folder in that computer's Ensemble workspace. */
  folder: string;
  repoUrl: string | null;
  branch: string;
  createdAt: string;
};

const WAITING = ["queued", "claimed", "running", "waiting_approval", "stopping"] as const;

/** The device's id and the ids of earlier pairings of the same computer. */
export async function pairingsOf(prisma: PrismaClient, device: Device): Promise<string[]> {
  const earlier = await prisma.device.findMany({
    where: { userId: device.userId, revokedAt: { not: null }, createdAt: { lte: device.createdAt } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const ids = [device.id];
  for (const old of earlier) if ((await currentDevice(prisma, old))?.id === device.id) ids.push(old.id);
  return ids;
}

/**
 * Newest first, the task's own runs before others. Each chain of continued runs is listed once, by
 * its newest step: continuing any step works in the same folder. Runs that never reached the
 * computer (cancelled or refused before it took them) have nothing to continue.
 */
export async function earlierRuns(
  prisma: PrismaClient,
  input: { owner: string; space: string; runner: string | null; deviceId: string; taskId?: string | null },
): Promise<EarlierRun[]> {
  const device = await prisma.device.findFirst({ where: { id: input.deviceId, userId: input.owner, revokedAt: null } });
  if (!device) return [];
  const jobs = await prisma.workspaceJob.findMany({
    where: {
      userId: input.space,
      runnerAccountId: input.runner,
      kind: "code",
      deviceId: { in: await pairingsOf(prisma, device) },
      OR: [{ claimedAt: { not: null } }, { status: { in: [...WAITING] } }],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, taskId: true, status: true, folderLabel: true, repoUrl: true, branch: true, createdAt: true, continueFromJobId: true, task: { select: { title: true } } },
  });
  const parentOf = new Map(jobs.map((job) => [job.id, job.continueFromJobId]));
  const rootOf = (id: string) => {
    let root = id;
    for (let hops = 0; hops < 50; hops += 1) {
      const parent = parentOf.get(root);
      if (!parent) break;
      root = parent;
    }
    return root;
  };
  const seen = new Set<string>();
  const rows: EarlierRun[] = [];
  for (const job of jobs) {
    const chain = rootOf(job.id);
    if (seen.has(chain)) continue;
    seen.add(chain);
    rows.push({
      jobId: job.id,
      taskId: job.taskId,
      title: job.task.title,
      status: job.status,
      folder: job.folderLabel ?? "",
      repoUrl: job.repoUrl,
      branch: job.branch,
      createdAt: job.createdAt.toISOString(),
    });
  }
  const own = input.taskId ? rows.filter((row) => row.taskId === input.taskId) : [];
  return [...own, ...rows.filter((row) => !own.includes(row))].slice(0, 30);
}
