/**
 * Node turns (docs/35 §5; ensemble-node docs/design B15): who speaks after a message, and running
 * their turns in lanes. A node has a conversation lane per room thread (it answers there) and a work
 * lane per plan step (its own work, which never posts). Turns run in order within a lane and in
 * parallel across lanes, so a node answers its owner while its work goes on. Conversation turns and
 * work turns draw on separate capacity, so work can never starve the conversation.
 *
 * A queued turn in a lane takes in later messages instead of queueing another. A new message from
 * the owner aborts a conversation turn that has not yet acted, and it starts again with both
 * messages. Turns are rows, so a restart finds what was waiting, and a turn cut off before it acted
 * runs again.
 *
 * A turn can wait in a tool call for its owner's answer on a card in the chat (`waitingForOwner`):
 * meanwhile it gives its slot back, and a new message from its owner in its lane ends the wait. A
 * turn whose owner has not answered yet parks (`requestPark`): it ends after its current tool calls
 * without posting a reply, and the answer wakes it again.
 *
 * Each row keeps what happened to it in `outcome` (`TurnOutcomeName`), apart from `status`, which keeps
 * its four values: a parked, merged, skipped or stopped turn is `done` there, a retried one `failed`.
 */
import type { FastifyInstance } from "fastify";
import type { NodeMessage, NodeTurn, Prisma, PrismaClient } from "@prisma/client";
import { safePublicError, truncateText } from "../lib/text.js";
import { runNodeTurn, type TurnOutcome } from "./brain.js";
import type { Mention } from "./mentions.js";
import { botStreak, loopBrake, routeRecord, whoSpeaks, type RouteDecision, type RouteInput, type RouteNode, type RouteRoom, type RouteTarget } from "./router.js";
import { activeHeuristics, heuristicsVersion } from "./heuristics.js";
import { recordDecision } from "./trace.js";
import { publishTo } from "./events.js";
import { postMessage, roomSettings } from "./store.js";
import { missionEnded, planTurnEnded } from "./plans.js";
import { postStatusCards } from "./status-cards.js";
import { forgetTurnMedia } from "./media.js";
import { actedCalls, uncertainCalls } from "./journal.js";
import { ownerMessageCase, recordSteer, recoverSteers, settleSteers, type SteerKind, type Worker } from "./steering.js";
import { groupMode, recoverRounds, roundTurnEnded, startRound, type RoundTurn } from "./groups.js";

const PARALLEL = Math.max(1, Number(process.env.ENSEMBLE_NODE_PARALLEL ?? 4) || 4);
/** Conversation turns in parallel on this server (kept apart from work, so talking never waits behind work). */
const TALK_PARALLEL = Math.max(1, Number(process.env.ENSEMBLE_NODE_TALK_PARALLEL ?? PARALLEL) || PARALLEL);
/** Work turns in parallel on this server. */
const WORK_PARALLEL = Math.max(1, Number(process.env.ENSEMBLE_NODE_WORK_PARALLEL ?? PARALLEL) || PARALLEL);
/** Work turns of one node at once (the owner's setting later; a concurrency limit, not a product wall). */
const WORK_PER_NODE = Math.max(1, Number(process.env.ENSEMBLE_NODE_WORK_PER_NODE ?? 3) || 3);
/** Queued turns older than this when the server starts are dropped, not run late (unless their mission still runs). */
const STALE_MS = 60 * 60 * 1000;

class Pool {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly size: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.size) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }
  release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

const talkPool = new Pool(TALK_PARALLEL);
const workPool = new Pool(WORK_PARALLEL);
const nodeWork = new Map<string, Pool>();
const chains = new Map<string, Promise<void>>();

/** The capacity a running turn holds: given back while it waits for its owner, taken again after. */
class Slot {
  private held = true;
  constructor(
    private readonly pool: Pool,
    private readonly own: Pool | null,
  ) {}
  give(): void {
    if (!this.held) return;
    this.held = false;
    this.pool.release();
    this.own?.release();
  }
  async take(): Promise<void> {
    if (this.held) return;
    if (this.own) await this.own.acquire();
    await this.pool.acquire();
    this.held = true;
  }
}

/**
 * `mergeable`: a person's message turn with nothing bound to it, which a newer message may stop and take over (`coalesce`).
 * `waiting`: set while a tool call waits for the owner's answer on a card; aborting it ends the wait.
 * `park`: what the turn waits for, once a tool asked to park it; it ends after its current tool calls.
 * `steerable`: the turn takes what its owner adds while it works, between its steps (node/steering.ts); `offers`
 * holds those additions until it takes them.
 */
type LiveTurn = {
  app: FastifyInstance;
  controller: AbortController;
  turnId: string;
  nodeId: string;
  roomId: string | null;
  planId: string | null;
  planStep: string | null;
  lane: string;
  acted: boolean;
  mergeable: boolean;
  slot: Slot;
  waiting: AbortController | null;
  park: string[];
  steerable: boolean;
  offers: SteerOffer[];
};
const live = new Map<string, LiveTurn>();

/** An owner's message offered to a running turn as an amendment, with its steering record. */
export type SteerOffer = { steerId: string; messageId: string };

/** What happened to a turn (`node_turns.outcome`): its state while it waits or runs, then how it ended. */
export type TurnOutcomeName = "queued" | "running" | "waiting_approval" | TurnOutcome["status"];

/** The `status` (queued | running | done | failed) a turn ends with, for how it ended. */
function statusOf(outcome: TurnOutcome["status"]): "done" | "failed" {
  return outcome === "failed" || outcome === "retry" ? "failed" : "done";
}

/** Moves a turn's outcome from one state to another, when it is still in the first. A failed write is logged; the turn goes on. */
async function moveOutcome(app: FastifyInstance, turnId: string, from: TurnOutcomeName, to: TurnOutcomeName): Promise<void> {
  await app.prisma.nodeTurn.updateMany({ where: { id: turnId, outcome: from }, data: { outcome: to } }).catch((error: unknown) => app.log.warn({ err: error, turnId }, "Could not record a node turn's outcome"));
}

/** The lane a turn runs in: a plan step's own work lane, else the room thread's conversation lane. */
export function laneFor(request: { roomId: string | null; private?: boolean; planId?: string | null; planStep?: string | null }): string {
  if (request.planId && request.planStep) return `work:${request.planId}:${request.planStep}`;
  return `conv:${request.roomId ?? "none"}:${request.private ? "p" : "s"}`;
}

export function isWorkLane(lane: string | null | undefined): boolean {
  return Boolean(lane?.startsWith("work:"));
}

function nodePool(nodeId: string): Pool {
  let pool = nodeWork.get(nodeId);
  if (!pool) {
    pool = new Pool(WORK_PER_NODE);
    nodeWork.set(nodeId, pool);
  }
  return pool;
}

export type TurnRequest = {
  nodeId: string;
  roomId: string;
  reason: string;
  triggerMessageId?: string | null;
  note?: string | null;
  private?: boolean;
  /** A plan's turn (node/plans.ts): a step's worker turn, or the lead's report. */
  planId?: string | null;
  planStep?: string | null;
  attempt?: number;
  /** An outbox effect's id: a turn with it already exists → nothing new. */
  operationId?: string | null;
  /** owner (default) or room: where the answer goes (C1). */
  audience?: "owner" | "room";
  /** The peer request this turn answers or plans, and for whom it is done (node/peer-requests.ts). */
  peerRequestId?: string | null;
  principals?: Record<string, unknown> | null;
  /** The first turn this one continues (a resume after a restart): it keeps that turn's operation and request. */
  originTurnId?: string | null;
  /** The space its Hub calls act in when they name none (a task's space). Null: the node's home space. */
  spaceId?: string | null;
  /** Not before then (a task just given from Ensemble waits a moment, so a slip can be undone for free). */
  runAfter?: Date | null;
  /** An independent answer (node/groups.ts): it reads the room only up to this message, and answers by `deadlineAt`. */
  snapshotSeq?: number | null;
  deadlineAt?: Date | null;
};

/** Rate-limited turns try again quietly this many times, this far apart. */
const RETRIES = 3;
const RETRY_MS = [8_000, 30_000, 90_000];

function tainted(message: Pick<NodeMessage, "userId" | "data"> | null, owner: string): boolean {
  return Boolean(message && (message.userId !== owner || (message.data as { fromNonOwner?: unknown } | null)?.fromNonOwner === true));
}

/** Reasons a person's message wakes a node for (a new one of these may coalesce a turn that has not acted yet). */
const PERSON_REASONS = new Set(["dm", "mentioned", "lead", "relevance"]);
/** Turns about someone else's words or a request (node/audience.ts, node/peer-requests.ts): never merged with others. */
const BOUND_REASONS = new Set(["disclose", "answer", "request"]);

/** A turn bound to an effect, a request or the turn it continues, or about someone else's words. */
function boundRequest(request: Pick<TurnRequest, "operationId" | "originTurnId" | "peerRequestId" | "reason">): boolean {
  return Boolean(request.operationId || request.originTurnId || request.peerRequestId) || BOUND_REASONS.has(request.reason);
}

/** Queues a node's turn (or adds to the one already waiting in its lane); false when the node is paused or gone. */
export async function enqueueTurn(app: FastifyInstance, request: TurnRequest): Promise<boolean> {
  return Boolean(await queueTurn(app, request));
}

/** `enqueueTurn` with the turn that will answer: a new one, the queued one it joined, or the one its operation already made. Null when the node is paused or gone. */
export async function queueTurn(app: FastifyInstance, request: TurnRequest): Promise<string | null> {
  const prisma = app.prisma;
  const node = await prisma.nodeAgent.findUnique({ where: { id: request.nodeId }, select: { userId: true, status: true } });
  if (!node || node.status !== "active") return null;
  if (request.operationId) {
    const made = await prisma.nodeTurn.findUnique({ where: { operationId: request.operationId }, select: { id: true } });
    if (made) return made.id;
  }
  const isPrivate = request.private ?? false;
  const lane = laneFor({ roomId: request.roomId, private: isPrivate, planId: request.planId, planStep: request.planStep });
  // A plan's turns stay apart: a step's turn never takes in another step's or a chat's. In a conversation, a
  // turn bound to something keeps its own row: nothing merges into it and it merges into nothing, so its
  // operation, its reason (a disclosure only drafts) and its request stay its own.
  const conversation = !request.planId;
  const queued =
    conversation && boundRequest(request)
      ? null
      : await prisma.nodeTurn.findFirst({
          where: {
            nodeId: request.nodeId,
            roomId: request.roomId,
            status: "queued",
            private: isPrivate,
            planId: request.planId ?? null,
            planStep: request.planStep ?? null,
            ...(conversation ? { operationId: null, originTurnId: null, peerRequestId: null, reason: { notIn: [...BOUND_REASONS] } } : {}),
          },
        });
  if (queued) {
    // The queued turn reads every new message anyway. It answers the newest one, unless the one it
    // holds came from someone other than the owner: that keeps the turn's writes held for approval.
    const [held, incoming] = await Promise.all(
      [queued.triggerMessageId, request.triggerMessageId].map((id) => (id ? prisma.nodeMessage.findUnique({ where: { id }, select: { userId: true, data: true } }) : null)),
    );
    const keep = tainted(held ?? null, node.userId) && !tainted(incoming ?? null, node.userId);
    await prisma.nodeTurn.update({
      where: { id: queued.id },
      data: {
        note: mergedNote(queued.note, request.note),
        ...(keep || !request.triggerMessageId ? {} : { triggerMessageId: request.triggerMessageId, reason: request.reason }),
        ...(request.peerRequestId && !queued.peerRequestId ? { peerRequestId: request.peerRequestId, principals: (request.principals ?? {}) as Prisma.InputJsonValue } : {}),
        ...(request.originTurnId && !queued.originTurnId && !queued.operationId ? { originTurnId: request.originTurnId } : {}),
      },
    });
    await coalesce(app, request, lane, node.userId);
    return queued.id;
  }
  const turn = await prisma.nodeTurn.create({
    data: {
      userId: node.userId,
      nodeId: request.nodeId,
      roomId: request.roomId,
      reason: request.reason,
      triggerMessageId: request.triggerMessageId ?? null,
      note: request.note ?? null,
      private: isPrivate,
      planId: request.planId ?? null,
      planStep: request.planStep ?? null,
      attempt: request.attempt ?? 0,
      lane,
      audience: request.audience ?? "owner",
      operationId: request.operationId ?? null,
      peerRequestId: request.peerRequestId ?? null,
      principals: (request.principals ?? {}) as Prisma.InputJsonValue,
      originTurnId: request.originTurnId ?? null,
      spaceId: request.spaceId ?? null,
      runAfter: request.runAfter ?? null,
      snapshotSeq: request.snapshotSeq ?? null,
      deadlineAt: request.deadlineAt ?? null,
      outcome: "queued",
    },
  });
  await coalesce(app, request, lane, node.userId);
  if (turn.runAfter) scheduleLater(app, turn);
  else schedule(app, turn);
  return turn.id;
}

/**
 * A turn about work taken away (a task given to another owner, node/task-assignment.ts): stopped
 * where it is if it runs and has not changed anything yet ("stopped": it leaves no trace); "acted"
 * when it already did something; "idle" when it is not running here.
 */
export function withdrawTurn(turnId: string): "stopped" | "acted" | "idle" {
  const entry = live.get(turnId);
  if (!entry) return "idle";
  if (entry.acted) return "acted";
  entry.controller.abort("withdrawn");
  return "stopped";
}

function mergedNote(held: string | null, incoming: string | null | undefined): string | null {
  if (held && incoming && held.includes(incoming)) return held;
  return [held, incoming].filter(Boolean).join("\n") || null;
}

/** A person's message turn with nothing bound to it: an approval, a run's end, a request or an outbox effect is never stopped to merge. */
function mergeable(turn: Pick<NodeTurn, "reason" | "operationId" | "peerRequestId" | "originTurnId">): boolean {
  return PERSON_REASONS.has(turn.reason) && !turn.operationId && !turn.peerRequestId && !turn.originTurnId;
}

/** What a turn stopped to merge was told (a run's end merged into it, a routing note) goes on with the turn that answers instead. */
async function carryNote(prisma: PrismaClient, turn: NodeTurn): Promise<void> {
  const note = (await prisma.nodeTurn.findUnique({ where: { id: turn.id }, select: { note: true } }))?.note;
  if (!note) return;
  const next = await prisma.nodeTurn.findFirst({
    where: { nodeId: turn.nodeId, roomId: turn.roomId, status: "queued", private: turn.private, planId: null, planStep: null, operationId: null, originTurnId: null, peerRequestId: null, reason: { notIn: [...BOUND_REASONS] } },
    orderBy: { createdAt: "asc" },
  });
  if (next) await prisma.nodeTurn.update({ where: { id: next.id }, data: { note: mergedNote(note, next.note) } });
}

/**
 * A person's new message while a turn runs in the lane (node/steering.ts). Its owner's turn that has not
 * acted yet stops and the queued one answers both messages (a follow-up, merged). One that has acted
 * finishes, and the new message is next (a follow-up, queued), unless it takes what its owner adds while it
 * works (`steerable`): then its owner's message is an amendment, written first and offered to it, and it
 * reads it between two steps. A turn waiting for its owner's answer on a card stops waiting when its owner
 * writes in its lane, acted or not: it parks, and the new message is answered next.
 */
async function coalesce(app: FastifyInstance, request: TurnRequest, lane: string, owner: string): Promise<void> {
  if (isWorkLane(lane) || !request.triggerMessageId || !PERSON_REASONS.has(request.reason)) return;
  // A turn already stopped (an interrupt, a replacement, a stop) is ending: nothing joins it.
  const entries = [...live.values()].filter((entry) => entry.nodeId === request.nodeId && entry.lane === lane && !entry.controller.signal.aborted);
  if (!entries.length) return;
  const message = await app.prisma.nodeMessage.findUnique({ where: { id: request.triggerMessageId }, select: { userId: true, authorKind: true, data: true } });
  const fromOwner = Boolean(message && message.authorKind === "human" && !tainted(message, owner));
  for (const entry of entries) {
    const worker: Worker = { state: "running", acted: entry.acted, canSteer: entry.steerable && fromOwner, mergeable: entry.mergeable && !entry.planId };
    let decided: { kind: SteerKind; operation: "coalesce" | "queue" | "inject" };
    if (!entry.acted && !entry.planId && entry.mergeable) {
      entry.controller.abort("coalesce");
      decided = { kind: "follow_up", operation: "coalesce" };
    } else if (fromOwner && entry.waiting) {
      entry.waiting.abort("owner");
      decided = { kind: "follow_up", operation: "queue" };
    } else {
      const choice = ownerMessageCase(worker);
      decided = choice.operation === "inject" ? { kind: "amendment", operation: "inject" } : { kind: "follow_up", operation: "queue" };
    }
    if (!fromOwner) continue;
    // Written before the turn can read it: an amendment is never handed over without its record.
    const steerId = await recordSteer(app, {
      userId: owner,
      nodeId: entry.nodeId,
      roomId: entry.roomId,
      turnId: entry.turnId,
      kind: decided.kind,
      target: "turn",
      targetId: entry.turnId,
      operation: decided.operation,
      worker,
      messageId: request.triggerMessageId,
      outcome: decided.operation === "inject" ? "pending" : "done",
    });
    if (decided.operation !== "inject" || !steerId) continue;
    if (entry.steerable && live.get(entry.turnId) === entry) entry.offers.push({ steerId, messageId: request.triggerMessageId });
    else await settleSteers(app, [steerId], "rejected");
  }
}

/** The running turn takes what its owner adds while it works (node/brain.ts, a turn on Ensemble's own loop only its owner reads). */
export function allowSteering(turnId: string): void {
  const entry = live.get(turnId);
  if (entry) entry.steerable = true;
}

/** The owner's additions waiting for the running turn, taken once. */
export function takeOffers(turnId: string): SteerOffer[] {
  const entry = live.get(turnId);
  return entry ? entry.offers.splice(0) : [];
}

/** The turn takes no more additions (it is ending): those still waiting, which the next turn reads as usual. */
export function closeSteering(turnId: string): SteerOffer[] {
  const entry = live.get(turnId);
  if (!entry) return [];
  entry.steerable = false;
  return entry.offers.splice(0);
}

/**
 * Interrupt and continue, or a replacement (node/steering.ts, node/stop.ts `steerConversation`): the owner's
 * message stops the turns of these nodes running in this lane now; their conversation goes on with that
 * message, which is queued as usual. Returns the turns stopped.
 */
export function interruptTurns(nodeIds: readonly string[], lane: string, why: "interrupt" | "replace" = "interrupt"): Array<{ turnId: string; nodeId: string; acted: boolean }> {
  const stopped: Array<{ turnId: string; nodeId: string; acted: boolean }> = [];
  for (const entry of live.values()) {
    if (!nodeIds.includes(entry.nodeId) || entry.lane !== lane || entry.controller.signal.aborted) continue;
    entry.controller.abort(why);
    stopped.push({ turnId: entry.turnId, nodeId: entry.nodeId, acted: entry.acted });
  }
  return stopped;
}

/** The turns of these nodes running now, in one lane or one room (null: anywhere), as steering and a stop read them. */
export function liveTurnsIn(nodeIds: readonly string[], where: { lane: string } | { roomId: string | null }): Array<{ turnId: string; nodeId: string; acted: boolean; steerable: boolean }> {
  return [...live.values()]
    .filter((entry) => nodeIds.includes(entry.nodeId) && ("lane" in where ? entry.lane === where.lane : where.roomId === null || entry.roomId === where.roomId))
    .map((entry) => ({ turnId: entry.turnId, nodeId: entry.nodeId, acted: entry.acted, steerable: entry.steerable }));
}

/**
 * A tool call waits for the owner's answer on a card: the turn gives its slot back meanwhile (other
 * turns run), and gets it again after. `wait` gets a signal that ends the wait: a new message from
 * the owner in the turn's lane (reason "owner"), a Stop or a merge (the turn's own reason), or the
 * turn already parking. Outside a queued turn (a tool called on its own) the signal never fires.
 */
export async function waitingForOwner<T>(turnId: string, wait: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const entry = live.get(turnId);
  const stop = new AbortController();
  if (!entry) return wait(stop.signal);
  // Already ending (parking after another call of this step, or stopped): nothing to wait for.
  if (entry.park.length || entry.controller.signal.aborted) {
    stop.abort(entry.park.length ? "park" : (entry.controller.signal.reason ?? "stop"));
    return wait(stop.signal);
  }
  const turnEnded = () => stop.abort(entry.controller.signal.reason ?? "stop");
  entry.controller.signal.addEventListener("abort", turnEnded, { once: true });
  entry.waiting = stop;
  entry.slot.give();
  await moveOutcome(entry.app, turnId, "running", "waiting_approval");
  try {
    return await wait(stop.signal);
  } finally {
    if (entry.waiting === stop) entry.waiting = null;
    entry.controller.signal.removeEventListener("abort", turnEnded);
    await moveOutcome(entry.app, turnId, "waiting_approval", "running");
    await entry.slot.take();
  }
}

/**
 * Parks the turn: it waits for its owner (`note` says for what) and ends after the tool calls it is
 * making now, quietly: no reply is posted, the note is kept in its conversation, and the owner's
 * answer wakes the node again. False outside a queued turn.
 */
export function requestPark(turnId: string, note: string): boolean {
  const entry = live.get(turnId);
  if (!entry) return false;
  if (!entry.park.includes(note)) entry.park.push(note);
  return true;
}

/** Called after each of the turn's tool calls: a turn asked to park stops here (its calls of this step have all run). */
export function parkIfAsked(turnId: string): void {
  const entry = live.get(turnId);
  if (entry?.park.length && !entry.controller.signal.aborted) entry.controller.abort("park");
}

/** What a parked turn waits for. */
export function parkedFor(turnId: string): string[] {
  return [...(live.get(turnId)?.park ?? [])];
}

/**
 * The turn posted a card for its owner and waits for the answer: it is no longer merged into a newer
 * message, so another person's message never cancels it; its owner's message ends the wait, and it parks.
 */
export function holdForCard(turnId: string): void {
  const entry = live.get(turnId);
  if (entry) entry.mergeable = false;
}

/** The turn just dispatched a tool that changes something: it is no longer aborted to coalesce, and a restart reconciles it. */
export async function markActed(app: FastifyInstance, turnId: string): Promise<void> {
  const entry = live.get(turnId);
  if (entry?.acted) return;
  if (entry) entry.acted = true;
  await app.prisma.nodeTurn.updateMany({ where: { id: turnId, sideEffectsAt: null }, data: { sideEffectsAt: new Date() } });
}

/** Records a tool the turn ran, as it ends (a restart reads them). */
export async function addReceipt(app: FastifyInstance, turnId: string, receipt: { name: string; state: string; summary?: string | null }): Promise<void> {
  const entry = JSON.stringify([{ name: receipt.name, state: receipt.state, summary: receipt.summary ? truncateText(receipt.summary, 200) : null }]);
  // One statement: tools that end together each keep their receipt.
  await app.prisma.$executeRaw`UPDATE node_turns SET receipts = receipts || ${entry}::jsonb WHERE id = ${turnId} AND jsonb_array_length(receipts) < 40`;
}

function laneKey(turn: Pick<NodeTurn, "nodeId" | "lane" | "roomId" | "private" | "planId" | "planStep">): string {
  return `${turn.nodeId}|${turn.lane ?? laneFor({ roomId: turn.roomId, private: turn.private, planId: turn.planId, planStep: turn.planStep })}`;
}

function schedule(app: FastifyInstance, turn: Pick<NodeTurn, "id" | "nodeId" | "lane" | "roomId" | "private" | "planId" | "planStep">): void {
  const key = laneKey(turn);
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(() => execute(app, turn.id));
  chains.set(key, next);
  void next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
}

async function execute(app: FastifyInstance, turnId: string): Promise<void> {
  const prisma = app.prisma;
  const head = await prisma.nodeTurn.findUnique({ where: { id: turnId }, select: { lane: true, nodeId: true, planId: true, planStep: true, snapshotSeq: true, triggerMessageId: true } });
  if (!head) return;
  const work = isWorkLane(head.lane) || Boolean(head.planStep);
  const pool = work ? workPool : talkPool;
  const own = work ? nodePool(head.nodeId) : null;
  if (own) await own.acquire();
  await pool.acquire();
  const slot = new Slot(pool, own);
  try {
    const claimed = await prisma.nodeTurn.updateMany({ where: { id: turnId, status: "queued" }, data: { status: "running", outcome: "running" } });
    if (claimed.count !== 1) return;
    const turn = await prisma.nodeTurn.findUniqueOrThrow({ where: { id: turnId } });
    const controller = new AbortController();
    const lane = turn.lane ?? laneFor(turn);
    live.set(turnId, { app, controller, turnId, nodeId: turn.nodeId, roomId: turn.roomId, planId: turn.planId, planStep: turn.planStep, lane, acted: Boolean(turn.sideEffectsAt), mergeable: mergeable(turn), slot, waiting: null, park: [], steerable: false, offers: [] });
    try {
      const outcome = await runNodeTurn(app, turn, { dispatch: (message) => dispatchMessage(app, message), signal: controller.signal });
      if (outcome.status === "retry") {
        // The model's rate limit: the same turn again a little later, without a message in the room.
        await prisma.nodeTurn.update({ where: { id: turnId }, data: { status: "failed", outcome: "retry", error: truncateText(outcome.error ?? "Rate limited.", 500), finishedAt: new Date() } });
        await retryLater(app, turn);
        return;
      }
      if (outcome.status === "coalesced") {
        await prisma.nodeTurn.update({ where: { id: turnId }, data: { status: "done", outcome: "coalesced", error: "Merged into the next turn: a newer message came first.", finishedAt: new Date() } });
        await carryNote(prisma, turn);
        return;
      }
      await prisma.nodeTurn.update({
        where: { id: turnId },
        data: {
          status: statusOf(outcome.status),
          outcome: outcome.status,
          model: outcome.model ?? null,
          credits: outcome.credits ?? null,
          error: outcome.error ? truncateText(outcome.error, 500) : null,
          finishedAt: new Date(),
        },
      });
      // A parked turn's step goes on working: its owner's answer wakes it. A stopped one already ended its step.
      if (outcome.status !== "done" && outcome.status !== "parked" && outcome.status !== "cancelled") await planTurnEnded(app, turn, outcome.error ? `Its node could not take its turn: ${truncateText(outcome.error, 300)}` : "Its node could not take its turn.");
    } finally {
      // Additions it never took are answered by the next turn, which reads their messages as usual.
      const left = closeSteering(turnId);
      live.delete(turnId);
      forgetTurnMedia(turnId);
      await settleSteers(app, left.map((offer) => offer.steerId), "rejected");
    }
  } catch (error) {
    app.log.error({ err: error, turnId }, "Node turn failed");
    const failed = await prisma.nodeTurn
      .update({ where: { id: turnId }, data: { status: "failed", outcome: "failed", error: truncateText(safePublicError(error), 500), finishedAt: new Date() } })
      .catch(() => null);
    if (failed) await planTurnEnded(app, failed, "Its node's turn failed.").catch((problem: unknown) => app.log.error({ err: problem }, "Could not settle a plan turn"));
  } finally {
    slot.give();
    // An independent answer: once the round has none left to run, its answers are brought together (node/groups.ts).
    if (head.snapshotSeq !== null) await roundTurnEnded(app, head).catch((error: unknown) => app.log.warn({ err: error, turnId }, "Could not check an independent round"));
  }
}

/** Retries waiting for their time, with what ends their background work. */
const delayed = new Map<ReturnType<typeof setTimeout>, () => void>();
let retryDelays: readonly number[] = RETRY_MS;

export function setTurnRetryDelaysForTests(delays: readonly number[] | null): void {
  retryDelays = delays ?? RETRY_MS;
}

/** Runs a queued turn once its time comes (a retry's `runAfter`); counted as background work. */
function scheduleLater(app: FastifyInstance, turn: Pick<NodeTurn, "id" | "nodeId" | "runAfter" | "lane" | "roomId" | "private" | "planId" | "planStep">): void {
  const wait = Math.max(0, (turn.runAfter?.getTime() ?? 0) - Date.now());
  if (!wait) return schedule(app, turn);
  let done: () => void = () => undefined;
  inBackground(app, () => new Promise<void>((resolve) => (done = resolve)));
  const timer = setTimeout(() => {
    delayed.delete(timer);
    schedule(app, turn);
    done();
  }, wait);
  timer.unref?.();
  delayed.set(timer, done);
}

/** The same turn again later, as a queued row: a restart runs it, a Stop drops it. */
async function retryLater(app: FastifyInstance, turn: NodeTurn): Promise<void> {
  const node = await app.prisma.nodeAgent.findUnique({ where: { id: turn.nodeId }, select: { status: true } });
  if (node?.status !== "active") {
    await planTurnEnded(app, turn, "Its node was paused before it could try again.");
    return;
  }
  const next = await app.prisma.nodeTurn.create({
    data: {
      userId: turn.userId,
      nodeId: turn.nodeId,
      roomId: turn.roomId,
      reason: turn.reason,
      triggerMessageId: turn.triggerMessageId,
      note: turn.note,
      private: turn.private,
      planId: turn.planId,
      planStep: turn.planStep,
      attempt: turn.attempt + 1,
      lane: turn.lane,
      audience: turn.audience,
      peerRequestId: turn.peerRequestId,
      principals: (turn.principals ?? {}) as Prisma.InputJsonValue,
      originTurnId: turn.originTurnId ?? turn.id,
      spaceId: turn.spaceId,
      snapshotSeq: turn.snapshotSeq,
      deadlineAt: turn.deadlineAt,
      runAfter: new Date(Date.now() + retryDelays[Math.min(turn.attempt, retryDelays.length - 1)]!),
      outcome: "queued",
    },
  });
  scheduleLater(app, next);
}

/** Whether a turn the model's rate limit stopped may try again. */
export function mayRetry(turn: Pick<NodeTurn, "attempt">): boolean {
  return turn.attempt < RETRIES;
}

/** Stops the running and queued turns of these nodes in a room (null: in every room). */
export async function stopTurns(app: FastifyInstance, nodeIds: readonly string[], roomId: string | null): Promise<number> {
  let stopped = 0;
  for (const entry of live.values()) {
    if ((roomId === null || entry.roomId === roomId) && nodeIds.includes(entry.nodeId)) {
      entry.controller.abort();
      stopped += 1;
    }
  }
  const where = { ...(roomId === null ? {} : { roomId }), nodeId: { in: [...nodeIds] }, status: "queued" };
  const planTurns = await app.prisma.nodeTurn.findMany({ where: { ...where, planId: { not: null } }, select: { planId: true, planStep: true } });
  const dropped = await app.prisma.nodeTurn.updateMany({ where, data: { status: "failed", outcome: "cancelled", error: "Stopped.", finishedAt: new Date() } });
  for (const turn of planTurns) await planTurnEnded(app, turn, "Stopped before it started.");
  return stopped + dropped.count;
}

/** A plan's turns (one step's or several, or all of them) stop: running ones are aborted, queued ones dropped. */
export async function stopPlanTurns(app: FastifyInstance, planId: string, steps: readonly string[] | null): Promise<void> {
  for (const entry of live.values()) {
    if (entry.planId === planId && (!steps || (entry.planStep && steps.includes(entry.planStep)))) entry.controller.abort();
  }
  await app.prisma.nodeTurn.updateMany({
    where: { planId, status: "queued", ...(steps ? { planStep: { in: [...steps] } } : {}) },
    data: { status: "failed", outcome: "cancelled", error: "Stopped.", finishedAt: new Date() },
  });
}

/** Shutdown: running turns stop where they are; queued rows run after the restart. */
export function abortAllTurns(): void {
  for (const entry of live.values()) entry.controller.abort();
  for (const [timer, done] of delayed) {
    clearTimeout(timer);
    done();
  }
  delayed.clear();
}

/**
 * After a restart (B4): a turn cut off before it acted runs again; one cut off after it acted is not
 * run twice but resumed, with a note of what it already did and of the calls that started without a
 * result (node/journal.ts: they may have acted, and are never run again blindly), so the work goes on
 * instead of ending blocked. Queued turns run now; old ones are dropped unless their mission still runs.
 */
export async function recoverTurns(app: FastifyInstance): Promise<void> {
  const prisma = app.prisma;
  const now = Date.now();
  const uncertain = await uncertainCalls(app);
  await recoverSteers(app);
  const running = await prisma.nodeTurn.findMany({ where: { status: "running" } });
  for (const turn of running) {
    const mayHaveRun = uncertain.get(turn.id) ?? [];
    if (!turn.sideEffectsAt && !mayHaveRun.length && !(await actedCalls(app, turn.id))) {
      await prisma.nodeTurn.update({ where: { id: turn.id }, data: { status: "queued", outcome: "queued", receipts: [] as Prisma.InputJsonValue } });
      continue;
    }
    await prisma.nodeTurn.update({ where: { id: turn.id }, data: { status: "failed", outcome: "failed", error: "Interrupted by a server restart after it had acted.", finishedAt: new Date(now) } });
    const receipts = (Array.isArray(turn.receipts) ? (turn.receipts as Array<{ name?: string; state?: string; summary?: string | null }>) : [])
      .map((row) => `- ${row.name ?? "a tool"} (${row.state ?? "?"})${row.summary ? `: ${row.summary}` : ""}`)
      .join("\n");
    const unsure = mayHaveRun.map((row) => `- ${row.tool}${row.label ? ` ${row.label}` : ""}`).join("\n");
    const note = [
      "Your previous turn was cut off by a server restart after it had started acting. Do not repeat what it already did: check first (node_sessions, the plan card, the workspace).",
      unsure ? `These calls started but their result was never saved, so they may already have happened. Check each one before you do it again; the same call made again first answers that it may have run:\n${unsure}` : "",
      receipts ? `It ran:\n${receipts}` : "",
      turn.note ?? "",
    ].filter(Boolean).join("\n");
    const resumed = turn.roomId
      ? await enqueueTurn(app, {
          nodeId: turn.nodeId,
          roomId: turn.roomId,
          reason: turn.reason,
          triggerMessageId: turn.triggerMessageId,
          note,
          private: turn.private,
          planId: turn.planId,
          planStep: turn.planStep,
          audience: turn.audience === "room" ? "room" : "owner",
          peerRequestId: turn.peerRequestId,
          principals: (turn.principals ?? {}) as Record<string, unknown>,
          originTurnId: turn.originTurnId ?? turn.id,
          spaceId: turn.spaceId,
          snapshotSeq: turn.snapshotSeq,
          deadlineAt: turn.deadlineAt,
        })
      : false;
    if (!resumed) await planTurnEnded(app, turn, "Interrupted by a server restart.").catch((error: unknown) => app.log.error({ err: error }, "Could not settle a plan turn"));
  }
  const old = await prisma.nodeTurn.findMany({ where: { status: "queued", createdAt: { lt: new Date(now - STALE_MS) } }, select: { id: true, planId: true, planStep: true } });
  const missions = await prisma.nodeMission.findMany({ where: { id: { in: [...new Set(old.map((row) => row.planId).filter((id): id is string => Boolean(id)))] } }, select: { id: true, status: true } });
  const liveMission = new Set(missions.filter((row) => !missionEnded(row.status)).map((row) => row.id));
  const drop = old.filter((row) => !row.planId || !liveMission.has(row.planId));
  if (drop.length) {
    await prisma.nodeTurn.updateMany({ where: { id: { in: drop.map((row) => row.id) } }, data: { status: "failed", outcome: "cancelled", error: "Too old to run after a restart.", finishedAt: new Date(now) } });
    for (const turn of drop) if (turn.planId) await planTurnEnded(app, turn, "Too old to run after a restart.").catch((error: unknown) => app.log.error({ err: error }, "Could not settle a plan turn"));
  }
  const queued = await prisma.nodeTurn.findMany({ where: { status: "queued" }, orderBy: { createdAt: "asc" }, select: { id: true, nodeId: true, runAfter: true, lane: true, roomId: true, private: true, planId: true, planStep: true } });
  for (const turn of queued) scheduleLater(app, turn);
  await recoverRounds(app);
}

const background = new Set<Promise<unknown>>();

/** Routing after a post runs after the response; failures are logged, never thrown at the poster. */
export function inBackground(app: FastifyInstance, work: () => Promise<unknown>): void {
  const running = work().catch((error: unknown) => app.log.error({ err: error }, "Node background work failed"));
  background.add(running);
  void running.finally(() => background.delete(running));
}

/** Waits until no node routing or turn is running or queued in this process (tests, shutdown). */
export async function settleTurns(): Promise<void> {
  while (chains.size || background.size) await Promise.allSettled([...chains.values(), ...background]);
}

/**
 * Wakes the nodes that should answer a message, and records who was woken and why (`node_decisions`, kind `route`).
 * `steerNote`: what an interrupt or a replacement by this message stopped or kept (node/stop.ts), for the turns it wakes.
 */
export async function dispatchMessage(app: FastifyInstance, message: NodeMessage, operationId?: string, steerNote?: string): Promise<void> {
  if (message.kind !== "text" || message.authorKind === "system") return;
  const prisma = app.prisma;
  const room = await prisma.nodeRoom.findUnique({ where: { id: message.roomId } });
  if (!room || room.archivedAt) return;
  const members = await prisma.nodeRoomMember.findMany({ where: { roomId: room.id, nodeId: { not: null } }, include: { node: true } });
  // A paused node wakes only for its owner's own message to it (its DM, or a mention), which also resumes it; nothing else wakes it.
  const mentioned = new Set(((Array.isArray(message.mentions) ? message.mentions : []) as Mention[]).filter((row) => row.kind === "node").map((row) => row.id));
  const wakes = (node: { id: string; userId: string }) => message.authorKind === "human" && message.userId === node.userId && (room.kind === "dm" || mentioned.has(node.id));
  const nodes: RouteNode[] = members
    .filter((row) => row.node)
    .map((row) => ({ id: row.node!.id, ownerId: row.node!.userId, active: row.node!.status === "active" || wakes(row.node!), representative: row.representative, role: row.node!.role, handle: row.handle }));
  const heuristics = activeHeuristics(app.log);
  const brakes = heuristics.router;
  const recent = await prisma.nodeMessage.findMany({
    where: { roomId: room.id, seq: { lte: message.seq }, ...(message.visibleTo.length ? {} : { visibleTo: { isEmpty: true } }) },
    orderBy: { seq: "desc" },
    take: Math.max(brakes.botStreak, brakes.loopWindow) + 4,
    select: { authorKind: true, kind: true, authorNodeId: true, body: true },
  });
  const input: RouteInput = {
    id: message.id,
    roomId: room.id,
    kind: message.kind,
    authorKind: message.authorKind as "human" | "node" | "system",
    authorNodeId: message.authorNodeId,
    authorId: message.userId,
    text: message.body,
    visibleTo: message.visibleTo,
    mentions: (Array.isArray(message.mentions) ? message.mentions : []) as Mention[],
    botDepth: message.botDepth,
    replyTo: (message.data as { replyTo?: RouteInput["replyTo"] } | null)?.replyTo ?? null,
  };
  const routeRoom: RouteRoom = { kind: room.kind as RouteRoom["kind"], leadNodeIds: roomSettings(room).leadNodeIds, mode: groupMode(room) };
  const streak = botStreak(recent);
  // The loop brakes read the node messages since the last person's (newest last), this one included.
  const sincePerson = recent.findIndex((row) => row.authorKind === "human");
  const chain = recent.slice(0, sincePerson < 0 ? recent.length : sincePerson).filter((row) => row.kind === "text").slice(0, brakes.loopWindow).reverse();
  const routed = whoSpeaks(input, routeRoom, nodes, streak, brakes);
  // A node's message that would wake another wakes nobody when it only repeats what was said since then (`loopBrake`).
  const loop = message.authorKind === "node" && routed.nodeIds.length ? loopBrake(chain) : null;
  const decision: RouteDecision = loop ? { reason: "none", nodeIds: [], brake: loop } : routed;
  const record = routeRecord(input, routeRoom, nodes, streak, brakes, decision);
  const turnIds: Array<string | null> = [];
  try {
    // `@leads status` in a room with other people: every person's status card, built by code (node/status-cards.ts).
    if (decision.reason === "status") return await postStatusCards(app, room, message);
    const targets: RouteTarget[] = decision.reason === "none" ? [] : (decision.targets ?? decision.nodeIds.map((nodeId) => ({ nodeId, private: message.visibleTo.length > 0, audience: "owner" as const })));
    if (decision.reason === "none" && decision.brake) {
      // Said once: not again until a person writes here.
      const lastPerson = await prisma.nodeMessage.findFirst({ where: { roomId: room.id, authorKind: "human" }, orderBy: { seq: "desc" }, select: { seq: true } });
      const said = await prisma.nodeMessage.findFirst({
        where: { roomId: room.id, authorKind: "system", kind: "status", seq: { gt: lastPerson?.seq ?? 0 }, OR: ["streak", "depth", "duplicate", "cycle"].map((brake) => ({ data: { path: ["brake"], equals: brake } })) },
        select: { id: true },
      });
      if (said) return;
      await postMessage(prisma, {
        roomId: room.id,
        userId: room.userId,
        authorKind: "system",
        kind: "status",
        body:
          decision.brake === "duplicate" || decision.brake === "cycle"
            ? room.kind === "task"
              ? "Paused here: the nodes kept saying the same thing to each other. Ask the node that made this helper to continue."
              : "Nodes paused here: they kept saying the same thing to each other. Mention a node to continue."
            : room.kind === "task"
              ? "Paused here: this went too deep. Ask the node that made this helper to continue."
              : decision.brake === "streak"
                ? "Nodes paused here: too many node messages in a row. Mention a node to continue."
                : "Nodes paused this thread: it went too deep. Mention a node to continue.",
        data: { brake: decision.brake } as Prisma.InputJsonObject,
        visibleTo: message.visibleTo,
      });
      return;
    }
    // The owner's mention resumes a paused node in a crew even when the lead answers: the lead's plan may need it.
    if (room.kind === "crew" && message.authorKind === "human") {
      for (const row of members) if (row.node && row.node.status === "paused" && mentioned.has(row.node.id) && row.node.userId === message.userId) await resumeNode(app, row.node);
    }
    // Independent views (node/groups.ts): each node named answers from the room as it is now, by a deadline; then one brings the answers together.
    const round: ((nodeId: string) => RoundTurn) | null =
      decision.reason !== "none" && decision.independent && targets.length > 1 && !operationId ? await startRound(app, message, targets.map((target) => target.nodeId), decision.independent.synthesizerId) : null;
    for (const target of targets) {
      const node = members.find((row) => row.nodeId === target.nodeId)?.node;
      if (node?.status === "paused" && wakes(node)) await resumeNode(app, node);
      const note = [target.note, steerNote].filter(Boolean).join("\n") || null;
      turnIds.push(await queueTurn(app, { nodeId: target.nodeId, roomId: room.id, reason: decision.reason, triggerMessageId: message.id, private: target.private, audience: target.audience, note, operationId, ...(round ? round(target.nodeId) : {}) }));
    }
  } finally {
    // Each woken node's turn: the one it got, or the queued one the message joined; null when it did not take one.
    const woken = record.choice.woken.map((row, index) => ({ ...row, turnId: turnIds[index] ?? null }));
    const only = woken.length === 1 ? woken[0]! : null;
    await recordDecision(app, { userId: message.userId, nodeId: only?.nodeId ?? null, turnId: only?.turnId ?? null, kind: "route", configVersion: heuristicsVersion(heuristics), inputs: record.inputs, choice: { ...record.choice, woken } });
  }
}

/** Back to work: by the owner's Resume, or by their message to it. Its pages and lists refresh. */
export async function resumeNode(app: FastifyInstance, node: { id: string; userId: string }): Promise<boolean> {
  const resumed = await app.prisma.nodeAgent.updateMany({ where: { id: node.id, status: "paused" }, data: { status: "active" } });
  if (resumed.count) publishTo([node.userId], "node.room", { nodeId: node.id, status: "active" });
  return resumed.count > 0;
}
