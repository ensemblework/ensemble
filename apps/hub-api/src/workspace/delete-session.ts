import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Prisma, type Actor } from "@prisma/client";
import { CodeAnswer } from "../remote/contract.js";
import { deleteLocalJobSessions } from "../remote/session-delete.js";
import { currentDevice } from "../devices/successor.js";
import { deviceOnline } from "../devices/constants.js";
import { askDeviceFor } from "../devices/file-relay.js";
import { appendLedger } from "../lib/ledger.js";
import { publishTo } from "../node/events.js";
import { sseHub } from "../lib/sse.js";
import { lockSession, resolveSession, runsOfSession, sessionDeletionOf } from "./sessions.js";
import { stopJob } from "./worker.js";

const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode, expose: true });
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Deletes an agent session: the agent's own history on the computers it ran on, then Ensemble's record of
 * it (the runs stay). `actor` "system" with `reason`: Ensemble's own clean-up (session-cleanup.ts).
 */
export async function deleteAgentSession(app: FastifyInstance, accountId: string, id: string, options: { actor?: Actor; reason?: string } = {}): Promise<{ deleted: true; sessionId: string }> {
  const scope = { space: accountId, runner: null };
  const session = await resolveSession(app.prisma, scope, id, true);
  if (!session) throw fail("That session is not available to your account.", 404);
  const root = await app.prisma.workspaceJob.findUniqueOrThrow({ where: { id: session.id } });
  if (sessionDeletionOf(root.context)?.state === "deleted") return { deleted: true, sessionId: session.id };
  const runs = await runsOfSession(app.prisma, scope, session.id, true);
  const jobs = await app.prisma.workspaceJob.findMany({ where: { id: { in: runs.map(run => run.id) }, userId: accountId, runnerAccountId: null } });
  if (jobs.length !== runs.length) throw fail("The session changed while deletion was being prepared. Read it again and retry.");
  const groups = new Map<string | null, string[]>();
  const devices = new Map<string, string>();
  for (const job of jobs) {
    if (!job.startedAt && !job.claimedAt) continue;
    let deviceId = job.deviceId;
    if (deviceId && !devices.has(deviceId)) {
      const old = await app.prisma.device.findFirst({ where: { id: deviceId, userId: accountId } });
      const device = old ? await currentDevice(app.prisma, old) : null;
      if (!device || !deviceOnline(device.lastSeenAt)) throw fail("Connect the computer that ran this session before deleting it. Nothing has been hidden.");
      if (Number(record(device.capabilities).sessionDelete ?? 0) < 1) throw fail(`Update Ensemble on ${device.name} to delete saved agent sessions, then retry.`);
      devices.set(deviceId, device.id);
    }
    if (deviceId) deviceId = devices.get(deviceId)!;
    groups.set(deviceId, [...(groups.get(deviceId) ?? []), job.id]);
  }
  const operation = randomUUID();
  await app.prisma.$transaction(async tx => {
    await lockSession(tx, session.id);
    const currentRuns = await runsOfSession(tx, scope, session.id, true);
    if (currentRuns.length !== jobs.length || currentRuns.some(run => !jobs.some(job => job.id === run.id))) throw fail("The session changed while deletion was being prepared. Read it again and retry.");
    const current = await tx.workspaceJob.findUniqueOrThrow({ where: { id: session.id } });
    const deleting = sessionDeletionOf(current.context);
    if (deleting?.state === "pending" && (deleting.until ?? 0) > Date.now()) throw fail("Deletion is already in progress. Wait for it to finish.");
    const pending = JSON.stringify({ state: "pending", operation, until: Date.now() + 90_000 });
    await tx.$executeRaw(Prisma.sql`UPDATE workspace_jobs SET context = COALESCE(context, '{}'::jsonb) || jsonb_build_object('sessionDeletion', ${pending}::jsonb) WHERE id IN (${Prisma.join(jobs.map(job => job.id))}) AND user_id = ${accountId} AND runner_account_id IS NULL`);
    await tx.workspaceJob.updateMany({ where: { id: { in: runs.map(run => run.id) }, status: "queued" }, data: { status: "cancelled", cancelRequestedAt: new Date(), finishedAt: new Date(), progress: "Session deletion", error: "Cancelled because the owner is deleting this session." } });
  });
  const notify = () => {
    publishTo([accountId], "node.sessions", { sessionId: session.id });
    sseHub.publish(accountId, { event: "workspace", data: { id: session.id } });
  };
  const renew = () => app.prisma.$transaction(async tx => {
    await lockSession(tx, session.id);
    const current = await tx.workspaceJob.findUniqueOrThrow({ where: { id: session.id } });
    if (record(record(current.context).sessionDeletion).operation !== operation) throw fail("Another deletion attempt owns this session. Read it again.");
    await tx.workspaceJob.update({ where: { id: session.id }, data: { context: { ...record(current.context), sessionDeletion: { state: "pending", operation, until: Date.now() + 90_000 } } } });
  });
  notify();
  try {
    for (const job of jobs) if (["claimed", "running", "waiting_approval", "stopping"].includes(job.status)) await stopJob(app, accountId, job.id);
    const deadline = Date.now() + 15_000;
    while (await app.prisma.workspaceJob.count({ where: { id: { in: jobs.map(job => job.id) }, status: { in: ["claimed", "running", "waiting_approval", "stopping"] } } })) {
      if (Date.now() >= deadline) throw fail("The session is still stopping. Its history has not been hidden; retry deletion when the computer has stopped it.");
      await new Promise(done => setTimeout(done, 250));
    }
    for (const [deviceId, jobIds] of groups) {
      if (deviceId) {
        for (let index = 0; index < jobIds.length; index += 25) {
          await renew();
          const answer = CodeAnswer.safeParse(await askDeviceFor(app.redis, { deviceId, event: "session.delete", data: { jobIds: jobIds.slice(index, index + 25) } }, 60_000));
          if (!answer.success) throw fail("The computer did not confirm deletion. Some native history may already be removed; reconnect it and retry.");
          if (answer.data.status !== 200 || record(answer.data.body).deleted !== true) throw fail(String(record(answer.data.body).error ?? "The agent did not confirm deletion. Retry on its computer."));
        }
      } else {
        for (const jobId of jobIds) { await renew(); await deleteLocalJobSessions(app, [jobId], false, accountId); }
      }
    }
    await app.prisma.$transaction(async tx => {
      await lockSession(tx, session.id);
      const current = await tx.workspaceJob.findUniqueOrThrow({ where: { id: session.id } });
      if (record(record(current.context).sessionDeletion).operation !== operation) throw fail("The deletion attempt changed. Read the session again.");
      const deleted = JSON.stringify({ state: "deleted", at: new Date().toISOString() });
      await tx.$executeRaw(Prisma.sql`UPDATE workspace_jobs SET context = COALESCE(context, '{}'::jsonb) || jsonb_build_object('sessionDeletion', ${deleted}::jsonb) WHERE id IN (${Prisma.join(jobs.map(job => job.id))}) AND user_id = ${accountId} AND runner_account_id IS NULL`);
    });
    await appendLedger({ userId: accountId, actor: options.actor ?? "me", action: "workspace.session.delete", payload: { sessionId: session.id, jobIds: jobs.map(job => job.id), engine: session.agent, projectFilesKept: true, ...(options.reason ? { reason: options.reason } : {}) } });
    notify();
    return { deleted: true, sessionId: session.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The session could not be deleted.";
    await app.prisma.$transaction(async tx => {
      await lockSession(tx, session.id);
      const current = await tx.workspaceJob.findUniqueOrThrow({ where: { id: session.id } });
      if (record(record(current.context).sessionDeletion).operation === operation) await tx.workspaceJob.update({ where: { id: session.id }, data: { context: { ...record(current.context), sessionDeletion: { state: "pending", error: message, until: 0, failedAt: Date.now() } } } });
    });
    notify();
    throw fail(message);
  }
}
