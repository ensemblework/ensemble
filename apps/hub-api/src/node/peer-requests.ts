/**
 * Peer requests (docs/35 §12; extension §15): a question, share, review or work request from one person
 * in a room to another, through the other person's lead. A record, not a chat: a public card shows its
 * kind, who asked whom, the ask and its status, updated in place; the target owner also gets a private
 * card to accept, edit, decline or always accept requests like it. The requester sees status and public
 * answers; the target owner sees everything and decides.
 *
 *   - question, share: the target's lead answers in the room, within what the room may see (a
 *     room-bound turn, node/audience.ts); something private needs its owner first (node_ask_owner).
 *   - work, review: nothing runs before the target owner accepts. Accepting gives their lead one
 *     private turn in My crew to plan the work for them; the mission it makes carries `requestedBy`,
 *     `deliverTo` and its principals (`missionOriginFor`, called where node/plans.ts makes missions).
 *     When the mission ends, code (no model) marks the public card done with how it ended.
 *
 * Also here: what leaving a room takes away, and Share to room.
 */
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeMessage, NodePeerRequest, NodeRoom, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../assistant/types.js";
import { sseHub } from "../lib/sse.js";
import { truncateText } from "../lib/text.js";
import type { Decision } from "./approvals.js";
import { publishTo } from "./events.js";
import { missionEnded } from "./missions-core.js";
import { Constraints } from "./plan-contract.js";
import { loadPlan } from "./plans.js";
import { enqueueTurn, inBackground } from "./queue.js";
import { announce, personIn, postMessage, roomPeople, updateMessageData, type MessageKind } from "./store.js";
import { PEER_KINDS, awayNow, personRow, prefsOf, revokeTrustTo, trustFor, updatePrefs, type PeerKind } from "./trust.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const REQUEST_STATUSES = ["open", "answered", "awaiting_owner", "approved", "declined", "done", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
/** Not decided yet: the target can still answer, accept or decline. */
const UNDECIDED = ["open", "awaiting_owner"];
const WORK = new Set<string>(["work", "review"]);

export const Ref = z
  .object({
    kind: z.enum(["task", "page", "file", "link", "message"]),
    id: z.string().max(200).optional(),
    title: z.string().trim().min(1).max(200),
    url: z.string().url().max(2000).optional(),
  })
  .strict();
export const Candidate = z
  .object({
    repo: z.string().trim().max(300).optional(),
    commit: z.string().trim().regex(/^[0-9a-f]{7,64}$/i, "A commit is its hash: 7 to 64 hexadecimal characters.").optional(),
    url: z.string().url().max(2000).optional(),
  })
  .strict();
export type Candidate = z.infer<typeof Candidate>;
export const NewRequest = z
  .object({
    to: z.string().trim().min(1).max(80).describe("The person: their account id or handle, or their lead's handle."),
    kind: z.enum(PEER_KINDS),
    text: z.string().trim().min(1).max(4000),
    refs: z.array(Ref).max(10).optional(),
    candidate: Candidate.optional(),
  })
  .strict();

/** A refusal with its HTTP status. Not approvals.ts' ApprovalError: importing that module here would close an import cycle through sessions.ts. */
export class RequestError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409) {
    super(message);
  }
}
const fail = (message: string, status: 400 | 403 | 404 | 409) => new RequestError(message, status);

const nameOf = (row: { name: string | null; email: string } | null | undefined): string => row?.name?.trim() || row?.email.split("@")[0] || "Someone";

async function names(db: Db, ids: string[]): Promise<Map<string, string>> {
  const rows = await db.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, email: true } });
  return new Map(rows.map((row) => [row.id, nameOf(row)]));
}

/** A person's current lead in a room. */
async function leadOf(db: Db, roomId: string, accountId: string) {
  return db.nodeRoomMember.findFirst({ where: { roomId, userId: accountId, nodeId: { not: null }, representative: true }, include: { node: true } });
}

/** The person `to` names: an account id, a person's handle, or one of their nodes' handles. */
async function resolvePerson(db: Db, roomId: string, to: string): Promise<string | null> {
  const members = await db.nodeRoomMember.findMany({ where: { roomId }, select: { userId: true, nodeId: true, handle: true } });
  const raw = to.trim();
  const handle = raw.replace(/^@/, "").toLowerCase();
  const person = members.find((row) => !row.nodeId && (row.userId === raw || row.handle === handle));
  if (person) return person.userId;
  const node = members.find((row) => row.nodeId && row.handle === handle);
  return node && members.some((row) => !row.nodeId && row.userId === node.userId) ? node.userId : null;
}

const statusLine: Record<string, string> = {
  open: "Open",
  answered: "Answered",
  awaiting_owner: "Waiting for {to}",
  approved: "Accepted by {to}",
  declined: "Declined",
  done: "Done",
  cancelled: "Cancelled",
};

/** The public card: what everyone in the room may read about the request. */
async function cardView(db: Db, request: NodePeerRequest) {
  const who = await names(db, [request.fromAccountId, request.toAccountId]);
  const members = await db.nodeRoomMember.findMany({ where: { roomId: request.roomId, OR: [{ userId: { in: [request.fromAccountId, request.toAccountId] }, nodeId: null }, { nodeId: { in: [request.toNodeId, request.fromNodeId ?? ""] } }] } });
  const handle = (accountId: string) => members.find((row) => !row.nodeId && row.userId === accountId)?.handle ?? null;
  const nodeHandle = (nodeId: string | null) => (nodeId ? (members.find((row) => row.nodeId === nodeId)?.handle ?? null) : null);
  const from = { accountId: request.fromAccountId, name: who.get(request.fromAccountId) ?? "Someone", handle: handle(request.fromAccountId), nodeId: request.fromNodeId, nodeHandle: nodeHandle(request.fromNodeId) };
  const to = { accountId: request.toAccountId, name: who.get(request.toAccountId) ?? "Someone", handle: handle(request.toAccountId), leadNodeId: request.toNodeId, leadHandle: nodeHandle(request.toNodeId) };
  let outcome: string | null = null;
  let requirements: Array<{ text: string; status: string }> = [];
  if (request.status === "done" && request.missionId) {
    const plan = await loadPlan(db, request.missionId);
    if (plan) {
      outcome = plan.mission.status;
      requirements = plan.data.requirements.map((row) => ({ text: truncateText(row.text, 200), status: row.status }));
    }
  }
  const data = {
    type: "peer_request",
    requestId: request.id,
    kind: request.kind,
    status: request.status,
    text: request.text,
    refs: request.refs,
    candidate: request.candidate,
    from,
    to,
    answer: request.answer,
    outcome,
    requirements,
    updatedAt: request.updatedAt.toISOString(),
  };
  const state = (statusLine[request.status] ?? request.status).replace("{to}", to.name);
  const result = outcome ? ` (${outcome.replace(/_/g, " ")}${requirements.length ? `: ${requirements.map((row) => `${row.text} ${row.status}`).join("; ")}` : ""})` : "";
  const body = `${from.name} asked ${to.name} (${request.kind}): ${truncateText(request.text, 600)}\n${state}${result}${request.answer && request.status === "declined" ? `: ${request.answer}` : ""}`;
  return { data, body };
}

/** The request as one person sees it: the target owner sees everything, everyone else what the public card shows. */
export async function wireRequest(db: Db, request: NodePeerRequest, viewerId: string) {
  const { data } = await cardView(db, request);
  const target = viewerId === request.toAccountId;
  return {
    id: request.id,
    roomId: request.roomId,
    kind: request.kind,
    status: request.status,
    text: request.text,
    refs: request.refs,
    candidate: request.candidate,
    from: data.from,
    to: data.to,
    answer: request.answer,
    outcome: data.outcome,
    requirements: data.requirements,
    cardId: request.cardId,
    ...(target ? { ownerCardId: request.ownerCardId, missionId: request.missionId } : {}),
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
  };
}

const OWNER_CARD_STATUS: Record<string, string> = { approved: "accepted", done: "accepted", declined: "declined", cancelled: "cancelled", answered: "answered" };

/** Brings both cards up to date with the request, and tells the room's people to re-read (`node.request`, no content). */
export async function refreshCards(app: FastifyInstance, requestId: string, extra: Record<string, unknown> = {}): Promise<void> {
  const prisma = app.prisma;
  const request = await prisma.nodePeerRequest.findUnique({ where: { id: requestId } });
  if (!request) return;
  const card = request.cardId ? await prisma.nodeMessage.findUnique({ where: { id: request.cardId } }) : null;
  if (card) {
    const { data, body } = await cardView(prisma, request);
    await updateMessageData(prisma, card, { ...data, ...extra }, body);
  }
  const ownerCard = request.ownerCardId ? await prisma.nodeMessage.findUnique({ where: { id: request.ownerCardId } }) : null;
  const next = OWNER_CARD_STATUS[request.status];
  const now = (ownerCard?.data as { status?: unknown } | null)?.status;
  if (ownerCard && next && now !== next && now !== "expired") await updateMessageData(prisma, ownerCard, { status: next, text: request.text, ...(request.status === "declined" ? { note: request.answer } : {}) });
  publishTo(await roomPeople(prisma, request.roomId), "node.request", { roomId: request.roomId, requestId: request.id });
}

/** A request the target's lead turned into a question for its owner (or a draft waiting for them). */
export async function requestAwaiting(app: FastifyInstance, requestId: string): Promise<void> {
  const moved = await app.prisma.nodePeerRequest.updateMany({ where: { id: requestId, status: "open" }, data: { status: "awaiting_owner" } });
  if (moved.count) await refreshCards(app, requestId);
}

export async function requestDeclined(app: FastifyInstance, requestId: string, note: string | null): Promise<void> {
  const moved = await app.prisma.nodePeerRequest.updateMany({ where: { id: requestId, status: { in: UNDECIDED } }, data: { status: "declined", answer: note, decidedAt: new Date() } });
  if (moved.count) await refreshCards(app, requestId);
}

/** The target's lead answered a question or share: posted (answered), or drafted for its owner (waiting for them). */
export async function requestReplied(app: FastifyInstance, requestId: string, message: NodeMessage, drafted: boolean): Promise<void> {
  const request = await app.prisma.nodePeerRequest.findUnique({ where: { id: requestId } });
  if (!request || WORK.has(request.kind) || !UNDECIDED.includes(request.status)) return;
  if (drafted) return requestAwaiting(app, requestId);
  const moved = await app.prisma.nodePeerRequest.updateMany({
    where: { id: requestId, status: { in: UNDECIDED } },
    data: { status: "answered", answer: truncateText(message.body, 2000), decidedAt: new Date() },
  });
  if (moved.count) await refreshCards(app, requestId, { answerMessageId: message.id });
}

// ── making a request ──────────────────────────────────────────────────────────────────────────

export type NewRequestInput = z.infer<typeof NewRequest> & { room: NodeRoom; fromAccountId: string; fromNodeId?: string | null };

/** Records a request, posts its public card, and either asks the target owner (work, review) or wakes their lead (question, share). */
export async function createPeerRequest(app: FastifyInstance, input: NewRequestInput): Promise<NodePeerRequest> {
  const prisma = app.prisma;
  const { room } = input;
  if (room.kind !== "room") throw fail("Requests are between people in a room.", 400);
  if (!(await personIn(prisma, room.id, input.fromAccountId))) throw fail("That room is not available.", 404);
  const to = await resolvePerson(prisma, room.id, input.to);
  if (!to) throw fail(`There is nobody called ${input.to} in this room.`, 404);
  if (to === input.fromAccountId) throw fail("That is you: ask your own nodes in My crew.", 400);
  const lead = await leadOf(prisma, room.id, to);
  if (!lead?.nodeId) throw fail("They have no lead in this room to take requests.", 409);
  if (input.kind === "review" && !input.candidate?.commit && !input.candidate?.url) throw fail("A review needs the exact candidate: a commit (with its repository) or a URL.", 400);
  const request = await prisma.nodePeerRequest.create({
    data: {
      roomId: room.id,
      fromAccountId: input.fromAccountId,
      fromNodeId: input.fromNodeId ?? null,
      toAccountId: to,
      toNodeId: lead.nodeId,
      kind: input.kind,
      text: input.text.trim(),
      refs: (input.refs ?? []) as Prisma.InputJsonValue,
      ...(input.candidate ? { candidate: input.candidate as Prisma.InputJsonValue } : {}),
      status: WORK.has(input.kind) ? "awaiting_owner" : "open",
    },
  });
  const { data, body } = await cardView(prisma, request);
  // "request" is a card kind of its own (not in store.ts's MessageKind): it never wakes a node, like every card.
  const { message: card } = await postMessage(prisma, { roomId: room.id, userId: input.fromAccountId, authorKind: "system", kind: "request" as unknown as MessageKind, body, data });
  await prisma.nodePeerRequest.update({ where: { id: request.id }, data: { cardId: card.id } });
  if (WORK.has(input.kind)) {
    const target = await personRow(prisma, room.id, to);
    const prefs = prefsOf(target);
    const trust = trustFor(prefs, input.fromAccountId);
    // Work its owner chose to accept from this person starts at once, unless they are away: then it waits for them.
    if (trust.workRequests === "accept" && trust.acceptKinds.includes(input.kind) && !awayNow(prefs)) {
      await prisma.nodePeerRequest.update({ where: { id: request.id }, data: { status: "approved", decidedAt: new Date() } });
      const fresh = (await prisma.nodePeerRequest.findUnique({ where: { id: request.id } }))!;
      await postMessage(prisma, {
        roomId: room.id,
        userId: to,
        authorKind: "system",
        kind: "status",
        body: `Accepted ${data.from.name}'s ${input.kind} request at once, as you set: “${truncateText(fresh.text, 300)}”. @${lead.handle} plans it in My crew.`,
        data: { requestId: request.id },
        visibleTo: [to],
      });
      await startAccepted(app, fresh, lead.node!);
    } else {
      await ownerCard(app, request, lead.node!, data.from.name);
    }
  } else {
    await askLead(app, request, lead.node!, data.from.name, card);
  }
  await refreshCards(app, request.id);
  return (await prisma.nodePeerRequest.findUnique({ where: { id: request.id } }))!;
}

/** The target owner's private card: who asks, what, which of their nodes would do it, and that it uses their computer and credits. */
async function ownerCard(app: FastifyInstance, request: NodePeerRequest, lead: NodeAgent, fromName: string): Promise<void> {
  const prisma = app.prisma;
  const nodes = await prisma.nodeRoomMember.findMany({ where: { roomId: request.roomId, userId: request.toAccountId, nodeId: { not: null } }, include: { node: { select: { name: true, role: true } } } });
  const candidate = request.candidate as Candidate | null;
  const pinned = candidate ? [candidate.repo, candidate.commit ? `at ${candidate.commit}` : "", candidate.url].filter(Boolean).join(" ") : "";
  const { message } = await postMessage(prisma, {
    roomId: request.roomId,
    userId: request.toAccountId,
    authorKind: "node",
    authorNodeId: lead.id,
    kind: "approval",
    body: `${fromName} asks for ${request.kind === "review" ? "a review" : "work"}: “${truncateText(request.text, 600)}”${pinned ? ` (candidate: ${pinned})` : ""}. Accept, edit or decline.`,
    data: {
      type: "peer_request",
      status: "pending",
      requestId: request.id,
      kind: request.kind,
      text: request.text,
      refs: request.refs,
      candidate: request.candidate,
      from: { accountId: request.fromAccountId, name: fromName },
      nodes: nodes.filter((row) => row.node).map((row) => ({ handle: row.handle, name: row.node!.name, role: row.node!.role, lead: row.representative })),
      cost: "If you accept, your lead plans it with your nodes, on your computer and your subscriptions and credits.",
    },
    visibleTo: [request.toAccountId],
  });
  await prisma.nodePeerRequest.update({ where: { id: request.id }, data: { ownerCardId: message.id } });
}

/** A question or share: the target's lead answers in the room, as a room-bound turn. */
async function askLead(app: FastifyInstance, request: NodePeerRequest, lead: NodeAgent, fromName: string, card: NodeMessage): Promise<void> {
  const operationId = `request:${request.id}:answer`;
  const refs = refsLine(request);
  const queued = await enqueueTurn(app, {
    nodeId: lead.id,
    roomId: request.roomId,
    reason: "request",
    triggerMessageId: card.id,
    private: false,
    audience: "room",
    operationId,
    note:
      `${fromName} asks your owner (${request.kind === "share" ? "to share something" : "a question"}): “${request.text}”${refs}. ` +
      "Answer it in the room for your owner, with only what this room may see (their status card, items they marked shareable, the room's space). If it needs something private, use node_ask_owner.",
  });
  if (queued) await app.prisma.nodeTurn.updateMany({ where: { operationId, peerRequestId: null }, data: { peerRequestId: request.id } });
}

function refsLine(request: Pick<NodePeerRequest, "refs">): string {
  const refs = Array.isArray(request.refs) ? (request.refs as Array<{ kind?: string; title?: string; url?: string; id?: string }>) : [];
  return refs.length ? ` (about: ${refs.map((row) => `${row.title ?? row.id ?? row.kind}${row.url ? ` <${row.url}>` : ""}`).join("; ")})` : "";
}

function candidateLine(candidate: Candidate | null): string {
  if (!candidate) return "";
  return [candidate.repo ? `repository ${candidate.repo}` : "", candidate.commit ? `at commit ${candidate.commit}` : "", candidate.url ? `URL ${candidate.url}` : ""].filter(Boolean).join(", ");
}

/**
 * Accepted work: one private turn of the target's lead in My crew, to plan it for its owner. The turn
 * carries the request, so the mission it makes records who asked and where the result goes.
 */
async function startAccepted(app: FastifyInstance, request: NodePeerRequest, lead: Pick<NodeAgent, "id">): Promise<void> {
  const prisma = app.prisma;
  const who = await names(prisma, [request.fromAccountId]);
  const from = who.get(request.fromAccountId) ?? "Someone";
  const room = await prisma.nodeRoom.findUnique({ where: { id: request.roomId }, select: { title: true } });
  const candidate = request.candidate as Candidate | null;
  const note =
    request.kind === "review"
      ? `Your owner accepted ${from}'s request in “${room?.title ?? "the room"}” for a review: “${request.text}”${refsLine(request)}. The candidate: ${candidateLine(candidate)}. ` +
        "Plan it now with node_plan for your owner, on their computer: a verify step that checks out exactly that candidate in a fresh clone, with no secrets in its environment, sandboxed, with network only for what the checks need, and reports pass or fail with each check. Fix nothing: the repair stays with the person who asked. The mission's constraints carry this. " +
        "When it ends, the request's card in the room shows how it ended; your detailed report stays here with your owner."
      : `Your owner accepted ${from}'s request in “${room?.title ?? "the room"}” for work: “${request.text}”${refsLine(request)}. ` +
        "Plan it now with node_plan for your owner (their nodes, their computer, their credits). When it ends, the request's card in the room shows how it ended; your detailed report stays here with your owner, who can share it to the room.";
  const operationId = `request:${request.id}:accepted`;
  const queued = await enqueueTurn(app, { nodeId: lead.id, roomId: request.roomId, reason: "request", private: true, audience: "owner", operationId, note });
  if (!queued) return;
  const principals = { data: request.toAccountId, billing: request.toAccountId, executionDevice: request.toAccountId, approver: request.toAccountId, requestedBy: request.fromAccountId } as Prisma.InputJsonValue;
  const made = await prisma.nodeTurn.updateMany({ where: { operationId, peerRequestId: null }, data: { peerRequestId: request.id, principals } });
  if (!made.count) {
    // The note joined a turn already waiting in My crew: that turn plans it.
    await prisma.nodeTurn.updateMany({ where: { nodeId: lead.id, roomId: request.roomId, private: true, status: "queued", planId: null, peerRequestId: null }, data: { peerRequestId: request.id, principals } });
  }
}

async function liveRequest(app: FastifyInstance, accountId: string, requestId: string): Promise<NodePeerRequest> {
  const request = await app.prisma.nodePeerRequest.findUnique({ where: { id: requestId } });
  if (!request || !(await personIn(app.prisma, request.roomId, accountId)) || (request.toAccountId !== accountId && request.fromAccountId !== accountId)) throw fail("That request is not available.", 404);
  return request;
}

/** The target owner accepts work or a review (optionally edited first, optionally always from this person). */
export async function acceptRequest(app: FastifyInstance, accountId: string, requestId: string, input: { text?: string; always?: boolean }): Promise<NodePeerRequest> {
  const prisma = app.prisma;
  const request = await liveRequest(app, accountId, requestId);
  if (request.toAccountId !== accountId) throw fail("Only the person it is for can accept it.", 404);
  if (!WORK.has(request.kind)) throw fail("Your lead answers questions; there is nothing to accept.", 400);
  if (!UNDECIDED.includes(request.status)) throw fail("That request was already settled.", 409);
  // Every delivery checks again that the person who asked is still here.
  if (!(await personIn(prisma, request.roomId, request.fromAccountId))) {
    await prisma.nodePeerRequest.updateMany({ where: { id: request.id, status: { in: UNDECIDED } }, data: { status: "cancelled", answer: "They left the room.", decidedAt: new Date() } });
    await refreshCards(app, request.id);
    throw fail("They have left the room, so the request is cancelled.", 409);
  }
  const lead = await leadOf(prisma, request.roomId, accountId);
  if (!lead?.node) throw fail("You have no lead in this room to plan it.", 409);
  if (lead.node.status !== "active") throw fail(`@${lead.handle} is paused. Resume it, then accept.`, 409);
  const text = input.text?.trim();
  const claimed = await prisma.nodePeerRequest.updateMany({
    where: { id: request.id, status: { in: UNDECIDED } },
    data: { status: "approved", decidedAt: new Date(), toNodeId: lead.node.id, ...(text ? { text: truncateText(text, 4000) } : {}) },
  });
  if (!claimed.count) throw fail("That request was already settled.", 409);
  if (input.always) {
    const me = await personRow(prisma, request.roomId, accountId);
    if (me) {
      await updatePrefs(prisma, me.id, (prefs) => {
        const current = prefs.trust?.people?.[request.fromAccountId] ?? {};
        const kinds = [...new Set([...(current.acceptKinds ?? []), request.kind as PeerKind])];
        return { ...prefs, trust: { everyone: prefs.trust?.everyone ?? {}, people: { ...(prefs.trust?.people ?? {}), [request.fromAccountId]: { ...current, workRequests: "accept", acceptKinds: kinds } } } };
      });
    }
  }
  const fresh = (await prisma.nodePeerRequest.findUnique({ where: { id: request.id } }))!;
  await startAccepted(app, fresh, lead.node);
  await refreshCards(app, request.id);
  return fresh;
}

/** The target owner declines, with an optional note the room sees on the card. */
export async function declineRequest(app: FastifyInstance, accountId: string, requestId: string, input: { note?: string }): Promise<NodePeerRequest> {
  const request = await liveRequest(app, accountId, requestId);
  if (request.toAccountId !== accountId) throw fail("Only the person it is for can decline it.", 404);
  const declined = await app.prisma.nodePeerRequest.updateMany({
    where: { id: request.id, status: { in: UNDECIDED } },
    data: { status: "declined", answer: input.note?.trim() ? truncateText(input.note.trim(), 1000) : null, decidedAt: new Date() },
  });
  if (!declined.count) throw fail("That request was already settled.", 409);
  await refreshCards(app, request.id);
  return (await app.prisma.nodePeerRequest.findUnique({ where: { id: request.id } }))!;
}

/** The requester takes back a request nobody has decided on yet. */
export async function cancelRequest(app: FastifyInstance, accountId: string, requestId: string): Promise<NodePeerRequest> {
  const request = await liveRequest(app, accountId, requestId);
  if (request.fromAccountId !== accountId) throw fail("Only the person who asked can cancel it.", 404);
  const cancelled = await app.prisma.nodePeerRequest.updateMany({ where: { id: request.id, status: { in: UNDECIDED } }, data: { status: "cancelled", decidedAt: new Date() } });
  if (!cancelled.count) throw fail("That request was already settled.", 409);
  await refreshCards(app, request.id);
  return (await app.prisma.nodePeerRequest.findUnique({ where: { id: request.id } }))!;
}

/** The target owner's private card, answered through Needs me (`POST /api/node/approvals/:id`): approve accepts, discard declines. */
export async function settlePeerCard(app: FastifyInstance, card: NodeMessage, node: NodeAgent, input: Decision): Promise<NodeMessage> {
  const requestId = (card.data as { requestId?: unknown } | null)?.requestId;
  if (typeof requestId !== "string") throw fail("That card is not available.", 404);
  if ((card.data as { status?: unknown }).status !== "pending") throw fail("This was already settled.", 409);
  if (input.decision === "approve") await acceptRequest(app, node.userId, requestId, { ...(input.body ? { text: input.body } : {}) });
  else await declineRequest(app, node.userId, requestId, {});
  return (await app.prisma.nodeMessage.findUnique({ where: { id: card.id } }))!;
}

/** The node tool: record a request. In a room-bound turn, for someone asking this node's owner; in My crew, the owner's own, to someone else. */
export function peerRequestTool(input: { node: NodeAgent; room: NodeRoom; askerId: string }): AnyHubTool {
  const { node, room, askerId } = input;
  const forOwner = askerId !== node.userId;
  return defineTool({
    name: "node_peer_request",
    area: "context",
    description: forOwner
      ? "Record a request for work or a review from the person who asked, for your owner to decide. Nothing runs until your owner accepts. Then tell them in a line that it waits for your owner."
      : "Ask another person in this room something, through their lead, for your owner: a question, a share (an artefact), a review of your owner's candidate (a commit or URL), or work. It is attributed to your owner and shows as a card in the room.",
    input: z.object({
      kind: z.enum(PEER_KINDS),
      text: z.string().trim().min(1).max(4000).describe("The request, standing alone."),
      to: z.string().trim().max(80).optional().describe(forOwner ? "Leave out: it is for your owner." : "The person: their handle or their lead's handle."),
      refs: z.array(Ref).max(10).optional(),
      candidate: Candidate.optional().describe("For a review: the repository and exact commit, or a URL."),
    }).strict(),
    isWrite: false,
    risk: "low",
    async run(ctx, value) {
      if (forOwner && !WORK.has(value.kind)) throw new ToolBlockedError("Answer questions yourself, within what this room may see; ask your owner (node_ask_owner) for anything private.");
      if (forOwner && value.to && (await resolvePerson(ctx.prisma, room.id, value.to)) !== node.userId) throw new ToolBlockedError("You record requests for your owner only. Other people's leads answer for them.");
      if (!forOwner && !value.to) throw new ToolBlockedError("Name who it is for (their handle, or their lead's).");
      try {
        const request = await createPeerRequest(ctx.app, {
          room,
          fromAccountId: askerId,
          fromNodeId: forOwner ? null : node.id,
          to: forOwner ? node.userId : value.to!,
          kind: value.kind,
          text: value.text,
          ...(value.refs ? { refs: value.refs } : {}),
          ...(value.candidate ? { candidate: value.candidate } : {}),
        });
        return toolOk(
          request.status === "approved"
            ? "Recorded and accepted at once (your owner's setting); it is planned in their My crew."
            : WORK.has(request.kind)
              ? `Recorded: it waits for ${forOwner ? "your owner" : "them"} to accept or decline. Say so in a line; promise nothing.`
              : "Recorded: their lead answers it in the room.",
          { request: request.id, status: request.status },
        );
      } catch (error) {
        if (error instanceof RequestError) throw new ToolBlockedError(error.message);
        throw error;
      }
    },
  });
}

// ── missions made for a request ─────────────────────────────────────────────────────────────

export type MissionOrigin = {
  requestedBy?: Prisma.InputJsonValue;
  deliverTo?: Prisma.InputJsonValue;
  principals?: Prisma.InputJsonValue;
  constraints?: Prisma.InputJsonValue;
};

/** A review's rules, written into the mission's constraints so every step's note carries them. */
function reviewConstraints(base: Constraints, candidate: Candidate | null): Constraints {
  const notes = [
    `Review candidate: ${candidateLine(candidate)}. Use a fresh clone at exactly that commit (or that URL as it is); change nothing in it.`,
    "No secrets in the environment; run sandboxed, with network only for what the checks need.",
    "Report pass or fail with each check (node_step_report); the repair stays with the person who asked.",
  ];
  const merged = {
    ...base,
    ...(candidate?.repo ? { repos: [...new Set([...(base.repos ?? []), candidate.repo])].slice(0, 10) } : {}),
    publish: "none" as const,
    notes: [...notes, ...(base.notes ?? [])].slice(0, 12).map((note) => truncateText(note, 500)),
  };
  const parsed = Constraints.safeParse(merged);
  return parsed.success ? parsed.data : { publish: "none", notes };
}

/**
 * What a new mission records when the lead's turn that makes it plans an accepted request: who asked,
 * where the result goes, its principals, and for a review the candidate in its constraints. Empty
 * for every other mission. Called where node/plans.ts creates missions.
 */
export async function missionOriginFor(db: Db, turnId: string, constraints?: Constraints): Promise<MissionOrigin> {
  const turn = await db.nodeTurn.findUnique({ where: { id: turnId.split(":")[0]! }, select: { peerRequestId: true, operationId: true, userId: true } }).catch(() => null);
  const requestId = turn?.peerRequestId ?? /^request:([0-9a-f-]{36}):accepted$/.exec(turn?.operationId ?? "")?.[1];
  if (!turn || !requestId) return {};
  const request = await db.nodePeerRequest.findUnique({ where: { id: requestId } });
  if (!request || request.status !== "approved" || request.toAccountId !== turn.userId || !WORK.has(request.kind)) return {};
  const owner = request.toAccountId;
  const candidate = request.candidate as Candidate | null;
  return {
    requestedBy: { accountId: request.fromAccountId, nodeId: request.fromNodeId, roomId: request.roomId, requestId: request.id, kind: request.kind, ...(candidate ? { candidate } : {}) },
    deliverTo: { roomId: request.roomId, audience: "room" },
    principals: { data: owner, billing: owner, executionDevice: owner, approver: owner },
    ...(request.kind === "review" ? { constraints: reviewConstraints(constraints ?? {}, candidate) as Prisma.InputJsonValue } : {}),
  };
}

/** A mission linked to a request: links it, and when it has ended marks the public card done (code, no model). */
export async function missionDelivered(app: FastifyInstance, missionId: string): Promise<void> {
  const prisma = app.prisma;
  const mission = await prisma.nodeMission.findUnique({ where: { id: missionId }, select: { id: true, status: true, requestedBy: true } });
  const requestId = (mission?.requestedBy as { requestId?: unknown } | null)?.requestId;
  if (!mission || typeof requestId !== "string") return;
  const request = await prisma.nodePeerRequest.findUnique({ where: { id: requestId } });
  if (!request || request.status !== "approved") return;
  if (!request.missionId) await prisma.nodePeerRequest.updateMany({ where: { id: request.id, missionId: null }, data: { missionId: mission.id } });
  if (!missionEnded(mission.status)) return;
  // Delivery checks again that both people are still in the room.
  const here = (await personIn(prisma, request.roomId, request.toAccountId)) && (await personIn(prisma, request.roomId, request.fromAccountId));
  const plan = await loadPlan(prisma, mission.id);
  const requirements = plan?.data.requirements ?? [];
  const line = `${mission.status.replace(/_/g, " ")}${requirements.length ? `: ${requirements.map((row) => `${row.text} (${row.status})`).join("; ")}` : ""}`;
  const done = await prisma.nodePeerRequest.updateMany({
    where: { id: request.id, status: "approved" },
    data: here ? { status: "done", missionId: mission.id, answer: truncateText(line, 2000) } : { status: "cancelled", missionId: mission.id, answer: "They left the room." },
  });
  if (done.count) await refreshCards(app, request.id);
}

/** Requests whose missions ended while nobody was listening (a restart): settled on a sweep. */
export async function syncPeerMissions(app: FastifyInstance): Promise<void> {
  const open = await app.prisma.nodePeerRequest.findMany({ where: { status: "approved" }, orderBy: { updatedAt: "asc" }, take: 100, select: { id: true, missionId: true } });
  for (const request of open) {
    const mission = request.missionId
      ? { id: request.missionId }
      : await app.prisma.nodeMission.findFirst({ where: { requestedBy: { path: ["requestId"], equals: request.id } }, orderBy: { createdAt: "desc" }, select: { id: true } });
    if (mission) await missionDelivered(app, mission.id);
  }
}

let watching = false;

/** Follows plan cards as they change: a mission made for a request is linked, and settled when it ends. */
export function watchPeerMissions(app: FastifyInstance): void {
  if (watching) return;
  watching = true;
  sseHub.onFrame(({ frame }) => {
    if (frame.event !== "node.message.updated" && frame.event !== "node.message") return;
    const message = frame.data as { id?: unknown; kind?: unknown } | null;
    if (message?.kind !== "plan" || typeof message.id !== "string") return;
    inBackground(app, () => missionDelivered(app, message.id as string));
  });
  const sweep = setInterval(() => inBackground(app, () => syncPeerMissions(app)), 60_000);
  sweep.unref?.();
  app.addHook("onClose", async () => clearInterval(sweep));
}

// ── leaving a room ──────────────────────────────────────────────────────────────────────────

export type Revoked = { requests: string[]; cards: string[] };

/**
 * A person leaves a room (or is removed), in the same transaction as their membership: the trust others
 * gave them goes, their undecided requests (made or received) are cancelled, their nodes' queued
 * conversation turns here are dropped (plan turns are stopped by the caller, which settles their plans),
 * and pending cards for them or about them here expire.
 */
export async function revokeOnLeave(tx: Prisma.TransactionClient, roomId: string, accountId: string): Promise<Revoked> {
  await revokeTrustTo(tx, roomId, accountId);
  const open = await tx.nodePeerRequest.findMany({ where: { roomId, status: { in: UNDECIDED }, OR: [{ fromAccountId: accountId }, { toAccountId: accountId }] }, select: { id: true } });
  const ids = open.map((row) => row.id);
  if (ids.length) await tx.nodePeerRequest.updateMany({ where: { id: { in: ids } }, data: { status: "cancelled", answer: "Cancelled: they left the room.", decidedAt: new Date() } });
  await tx.nodeTurn.updateMany({ where: { roomId, userId: accountId, status: "queued", planId: null }, data: { status: "failed", error: "Its owner left the room.", finishedAt: new Date() } });
  const cards = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE node_messages SET data = data || jsonb_build_object('status', 'expired', 'why', 'They left the room.')
    WHERE room_id = ${roomId} AND kind = 'approval' AND data->>'status' = 'pending'
      AND (${accountId} = ANY(visible_to) OR data->'asker'->>'accountId' = ${accountId} OR data->'from'->>'accountId' = ${accountId} OR data->>'requestId' = ANY(${ids}::text[]))
    RETURNING id`;
  return { requests: ids, cards: cards.map((row) => row.id) };
}

/** After the leave committed: the changed cards reach the people still there, and Needs me updates. */
export async function afterLeave(app: FastifyInstance, revoked: Revoked): Promise<void> {
  for (const id of revoked.requests) await refreshCards(app, id);
  const cards = revoked.cards.length ? await app.prisma.nodeMessage.findMany({ where: { id: { in: revoked.cards } } }) : [];
  for (const card of cards) {
    await announce(app.prisma, card, "node.message.updated");
    sseHub.publish(card.userId, { event: "approval", data: { source: "node", id: card.id } });
  }
}

// ── share to room ───────────────────────────────────────────────────────────────────────────

/**
 * Share to room: the owner publishes one of their own private messages, or their own node's private
 * reply, in the room, as themselves or through their lead. The copy points at the original and wakes nobody.
 */
export async function shareMessage(app: FastifyInstance, accountId: string, messageId: string, as: "me" | "lead"): Promise<NodeMessage> {
  const prisma = app.prisma;
  const original = await prisma.nodeMessage.findUnique({ where: { id: messageId } });
  if (!original || !(await personIn(prisma, original.roomId, accountId)) || !original.visibleTo.includes(accountId)) throw fail("That message is not available.", 404);
  const room = await prisma.nodeRoom.findUnique({ where: { id: original.roomId } });
  if (!room || room.archivedAt || room.kind !== "room") throw fail("Share to room is for rooms with other people.", 400);
  const mine = original.visibleTo.length === 1 && original.userId === accountId && (original.authorKind === "human" || original.authorKind === "node");
  if (!mine || original.kind !== "text" || (original.data as { deleted?: unknown } | null)?.deleted) throw fail("You can share only your own private messages and your own nodes' private replies.", 403);
  const lead = as === "lead" ? await leadOf(prisma, room.id, accountId) : null;
  if (as === "lead" && !lead?.nodeId) throw fail("You have no lead in this room.", 409);
  const source = (original.data ?? {}) as { refs?: unknown; files?: unknown };
  const { message } = await postMessage(prisma, {
    roomId: room.id,
    userId: accountId,
    authorKind: as === "lead" ? "node" : "human",
    authorNodeId: lead?.nodeId ?? null,
    body: original.body,
    data: {
      sharedFrom: { id: original.id, seq: original.seq, authorKind: original.authorKind, authorNodeId: original.authorNodeId },
      ...(as === "lead" ? { sharedBy: accountId } : {}),
      ...(Array.isArray(source.refs) ? { refs: source.refs } : {}),
      ...(Array.isArray(source.files) ? { files: source.files } : {}),
    },
    clientId: `share:${original.id}:${as}`,
  });
  return message;
}
