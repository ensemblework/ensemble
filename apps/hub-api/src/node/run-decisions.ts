/**
 * A node's runs ask in the chat (docs/35 §8.6). When the agent of a run a node started (`node_runs.job_id`)
 * asks a question or a permission, Ensemble's decision for it (`agent_decisions`, the same as Needs me
 * answers) gets one card in the run card's conversation and thread, for the owner only
 * (`data.type: "run_decision"`). It is answered there through `POST /api/decisions/:id/decide`, like any
 * decision; the card follows every answer, from anywhere (the decision bus), its expiry and the run's
 * end. Ensemble's Hub leaves these decisions out of its Needs me and says how many wait in Node chats
 * instead (`GET /api/decisions?surface=hub`), where Ensemble Node has a site (`nodeWebOrigin`).
 */
import type { AgentDecision, NodeMessage, Prisma, PrismaClient } from "@prisma/client";
import { closeEndedWork, decisionBus, WORK_ENDED } from "../lib/decisions.js";
import { nodeWebOrigin } from "../lib/node-origin.js";
import { truncateText } from "../lib/text.js";
import { postMessage, updateMessageDataIf } from "./store.js";

/** `data.type` of the card. */
export const RUN_DECISION_CARD = "run_decision";
/** A node's own computer-tool question (node/device-tool-decisions.ts `COMPUTER_CARD`), named here so the device runtime that imports this stays light. */
const COMPUTER_CARD = "computer";
/** Between answers seen on the bus, a waiting decision is read again this often (an answer from another process, or its run's end). */
const RECHECK_MS = 60_000;

type Log = { warn: (obj: unknown, message?: string) => void };
/** What these need of the app: its database, and somewhere to say what went wrong. */
export type RunDecisionContext = { prisma: PrismaClient; log?: Log };

/** Who answered: the owner (on the card or anywhere Ensemble's decide route is used), the node (a question of fact it may answer, node/session-questions.ts), or the computer or the tool itself. */
export type AnsweredBy = "owner" | "node" | "elsewhere";

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

const waiting = (decisionId: string): Prisma.NodeMessageWhereInput => ({
  kind: "approval",
  AND: [{ data: { path: ["type"], equals: RUN_DECISION_CARD } }, { data: { path: ["decisionId"], equals: decisionId } }],
});

/** Answers the owner gave through the decide route in this process, until their cards say so (`ownerAnswering`). */
const byOwner = new Set<string>();

/** The decide route is answering this decision for its owner: its card says "owner", whoever updates it first. */
export function ownerAnswering(decisionId: string): () => void {
  byOwner.add(decisionId);
  return () => byOwner.delete(decisionId);
}

/** What a card shows of its decision now. */
function cardState(row: AgentDecision, by?: AnsweredBy): Record<string, unknown> {
  if (row.status === "pending") return { status: "pending" };
  if (row.status === "expired") return { status: row.reason === WORK_ENDED ? "closed" : "expired", answeredAt: null, answeredBy: null };
  const answeredAt = (row.decidedAt ?? new Date()).toISOString();
  // Answered in the tool's own window, before anyone answered here.
  if (row.status !== "decided") return { status: "answered", answer: null, decision: null, answeredAt, answeredBy: "elsewhere" };
  const node = record(row.detail).answeredBy ? "node" : null;
  return {
    status: "answered",
    answer: row.reason ?? null,
    decision: row.decision === "allow" ? "allow" : "deny",
    answeredAt,
    answeredBy: node ?? by ?? (byOwner.has(row.id) ? "owner" : "elsewhere"),
  };
}

/** Where a card opens on Ensemble Node's site, or null without one. */
export function cardUrl(card: Pick<NodeMessage, "id" | "roomId">): string | null {
  const origin = nodeWebOrigin();
  return origin ? `${origin}/r/${card.roomId}#m-${card.id}` : null;
}

/**
 * The card for a new decision of a node's run, in the run card's conversation and thread, for its
 * owner only; the same card again for a decision that has one. Null when no node follows the run (its
 * question stays on Needs me only). The card then follows the decision (`watchRunDecision`).
 */
export async function postRunDecisionCard(ctx: RunDecisionContext, row: AgentDecision): Promise<NodeMessage | null> {
  const { prisma } = ctx;
  if (row.source !== "ensemble" || !row.sessionId) return null;
  const detail = record(row.detail);
  const jobId = text(detail.jobId) ?? row.sessionId;
  const run = await prisma.nodeRun.findUnique({ where: { jobId }, select: { nodeId: true, roomId: true, userId: true, messageId: true, planId: true, planStep: true } });
  if (!run || run.userId !== row.userId) return null;
  const existing = await prisma.nodeMessage.findFirst({ where: { roomId: run.roomId, userId: run.userId, ...waiting(row.id) } });
  if (existing) return existing;
  const room = await prisma.nodeRoom.findUnique({ where: { id: run.roomId }, select: { archivedAt: true } });
  if (!room || room.archivedAt) return null;
  const runCard = run.messageId ? await prisma.nodeMessage.findUnique({ where: { id: run.messageId }, select: { body: true, data: true, rootMessageId: true, botDepth: true } }) : null;
  const runTitle = text(runCard?.body) ?? text(detail.taskTitle) ?? "the run";
  const event = row.event === "question" ? "question" : "permission";
  const tier = text(detail.tier);
  const { message } = await postMessage(prisma, {
    roomId: run.roomId,
    userId: run.userId,
    authorKind: "node",
    authorNodeId: run.nodeId,
    kind: "approval",
    body: truncateText(`${event === "question" ? "The run asks" : "The run asks to"} (${runTitle}): ${row.title}`, 600),
    data: {
      type: RUN_DECISION_CARD,
      status: "pending",
      decisionId: row.id,
      jobId,
      runTitle,
      event,
      title: row.title,
      command: text(detail.command),
      cwd: row.cwd,
      options: strings(detail.options),
      allowCustom: detail.allowCustom === true,
      recommended: text(detail.recommended),
      answer: null,
      decision: null,
      answeredAt: null,
      answeredBy: null,
      // Beyond C3's shape: which computer asks, whether an allow is confirmed first, and whether only that computer may answer it.
      computer: text(detail.deviceName),
      confirm: detail.confirm === true,
      computerOnly: tier === "run_branch_push" || tier === "high_risk",
      private: record(runCard?.data).private === true,
      // The step waits for this answer, as for its other cards.
      ...(run.planId && run.planStep ? { plan: { id: run.planId, step: run.planStep } } : {}),
    },
    visibleTo: [run.userId],
    rootMessageId: runCard?.rootMessageId ?? null,
    ...(runCard ? { botDepth: runCard.botDepth } : {}),
  });
  watchRunDecision(ctx, row.id);
  return message;
}

/** Every waiting card of a decision says how it ended. `by`: who answered, when the caller knows. */
export async function settleRunDecisionCards(ctx: RunDecisionContext, row: AgentDecision, by?: AnsweredBy): Promise<number> {
  if (row.status === "pending") return 0;
  const cards = await ctx.prisma.nodeMessage.findMany({ where: { userId: row.userId, ...waiting(row.id) } });
  let changed = 0;
  for (const card of cards) {
    if (record(card.data).status !== "pending") continue;
    if (await updateMessageDataIf(ctx.prisma, card, { data: { path: ["status"], equals: "pending" } }, cardState(row, by))) changed += 1;
  }
  return changed;
}

/** Resolves when the decision bus says this decision changed, or after `ms`. */
function changed(id: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      decisionBus.off(id, done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    decisionBus.once(id, done);
  });
}

const watching = new Set<string>();

/**
 * Follows a waiting decision in this process until it leaves pending (an answer from anywhere, its
 * expiry, its run's end), then its cards say so. A restart picks the waiting ones up again
 * (`recoverRunDecisions`).
 */
export function watchRunDecision(ctx: RunDecisionContext, id: string): void {
  if (watching.has(id)) return;
  watching.add(id);
  void (async () => {
    try {
      for (;;) {
        const row = await ctx.prisma.agentDecision.findUnique({ where: { id } });
        if (!row) return;
        if (row.status !== "pending") {
          await settleRunDecisionCards(ctx, row);
          return;
        }
        const left = row.expiresAt.getTime() - Date.now();
        if (left <= 0) {
          // Nobody answered in time: it closes, as the computer's own wait would close it.
          if ((await ctx.prisma.agentDecision.updateMany({ where: { id, status: "pending" }, data: { status: "expired" } })).count) decisionBus.emit(id);
          continue;
        }
        await changed(id, Math.min(left + 50, RECHECK_MS));
      }
    } catch (error) {
      ctx.log?.warn({ err: error, decisionId: id }, "could not follow a run's question in the chat");
    } finally {
      watching.delete(id);
    }
  })();
}

/** A node run ended: its requests close with it (as the database closes them) and their cards say so. */
export async function closeRunDecisions(ctx: RunDecisionContext, jobId: string): Promise<number> {
  const cards = await ctx.prisma.nodeMessage.findMany({ where: { kind: "approval", AND: [{ data: { path: ["type"], equals: RUN_DECISION_CARD } }, { data: { path: ["jobId"], equals: jobId } }, { data: { path: ["status"], equals: "pending" } }] } });
  if (!cards.length) return 0;
  await closeEndedWork(ctx.prisma, [jobId]);
  let closed = 0;
  for (const card of cards) {
    const decisionId = text(record(card.data).decisionId);
    const row = decisionId ? await ctx.prisma.agentDecision.findUnique({ where: { id: decisionId } }) : null;
    if (row && row.status !== "pending") {
      decisionBus.emit(row.id);
      closed += await settleRunDecisionCards(ctx, row);
      continue;
    }
    // Its decision is gone, or the run's end did not close it: the card closes with the run anyway.
    if (await updateMessageDataIf(ctx.prisma, card, { data: { path: ["status"], equals: "pending" } }, { status: "closed", answeredAt: null, answeredBy: null })) closed += 1;
  }
  return closed;
}

/** After a restart: follow the cards still waiting again, and close the ones whose decision ended meanwhile. */
export async function recoverRunDecisions(ctx: RunDecisionContext): Promise<void> {
  const cards = await ctx.prisma.nodeMessage.findMany({
    where: { kind: "approval", AND: [{ data: { path: ["type"], equals: RUN_DECISION_CARD } }, { data: { path: ["status"], equals: "pending" } }] },
    select: { data: true },
    take: 500,
  });
  for (const card of cards) {
    const decisionId = text(record(card.data).decisionId);
    if (decisionId) watchRunDecision(ctx, decisionId);
  }
}

/**
 * Decisions waiting on a card in a Node chat (a node's runs, and a node's own computer tools), which
 * the Hub's Needs me leaves out, and where to open them: the one chat they are in, or Node's activity.
 * Empty without a Node site: then the Hub lists them all.
 */
export async function nodeChatDecisions(prisma: Pick<PrismaClient, "nodeMessage">, userId: string): Promise<{ ids: Set<string>; url: string | null; rooms: Map<string, { roomId: string; cardId: string }> }> {
  const origin = nodeWebOrigin();
  if (!origin) return { ids: new Set(), url: null, rooms: new Map() };
  const cards = await prisma.nodeMessage.findMany({
    where: {
      userId,
      kind: "approval",
      visibleTo: { equals: [userId] },
      AND: [{ data: { path: ["status"], equals: "pending" } }, { OR: [{ data: { path: ["type"], equals: RUN_DECISION_CARD } }, { data: { path: ["type"], equals: COMPUTER_CARD } }] }],
    },
    select: { id: true, roomId: true, data: true },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  const rooms = new Map<string, { roomId: string; cardId: string }>();
  for (const card of cards) {
    const id = text(record(card.data).decisionId);
    if (id && !rooms.has(id)) rooms.set(id, { roomId: card.roomId, cardId: card.id });
  }
  return { ids: new Set(rooms.keys()), url: `${origin}/activity`, rooms };
}

/** The Hub's line for decisions waiting in Node chats: how many, and the chat to open (Node's activity when they are in several). */
export function nodeChatLine(waitingIds: readonly string[], chat: Awaited<ReturnType<typeof nodeChatDecisions>>): { count: number; url: string | null } {
  const places = waitingIds.map((id) => chat.rooms.get(id)).filter((place): place is { roomId: string; cardId: string } => Boolean(place));
  const roomIds = new Set(places.map((place) => place.roomId));
  const one = roomIds.size === 1 ? places[0]! : null;
  return { count: places.length, url: one ? cardUrl({ id: one.cardId, roomId: one.roomId }) : chat.url };
}
