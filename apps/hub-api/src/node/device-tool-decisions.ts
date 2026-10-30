/**
 * The owner's answers for a node's tools on their computer (B9, plan §10.5). When the computer says a
 * call needs the owner (the first use of a folder, or of a web address when the owner asks before
 * browsing), one question asks, with Once, This mission and Always for this folder; another call for
 * the same folder in the same conversation or plan while it waits does not ask again. The question is
 * an inline card in the chat where the node is talking (`data.type: "computer"`, owner only), and an
 * Ensemble decision behind it, so the Hub, the phone and `ensemble needs` can answer it too; any answer
 * updates the card.
 *
 * The node's tool call waits in its turn for the answer (`awaitAnswer`), then makes the call again with
 * it. When the owner does not answer in time, the turn parks on the question, and the answer wakes each
 * conversation or step parked on it (`watchDecision`), with the exact call to make again. The answer
 * reaches the computer with the node's next call there (the computer keeps "this mission" and "always"
 * as its own rules).
 */
import { EventEmitter } from "node:events";
import type { AgentDecision, NodeMessage, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { decisionBus, WORK_ENDED } from "../lib/decisions.js";
import { appendLedger } from "../lib/ledger.js";
import { nodeWebOrigin } from "../lib/node-origin.js";
import { sseHub } from "../lib/sse.js";
import type { NodeToolAsk, NodeToolGrant } from "../remote/contract.js";
import { publishTo } from "./events.js";
import { enqueueTurn, waitingForOwner } from "./queue.js";
import { postMessage, updateMessageDataIf } from "./store.js";

/** `agent_decisions.tool_name` of these questions. */
export const NODE_TOOL_DECISION = "Computer tools";
/** `data.type` of the inline card. */
export const COMPUTER_CARD = "computer";
/** A question from work the owner started waits for them; it goes stale after this. */
const WAIT_DAYS = 30;
/** How long a tool call waits in its turn for the owner's answer before the turn parks. */
const PERMISSION_WAIT_MS = 180_000;
/** While a call waits, the question is read again this often (an answer given to another process). */
const WAIT_RECHECK_MS = 3_000;

export const CHOICES = { once: "Once", mission: "This mission", folder: "Always for this folder", origin: "Always for this address" } as const;

/** How long a tool call waits for its owner's answer (`ENSEMBLE_NODE_PERMISSION_WAIT_MS`). */
export function permissionWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ENSEMBLE_NODE_PERMISSION_WAIT_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : PERMISSION_WAIT_MS;
}

/** The owner's first name (or their email's name), as a node's notes name them. */
export async function ownerName(prisma: Pick<PrismaClient, "user">, userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  return user?.name?.trim().split(/\s+/)[0] || user?.email.split("@")[0] || "your owner";
}

type Waiting = { turnId: string; ownerId: string; nodeId: string; roomId: string; private: boolean; threadRootId: string | null };

/**
 * A tool call waits in its turn for the owner's answer on a card: the node shows as waiting for them
 * (`node.status` "waiting", with the card), and its turn gives its slot back meanwhile (queue.ts).
 */
export async function waitForOwner<T>(where: Waiting, cardId: string, wait: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const frame = { roomId: where.roomId, nodeId: where.nodeId, private: where.private, threadRootId: where.threadRootId };
  publishTo([where.ownerId], "node.status", { ...frame, state: "waiting", cardId });
  try {
    return await waitingForOwner(where.turnId, wait);
  } finally {
    publishTo([where.ownerId], "node.status", { ...frame, state: "thinking" });
  }
}

export type NodeToolCard = {
  nodeId: string;
  nodeSlug: string;
  roomId: string;
  private: boolean;
  planId: string | null;
  planStep: string | null;
  mission: string;
  deviceId: string;
  deviceName: string;
  capability: NodeToolAsk["capability"];
  target: string;
  label: string;
  scope: NodeToolAsk["scope"];
  /** The conversations and steps whose turn parked waiting on this question: its answer wakes each (absent on older questions: the one that asked). */
  parked?: ParkedLane[];
  /** The computer has used the answer (it keeps "this mission" and "always" itself). */
  delivered: boolean;
  /** The node heard the answer. */
  announced: boolean;
};

/** A conversation (a room's shared or private thread) or a plan step whose turn parked on a question, with the exact call it makes again. */
export type ParkedLane = { roomId: string; private: boolean; planId: string | null; planStep: string | null; retry: string | null };

export const laneKey = (lane: Pick<ParkedLane, "roomId" | "private" | "planId" | "planStep">): string => `${lane.roomId}|${lane.private ? "p" : "s"}|${lane.planId ?? ""}|${lane.planStep ?? ""}`;

type Detail = { nodeTool?: NodeToolCard; options?: string[]; command?: string | null } & Record<string, unknown>;

const detailOf = (row: Pick<AgentDecision, "detail">): Detail => (row.detail && typeof row.detail === "object" && !Array.isArray(row.detail) ? (row.detail as Detail) : {});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the card's answer covers: once, the mission, or always (the folder or the address). */
export function grantScope(row: Pick<AgentDecision, "decision" | "reason" | "detail">): NodeToolGrant["scope"] | null {
  if (row.decision !== "allow") return null;
  const reason = (row.reason ?? "").trim();
  if (reason === CHOICES.mission) return "mission";
  if (reason === CHOICES.folder || reason === CHOICES.origin) return "always";
  return "once";
}

const VERBS: Record<NodeToolAsk["capability"], string> = { run: "run commands", git: "read git", files: "change files", http: "call", browse: "browse", read: "share files" };

/** The card's question: what the node wants to do, where, on which computer. */
function title(card: Pick<NodeToolCard, "nodeSlug" | "capability" | "label" | "scope" | "deviceName">): string {
  if (card.scope === "origin" && card.capability === "browse") return `@${card.nodeSlug} wants to open ${card.label} in the Ensemble browser on ${card.deviceName}`;
  if (card.scope === "origin") return `@${card.nodeSlug} wants to call ${card.label} on ${card.deviceName}`;
  return `@${card.nodeSlug} wants to ${VERBS[card.capability]} in ${card.label} on ${card.deviceName}`;
}

/** Where the node would act, in words: "in app on Mira's laptop", or the address. */
export function placeOf(card: Pick<NodeToolCard, "scope" | "label" | "deviceName">): string {
  return card.scope === "origin" ? `${card.label} on ${card.deviceName}` : `in ${card.label} on ${card.deviceName}`;
}

/**
 * Opens the question for this node, computer and folder (or address) in this conversation or plan, or
 * finds the one still waiting. Returns it and whether it is new; a new one is announced with
 * `noticeAsked` once its card is posted.
 */
export async function askOwner(app: Pick<FastifyInstance, "prisma">, owner: string, card: Omit<NodeToolCard, "delivered" | "announced" | "parked">, call: string, weak: boolean): Promise<{ row: AgentDecision; created: boolean }> {
  const prisma = app.prisma;
  const waiting = await prisma.agentDecision.findMany({ where: { userId: owner, toolName: NODE_TOOL_DECISION, status: "pending" }, orderBy: { requestedAt: "asc" }, take: 200 });
  const same = waiting.find((row) => {
    const known = detailOf(row).nodeTool;
    // Within one conversation or plan: "This mission" means the same there for every call it covers.
    return known && known.nodeId === card.nodeId && known.deviceId === card.deviceId && known.target === card.target && known.mission === card.mission;
  });
  if (same) return { row: same, created: false };
  // Where the computer's sandbox is weak, "always" would not cover commands there: it is not offered.
  const options = [CHOICES.once, CHOICES.mission, ...(weak ? [] : [card.scope === "origin" ? CHOICES.origin : CHOICES.folder])];
  const row = await prisma.agentDecision.create({
    data: {
      userId: owner,
      source: "ensemble",
      event: "question",
      toolName: NODE_TOOL_DECISION,
      title: title(card),
      cwd: card.scope === "folder" ? card.label : null,
      detail: {
        options,
        allowCustom: false,
        recommended: null,
        command: call.slice(0, 2000),
        header: weak ? "This computer's sandbox is weak, so commands ask once per mission" : null,
        nodeTool: { ...card, parked: [], delivered: false, announced: false },
      } as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + WAIT_DAYS * 86_400_000),
    },
  });
  return { row, created: true };
}

/** A new question reaches the owner: a notification that opens its card in the Node chat (or Needs me), Needs me everywhere, the ledger. */
export async function noticeAsked(app: Pick<FastifyInstance, "prisma">, row: AgentDecision, roomId: string, cardId: string | null): Promise<void> {
  const card = detailOf(row).nodeTool;
  const origin = nodeWebOrigin();
  const url = origin ? `${origin}/r/${roomId}${cardId ? `#m-${cardId}` : ""}` : "/needs-me";
  await app.prisma.notification.create({ data: { userId: row.userId, kind: "decision", title: row.title.slice(0, 200), body: card?.label ?? "", urgent: true, url } });
  sseHub.publish(row.userId, { event: "decision", data: { id: row.id, status: "pending", title: row.title, source: "ensemble", runnerAccountId: null } });
  await appendLedger({ userId: row.userId, actor: "agent", action: "node.tool.asked", payload: { nodeId: card?.nodeId ?? null, deviceId: card?.deviceId ?? null, capability: card?.capability ?? null, target: card?.label ?? null } });
}

type CardInput = {
  node: { id: string; slug: string; userId: string };
  roomId: string;
  private: boolean;
  rootMessageId: string | null;
  botDepth?: number;
  /** What the node tried, in a line ("Run: npm test"). */
  call: string;
  planId: string | null;
  planStep: string | null;
};

const cardWhere = (decisionId: string): Prisma.NodeMessageWhereInput => ({ kind: "approval", AND: [{ data: { path: ["type"], equals: COMPUTER_CARD } }, { data: { path: ["decisionId"], equals: decisionId } }] });

/**
 * The question's card in this conversation: owner only, with the node's call and the answers it offers.
 * One card per question and room; a later call that waits on it renames what it tried.
 */
export async function computerCard(app: Pick<FastifyInstance, "prisma">, row: AgentDecision, input: CardInput): Promise<NodeMessage> {
  const prisma = app.prisma as PrismaClient;
  const tool = detailOf(row).nodeTool;
  const existing = await prisma.nodeMessage.findFirst({ where: { roomId: input.roomId, userId: input.node.userId, ...cardWhere(row.id) }, orderBy: { createdAt: "desc" } });
  if (existing) {
    const data = existing.data as { status?: unknown; call?: unknown };
    if (data.status === "pending" && data.call !== input.call) return (await updateMessageDataIf(prisma, existing, { data: { path: ["status"], equals: "pending" } }, { call: input.call.slice(0, 500) })) ?? existing;
    return existing;
  }
  const options = Array.isArray(detailOf(row).options) ? detailOf(row).options! : [CHOICES.once, CHOICES.mission];
  const { message } = await postMessage(prisma, {
    roomId: input.roomId,
    userId: input.node.userId,
    authorKind: "node",
    authorNodeId: input.node.id,
    kind: "approval",
    body: row.title,
    data: {
      type: COMPUTER_CARD,
      status: row.status === "pending" ? "pending" : statusOf(row),
      decisionId: row.id,
      capability: tool?.capability ?? null,
      label: tool?.label ?? null,
      scope: tool?.scope ?? null,
      deviceName: tool?.deviceName ?? null,
      call: input.call.slice(0, 500),
      options,
      answer: null,
      answeredAt: null,
      private: input.private,
      // The step waits for this answer; it is not nudged or ended meanwhile.
      ...(input.planId && input.planStep ? { plan: { id: input.planId, step: input.planStep } } : {}),
    },
    visibleTo: [input.node.userId],
    rootMessageId: input.rootMessageId,
    ...(input.botDepth !== undefined ? { botDepth: input.botDepth } : {}),
  });
  return message;
}

/** A closed question's card status: allowed, denied or expired. */
function statusOf(row: Pick<AgentDecision, "status" | "decision">): "allowed" | "denied" | "expired" {
  if (row.status !== "decided") return "expired";
  return row.decision === "allow" ? "allowed" : "denied";
}

/** The answer as the card shows it: the option chosen, or No. */
function answerOf(row: AgentDecision): string | null {
  const scope = grantScope(row);
  if (row.status !== "decided") return null;
  if (!scope) return "No";
  if (scope === "mission") return CHOICES.mission;
  if (scope === "always") return detailOf(row).nodeTool?.scope === "origin" ? CHOICES.origin : CHOICES.folder;
  return CHOICES.once;
}

/** Every card of an answered question says how it was answered (the room hears the change). */
export async function settleComputerCards(app: Pick<FastifyInstance, "prisma">, row: AgentDecision): Promise<void> {
  if (row.status === "pending") return;
  const prisma = app.prisma as PrismaClient;
  const cards = await prisma.nodeMessage.findMany({ where: { userId: row.userId, ...cardWhere(row.id) } });
  const patch = { status: statusOf(row), answer: answerOf(row), answeredAt: (row.decidedAt ?? new Date()).toISOString() };
  for (const card of cards) {
    if ((card.data as { status?: unknown }).status !== "pending") continue;
    await updateMessageDataIf(prisma, card, { data: { path: ["status"], equals: "pending" } }, patch);
  }
}

/**
 * A card's work ended (its plan step closed it): that step no longer waits on the question, and the
 * question closes unless another conversation or step is parked on it, so nobody answers it for work
 * that is over.
 */
export async function closeComputerQuestion(app: Pick<FastifyInstance, "prisma">, card: Pick<NodeMessage, "data">): Promise<void> {
  const data = card.data as { type?: unknown; decisionId?: unknown; plan?: { id?: unknown; step?: unknown } } | null;
  if (data?.type !== COMPUTER_CARD || typeof data.decisionId !== "string") return;
  const ended = (lane: ParkedLane) => lane.planId === data.plan?.id && lane.planStep === data.plan?.step;
  await changeRecord(app.prisma, data.decisionId, (tool) => (tool.parked?.some(ended) ? { ...tool, parked: tool.parked.filter((lane) => !ended(lane)) } : null));
  const row = await app.prisma.agentDecision.findUnique({ where: { id: data.decisionId } });
  if (!row || row.status !== "pending" || detailOf(row).nodeTool?.parked?.length) return;
  const closed = await app.prisma.agentDecision.updateMany({ where: { id: data.decisionId, toolName: NODE_TOOL_DECISION, status: "pending" }, data: { status: "expired", reason: WORK_ENDED, decidedAt: new Date() } });
  if (closed.count) decisionBus.emit(data.decisionId);
}

/** The owner's answers for this node on this computer that the computer has not used yet. */
export async function pendingGrants(prisma: Pick<PrismaClient, "agentDecision">, owner: string, nodeId: string, deviceId: string): Promise<NodeToolGrant[]> {
  const rows = await prisma.agentDecision.findMany({
    where: { userId: owner, toolName: NODE_TOOL_DECISION, status: "decided", decision: "allow", decidedAt: { gte: new Date(Date.now() - WAIT_DAYS * 86_400_000) } },
    orderBy: { decidedAt: "asc" },
    take: 200,
  });
  const grants: NodeToolGrant[] = [];
  for (const row of rows) {
    const card = detailOf(row).nodeTool;
    const scope = grantScope(row);
    if (!card || !scope || card.delivered || card.nodeId !== nodeId || card.deviceId !== deviceId) continue;
    grants.push({ id: row.id, scope, target: card.target });
  }
  return grants.slice(-20);
}

/**
 * Changes a question's node-tool record: `change` gets it as read and returns the new one, or null for
 * no change. A compare-and-set on the whole record, tried again when another change came first.
 */
async function changeRecord(prisma: Pick<PrismaClient, "agentDecision">, id: string, change: (tool: NodeToolCard) => NodeToolCard | null): Promise<NodeToolCard | null> {
  for (let tries = 0; tries < 8; tries += 1) {
    const row = await prisma.agentDecision.findUnique({ where: { id } });
    const detail = row ? detailOf(row) : null;
    const next = detail?.nodeTool ? change(detail.nodeTool) : null;
    if (!row || !next) return null;
    const changed = await prisma.agentDecision.updateMany({ where: { id, detail: { equals: row.detail as Prisma.InputJsonValue } }, data: { detail: { ...detail, nodeTool: next } as Prisma.InputJsonValue } });
    if (changed.count === 1) return next;
  }
  return null;
}

/** Sets a flag of a question's node-tool record, once: true when this call set it. */
async function markCard(prisma: Pick<PrismaClient, "agentDecision">, id: string, field: "delivered" | "announced"): Promise<boolean> {
  return Boolean(await changeRecord(prisma, id, (tool) => (tool[field] ? null : { ...tool, [field]: true })));
}

/** A turn parks on this question: its answer wakes that conversation or step with the call to make again. */
async function parkOn(prisma: Pick<PrismaClient, "agentDecision">, id: string, lane: ParkedLane): Promise<void> {
  await changeRecord(prisma, id, (tool) => ({ ...tool, parked: [...(tool.parked ?? []).filter((row) => laneKey(row) !== laneKey(lane)), lane].slice(-10) }));
}

/** The computer used these answers: they are not sent again. Grants that are not the owner's answers (a standing one for browsing) are not questions. */
export async function markGrantsUsed(prisma: Pick<PrismaClient, "agentDecision">, ids: readonly string[]): Promise<void> {
  for (const id of ids) if (UUID.test(id)) await markCard(prisma, id, "delivered");
}

/** Questions a tool call is waiting on in its turn, in this process: their answer is the call's to hear, not a new turn's. */
const heldInTurn = new Map<string, number>();
/** Says when a question is no longer held by a waiting call. */
const holds = new EventEmitter();
holds.setMaxListeners(0);

/** Resolves once no tool call in this process waits on this question. */
function released(id: string): Promise<void> {
  return new Promise((resolve) => {
    if (!heldInTurn.has(id)) return resolve();
    holds.once(id, () => resolve());
  });
}

/** Resolves when the decision bus says this question changed, after `ms`, or when `signal` aborts. */
function changed(id: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      decisionBus.off(id, done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    decisionBus.once(id, done);
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
}

/** Reads a question, closing it first when its time ran out. */
async function current(app: Pick<FastifyInstance, "prisma">, id: string): Promise<AgentDecision | null> {
  const row = await app.prisma.agentDecision.findUnique({ where: { id } });
  if (!row || row.status !== "pending" || row.expiresAt >= new Date()) return row;
  await app.prisma.agentDecision.updateMany({ where: { id, status: "pending" }, data: { status: "expired" } });
  return app.prisma.agentDecision.findUnique({ where: { id } });
}

/**
 * A tool call of the conversation or step `lane` waits for the owner's answer to this question, up to
 * `ms` or until `signal` ends the wait. The answered question (its cards updated, and the other
 * conversations parked on it woken); or null when the wait ended first: the lane is then parked on the
 * question, and its answer wakes it (`watchDecision`).
 */
export async function awaitAnswer(app: FastifyInstance, id: string, signal: AbortSignal, ms: number, lane: ParkedLane): Promise<AgentDecision | null> {
  heldInTurn.set(id, (heldInTurn.get(id) ?? 0) + 1);
  try {
    const deadline = Date.now() + ms;
    for (;;) {
      const row = await current(app, id);
      if (!row) return null;
      if (row.status !== "pending") {
        await answered(app, row, laneKey(lane));
        return row;
      }
      const left = deadline - Date.now();
      if (signal.aborted || left <= 0) break;
      await changed(id, Math.min(left, WAIT_RECHECK_MS), signal);
    }
    // Parked before the hold ends, so an answer from now on wakes this lane too; one that came meanwhile is heard here.
    await parkOn(app.prisma, id, lane);
    const last = await current(app, id);
    if (!last || last.status === "pending") return null;
    await answered(app, last, laneKey(lane));
    return last;
  } finally {
    const left = (heldInTurn.get(id) ?? 1) - 1;
    if (left > 0) heldInTurn.set(id, left);
    else {
      heldInTurn.delete(id);
      holds.emit(id);
    }
  }
}

/** The note that wakes a conversation or step parked on an answered question: the answer, and the call to make again. */
function wakeNote(row: AgentDecision, tool: NodeToolCard, again: string | null): string {
  const scope = grantScope(row);
  const where = placeOf(tool);
  if (row.status !== "decided") return `Your owner did not answer the card about your computer tools ${where}, and it closed. Go on without them, or ask again later if they are still needed.`;
  if (!scope) return `Your owner chose not to allow your computer tools ${where}. Go on without them, or say what cannot be done without them.`;
  return `Your owner allowed your computer tools ${where}${scope === "once" ? " for one call" : scope === "mission" ? " for this mission" : " from now on"}. Make this call again now${again ? `: ${again}` : "."}`;
}

/**
 * An answered question is heard, once: its cards say how, and each conversation or step parked on it
 * is woken with the call it makes again, except `except` (the one whose call heard it while waiting).
 */
async function answered(app: FastifyInstance, row: AgentDecision, except: string | null): Promise<void> {
  if (!(await markCard(app.prisma, row.id, "announced"))) return;
  await settleComputerCards(app, row);
  const fresh = (await app.prisma.agentDecision.findUnique({ where: { id: row.id } })) ?? row;
  const detail = detailOf(fresh);
  const tool = detail.nodeTool;
  if (!tool) return;
  // An older question (asked before turns parked on it) wakes the conversation that asked.
  const lanes: ParkedLane[] = tool.parked ?? [{ roomId: tool.roomId, private: tool.private, planId: tool.planId, planStep: tool.planStep, retry: detail.command ?? null }];
  for (const lane of lanes) {
    if (laneKey(lane) === except) continue;
    await enqueueTurn(app, { nodeId: tool.nodeId, roomId: lane.roomId, reason: "approval", note: wakeNote(row, tool, lane.retry), private: lane.private, ...(lane.planId ? { planId: lane.planId, planStep: lane.planStep } : {}) });
  }
}

const watching = new Set<string>();
/** Between answers seen on the bus, the question is read again this often (an answer from another process). */
const RECHECK_MS = 5 * 60_000;

/** Waits for the owner's answer in this process and then tells the node. A restart picks it up again (`recoverNodeToolDecisions`). */
export function watchDecision(app: FastifyInstance, id: string): void {
  if (watching.has(id)) return;
  watching.add(id);
  void (async () => {
    try {
      for (;;) {
        const row = await app.prisma.agentDecision.findUnique({ where: { id } });
        if (!row) return;
        if (row.status !== "pending") {
          // A call waiting in its turn hears it first; whatever it leaves is heard here after.
          if (heldInTurn.has(id)) {
            await released(id);
            continue;
          }
          return await answered(app, row, null);
        }
        if (row.expiresAt < new Date()) {
          await app.prisma.agentDecision.updateMany({ where: { id, status: "pending" }, data: { status: "expired" } });
          continue;
        }
        await changed(id, RECHECK_MS);
      }
    } catch (error) {
      app.log.warn({ err: error, decisionId: id }, "could not follow a node tool question");
    } finally {
      watching.delete(id);
    }
  })();
}

/** After a restart: follow the questions still waiting, and tell nodes about answers they missed. */
export async function recoverNodeToolDecisions(app: FastifyInstance): Promise<void> {
  const rows = await app.prisma.agentDecision.findMany({ where: { toolName: NODE_TOOL_DECISION, OR: [{ status: "pending" }, { decidedAt: { gte: new Date(Date.now() - 86_400_000) } }] }, take: 500 });
  for (const row of rows) {
    if (row.status === "pending") watchDecision(app, row.id);
    else if (!detailOf(row).nodeTool?.announced) await answered(app, row, null).catch(() => undefined);
  }
}
