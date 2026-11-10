/**
 * Whether a run that continues an earlier one also continued its agent session (docs/30, Agent
 * sessions). A run resumes the agent's own conversation from the nearest earlier run of the same agent
 * session that recorded one (each engine records its session id on its `engine` event). When that
 * session no longer exists (deleted in the agent's own app, or by its own clean-up), the agent cannot
 * reopen it and the run starts a new session with the whole brief, the earlier task's summary in it
 * (workspace/agent.ts). A session Ensemble deleted is not tried at all.
 *
 * Every agent keeps a session's id when it resumes one, so the web tells the two apart from the ids
 * computers already send: no new event or protocol.
 */
import type { PrismaClient } from "@prisma/client";
import { isCodeEngine } from "@ensemble/shared-types";
import { continuesSessionOf } from "./sessions.js";

/** The agent session a run started or resumed, as its engine reported it. */
export async function engineSessionOf(prisma: Pick<PrismaClient, "workspaceEvent">, jobId: string): Promise<string | null> {
  const started = await prisma.workspaceEvent.findFirst({ where: { jobId, kind: "engine" }, orderBy: { sequence: "desc" }, select: { data: true } });
  const session = (started?.data as { session?: unknown } | null)?.session;
  return typeof session === "string" && session ? session : null;
}

/**
 * The agent session a run continuing `continueFromJobId` resumes: the nearest earlier run of the same agent
 * session that recorded one. Null when there is none to resume (another agent; a session that was deleted).
 */
export async function sessionToResume(prisma: Pick<PrismaClient, "workspaceJob" | "workspaceEvent">, job: { continueFromJobId: string | null; provider: string | null; context?: unknown }): Promise<string | null> {
  let child: { provider: string | null; context: unknown } = { provider: job.provider, context: job.context ?? null };
  let id = job.continueFromJobId;
  for (let hops = 0; id && hops < 20; hops += 1) {
    const run: { provider: string | null; context: unknown; continueFromJobId: string | null } | null = await prisma.workspaceJob.findUnique({ where: { id }, select: { provider: true, context: true, continueFromJobId: true } });
    if (!run || !continuesSessionOf(child, run)) return null;
    const session = await engineSessionOf(prisma, id);
    if (session) return session;
    child = run;
    id = run.continueFromJobId;
  }
  return null;
}

export type SessionRestart = "gone" | "deleted";

/**
 * For a run that continues an earlier one by the same agent: `gone` when it could not resume the agent
 * session it should have (the agent no longer had it), `deleted` when that session had been deleted in
 * Ensemble, so the run started a new one on purpose. Null otherwise, and before the run has a session.
 */
export async function sessionRestartOf(
  prisma: Pick<PrismaClient, "workspaceJob" | "workspaceEvent">,
  job: { id: string; kind: string; provider: string | null; continueFromJobId: string | null; context: unknown },
): Promise<SessionRestart | null> {
  if (job.kind !== "code" || !isCodeEngine(job.provider) || !job.continueFromJobId) return null;
  const previous = await prisma.workspaceJob.findUnique({ where: { id: job.continueFromJobId }, select: { provider: true, context: true } });
  if (!previous || previous.provider !== job.provider) return null;
  const mine = await engineSessionOf(prisma, job.id);
  if (!mine) return null;
  if (!continuesSessionOf(job, previous)) return "deleted";
  const expected = await sessionToResume(prisma, job);
  return expected && expected !== mine ? "gone" : null;
}
