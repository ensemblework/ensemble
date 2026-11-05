import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { isCodeEngine } from "@ensemble/shared-types";
import { env } from "../config.js";
import { deleteNativeSession } from "../workspace/engines/delete-session.js";
import { lockSession, runsOfSession, sessionOfJob, sessionDeletionOf } from "../workspace/sessions.js";
import { stopJob } from "../workspace/worker.js";
import { loadHeld } from "./store.js";
import type { HostedClient } from "./client.js";
import type { CodeAnswer } from "./contract.js";

export const SESSION_DELETE_API = 1;
const Request = z.object({ id: z.string().min(1).max(100), jobIds: z.array(z.string().uuid()).min(1).max(1000) }).strict();
const engineSession = z.object({ session: z.string().min(1) });
const receipt = (id: string) => `session.native-deleted:${id}`;
const nativeDeletes = new Map<string, Promise<void>>();

export async function deleteLocalJobSessions(app: FastifyInstance, ids: string[], hosted: boolean, accountId = env.ENSEMBLE_DEV_USER_ID): Promise<void> {
  const mapped = loadHeld();
  const jobs = await app.prisma.workspaceJob.findMany({
    where: { userId: accountId, ...(hosted
      ? { OR: [{ id: { in: ids.flatMap(id => mapped[id]?.localJobId ? [mapped[id]!.localJobId!] : []) } }, ...ids.map(id => ({ context: { path: ["hostedJobId"], equals: id } }))] }
      : { id: { in: ids } }) },
    select: { id: true, userId: true, runnerAccountId: true, kind: true, provider: true, status: true, externalRoot: true, repoPath: true, context: true },
  });
  if (hosted) {
    for (const id of ids) {
      if (!jobs.some(job => job.id === mapped[id]?.localJobId || (job.context && typeof job.context === "object" && "hostedJobId" in job.context && job.context.hostedJobId === id))) throw new Error("A recorded local run could not be found. Restore this runtime's job history before retrying; deletion has not been confirmed.");
    }
  }
  const roots = new Set<string>();
  if (hosted) for (const job of jobs) {
    const session = await sessionOfJob(app.prisma, job);
    if (session) roots.add(session.id);
  }
  for (const root of roots) {
    await app.prisma.$transaction(async tx => {
      await lockSession(tx, root);
      const row = await tx.workspaceJob.findUniqueOrThrow({ where: { id: root } });
      if (sessionDeletionOf(row.context)?.state === "deleted") return;
      const context = row.context && typeof row.context === "object" && !Array.isArray(row.context) ? row.context : {};
      await tx.workspaceJob.update({ where: { id: root }, data: { context: { ...context, sessionDeletion: { state: "pending", until: 0 } } } });
      const runs = await runsOfSession(tx, { space: accountId, runner: null }, root, true);
      await tx.workspaceJob.updateMany({ where: { id: { in: runs.map(run => run.id) }, status: "queued" }, data: { status: "cancelled", finishedAt: new Date(), cancelRequestedAt: new Date() } });
    });
    const runs = await runsOfSession(app.prisma, { space: accountId, runner: null }, root, true);
    for (const run of runs) if (["claimed", "running", "waiting_approval", "stopping"].includes(run.status)) await stopJob(app, accountId, run.id);
  }
  const allIds = new Set(jobs.map(job => job.id));
  for (const root of roots) for (const run of await runsOfSession(app.prisma, { space: accountId, runner: null }, root, true)) allIds.add(run.id);
  const deadline = Date.now() + 15_000;
  while (await app.prisma.workspaceJob.count({ where: { id: { in: [...allIds] }, status: { in: ["claimed", "running", "queued", "waiting_approval", "stopping"] } } })) {
    if (Date.now() >= deadline) throw new Error("The agent is still stopping on this computer. Retry deletion when it has stopped.");
    await new Promise(done => setTimeout(done, 250));
  }
  const nativeJobs = await app.prisma.workspaceJob.findMany({ where: { userId: accountId, id: { in: [...allIds] } }, select: { id: true, provider: true, externalRoot: true, repoPath: true } });
  const events = await app.prisma.workspaceEvent.findMany({ where: { jobId: { in: [...allIds] }, kind: "engine" }, select: { jobId: true, data: true } });
  const seen = new Set<string>();
  for (const job of nativeJobs) {
    if (!isCodeEngine(job.provider)) continue;
    const engine = job.provider;
    for (const event of events.filter(event => event.jobId === job.id)) {
      const data = engineSession.safeParse(event.data);
      if (!data.success) continue;
      const key = `${job.provider}:${data.data.session}`;
      if (seen.has(key)) continue;
      const done = await app.prisma.preference.findUnique({ where: { userId_key: { userId: accountId, key: receipt(key) } } });
      if (!done) {
        const inFlight = `${accountId}:${key}`;
        const existing = nativeDeletes.get(inFlight);
        if (existing) await existing;
        else {
          const deletion = (async () => {
            await deleteNativeSession(engine, data.data.session, job.externalRoot ?? job.repoPath ?? process.cwd());
            await app.prisma.preference.upsert({
              where: { userId_key: { userId: accountId, key: receipt(key) } },
              create: { userId: accountId, key: receipt(key), value: { deleted: true }, source: "system" },
              update: { value: { deleted: true }, deletedAt: null },
            });
          })();
          nativeDeletes.set(inFlight, deletion);
          try { await deletion; } finally { nativeDeletes.delete(inFlight); }
        }
      }
      seen.add(key);
    }
    for (const root of roots) await app.prisma.$transaction(async tx => {
      await lockSession(tx, root);
      const deleted = JSON.stringify({ state: "deleted", at: new Date().toISOString() });
      const runs = await runsOfSession(tx, { space: accountId, runner: null }, root, true);
      await tx.$executeRaw(Prisma.sql`UPDATE workspace_jobs SET context = COALESCE(context, '{}'::jsonb) || jsonb_build_object('sessionDeletion', ${deleted}::jsonb) WHERE id IN (${Prisma.join(runs.map(run => run.id))}) AND user_id = ${accountId} AND runner_account_id IS NULL`);
    });
  }
}

export async function answerSessionDelete(app: FastifyInstance, client: HostedClient, input: unknown): Promise<void> {
  const parsed = Request.safeParse(input);
  const id = parsed.success ? parsed.data.id : typeof input === "object" && input && "id" in input && typeof input.id === "string" ? input.id : null;
  if (!id) { app.log.warn("Session deletion request has no request ID"); return; }
  let answer: CodeAnswer;
  try {
    if (!parsed.success) throw new Error("Invalid session deletion request.");
    await deleteLocalJobSessions(app, parsed.data.jobIds, true);
    answer = { status: 200, body: { deleted: true } };
  } catch (error) {
    app.log.warn({ err: error }, "Native session deletion failed");
    answer = { status: 409, body: { error: error instanceof Error ? error.message : "The computer could not delete its agent session." } };
  }
  await client.answerCode(id, answer);
}
