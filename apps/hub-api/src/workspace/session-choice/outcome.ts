/**
 * How a run went after its session was chosen (session-choice/choose.ts), kept on its decision for
 * calibration: its status, how long it took, its tokens, and for a continued session whether the agent
 * really resumed it (every agent keeps the session's id when it resumes one; a session it could not
 * reopen starts under a new id).
 */
import type { PrismaClient } from "@prisma/client";

async function engineSession(prisma: PrismaClient, jobId: string | null): Promise<string | null> {
  if (!jobId) return null;
  const events = await prisma.workspaceEvent.findMany({ where: { jobId, kind: "engine" }, orderBy: { sequence: "desc" }, take: 5, select: { data: true } });
  for (const event of events) {
    const session = (event.data as { session?: unknown } | null)?.session;
    if (typeof session === "string" && session) return session;
  }
  return null;
}

export async function recordChoiceOutcome(prisma: PrismaClient, jobId: string): Promise<void> {
  const row = await prisma.sessionChoice.findUnique({ where: { jobId }, select: { id: true, decision: true, continuedJobId: true } });
  if (!row) return;
  const job = await prisma.workspaceJob.findUnique({ where: { id: jobId }, select: { status: true, startedAt: true, claimedAt: true, finishedAt: true, tokensIn: true, tokensOut: true, continueFromJobId: true } });
  if (!job) return;
  const began = job.startedAt ?? job.claimedAt;
  let resumed: boolean | null = null;
  if (row.decision === "continue") {
    const [mine, before] = await Promise.all([engineSession(prisma, jobId), engineSession(prisma, job.continueFromJobId ?? row.continuedJobId)]);
    resumed = mine && before ? mine === before : null;
  }
  await prisma.sessionChoice.update({
    where: { id: row.id },
    data: { outcome: { status: job.status, durationMs: began && job.finishedAt ? job.finishedAt.getTime() - began.getTime() : null, tokensIn: job.tokensIn, tokensOut: job.tokensOut, resumed } },
  });
}
