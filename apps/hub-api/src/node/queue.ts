/**
 * Node turns (docs/35 §5): who speaks after a message, and running their turns one at a time per
 * node and a few at a time per server. A queued turn for a node and thread takes in later
 * messages instead of queueing another. Turns are rows, so a restart finds what was waiting.
 */
import type { FastifyInstance } from "fastify";
import type { NodeMessage, NodeTurn, Prisma } from "@prisma/client";
import type { ModelTier } from "@ensemble/shared-types";
import { complete } from "../lib/runtime.js";
import { loadSettings } from "../lib/settings.js";
import { safePublicError, truncateText } from "../lib/text.js";
import { runNodeTurn } from "./brain.js";
import type { Mention } from "./mentions.js";
import { defaultChatModel } from "./model.js";
import { MAX_BOT_STREAK, botStreak, parseRelevance, relevancePrompt, whoSpeaks, type RelevanceCandidate, type RouteNode } from "./router.js";
import { publishTo } from "./events.js";
import { postMessage, roomSettings } from "./store.js";
import { planTurnEnded } from "./plans.js";

const PARALLEL = Math.max(1, Number(process.env.ENSEMBLE_NODE_PARALLEL ?? 4) || 4);
/** Queued turns older than this when the server starts are dropped, not run late. */
const STALE_MS = 60 * 60 * 1000;

let active = 0;
const waiting: Array<() => void> = [];
const chains = new Map<string, Promise<void>>();
const live = new Map<string, { controller: AbortController; nodeId: string; roomId: string | null; planId: string | null; planStep: string | null }>();

async function acquire(): Promise<void> {
  if (active < PARALLEL) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  waiting.shift()?.();
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
};

/** Rate-limited turns try again quietly this many times, this far apart. */
const RETRIES = 3;
const RETRY_MS = [8_000, 30_000, 90_000];

function tainted(message: Pick<NodeMessage, "userId" | "data"> | null, owner: string): boolean {
  return Boolean(message && (message.userId !== owner || (message.data as { fromNonOwner?: unknown } | null)?.fromNonOwner === true));
}

/** Queues a node's turn (or adds to the one already waiting there); false when the node is paused or gone. */
export async function enqueueTurn(app: FastifyInstance, request: TurnRequest): Promise<boolean> {
  const prisma = app.prisma;
  const node = await prisma.nodeAgent.findUnique({ where: { id: request.nodeId }, select: { userId: true, status: true } });
  if (!node || node.status !== "active") return false;
  const isPrivate = request.private ?? false;
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
    const note = [queued.note, request.note].filter(Boolean).join("\n") || null;
    await prisma.nodeTurn.update({
      where: { id: queued.id },
      data: { note, ...(keep || !request.triggerMessageId ? {} : { triggerMessageId: request.triggerMessageId, reason: request.reason }) },
    });
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
    },
  });
  schedule(app, turn);
  return true;
}

function schedule(app: FastifyInstance, turn: Pick<NodeTurn, "id" | "nodeId">): void {
  const previous = chains.get(turn.nodeId) ?? Promise.resolve();
  const next = previous.then(() => execute(app, turn.id));
  chains.set(turn.nodeId, next);
  void next.finally(() => {
    if (chains.get(turn.nodeId) === next) chains.delete(turn.nodeId);
  });
}

async function execute(app: FastifyInstance, turnId: string): Promise<void> {
  await acquire();
  const prisma = app.prisma;
  try {
    const claimed = await prisma.nodeTurn.updateMany({ where: { id: turnId, status: "queued" }, data: { status: "running" } });
    if (claimed.count !== 1) return;
    const turn = await prisma.nodeTurn.findUniqueOrThrow({ where: { id: turnId } });
    const controller = new AbortController();
    live.set(turnId, { controller, nodeId: turn.nodeId, roomId: turn.roomId, planId: turn.planId, planStep: turn.planStep });
    try {
      const outcome = await runNodeTurn(app, turn, { dispatch: (message) => dispatchMessage(app, message), signal: controller.signal });
      if (outcome.status === "retry") {
        // The model's rate limit: the same turn again a little later, without a message in the room.
        await prisma.nodeTurn.update({ where: { id: turnId }, data: { status: "failed", error: truncateText(outcome.error ?? "Rate limited.", 500), finishedAt: new Date() } });
        await retryLater(app, turn);
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
    release();
  }
}

/** Retries waiting for their time, with what ends their background work. */
const delayed = new Map<ReturnType<typeof setTimeout>, () => void>();
let retryDelays: readonly number[] = RETRY_MS;

export function setTurnRetryDelaysForTests(delays: readonly number[] | null): void {
  retryDelays = delays ?? RETRY_MS;
}

/** Runs a queued turn once its time comes (a retry's `runAfter`); counted as background work. */
function scheduleLater(app: FastifyInstance, turn: Pick<NodeTurn, "id" | "nodeId" | "runAfter">): void {
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

/** After a restart: a turn cut off mid-way is not run twice; recent queued ones run now. */
export async function recoverTurns(app: FastifyInstance): Promise<void> {
  const prisma = app.prisma;
  const now = Date.now();
  const stale = { status: "queued", createdAt: { lt: new Date(now - STALE_MS) } };
  // A plan's turn cut off here ends its part of the plan as blocked, so the plan goes on.
  const cut = await prisma.nodeTurn.findMany({ where: { planId: { not: null }, OR: [{ status: "running" }, stale] }, select: { planId: true, planStep: true } });
  await prisma.nodeTurn.updateMany({ where: { status: "running" }, data: { status: "failed", error: "Interrupted by a server restart.", finishedAt: new Date(now) } });
  await prisma.nodeTurn.updateMany({ where: stale, data: { status: "failed", error: "Too old to run after a restart.", finishedAt: new Date(now) } });
  for (const turn of cut) await planTurnEnded(app, turn, "Interrupted by a server restart.").catch((error: unknown) => app.log.error({ err: error }, "Could not settle a plan turn"));
  const queued = await prisma.nodeTurn.findMany({ where: { status: "queued" }, orderBy: { createdAt: "asc" }, select: { id: true, nodeId: true, runAfter: true } });
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

type Relevance = (input: { authorId: string; system: string; prompt: string }) => Promise<unknown>;
let relevanceForTests: Relevance | null = null;

export function setNodeRelevanceForTests(fn: Relevance | null): void {
  relevanceForTests = fn;
}

/** A small model call, paid by the message's author, picks which representatives answer. */
async function relevant(app: FastifyInstance, message: NodeMessage, candidates: RelevanceCandidate[]): Promise<string[]> {
  const prisma = app.prisma;
  const [author, recent] = await Promise.all([
    prisma.user.findUnique({ where: { id: message.userId }, select: { name: true, email: true } }),
    prisma.nodeMessage.findMany({ where: { roomId: message.roomId, seq: { lt: message.seq }, kind: "text", visibleTo: { isEmpty: true } }, orderBy: { seq: "desc" }, take: 6 }),
  ]);
  const { system, prompt } = relevancePrompt(
    message.body,
    author?.name?.trim() || author?.email.split("@")[0] || "someone",
    candidates,
    recent.reverse().map((row) => truncateText(row.body, 300)),
  );
  try {
    if (relevanceForTests) return parseRelevance(await relevanceForTests({ authorId: message.userId, system, prompt }), candidates);
    const settings = await loadSettings(prisma, message.userId);
    const model = defaultChatModel(settings);
    if (!model) return [];
    const easy = { provider: model.provider as ModelTier["provider"], model: model.model, effort: "default" as const };
    const answer = await complete({ userId: message.userId, settings: { ...settings, models: { ...settings.models, easy } }, tier: "easy", system, prompt, json: true, purpose: "Ensemble Node routing" });
    return parseRelevance(answer.json, candidates);
  } catch (error) {
    app.log.warn({ err: error }, "Node relevance routing failed; nobody answers");
    return [];
  }
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
    .map((row) => ({ id: row.node!.id, ownerId: row.node!.userId, active: row.node!.status === "active" || wakes(row.node!), representative: row.representative, role: row.node!.role }));
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
      visibleTo: message.visibleTo,
      mentions: (Array.isArray(message.mentions) ? message.mentions : []) as Mention[],
      botDepth: message.botDepth,
    },
    { kind: room.kind as "dm" | "crew" | "room" | "task", leadNodeIds: roomSettings(room).leadNodeIds },
    nodes,
    botStreak(recent),
  );
  let ids: string[] = decision.nodeIds;
  if (decision.reason === "relevance") {
    const owners = await prisma.user.findMany({ where: { id: { in: nodes.map((row) => row.ownerId) } }, select: { id: true, name: true, email: true } });
    const ownerName = new Map(owners.map((row) => [row.id, row.name?.trim() || row.email.split("@")[0]!]));
    const duties = roomSettings(room).responsibilities;
    const candidates = decision.candidates.map((id) => {
      const row = members.find((member) => member.nodeId === id)!;
      return { id, handle: row.handle, owner: ownerName.get(row.userId) ?? "someone", role: row.node!.role, focus: duties[row.userId] ?? "" };
    });
    ids = await relevant(app, message, candidates);
  }
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
  for (const nodeId of ids) {
    const node = members.find((row) => row.nodeId === nodeId)?.node;
    if (node?.status === "paused" && wakes(node)) await resumeNode(app, node);
    await enqueueTurn(app, { nodeId, roomId: room.id, reason: decision.reason, triggerMessageId: message.id, private: message.visibleTo.length > 0 });
  }
}

/** Back to work: by the owner's Resume, or by their message to it. Its pages and lists refresh. */
export async function resumeNode(app: FastifyInstance, node: { id: string; userId: string }): Promise<boolean> {
  const resumed = await app.prisma.nodeAgent.updateMany({ where: { id: node.id, status: "paused" }, data: { status: "active" } });
  if (resumed.count) publishTo([node.userId], "node.room", { nodeId: node.id, status: "active" });
  return resumed.count > 0;
}
