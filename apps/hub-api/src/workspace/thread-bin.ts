/**
 * The Bin of the Code tab's agent (docs/16 §9, docs/41 §5): a deleted thread waits CODE_THREAD_BIN_DAYS
 * with its agent sessions, so Restore brings the whole conversation back. Once its time is up, or it is
 * deleted for good, it is retired work: the session clean-up deletes its sessions as for any other
 * (`sweepAgentSessions` → `deleteAgentSession`), and the thread itself goes once none is left (`purgeThreads`).
 */
import { CODE_ENGINES } from "@ensemble/shared-types";
import { Prisma, type PrismaClient } from "@prisma/client";
import { CODE_THREAD_BIN_DAYS, CODE_THREAD_PREFIX } from "../lib/node-tasks.js";

type Db = PrismaClient | Prisma.TransactionClient;

const DAY = 86_400_000;
const THREADS = `${CODE_THREAD_PREFIX}%`;

/** A thread deleted before this has left the Bin: it is no longer listed there or restored. */
export function binStart(now = new Date()): Date {
  return new Date(now.getTime() - CODE_THREAD_BIN_DAYS * DAY);
}

/**
 * Whether the thread `t` still has an agent session to delete: a run that started in an agent and whose
 * session is not deleted. Runs that came from the web are the web's to clean up (session-cleanup.ts).
 */
const sessionLeft = Prisma.sql`EXISTS (
  SELECT 1 FROM workspace_jobs j
  WHERE j.task_id = t.id AND j.runner_account_id IS NULL AND j.kind = 'code'
    AND j.provider IN (${Prisma.join([...CODE_ENGINES])})
    AND (j.started_at IS NOT NULL OR j.claimed_at IS NOT NULL)
    AND COALESCE(j.context->>'origin', '') <> 'web'
    AND COALESCE(j.context->'sessionDeletion'->>'state', '') <> 'deleted'
)`;

/**
 * Deletes a thread in the Bin for good: at once when it has no agent session to delete (or the person keeps
 * them, Settings › Orchestration), else it leaves the Bin now and goes once the clean-up has deleted its
 * sessions. False when it is not in the Bin.
 */
export async function deleteThreadForGood(db: Db, userId: string, id: string, options: { keepSessions: boolean; now?: Date }): Promise<boolean> {
  const now = options.now ?? new Date();
  const start = binStart(now);
  const inBin = await db.task.findFirst({ where: { id, userId, sourceRef: { startsWith: CODE_THREAD_PREFIX }, deletedAt: { gte: start } }, select: { id: true } });
  if (!inBin) return false;
  const left = options.keepSessions ? [] : await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT t.id FROM tasks t WHERE t.id = ${id} AND ${sessionLeft}`);
  if (!left.length) {
    await db.task.deleteMany({ where: { id, userId } });
    return true;
  }
  // Its Bin time is up now: the sweep sees it retired at once, and Restore no longer finds it.
  await db.task.updateMany({ where: { id, userId }, data: { deletedAt: new Date(start.getTime() - 1) } });
  return true;
}

/**
 * Removes the threads out of the Bin whose agent sessions are deleted, or all of them when the person keeps
 * their sessions. A thread whose computer never comes back goes with Trash (`retentionDays`).
 */
export async function purgeThreads(db: Db, userId: string, options: { keepSessions: boolean; now?: Date }): Promise<number> {
  const waiting = options.keepSessions ? Prisma.empty : Prisma.sql`AND NOT ${sessionLeft}`;
  return db.$executeRaw(Prisma.sql`DELETE FROM tasks t WHERE t.user_id = ${userId} AND t.source_ref LIKE ${THREADS} AND t.deleted_at < ${binStart(options.now)} ${waiting}`);
}
