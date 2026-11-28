import type { Prisma, PrismaClient, Task } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;
const DISMISSED_PREFIX = "desk.needs-me.dismissed.";

export function pendingApprovalsWhere(userId: string): Prisma.ApprovalWhereInput {
  return {
    userId,
    decision: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    run: {
      deletedAt: null,
      endedAt: null,
      OR: [{ outcome: null }, { outcome: "waiting_approval" }],
      task: { deletedAt: null, status: { notIn: ["done", "dropped"] } },
    },
  };
}

/** Permissions have their own actionable cards. A task status alone is not an approval request. */
export async function waitingTaskIds(db: Db, userId: string, tasks: Pick<Task, "id" | "status" | "updatedAt">[]): Promise<Set<string>> {
  const waiting = tasks.filter(task => task.status === "blocked");
  if (!waiting.length) return new Set();
  const [dismissed, runs] = await Promise.all([
    db.preference.findMany({ where: { userId, deletedAt: null, key: { in: waiting.map(task => `${DISMISSED_PREFIX}${task.id}`) } }, select: { key: true, value: true } }),
    db.run.findMany({ where: { userId, taskId: { in: waiting.map(task => task.id) } }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], distinct: ["taskId"], select: { taskId: true, deletedAt: true } }),
  ]);
  const hidden = new Map(dismissed.map(row => [row.key.slice(DISMISSED_PREFIX.length), row.value]));
  const latest = new Map(runs.map(run => [run.taskId, run]));
  return new Set(waiting.filter(task => {
    if (hidden.get(task.id) === task.updatedAt.toISOString()) return false;
    return !latest.get(task.id)?.deletedAt;
  }).map(task => task.id));
}
