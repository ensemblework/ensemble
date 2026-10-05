/**
 * Finish a device job the way `executeJob` finishes a server job:
 * Run, Task, TaskTransition, ledger, and a notification. No model call.
 */
import type { Prisma, PrismaClient, WorkspaceJob } from "@prisma/client";
import { appendLedger } from "../lib/ledger.js";
import { redactText } from "../lib/redact.js";
import { sseHub } from "../lib/sse.js";
import { LIVE_DEVICE_STATUSES } from "./constants.js";
import { expireDeviceDecisions } from "./settle.js";

export type DeviceOutcome = "succeeded" | "failed" | "cancelled" | "blocked";

export type DeviceResult = { kind: "pr" | "commit" | "branch"; url: string; sha?: string };

type FinishDb = PrismaClient | Prisma.TransactionClient;

function taskStatusFor(outcome: DeviceOutcome, markDone: boolean): "done" | "waiting_approval" | "todo" | "blocked" {
  if (outcome === "succeeded") return markDone ? "done" : "waiting_approval";
  if (outcome === "cancelled") return "todo";
  return "blocked";
}

function runOutcomeFor(outcome: DeviceOutcome): "success" | "failed" | "cancelled" | "needs_info" {
  if (outcome === "succeeded") return "success";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "blocked") return "needs_info";
  return "failed";
}

export async function finishDeviceJob(
  prisma: PrismaClient,
  job: WorkspaceJob & { task: { id: string; title: string; status: string; owner: string } },
  input: { outcome: DeviceOutcome; summary: string; results: DeviceResult[] },
): Promise<boolean> {
  const summary = redactText(input.summary).slice(0, 4000);
  const outcome = input.outcome;
  const jobStatus = outcome;
  const now = new Date();
  const error = outcome === "succeeded" ? null : summary.slice(0, 2000) || "Stopped.";
  const progress = outcome === "succeeded" ? "Finished" : error?.slice(0, 200) ?? "Stopped";

  const won = await prisma.$transaction(async (tx: FinishDb) => {
    const updated = await tx.workspaceJob.updateMany({
      where: {
        id: job.id,
        deviceId: job.deviceId,
        leaseToken: job.leaseToken,
        status: { in: [...LIVE_DEVICE_STATUSES] },
        leaseUntil: { gt: now },
      },
      data: {
        status: jobStatus,
        finishedAt: now,
        error,
        summary,
        progress,
        results: input.results,
        leaseToken: null,
      },
    });
    if (updated.count !== 1) return null;
    let runId = job.runId;
    if (!runId) {
      const run = await tx.run.create({
        data: {
          taskId: job.taskId,
          userId: job.userId,
          worker: job.kind === "research" ? "research" : "workspace",
          requestedModel: job.model,
          assignmentInstructions: job.instructions || null,
        },
      });
      runId = run.id;
      await tx.workspaceJob.update({ where: { id: job.id }, data: { runId } });
    }
    await expireDeviceDecisions(tx, [job.id]);
    await tx.run.update({
      where: { id: runId },
      data: {
        endedAt: now,
        outcome: runOutcomeFor(outcome),
        error,
        result: summary || null,
      },
    });
    const next = taskStatusFor(outcome, job.markDone);
    const fresh = await tx.task.findUnique({ where: { id: job.taskId }, select: { status: true, owner: true } });
    if (fresh && fresh.owner === "agent" && fresh.status !== next) {
      await tx.task.update({
        where: { id: job.taskId },
        data: {
          status: next,
          completedAt: next === "done" ? now : null,
          blockedQuestion: next === "blocked" ? ({ question: error ?? "The agent stopped.", options: [] } as Prisma.InputJsonValue) : undefined,
        },
      });
      await tx.taskTransition.create({
        data: {
          userId: job.userId,
          taskId: job.taskId,
          fromStatus: fresh.status,
          toStatus: next,
          fromOwner: "agent",
          toOwner: "agent",
          actor: "agent",
          reason: error ?? "Agent finished",
          runId,
        },
      });
    }
    await tx.notification.create({
      data: {
        userId: job.userId,
        kind: "agent",
        title: outcome === "succeeded" ? `Agent finished: ${job.task.title}` : `Agent ${outcome === "cancelled" ? "stopped" : "needs you"}: ${job.task.title}`,
        body: (error ?? summary).slice(0, 300),
        url: `/tasks/${job.taskId}`,
      },
    });
    return runId;
  });
  if (!won) return false;
  await appendLedger({
    userId: job.userId,
    actor: "agent",
    action: `workspace.job.${outcome === "succeeded" ? "success" : outcome}`,
    taskId: job.taskId,
    runId: won,
    payload: { jobId: job.id, kind: job.kind, deviceId: job.deviceId, results: input.results.length },
  });
  sseHub.publish(job.userId, { event: "workspace", data: { id: job.id } });
  sseHub.publish(job.userId, { event: "task", data: { id: job.taskId, action: "agent" } });
  sseHub.publish(job.userId, { event: "page", data: { taskId: job.taskId } });
  return true;
}
