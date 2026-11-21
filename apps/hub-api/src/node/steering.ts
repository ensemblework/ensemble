/**
 * Steering work already going (docs/35 §5.9). Five cases; which one applies is chosen by what the owner
 * asked for (an explicit control: the composer's choice on a message, a session's delivery), never by
 * their wording, and how it is done is decided by the worker's state:
 *
 *   follow_up    a new message while a turn runs: merged into that turn while it has not acted
 *                (`coalesce`), else it waits for the next turn (`queue`); with nothing running, a new run
 *   amendment    a change to the work going on, written first (`node_steers`, a version per target), then
 *                handed to the running worker when it can take one (`inject`: a node turn on Ensemble's own
 *                loop takes it between steps), else given at its next turn (`next_turn`), or written into
 *                the brief of a run that has not started (`brief`)
 *   interrupt    the run going on stops; the conversation or session goes on with the new message
 *   replacement  the run going on stops, and what it started stops too or is kept on purpose (listed on the
 *                record and told to the turn that takes the new message); the new message is new work
 *   stop         the work stops with every child (node/stop.ts)
 *
 * A plain message from its owner to a node whose turn runs in the same thread is a follow-up or an
 * amendment by that turn's state alone (`ownerMessageCase`). Each decision is in `node_decisions` (kind
 * `steer`). An amendment's outcome: `accepted` (its worker took it), `rejected` (it could not, so the next
 * turn reads it as usual) or `indeterminate` (handed over, then the call that carried it never answered):
 * an indeterminate one is never handed over again.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { recordDecision } from "./trace.js";

export type SteerKind = "follow_up" | "amendment" | "interrupt" | "replacement" | "stop";
export type SteerOperation = "coalesce" | "queue" | "inject" | "next_turn" | "brief" | "interrupt" | "replace" | "stop" | "new_run";
export type SteerOutcome = "pending" | "accepted" | "rejected" | "indeterminate" | "done";
export type SteerTarget = "turn" | "session" | "conversation";

/** The worker as a steering decision reads it: nothing running, a run not started yet, or one going on. */
export type Worker = {
  state: "idle" | "queued" | "running";
  /** It already did something that changes the world (a turn: `sideEffectsAt`). */
  acted: boolean;
  /** It takes a change while it runs (a node turn on Ensemble's own loop). No agent session does yet. */
  canSteer: boolean;
  /** A person's message turn with nothing bound to it: a newer message may stop it and take over. */
  mergeable?: boolean;
};

/** How a steering is done, from the case asked for and the worker's state. Pure. */
export function steerOperation(kind: SteerKind, worker: Worker): SteerOperation {
  if (kind === "stop") return "stop";
  if (worker.state === "idle") return "new_run";
  if (kind === "follow_up") return worker.state === "running" && !worker.acted && worker.mergeable ? "coalesce" : "queue";
  if (kind === "amendment") return worker.state === "queued" ? "brief" : worker.canSteer ? "inject" : "next_turn";
  if (kind === "interrupt") return worker.state === "queued" ? "brief" : "interrupt";
  return "replace";
}

/** A plain owner message while the node's turn runs in that thread: an amendment when the turn has acted and takes changes, else a follow-up. */
export function ownerMessageCase(worker: Worker): { kind: SteerKind; operation: SteerOperation } {
  const kind: SteerKind = worker.state === "running" && worker.acted && worker.canSteer ? "amendment" : "follow_up";
  return { kind, operation: steerOperation(kind, worker) };
}

/** A session message's delivery as a case: `steer` stops the run going on and continues it. */
export function deliveryCase(delivery: "queue" | "amend" | "steer" | "replace"): SteerKind {
  return delivery === "queue" ? "follow_up" : delivery === "amend" ? "amendment" : delivery === "steer" ? "interrupt" : "replacement";
}

/** A child a replacement or a stop stopped or left running: a turn, a plan, an agent run, a helper, a recording. */
export type SteerChild = { kind: "turn" | "plan" | "run" | "helper" | "recording" | "command"; id: string; title?: string };

export type SteerRecord = {
  userId: string;
  nodeId: string;
  roomId?: string | null;
  turnId?: string | null;
  kind: SteerKind;
  target: SteerTarget;
  targetId: string;
  operation: SteerOperation;
  worker: Worker;
  messageId?: string | null;
  jobId?: string | null;
  outcome?: SteerOutcome;
  children?: { stopped?: SteerChild[]; kept?: SteerChild[] };
};

/**
 * Writes one steering (`node_steers`, with an amendment's next version for its target) and its decision
 * (`node_decisions`, kind `steer`), before anything is done about it. Returns the steering's id, or null
 * when it could not be written (logged; the work goes on).
 */
export async function recordSteer(app: Pick<FastifyInstance, "prisma" | "log">, record: SteerRecord): Promise<string | null> {
  try {
    const version = record.kind === "amendment" ? (await app.prisma.nodeSteer.count({ where: { target: record.target, targetId: record.targetId, kind: "amendment" } })) + 1 : 0;
    const row = await app.prisma.nodeSteer.create({
      data: {
        userId: record.userId,
        nodeId: record.nodeId,
        roomId: record.roomId ?? null,
        kind: record.kind,
        target: record.target,
        targetId: record.targetId,
        version,
        operation: record.operation,
        messageId: record.messageId ?? null,
        jobId: record.jobId ?? null,
        outcome: record.outcome ?? "pending",
        children: (record.children ?? {}) as Prisma.InputJsonValue,
        ...(record.outcome && record.outcome !== "pending" ? { settledAt: new Date() } : {}),
      },
      select: { id: true },
    });
    await recordDecision(app, {
      userId: record.userId,
      nodeId: record.nodeId,
      turnId: record.turnId ?? null,
      kind: "steer",
      inputs: { target: record.target, targetId: record.targetId, worker: record.worker, ...(record.messageId ? { messageId: record.messageId } : {}) },
      choice: {
        kind: record.kind,
        operation: record.operation,
        steerId: row.id,
        ...(version ? { version } : {}),
        ...(record.children?.stopped?.length ? { stopped: record.children.stopped.length } : {}),
        ...(record.children?.kept?.length ? { kept: record.children.kept.length } : {}),
      },
    });
    return row.id;
  } catch (error) {
    app.log.warn({ err: error, kind: record.kind, target: record.target }, "Could not record a steering");
    return null;
  }
}

/** Settles steerings still pending (or only handed over): their outcome, once. */
export async function settleSteers(app: Pick<FastifyInstance, "prisma" | "log">, ids: readonly string[], outcome: Exclude<SteerOutcome, "pending">, extra: { jobId?: string | null } = {}): Promise<void> {
  if (!ids.length) return;
  await app.prisma.nodeSteer
    .updateMany({ where: { id: { in: [...ids] }, outcome: "pending" }, data: { outcome, settledAt: new Date(), ...(extra.jobId ? { jobId: extra.jobId } : {}) } })
    .catch((error: unknown) => app.log.warn({ err: error }, "Could not settle a steering"));
}

/** Marks amendments as handed to their running worker: from now on they are never handed over again. */
export async function steersHanded(app: Pick<FastifyInstance, "prisma">, ids: readonly string[]): Promise<void> {
  if (ids.length) await app.prisma.nodeSteer.updateMany({ where: { id: { in: [...ids] }, handedAt: null }, data: { handedAt: new Date() } });
}

/**
 * After a restart: amendments a turn had taken but whose model call never answered are indeterminate (never
 * handed over again); ones it never took are rejected, so the next turn reads their message as usual.
 */
export async function recoverSteers(app: Pick<FastifyInstance, "prisma">): Promise<void> {
  const now = new Date();
  await app.prisma.nodeSteer.updateMany({ where: { outcome: "pending", target: "turn", handedAt: { not: null } }, data: { outcome: "indeterminate", settledAt: now } });
  await app.prisma.nodeSteer.updateMany({ where: { outcome: "pending", target: "turn", handedAt: null }, data: { outcome: "rejected", settledAt: now } });
}
