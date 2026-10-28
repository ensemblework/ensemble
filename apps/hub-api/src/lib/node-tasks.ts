/**
 * Runs Ensemble Node starts on its own (node/sessions.ts) keep their record on an internal task whose
 * `sourceRef` is "node:<nodeId>". Those tasks stay off the board: board lists, Today, the assistant's
 * task lists and the CLI's task list leave them out. Their runs still show in Runs and Needs me.
 */
import type { Prisma } from "@prisma/client";

export const NODE_TASK_PREFIX = "node:";

export const nodeTaskRef = (nodeId: string): string => `${NODE_TASK_PREFIX}${nodeId}`;

export const isNodeTask = (task: { sourceRef?: string | null }): boolean => Boolean(task.sourceRef?.startsWith(NODE_TASK_PREFIX));

/** Matches Node's internal run tasks; board lists put it under `NOT`. */
export const NODE_TASK: Prisma.TaskWhereInput = { sourceRef: { startsWith: NODE_TASK_PREFIX } };

/** A `where` fragment for board lists. `sourceRef` is never null, so NOT keeps every other task. */
export const ON_BOARD: Prisma.TaskWhereInput = { NOT: NODE_TASK };
