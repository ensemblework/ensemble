/**
 * Internal tasks: records runs keep that never show on the board.
 *
 * - Runs Ensemble Node starts on its own (node/sessions.ts) keep theirs on a task whose `sourceRef` is
 *   "node:<nodeId>".
 * - A thread of the Code tab's agent (`/api/agent/threads`, routes/agents.ts) is a task whose `sourceRef` is
 *   "code:<key>", the key naming the computer and folder the thread works in (`codeThreadKey`).
 *
 * Board lists, Today, the assistant's task lists and the CLI's task list leave both out (`ON_BOARD`).
 * Their runs still show in Runs and Needs me.
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

export const NODE_TASK_PREFIX = "node:";
export const CODE_THREAD_PREFIX = "code:";

export const nodeTaskRef = (nodeId: string): string => `${NODE_TASK_PREFIX}${nodeId}`;

export const isNodeTask = (task: { sourceRef?: string | null }): boolean => Boolean(task.sourceRef?.startsWith(NODE_TASK_PREFIX));

/**
 * The key of a Code-tab thread's folder: the computer (a paired computer's id, or "local" for this
 * Ensemble) and the folder's path, hashed so the path itself is not stored on the task.
 */
export function codeThreadKey(deviceId: string | null | undefined, folder: string): string {
  const where = deviceId || "local";
  return createHash("sha256").update(`${where}\n${folder.trim().replace(/\/+$/, "") || "/"}`).digest("hex").slice(0, 32);
}

export const codeThreadRef = (deviceId: string | null | undefined, folder: string): string => `${CODE_THREAD_PREFIX}${codeThreadKey(deviceId, folder)}`;

export const isCodeThreadTask = (task: { sourceRef?: string | null }): boolean => Boolean(task.sourceRef?.startsWith(CODE_THREAD_PREFIX));

/** Matches Node's internal run tasks. */
export const NODE_TASK: Prisma.TaskWhereInput = { sourceRef: { startsWith: NODE_TASK_PREFIX } };

/** Matches every internal task (Node's runs, Code-tab threads); board lists put it under `NOT`. */
export const INTERNAL_TASK: Prisma.TaskWhereInput = { OR: [NODE_TASK, { sourceRef: { startsWith: CODE_THREAD_PREFIX } }] };

/** A `where` fragment for board lists. `sourceRef` is never null, so NOT keeps every other task. */
export const ON_BOARD: Prisma.TaskWhereInput = { NOT: INTERNAL_TASK };
