/**
 * The Bin of the Code tab's agent (docs/16 §9, docs/41 §5): a deleted thread waits CODE_THREAD_BIN_DAYS
 * with its agent sessions, so Restore brings the whole conversation back. Once its time is up, or it is
 * deleted for good, it is retired work: the session clean-up deletes its sessions as for any other
 * (`sweepAgentSessions` → `deleteAgentSession`), and the thread itself goes once none is left (`purgeThreads`).
 * Trash shows a thread only while it is in the Bin: its general purge, Empty Trash and Restore go through here.
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

/** Tasks that are not Code threads: Trash's own purge and Empty Trash leave threads to the Bin. */
export const NOT_THREAD: Prisma.TaskWhereInput = { NOT: { sourceRef: { startsWith: CODE_THREAD_PREFIX } } };

/** Tasks that are not Code threads out of the Bin: Trash lists and restores only these. */
export function notOutOfBin(now = new Date()): Prisma.TaskWhereInput {
  return { NOT: { sourceRef: { startsWith: CODE_THREAD_PREFIX }, deletedAt: { lt: binStart(now) } } };
}

/**
 * Deletes threads in the Bin for good (`id`: one; none: every one, Empty Trash): at once when a thread has
 * no agent session to delete (or the person keeps them, Settings › Orchestration), else it leaves the Bin
 * now and goes once the clean-up has deleted its sessions. Returns how many left the Bin.
 */
export async function deleteFromBin(db: Db, userId: string, options: { id?: string; keepSessions: boolean; now?: Date }): Promise<number> {
  const start = binStart(options.now ?? new Date());
  const one = options.id ? Prisma.sql`AND t.id = ${options.id}` : Prisma.empty;
  const kept = options.keepSessions ? Prisma.empty : Prisma.sql`AND NOT ${sessionLeft}`;
  const inBin = Prisma.sql`t.user_id = ${userId} AND t.source_ref LIKE ${THREADS} AND t.deleted_at >= ${start} ${one}`;
  const gone = await db.$executeRaw(Prisma.sql`DELETE FROM tasks t WHERE ${inBin} ${kept}`);
  // The rest have a session to delete. Their Bin time is up now: the sweep sees them retired at once, and Restore no longer finds them.
  const out = await db.$executeRaw(Prisma.sql`UPDATE tasks t SET deleted_at = ${new Date(start.getTime() - 1)} WHERE ${inBin}`);
  return gone + out;
}

/**
 * Removes the threads out of the Bin whose agent sessions are deleted, or all of them when the person keeps
 * their sessions. One whose computer never comes back to delete them goes `giveUpDays` after it left the
 * Bin (Trash's `retentionDays`).
 */
export async function purgeThreads(db: Db, userId: string, options: { keepSessions: boolean; giveUpDays?: number; now?: Date }): Promise<number> {
  const start = binStart(options.now);
  const giveUp = options.giveUpDays ? Prisma.sql`OR t.deleted_at < ${new Date(start.getTime() - options.giveUpDays * DAY)}` : Prisma.empty;
  const waiting = options.keepSessions ? Prisma.empty : Prisma.sql`AND (NOT ${sessionLeft} ${giveUp})`;
  return db.$executeRaw(Prisma.sql`DELETE FROM tasks t WHERE t.user_id = ${userId} AND t.source_ref LIKE ${THREADS} AND t.deleted_at < ${start} ${waiting}`);
}
