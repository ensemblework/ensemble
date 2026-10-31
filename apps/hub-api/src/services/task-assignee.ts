/**
 * Who a task is with, as Ensemble Node sees it (docs/35 §6.6), and the hook that tells Ensemble Node when a
 * write gives a task to a node or a crew, or takes it away. Kept apart from services/tasks.ts so the writes
 * outside it (a run made for the task, Undo) can call it too.
 */
import type { Prisma, PrismaClient, Task } from "@prisma/client";
import { currentScope } from "../sharing/context.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** Who a task is with, as Ensemble Node sees it: a node or a crew when `owner` is "node". */
export type TaskAssignee = { owner: Task["owner"]; nodeId: string | null; roomId: string | null };
/**
 * A task's node or crew changed (assigned, reassigned or taken away), in a write not yet committed:
 * `at` is the task's new `updatedAt`, so a listener can tell when (and whether) it committed.
 */
export type TaskAssignment = { taskId: string; spaceId: string; at: Date; before: TaskAssignee | null; after: TaskAssignee; byAccountId: string; byNodeId: string | null };
let assignmentListener: ((change: TaskAssignment) => void) | null = null;

/** Set by Ensemble Node (node/task-assignment.ts): it tells the node or the crew's lead. */
export function onTaskAssignment(listener: ((change: TaskAssignment) => void) | null): void {
  assignmentListener = listener;
}

export function assigneeOf(task: Pick<Task, "owner" | "assigneeNodeId" | "assigneeRoomId">): TaskAssignee {
  return task.owner === "node" ? { owner: "node", nodeId: task.assigneeNodeId, roomId: task.assigneeRoomId } : { owner: task.owner, nodeId: null, roomId: null };
}

/** Every write that moves a task to, from or between nodes and crews calls this. */
export function taskAssignmentChanged(change: TaskAssignment): void {
  const { before, after } = change;
  if (before?.owner !== "node" && after.owner !== "node") return;
  if (before && before.owner === after.owner && before.nodeId === after.nodeId && before.roomId === after.roomId) return;
  assignmentListener?.(change);
}

/** The person acting in a space: the signed-in account, else (code acting without a request) the space's owner. */
export async function actingAccount(db: Db, spaceId: string): Promise<string> {
  const scope = currentScope();
  if (scope && scope.spaceId === spaceId) return scope.accountId;
  const space = await db.user.findUnique({ where: { id: spaceId }, select: { ownerId: true } });
  return space?.ownerId ?? spaceId;
}
