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
 */
import type { FastifyInstance } from "fastify";
import type { NodeMessage, NodeTurn, Prisma } from "@prisma/client";
import { safePublicError, truncateText } from "../lib/text.js";
import { runNodeTurn } from "./brain.js";
import type { Mention } from "./mentions.js";
import { MAX_BOT_STREAK, botStreak, whoSpeaks, type RouteNode, type RouteTarget } from "./router.js";
import { publishTo } from "./events.js";
import { postMessage, roomSettings } from "./store.js";
import { missionEnded, planTurnEnded } from "./plans.js";
import { postStatusCards } from "./status-cards.js";

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
type LiveTurn = { controller: AbortController; turnId: string; nodeId: string; roomId: string | null; planId: string | null; planStep: string | null; lane: string; acted: boolean };
const live = new Map<string, LiveTurn>();

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
};

/** Rate-limited turns try again quietly this many times, this far apart. */
const RETRIES = 3;
const RETRY_MS = [8_000, 30_000, 90_000];

function tainted(message: Pick<NodeMessage, "userId" | "data"> | null, owner: string): boolean {
  return Boolean(message && (message.userId !== owner || (message.data as { fromNonOwner?: unknown } | null)?.fromNonOwner === true));
}

/** Reasons a person's message wakes a node for (a new one of these may coalesce a turn that has not acted yet). */
const PERSON_REASONS = new Set(["dm", "mentioned", "lead", "relevance"]);

/** Queues a node's turn (or adds to the one already waiting in its lane); false when the node is paused or gone. */
export async function enqueueTurn(app: FastifyInstance, request: TurnRequest): Promise<boolean> {
  const prisma = app.prisma;
  const node = await prisma.nodeAgent.findUnique({ where: { id: request.nodeId }, select: { userId: true, status: true } });
  if (!node || node.status !== "active") return false;
  if (request.operationId && (await prisma.nodeTurn.findUnique({ where: { operationId: request.operationId }, select: { id: true } }))) return true;
  const isPrivate = request.private ?? false;
  const lane = laneFor({ roomId: request.roomId, private: isPrivate, planId: request.planId, planStep: request.planStep });
  // A plan's turns stay apart: a step's turn never takes in another step's or a chat's.
  const queued = await prisma.nodeTurn.findFirst({
    where: { nodeId: request.nodeId, roomId: request.roomId, status: "queued", private: isPrivate, planId: request.planId ?? null, planStep: request.planStep ?? null },
  });
  if (queued) {
    // The queued turn reads every new message anyway. It answers the newest one, unless the one it
    // holds came from someone other than the owner: that keeps the turn's writes held for approval.
    const [held, incoming] = await Promise.all(
      [queued.triggerMessageId, request.triggerMessageId].map((id) => (id ? prisma.nodeMessage.findUnique({ where: { id }, select: { userId: true, data: true } }) : null)),
    );
    const keep = tainted(held ?? null, node.userId) && !tainted(incoming ?? null, node.userId);
    const note = queued.note && request.note && queued.note.includes(request.note) ? queued.note : [queued.note, request.note].filter(Boolean).join("\n") || null;
    await prisma.nodeTurn.update({
      where: { id: queued.id },
      data: { note, ...(keep || !request.triggerMessageId ? {} : { triggerMessageId: request.triggerMessageId, reason: request.reason }) },
    });
    coalesce(request, lane, node.userId);
    return true;
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
    },
  });
  coalesce(request, lane, node.userId);
  schedule(app, turn);
  return true;
}

/**
 * A person's new message while the lane's conversation turn has not acted yet: that turn stops and
 * the queued one answers both messages. A turn that has acted finishes; the new message is next.
 */
function coalesce(request: TurnRequest, lane: string, _ownerId: string): void {
  if (isWorkLane(lane) || !request.triggerMessageId || !PERSON_REASONS.has(request.reason)) return;
  for (const entry of live.values()) {
    if (entry.nodeId === request.nodeId && entry.lane === lane && !entry.acted && !entry.planId) entry.controller.abort("coalesce");
  }
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
  const head = await prisma.nodeTurn.findUnique({ where: { id: turnId }, select: { lane: true, nodeId: true, planId: true, planStep: true } });
  if (!head) return;
  const work = isWorkLane(head.lane) || Boolean(head.planStep);
  const pool = work ? workPool : talkPool;
  const own = work ? nodePool(head.nodeId) : null;
  if (own) await own.acquire();
  await pool.acquire();
  try {
    const claimed = await prisma.nodeTurn.updateMany({ where: { id: turnId, status: "queued" }, data: { status: "running" } });
    if (claimed.count !== 1) return;
    const turn = await prisma.nodeTurn.findUniqueOrThrow({ where: { id: turnId } });
    const controller = new AbortController();
    const lane = turn.lane ?? laneFor(turn);
    live.set(turnId, { controller, turnId, nodeId: turn.nodeId, roomId: turn.roomId, planId: turn.planId, planStep: turn.planStep, lane, acted: Boolean(turn.sideEffectsAt) });
    try {
      const outcome = await runNodeTurn(app, turn, { dispatch: (message) => dispatchMessage(app, message), signal: controller.signal });
      if (outcome.status === "retry") {
        // The model's rate limit: the same turn again a little later, without a message in the room.
        await prisma.nodeTurn.update({ where: { id: turnId }, data: { status: "failed", error: truncateText(outcome.error ?? "Rate limited.", 500), finishedAt: new Date() } });
        await retryLater(app, turn);
        return;
      }
      if (outcome.status === "coalesced") {
        await prisma.nodeTurn.update({ where: { id: turnId }, data: { status: "done", error: "Merged into the next turn: a newer message came first.", finishedAt: new Date() } });
        return;
      }
      await prisma.nodeTurn.update({
        where: { id: turnId },
        data: {
          status: outcome.status === "failed" ? "failed" : "done",
          model: outcome.model ?? null,
          credits: outcome.credits ?? null,
          error: outcome.error ? truncateText(outcome.error, 500) : null,
          finishedAt: new Date(),
        },
      });
      if (outcome.status !== "done") await planTurnEnded(app, turn, outcome.error ? `Its node could not take its turn: ${truncateText(outcome.error, 300)}` : "Its node could not take its turn.");
    } finally {
      live.delete(turnId);
    }
  } catch (error) {
    app.log.error({ err: error, turnId }, "Node turn failed");
    const failed = await prisma.nodeTurn
      .update({ where: { id: turnId }, data: { status: "failed", error: truncateText(safePublicError(error), 500), finishedAt: new Date() } })
      .catch(() => null);
    if (failed) await planTurnEnded(app, failed, "Its node's turn failed.").catch((problem: unknown) => app.log.error({ err: problem }, "Could not settle a plan turn"));
  } finally {
    pool.release();
    own?.release();
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
      runAfter: new Date(Date.now() + retryDelays[Math.min(turn.attempt, retryDelays.length - 1)]!),
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
  const dropped = await app.prisma.nodeTurn.updateMany({ where, data: { status: "failed", error: "Stopped.", finishedAt: new Date() } });
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
    data: { status: "failed", error: "Stopped.", finishedAt: new Date() },
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
 * run twice but resumed, with a note of what it already did, so the work goes on instead of ending
 * blocked. Queued turns run now; old ones are dropped unless their mission still runs.
 */
export async function recoverTurns(app: FastifyInstance): Promise<void> {
  const prisma = app.prisma;
  const now = Date.now();
  const running = await prisma.nodeTurn.findMany({ where: { status: "running" } });
  for (const turn of running) {
    if (!turn.sideEffectsAt) {
      await prisma.nodeTurn.update({ where: { id: turn.id }, data: { status: "queued", receipts: [] as Prisma.InputJsonValue } });
      continue;
    }
    await prisma.nodeTurn.update({ where: { id: turn.id }, data: { status: "failed", error: "Interrupted by a server restart after it had acted.", finishedAt: new Date(now) } });
    const receipts = (Array.isArray(turn.receipts) ? (turn.receipts as Array<{ name?: string; state?: string; summary?: string | null }>) : [])
      .map((row) => `- ${row.name ?? "a tool"} (${row.state ?? "?"})${row.summary ? `: ${row.summary}` : ""}`)
      .join("\n");
    const note = [
      "Your previous turn was cut off by a server restart after it had started acting. Do not repeat what it already did: check first (node_sessions, the plan card, the workspace).",
      receipts ? `It ran:\n${receipts}` : "",
      turn.note ?? "",
    ].filter(Boolean).join("\n");
    const resumed = turn.roomId
      ? await enqueueTurn(app, { nodeId: turn.nodeId, roomId: turn.roomId, reason: turn.reason, triggerMessageId: turn.triggerMessageId, note, private: turn.private, planId: turn.planId, planStep: turn.planStep })
      : false;
    if (!resumed) await planTurnEnded(app, turn, "Interrupted by a server restart.").catch((error: unknown) => app.log.error({ err: error }, "Could not settle a plan turn"));
  }
  const old = await prisma.nodeTurn.findMany({ where: { status: "queued", createdAt: { lt: new Date(now - STALE_MS) } }, select: { id: true, planId: true, planStep: true } });
  const missions = await prisma.nodeMission.findMany({ where: { id: { in: [...new Set(old.map((row) => row.planId).filter((id): id is string => Boolean(id)))] } }, select: { id: true, status: true } });
  const liveMission = new Set(missions.filter((row) => !missionEnded(row.status)).map((row) => row.id));
  const drop = old.filter((row) => !row.planId || !liveMission.has(row.planId));
  if (drop.length) {
    await prisma.nodeTurn.updateMany({ where: { id: { in: drop.map((row) => row.id) } }, data: { status: "failed", error: "Too old to run after a restart.", finishedAt: new Date(now) } });
    for (const turn of drop) if (turn.planId) await planTurnEnded(app, turn, "Too old to run after a restart.").catch((error: unknown) => app.log.error({ err: error }, "Could not settle a plan turn"));
  }
  const queued = await prisma.nodeTurn.findMany({ where: { status: "queued" }, orderBy: { createdAt: "asc" }, select: { id: true, nodeId: true, runAfter: true, lane: true, roomId: true, private: true, planId: true, planStep: true } });
  for (const turn of queued) scheduleLater(app, turn);
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

/** Wakes the nodes that should answer a message. */
export async function dispatchMessage(app: FastifyInstance, message: NodeMessage): Promise<void> {
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
  const recent = await prisma.nodeMessage.findMany({
    where: { roomId: room.id, seq: { lte: message.seq }, ...(message.visibleTo.length ? {} : { visibleTo: { isEmpty: true } }) },
    orderBy: { seq: "desc" },
    take: MAX_BOT_STREAK + 4,
    select: { authorKind: true, kind: true },
  });
  const decision = whoSpeaks(
    {
      kind: message.kind,
      authorKind: message.authorKind as "human" | "node" | "system",
      authorNodeId: message.authorNodeId,
      authorId: message.userId,
      text: message.body,
      visibleTo: message.visibleTo,
      mentions: (Array.isArray(message.mentions) ? message.mentions : []) as Mention[],
      botDepth: message.botDepth,
    },
    { kind: room.kind as "dm" | "crew" | "room" | "task", leadNodeIds: roomSettings(room).leadNodeIds },
    nodes,
    botStreak(recent),
  );
  // `@leads status` in a room with other people: every person's status card, built by code (node/status-cards.ts).
  if (decision.reason === "status") return postStatusCards(app, room, message);
  const targets: RouteTarget[] = decision.reason === "none" ? [] : (decision.targets ?? decision.nodeIds.map((nodeId) => ({ nodeId, private: message.visibleTo.length > 0, audience: "owner" as const })));
  if (decision.reason === "none" && decision.brake) {
    // Said once: not again until a person writes here.
    const lastPerson = await prisma.nodeMessage.findFirst({ where: { roomId: room.id, authorKind: "human" }, orderBy: { seq: "desc" }, select: { seq: true } });
    const said = await prisma.nodeMessage.findFirst({
      where: { roomId: room.id, authorKind: "system", kind: "status", seq: { gt: lastPerson?.seq ?? 0 }, OR: [{ data: { path: ["brake"], equals: "streak" } }, { data: { path: ["brake"], equals: "depth" } }] },
      select: { id: true },
    });
    if (said) return;
    await postMessage(prisma, {
      roomId: room.id,
      userId: room.userId,
      authorKind: "system",
      kind: "status",
      body:
        room.kind === "task"
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
  for (const target of targets) {
    const node = members.find((row) => row.nodeId === target.nodeId)?.node;
    if (node?.status === "paused" && wakes(node)) await resumeNode(app, node);
    await enqueueTurn(app, { nodeId: target.nodeId, roomId: room.id, reason: decision.reason, triggerMessageId: message.id, private: target.private, audience: target.audience, note: target.note ?? null });
  }
}

/** Back to work: by the owner's Resume, or by their message to it. Its pages and lists refresh. */
export async function resumeNode(app: FastifyInstance, node: { id: string; userId: string }): Promise<boolean> {
  const resumed = await app.prisma.nodeAgent.updateMany({ where: { id: node.id, status: "paused" }, data: { status: "active" } });
  if (resumed.count) publishTo([node.userId], "node.room", { nodeId: node.id, status: "active" });
  return resumed.count > 0;
}
