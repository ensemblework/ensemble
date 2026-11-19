/**
 * Which threads of the Code tab's agent the person has open now (docs/16 §9). An open thread says so
 * every few seconds (`POST /api/agent/threads/:id/watch`); while it does, its agent's questions and
 * permission requests are answered in the thread itself and stay out of Needs me and its alerts. Once
 * the thread is closed (or the tab hidden) the mark lapses and they wait in Needs me as any other run's.
 */
import type { PrismaClient } from "@prisma/client";
import { CODE_THREAD_PREFIX } from "./node-tasks.js";
import { redis } from "./redis.js";

/** How long an open thread's mark lasts without being renewed. The web renews it every 15 s. */
export const WATCH_TTL_SECONDS = 40;

const key = (userId: string, threadId: string) => `code:watch:${userId}:${threadId}`;

/** Marks the thread open for another while. True when it was not open before. */
export async function watchThread(userId: string, threadId: string): Promise<boolean> {
  const before = await redis.get(key(userId, threadId));
  await redis.set(key(userId, threadId), "1", "EX", WATCH_TTL_SECONDS);
  return !before;
}

const presentKey = (userId: string) => `code:present:${userId}`;

/**
 * The person has the Code tab in front of them (any thread, or its Welcome): the web says so every 20 s while
 * the tab is visible (`POST /api/agent/code-presence`). While it lasts, a thread's finished turn does not
 * notify (workspace/review-notice.ts): the thread list shows it.
 */
export async function markCodePresent(userId: string, present: boolean): Promise<void> {
  if (present) await redis.set(presentKey(userId), "1", "EX", WATCH_TTL_SECONDS + 5);
  else await redis.del(presentKey(userId));
}

/** Whether the person is on the Code tab now. Never throws: without Redis they are not. */
export async function onCodeTab(userId: string): Promise<boolean> {
  try {
    return Boolean(await redis.get(presentKey(userId)));
  } catch {
    return false;
  }
}

/** The thread is closed. True when it was open. */
export async function unwatchThread(userId: string, threadId: string): Promise<boolean> {
  return (await redis.del(key(userId, threadId))) > 0;
}

/** The threads among `threadIds` that are open now. Never throws: without Redis nothing is watched. */
export async function watchedThreads(userId: string, threadIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(threadIds.filter(Boolean))];
  if (!ids.length) return new Set();
  try {
    const values = await redis.mget(...ids.map((id) => key(userId, id)));
    return new Set(ids.filter((_, index) => values[index]));
  } catch {
    return new Set();
  }
}

/** The task a run's request belongs to, as its detail names it. */
export function decisionTaskId(row: { detail?: unknown }): string | null {
  const detail = row.detail && typeof row.detail === "object" ? (row.detail as { taskId?: unknown }) : null;
  return typeof detail?.taskId === "string" ? detail.taskId : null;
}

/** Requests whose thread is open now are left out: the thread shows them. */
export async function withoutWatchedThreads<T extends { detail?: unknown }>(userId: string, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const watched = await watchedThreads(userId, rows.map(decisionTaskId).filter((id): id is string => Boolean(id)));
  if (!watched.size) return rows;
  return rows.filter((row) => {
    const taskId = decisionTaskId(row);
    return !taskId || !watched.has(taskId);
  });
}

/** True while the thread a request belongs to is open: no Needs me alert for it. */
export async function isWatched(userId: string, threadId: string | null | undefined): Promise<boolean> {
  if (!threadId) return false;
  return (await watchedThreads(userId, [threadId])).has(threadId);
}

/**
 * How a run's new request alerts the person when the run is a turn of a Code tab thread: not at all
 * while the thread is open (it asks there), else with a link that opens the thread. Null for other runs.
 */
export async function threadAlert(prisma: Pick<PrismaClient, "task">, userId: string, taskId: string | null | undefined): Promise<{ quiet: boolean; url: string } | null> {
  if (!taskId) return null;
  const task = await prisma.task.findFirst({ where: { id: taskId, userId }, select: { sourceRef: true } }).catch(() => null);
  if (!task?.sourceRef.startsWith(CODE_THREAD_PREFIX)) return null;
  return { quiet: await isWatched(userId, taskId), url: `/code?view=agent&thread=${encodeURIComponent(taskId)}` };
}
