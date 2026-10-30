/**
 * The mission outbox (ensemble-node docs/design B4, plan §9.1): effects of committed mission changes,
 * delivered at least once. A delivery is applied once by its consumer: a turn carries the effect's
 * operation id under a unique constraint, so a redelivered row finds that turn and adds nothing.
 *
 * A change kicks the dispatcher right after its commit; a sweep every few seconds picks up rows a
 * crash or a failed delivery left, so a restart resumes coordination from committed state.
 */
import type { FastifyInstance } from "fastify";
import type { NodeOutbox } from "@prisma/client";
import { enqueueTurn, inBackground } from "./queue.js";
import { endPlan, finishStep, loadPlan, onMissionEffects, reportNote, stepNote, type PlanData } from "./plans.js";
import { updateMessageData } from "./store.js";
import { loginCardClosed } from "./logins.js";
import type { AttemptReason } from "./missions-core.js";
import { dispatchStep } from "./dispatch.js";
import { helperRoomOf } from "./helpers.js";

const CLAIM_MS = 60_000;
const SWEEP_MS = Number(process.env.ENSEMBLE_NODE_OUTBOX_SWEEP_MS ?? 5_000) || 5_000;
const BACKOFF_MS = [2_000, 10_000, 30_000, 120_000, 600_000];

let running = false;
let again = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** Delivers due rows now (and again if more arrived meanwhile). */
export async function dispatchOutbox(app: FastifyInstance): Promise<number> {
  if (running) {
    again = true;
    return 0;
  }
  running = true;
  let delivered = 0;
  try {
    do {
      again = false;
      const now = new Date();
      const rows = await app.prisma.nodeOutbox.findMany({
        where: { deliveredAt: null, availableAt: { lte: now }, OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] },
        orderBy: { createdAt: "asc" },
        take: 50,
      });
      for (const row of rows) {
        const claimed = await app.prisma.nodeOutbox.updateMany({
          where: { id: row.id, deliveredAt: null, OR: [{ claimedUntil: null }, { claimedUntil: { lt: new Date() } }] },
          data: { claimedUntil: new Date(Date.now() + CLAIM_MS), attempts: { increment: 1 } },
        });
        if (claimed.count !== 1) continue;
        try {
          await deliver(app, row);
          await app.prisma.nodeOutbox.update({ where: { id: row.id }, data: { deliveredAt: new Date(), claimedUntil: null, error: null } });
          delivered += 1;
        } catch (error) {
          app.log.error({ err: error, operationId: row.operationId }, "Node outbox delivery failed");
          const wait = BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)]!;
          await app.prisma.nodeOutbox
            .update({ where: { id: row.id }, data: { claimedUntil: null, availableAt: new Date(Date.now() + wait), error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) } })
            .catch(() => undefined);
        }
      }
      if (rows.length === 50) again = true;
    } while (again);
  } finally {
    running = false;
  }
  return delivered;
}

async function deliver(app: FastifyInstance, row: NodeOutbox): Promise<void> {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const planId = row.missionId;
  if (!planId) return;
  const plan = await loadPlan(app.prisma, planId);
  if (!plan) return;
  if (row.kind === "turn") return deliverTurn(app, row, plan.data, plan.message.roomId, payload);
  if (row.kind === "report") return deliverReport(app, row, plan.data, payload);
  if (row.kind === "expire_cards") await expireCards(app, planId, Array.isArray(payload.steps) ? (payload.steps as string[]) : null, String(payload.why ?? "Its work ended."));
}

async function deliverTurn(app: FastifyInstance, row: NodeOutbox, data: PlanData, planRoomId: string, payload: Record<string, unknown>): Promise<void> {
  const stepId = String(payload.stepId ?? "");
  const attempt = Number(payload.attempt ?? 1);
  const reason = String(payload.reason ?? "first") as AttemptReason;
  const step = data.steps.find((candidate) => candidate.id === stepId);
  // The attempt it was for is over (stopped, ended, superseded): nothing to deliver.
  if (!step || step.status !== "working" || step.attempt !== attempt) return;
  if (data.status !== "running" && data.status !== "reporting") return;
  // Work in files goes straight to a coding agent from its packet (B8); the node takes a turn otherwise.
  const dispatched = await dispatchStep(app, data, step, reason, planRoomId);
  if (dispatched?.done) return;
  const note = dispatched
    ? `${stepNote(data, step, reason)}\n\nEnsemble could not hand this step straight to a coding agent: ${dispatched.why}\nDecide where it runs (node_session_start, or node_session_send to your session), or report it blocked with why.`
    : stepNote(data, step, reason);
  // A helper works in its own thread (node/helpers.ts), the only room it is in.
  const roomId = step.executor === "helper" ? ((await helperRoomOf(app.prisma, step.nodeId))?.id ?? planRoomId) : planRoomId;
  const queued = await enqueueTurn(app, {
    nodeId: step.nodeId,
    roomId,
    reason: "plan",
    note,
    planId: data.missionId,
    planStep: step.id,
    operationId: row.operationId,
  });
  if (!queued) await finishStep(app, data.missionId, step.id, { status: "blocked", result: `@${step.handle} is paused or gone, so it could not start.`, outcome: "blocked", attempt });
}

async function deliverReport(app: FastifyInstance, row: NodeOutbox, data: PlanData, payload: Record<string, unknown>): Promise<void> {
  if (data.status !== "reporting") return;
  // A routine that reports nothing: its run is listed with the routine, and nobody is told.
  if (data.routine?.notify === "never") return endPlan(app, data.missionId);
  const judgement = Array.isArray(payload.judgement) ? payload.judgement.map(String) : [];
  const reported = await enqueueTurn(app, {
    nodeId: data.leadNodeId,
    roomId: data.originRoomId,
    reason: "plan",
    note: reportNote(data, judgement),
    planId: data.missionId,
    private: data.originPrivate,
    operationId: row.operationId,
  });
  if (!reported) await endPlan(app, data.missionId);
}

/** Cards of ended work still waiting on the owner close: an answer now would act for work that is over. */
export async function expireCards(app: FastifyInstance, planId: string, steps: string[] | null, why: string): Promise<number> {
  const cards = await app.prisma.nodeMessage.findMany({
    where: { kind: "approval", AND: [{ data: { path: ["plan", "id"], equals: planId } }, { data: { path: ["status"], equals: "pending" } }] },
  });
  let expired = 0;
  for (const card of cards) {
    const step = (card.data as { plan?: { step?: unknown } }).plan?.step;
    if (steps && !(typeof step === "string" && steps.includes(step))) continue;
    // A step's current attempt may still use a card made for it after this ended attempt; only cards from before the end close.
    if (steps && typeof step === "string") {
      const row = await app.prisma.nodeStep.findUnique({ where: { missionId_id: { missionId: planId, id: step } }, select: { status: true, startedAt: true } });
      if (row && (row.status === "working" || row.status === "waiting") && !(row.startedAt && card.createdAt < row.startedAt)) continue;
    }
    const closed = await updateMessageData(app.prisma, card, { status: "expired", expiredReason: why });
    // A sign-in card's computer frees its tab (node/logins.ts).
    if ((card.data as { type?: unknown }).type === "login") void loginCardClosed(app, closed).catch(() => undefined);
    expired += 1;
  }
  return expired;
}

/** Runs the dispatcher in the background after a commit (tests and shutdown wait for it). */
export function kickOutbox(app: FastifyInstance): void {
  inBackground(app, () => dispatchOutbox(app));
}

/** Starts delivering: right after each change, and in a sweep for rows a restart or a failure left. */
export function startOutbox(app: FastifyInstance): void {
  onMissionEffects(kickOutbox);
  if (timer) return;
  timer = setInterval(() => void dispatchOutbox(app).catch((error: unknown) => app.log.error({ err: error }, "Node outbox sweep failed")), SWEEP_MS);
  timer.unref?.();
  kickOutbox(app);
}

export function stopOutbox(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Registers delivery without the sweep (tests drive the dispatcher themselves). */
export function registerOutbox(): void {
  onMissionEffects(kickOutbox);
}
