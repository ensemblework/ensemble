/**
 * Agent session clean-up (docs/30, Cleaning up sessions). Ensemble's runs leave sessions in the person's own agents
 * (Claude Code's, Codex's, Copilot's… history on their computer); those of finished work are deleted, so
 * the agents' apps are not cluttered by Ensemble. A session goes when every task it worked on is
 * retired: deleted (after a grace of a few minutes, so Undo can bring the task back with it), or done or
 * dropped for longer than the completed window (Settings → Data retention) and not pinned. A session with
 * a run still going, or whose computer is offline or too old to delete sessions, waits for a later sweep.
 * The run records in Ensemble, the project folders and their files stay; only the agent's conversation
 * goes (`deleteAgentSession`). Off with Settings → Orchestration → cleanSessions.
 */
import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { CODE_ENGINES } from "@ensemble/shared-types";
import { currentDevice } from "../devices/successor.js";
import { deviceOnline } from "../devices/constants.js";
import { deleteAgentSession } from "./delete-session.js";
import { resolveSession, runsOfSession } from "./sessions.js";

/** A deleted task's sessions wait this long, so Undo (or a quick restore from Trash) still finds them. */
export const DELETED_GRACE_MS = 10 * 60_000;
/** A failed deletion is tried again after this long. */
const RETRY_MS = 86_400_000;
/** Sessions deleted per sweep: each may wait on a computer. */
const MAX_PER_SWEEP = 20;
const LIVE = ["queued", "claimed", "running", "waiting_approval", "stopping"];

export type SweepResult = { deleted: string[]; waiting: number; failed: number };

/**
 * Deletes the agent sessions of the person's retired work. `completedDays`: the completed window. Runs
 * that came from the web (this computer's copy of a claimed job) are the web's to clean up.
 */
export async function sweepAgentSessions(
  app: FastifyInstance,
  userId: string,
  options: { completedDays: number; now?: Date; max?: number; remove?: (sessionId: string) => Promise<unknown> },
): Promise<SweepResult> {
  const remove = options.remove ?? ((sessionId: string) => deleteAgentSession(app, userId, sessionId, { actor: "system", reason: "retired" }));
  const now = options.now ?? new Date();
  const deletedBefore = new Date(now.getTime() - DELETED_GRACE_MS);
  const completedBefore = new Date(now.getTime() - options.completedDays * 86_400_000);
  const retryBefore = now.getTime() - RETRY_MS;
  const rows = await app.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT j.id FROM workspace_jobs j JOIN tasks t ON t.id = j.task_id
    WHERE j.user_id = ${userId} AND j.runner_account_id IS NULL AND j.kind = 'code'
      AND j.provider IN (${Prisma.join([...CODE_ENGINES])})
      AND (j.started_at IS NOT NULL OR j.claimed_at IS NOT NULL)
      AND COALESCE(j.context->>'origin', '') <> 'web'
      AND (
        j.context->'sessionDeletion' IS NULL
        OR (j.context->'sessionDeletion'->>'state' = 'pending'
            AND COALESCE((j.context->'sessionDeletion'->>'failedAt')::bigint, (j.context->'sessionDeletion'->>'until')::bigint, 0) < ${retryBefore})
      )
      AND (
        (t.deleted_at IS NOT NULL AND t.deleted_at <= ${deletedBefore})
        OR (t.deleted_at IS NULL AND t.pinned = false AND t.status::text IN ('done', 'dropped') AND t.completed_at <= ${completedBefore})
      )
    ORDER BY j.created_at ASC
    LIMIT 300`);
  const scope = { space: userId, runner: null };
  const seen = new Set<string>();
  const result: SweepResult = { deleted: [], waiting: 0, failed: 0 };
  for (const { id } of rows) {
    if (result.deleted.length + result.failed >= (options.max ?? MAX_PER_SWEEP)) break;
    const session = await resolveSession(app.prisma, scope, id, true);
    if (!session || seen.has(session.id)) continue;
    seen.add(session.id);
    if (session.deletion?.state === "deleted") continue;
    const runs = await runsOfSession(app.prisma, scope, session.id, true);
    if (runs.some((run) => LIVE.includes(run.status))) {
      result.waiting += 1;
      continue;
    }
    // Every task the session worked on is retired; one still in use keeps it.
    const taskIds = [...new Set(runs.map((run) => run.taskId))];
    const inUse = await app.prisma.task.count({
      where: {
        id: { in: taskIds },
        OR: [
          { deletedAt: { gt: deletedBefore } },
          { deletedAt: null, OR: [{ pinned: true }, { status: { notIn: ["done", "dropped"] } }, { completedAt: null }, { completedAt: { gt: completedBefore } }] },
        ],
      },
    });
    if (inUse) continue;
    if (!(await reachable(app, userId, runs.map((run) => run.id)))) {
      result.waiting += 1;
      continue;
    }
    try {
      await remove(session.id);
      result.deleted.push(session.id);
    } catch (error) {
      result.failed += 1;
      app.log?.info({ err: error, userId, sessionId: session.id }, "agent session clean-up will try again later");
    }
  }
  return result;
}

/** Whether every computer the session ran on is online and can delete sessions now: else it waits, untouched. */
async function reachable(app: FastifyInstance, userId: string, jobIds: string[]): Promise<boolean> {
  const jobs = await app.prisma.workspaceJob.findMany({ where: { id: { in: jobIds } }, select: { deviceId: true, startedAt: true, claimedAt: true } });
  const deviceIds = [...new Set(jobs.filter((job) => job.startedAt || job.claimedAt).map((job) => job.deviceId))];
  for (const deviceId of deviceIds) {
    if (!deviceId) {
      if (process.env.ENSEMBLE_DESKTOP !== "1") return false;
      continue;
    }
    const old = await app.prisma.device.findFirst({ where: { id: deviceId, userId } });
    const device = old ? await currentDevice(app.prisma, old) : null;
    if (!device || !deviceOnline(device.lastSeenAt)) return false;
    const capabilities = (device.capabilities && typeof device.capabilities === "object" ? device.capabilities : {}) as { sessionDelete?: unknown };
    if (Number(capabilities.sessionDelete ?? 0) < 1) return false;
  }
  return true;
}

/** Accounts whose sweep is running, and when each last ran (the scheduler sweeps at most every 15 minutes). */
const sweeping = new Set<string>();
const lastSweep = new Map<string, number>();
export const SWEEP_EVERY_MS = 15 * 60_000;

/** The scheduler's call: a sweep for the account when one is due, never two at once, never blocking the tick. */
export function sweepWhenDue(app: FastifyInstance, userId: string, completedDays: number, now = Date.now()): void {
  if (sweeping.has(userId) || now - (lastSweep.get(userId) ?? 0) < SWEEP_EVERY_MS) return;
  sweeping.add(userId);
  lastSweep.set(userId, now);
  void sweepAgentSessions(app, userId, { completedDays })
    .then((result) => {
      if (result.deleted.length) app.log?.info({ userId, deleted: result.deleted.length }, "agent sessions cleaned up");
    })
    .catch((error: unknown) => app.log?.error({ err: error, userId }, "agent session clean-up failed"))
    .finally(() => sweeping.delete(userId));
}
