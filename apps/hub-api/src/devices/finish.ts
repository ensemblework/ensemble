/**
 * Finish a device job the way `executeJob` finishes a server job:
 * Run, Task, TaskTransition, ledger, and a notification. No model call.
 */
import { noticeCodeTurn, noticeReadyForReview } from "../workspace/review-notice.js";
import { codeTurnOf, isChatTurn } from "../workspace/trust.js";
import type { Prisma, PrismaClient, WorkspaceJob } from "@prisma/client";
import { appendLedger } from "../lib/ledger.js";
import { redactText } from "../lib/redact.js";
import { sseHub } from "../lib/sse.js";
import { LIVE_DEVICE_STATUSES } from "./constants.js";
import { announceClosedDecisions, expireDeviceDecisions, wakeQueuedDevices } from "./settle.js";
import { requireVerifiedUser } from "../lib/hosted-access.js";
import type { RunTotals } from "../remote/contract.js";
import { observedUpdate } from "../workspace/engines/observed.js";
import type { StepReport } from "../node/report.js";
import { keepCodeTurnResult, type CodeTurnResult } from "../workspace/code-turn.js";
import { saveCompletion, taskStatusAfter, verifiedReason, type Completion } from "../workspace/completion.js";
import { acceptanceChecksFor } from "../workspace/acceptance-checks.js";

export type DeviceOutcome = "succeeded" | "failed" | "cancelled" | "blocked";

export type DeviceResult = { kind: "pr" | "commit" | "branch"; url: string; sha?: string };

type FinishDb = PrismaClient | Prisma.TransactionClient;

/** Every string in a value with key shapes hidden, as every text a computer sends is. */
function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactDeep(item)])) as T;
  return value;
}

const RUN_END = { succeeded: "success", failed: "failed", cancelled: "cancelled", blocked: "blocked" } as const;

/**
 * Whether an assigned run had checks: the agent reported one with a command, or its task's or plan
 * step's acceptance criteria name one. A run that had some is never done on the agent's word.
 */
async function hadChecks(db: FinishDb, job: Pick<WorkspaceJob, "id" | "userId" | "taskId">, report: StepReport | null): Promise<boolean> {
  if (report?.checks?.some((check) => check.rerun)) return true;
  const task = await db.task.findUnique({ where: { id: job.taskId }, select: { description: true, notes: true } });
  return (await acceptanceChecksFor(db, { userId: job.userId, jobId: job.id, text: `${task?.description ?? ""}\n${task?.notes ?? ""}` }).catch(() => [])).length > 0;
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
  input: {
    outcome: DeviceOutcome;
    summary: string;
    results: DeviceResult[];
    totals?: RunTotals;
    report?: StepReport | null;
    codeTurn?: CodeTurnResult | null;
    /** Any other run's checks as its computer ran them again. */
    completion?: Completion | null;
    /** The computer runs an assigned run's checks again (`capabilities.runVerification`): its task is done only when they pass. */
    verifies?: boolean;
  },
): Promise<boolean> {
  await requireVerifiedUser(job.userId);
  const summary = redactText(input.summary).slice(0, 20_000);
  const totals = input.totals;
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
        // The worker's own result (report_result or .ensemble/result.json on the computer), redacted again here.
        ...(input.report ? { report: redactDeep(input.report) as unknown as Prisma.InputJsonValue } : {}),
        // What the computer reported: counts, the model that answered, its cost estimate, the files changed (names only).
        ...(totals
          ? {
              turns: totals.turns ?? 0,
              toolCalls: totals.toolCalls ?? 0,
              tokensIn: totals.tokensIn ?? 0,
              tokensOut: totals.tokensOut ?? 0,
              evidence: { files: totals.files.map((file) => ({ ...file, path: redactText(file.path).slice(0, 500) })), model: totals.model ?? null, costUsd: totals.costUsd ?? null, ...(totals.reviewId ? { reviewId: totals.reviewId } : {}) } as Prisma.InputJsonValue,
              ...observedUpdate(totals.observed),
            }
          : {}),
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
    await expireDeviceDecisions(tx, [job.id], false);
    await tx.run.update({
      where: { id: runId },
      data: {
        endedAt: now,
        outcome: runOutcomeFor(outcome),
        error,
        result: summary || null,
      },
    });
    // A Code tab turn: what its packet sent, the checks the computer ran again, and its handoff record.
    if (input.codeTurn) await keepCodeTurnResult(tx, job, runId, input.codeTurn);
    else if (input.completion) await saveCompletion(tx, runId, input.completion);
    // An assigned run on a computer that runs its checks again: its task is done only when they passed.
    const assigned = job.kind === "code" && !isChatTurn(job.context) && input.verifies === true;
    const checks = assigned ? (input.completion?.checks ?? null) : null;
    const ended = taskStatusAfter({ outcome: RUN_END[outcome], markDone: job.markDone, checks, hasChecks: assigned && !checks && outcome === "succeeded" && (await hadChecks(tx, job, input.report ?? null)) });
    const next = ended.status;
    const fresh = await tx.task.findUnique({ where: { id: job.taskId }, select: { status: true, owner: true } });
    if (fresh && fresh.owner === "agent" && fresh.status !== next) {
      await tx.task.update({
        where: { id: job.taskId },
        data: {
          status: next,
          completedAt: next === "done" ? now : null,
          blockedQuestion: next === "blocked" ? ({ question: ended.question ?? error ?? "The agent stopped.", options: [] } as Prisma.InputJsonValue) : undefined,
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
          reason: error ?? verifiedReason(ended.verified),
          runId,
        },
      });
    }
    // A finished or stopped run is already on the board and in Runs; only work that needs the person notifies.
    // A node's run reports in its chat, where the node goes on (retries, asks): it does not notify here.
    const nodeRun = await tx.nodeRun.findUnique({ where: { jobId: job.id }, select: { id: true } });
    // A Code tab thread's turn notifies only while the person is away from the Code tab, and opens the thread.
    const codeTurn = Boolean(codeTurnOf(job.context));
    if (codeTurn && !nodeRun) {
      if (outcome !== "cancelled") await noticeCodeTurn(tx, { userId: job.userId, taskId: job.taskId, title: job.task.title, summary, failed: outcome === "succeeded" ? null : (error ?? summary) });
    } else if (outcome === "succeeded" && next === "waiting_approval" && !nodeRun && !isChatTurn(job.context)) await noticeReadyForReview(tx, { userId: job.userId, taskId: job.taskId, title: job.task.title, summary, runId });
    if ((outcome !== "succeeded" || ended.verified === "failed") && outcome !== "cancelled" && !nodeRun && !codeTurn) await tx.notification.create({
      data: {
        userId: job.userId,
        kind: "agent",
        title: `Agent needs you: ${job.task.title}`,
        body: (error ?? ended.question ?? summary).slice(0, 300),
        url: `/tasks/${job.taskId}`,
        subject: `task:${job.taskId}`,
      },
    });
    return runId;
  });
  if (!won) return false;
  await announceClosedDecisions(prisma, [job.id]).catch(() => undefined);
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
  await wakeQueuedDevices(prisma, job.userId).catch(() => undefined);
  return true;
}
