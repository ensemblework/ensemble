/**
 * Group modes (docs/35 §4.2). A crew or a room with other people works `coordinated` (the default: one node
 * answers a person's message, in a crew its lead, which hands parts to the others through a plan) or
 * `independent`, set on the room (`settings.mode`, PATCH /api/node/rooms/:id).
 *
 * Independent views: a person's message that names several nodes is answered by each of them on its own,
 * from the room as it was when it was asked (`node_turns.snapshot_seq`): a sibling's answer is not shown to
 * a node before its own, and its read cursor stops before them, so its next turn reads them as new. The
 * round is written on the message (`data.independent`: the nodes, who brings the answers together, the
 * deadline). Once every one of them answered (or could not), or the deadline passed, one node brings the
 * answers together in a `synthesis` turn, once (`synthesis:<message id>`): the router chose it (node/router.ts:
 * the crew's lead, in a room its steward, else the author's own lead, else the first node named).
 */
import type { FastifyInstance } from "fastify";
import type { NodeMessage, NodeRoom, NodeTurn } from "@prisma/client";
import { roomSettings, updateMessageData } from "./store.js";
import { queueTurn } from "./queue.js";
import { activeHeuristics } from "./heuristics.js";

export const GROUP_MODES = ["independent", "coordinated"] as const;
export type GroupMode = (typeof GROUP_MODES)[number];

/** The room's group mode: only a crew or a room with other people has one other than `coordinated`. */
export function groupMode(room: Pick<NodeRoom, "kind" | "settings">): GroupMode {
  if (room.kind !== "crew" && room.kind !== "room") return "coordinated";
  return roomSettings(room).mode === "independent" ? "independent" : "coordinated";
}

export type IndependentRound = { nodeIds: string[]; synthesizerId: string | null; deadlineAt: string };

/** The independent round a message started, from its data. */
export function independentRound(message: Pick<NodeMessage, "data"> | null): IndependentRound | null {
  const raw = (message?.data as { independent?: unknown } | null)?.independent;
  if (!raw || typeof raw !== "object") return null;
  const round = raw as Record<string, unknown>;
  const nodeIds = Array.isArray(round.nodeIds) ? round.nodeIds.filter((id): id is string => typeof id === "string") : [];
  if (!nodeIds.length || typeof round.deadlineAt !== "string") return null;
  return { nodeIds, synthesizerId: typeof round.synthesizerId === "string" ? round.synthesizerId : null, deadlineAt: round.deadlineAt };
}

/** The turn fields of an independent answer: it reads the room up to the message, and answers by the deadline. */
export type RoundTurn = { snapshotSeq: number; deadlineAt: Date; operationId: string };

/**
 * Starts a round for a message (node/queue.ts `dispatchMessage`, before its turns are queued): writes it on the
 * message and sets the deadline's timer. Returns each answering node's turn fields.
 */
export async function startRound(app: FastifyInstance, message: NodeMessage, nodeIds: readonly string[], synthesizerId: string | null): Promise<(nodeId: string) => RoundTurn> {
  const deadlineAt = new Date(Date.now() + activeHeuristics(app.log).groups.independentDeadlineSeconds * 1000);
  await updateMessageData(app.prisma, message, { independent: { nodeIds: [...nodeIds], synthesizerId, deadlineAt: deadlineAt.toISOString() } });
  closeAt(app, message.id, deadlineAt);
  return (nodeId) => ({ snapshotSeq: message.seq, deadlineAt, operationId: `independent:${message.id}:${nodeId}` });
}

const timers = new Map<string, NodeJS.Timeout>();

function closeAt(app: FastifyInstance, messageId: string, at: Date): void {
  clearTimeout(timers.get(messageId));
  const timer = setTimeout(() => {
    timers.delete(messageId);
    void closeRound(app, messageId, "deadline").catch((error: unknown) => app.log.warn({ err: error, messageId }, "Could not close an independent round"));
  }, Math.max(0, at.getTime() - Date.now()));
  timer.unref?.();
  timers.set(messageId, timer);
}

/** Shutdown and tests: no deadline fires any more. */
export function forgetRounds(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

/** The round's answering turns (every attempt and resume carries its snapshot). */
function roundTurns(app: FastifyInstance, messageId: string) {
  return app.prisma.nodeTurn.findMany({ where: { triggerMessageId: messageId, snapshotSeq: { not: null } }, select: { nodeId: true, status: true, outcome: true } });
}

/** An independent answer ended (node/queue.ts): when none of the round is left to run, the answers are brought together. */
export async function roundTurnEnded(app: FastifyInstance, turn: Pick<NodeTurn, "snapshotSeq" | "triggerMessageId">): Promise<void> {
  if (turn.snapshotSeq === null || !turn.triggerMessageId) return;
  const turns = await roundTurns(app, turn.triggerMessageId);
  if (turns.some((row) => row.status === "queued" || row.status === "running")) return;
  await closeRound(app, turn.triggerMessageId, "answered");
}

/**
 * The answers are brought together, once: the synthesizer's turn, with who answered and who did not. Returns
 * its turn id, or null when the round has nobody to do it (its author reads the answers).
 */
export async function closeRound(app: FastifyInstance, messageId: string, why: "answered" | "deadline"): Promise<string | null> {
  clearTimeout(timers.get(messageId));
  timers.delete(messageId);
  const prisma = app.prisma;
  const message = await prisma.nodeMessage.findUnique({ where: { id: messageId } });
  const round = independentRound(message);
  if (!message || !round?.synthesizerId) return null;
  const members = await prisma.nodeRoomMember.findMany({ where: { roomId: message.roomId, nodeId: { in: round.nodeIds } }, select: { nodeId: true, handle: true } });
  const handle = (nodeId: string) => `@${members.find((row) => row.nodeId === nodeId)?.handle ?? "a node"}`;
  const turns = await roundTurns(app, messageId);
  const answered = round.nodeIds.filter((nodeId) => turns.some((row) => row.nodeId === nodeId && row.outcome === "done"));
  const missing = round.nodeIds.filter((nodeId) => !answered.includes(nodeId));
  const list = (ids: string[]) => ids.map(handle).join(", ");
  const room = await prisma.nodeRoom.findUnique({ where: { id: message.roomId }, select: { kind: true } });
  const author = message.userId === (await prisma.nodeAgent.findUnique({ where: { id: round.synthesizerId }, select: { userId: true } }))?.userId ? "your owner" : "the person who asked";
  const note = [
    `Independent views on #${message.seq}: ${answered.length ? `${list(answered)} answered it, each on their own` : "none of the nodes asked answered it"}${missing.length ? `; ${list(missing)} did not answer${why === "deadline" ? " in time" : ""}` : ""}.`,
    `Bring the answers together for ${author}: where they agree, where they differ (keep each disagreement and who holds it) and what is still unknown. Do not ask them again.`,
  ].join(" ");
  return queueTurn(app, {
    nodeId: round.synthesizerId,
    roomId: message.roomId,
    reason: "synthesis",
    triggerMessageId: message.id,
    private: message.visibleTo.length > 0,
    audience: room?.kind === "room" && message.visibleTo.length === 0 ? "room" : "owner",
    note,
    operationId: `synthesis:${message.id}`,
  });
}

/**
 * After a restart (node/queue.ts `recoverTurns`): a round whose answers are in or whose deadline passed is
 * brought together now; one still going gets its deadline's timer again.
 */
export async function recoverRounds(app: FastifyInstance, now = Date.now()): Promise<void> {
  const open = await app.prisma.nodeTurn.findMany({
    where: { snapshotSeq: { not: null }, triggerMessageId: { not: null }, deadlineAt: { gt: new Date(now - 24 * 3600_000) } },
    select: { triggerMessageId: true, deadlineAt: true },
    distinct: ["triggerMessageId"],
  });
  for (const row of open) {
    const messageId = row.triggerMessageId!;
    if (await app.prisma.nodeTurn.findUnique({ where: { operationId: `synthesis:${messageId}` }, select: { id: true } })) continue;
    const turns = await roundTurns(app, messageId);
    const going = turns.some((turn) => turn.status === "queued" || turn.status === "running");
    if (!going || (row.deadlineAt && row.deadlineAt.getTime() <= now)) await closeRound(app, messageId, going ? "deadline" : "answered");
    else if (row.deadlineAt) closeAt(app, messageId, row.deadlineAt);
  }
}
