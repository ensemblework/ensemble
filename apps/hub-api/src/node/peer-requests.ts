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
 *     When the mission ends, code (no model) marks the request done. How it went reaches the room only
 *     in what the target owner posts (node/room-results.ts).
 *
 * The public card shows what the requester wrote (text, refs, candidate), who asked whom and how it
 * stands, with a link to a public answer: never the target owner's words for their lead, their decline
 * note, or anything from the work. A request a lead drafts in My crew reaches the room only when its
 * owner sends it (`sendRequestDraft`).
 *
 * Also here: what leaving a room takes away, and Share to room.
 */
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeMessage, NodePeerRequest, NodeRoom, NodeTurn, Prisma, PrismaClient, Task } from "@prisma/client";
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
import { modeLine, proposeTask, requesterTask, roleIn, syncRequestTask } from "./room-space.js";
import { forgetPerson } from "./room-events.js";
import { dropStewardOf } from "./steward.js";
import { followMission, roomTaskOrigin, syncMissionResults } from "./room-results.js";
import { nodeSpace } from "./spaces.js";

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

/**
 * The public card: what everyone in the room may read about the request. Only what the requester wrote
 * (text, refs, candidate), who asked whom, how it stands, and links (the public answer, the task).
 */
async function cardView(db: Db, request: NodePeerRequest) {
  const who = await names(db, [request.fromAccountId, request.toAccountId]);
  const members = await db.nodeRoomMember.findMany({ where: { roomId: request.roomId, OR: [{ userId: { in: [request.fromAccountId, request.toAccountId] }, nodeId: null }, { nodeId: { in: [request.toNodeId, request.fromNodeId ?? ""] } }] } });
  const handle = (accountId: string) => members.find((row) => !row.nodeId && row.userId === accountId)?.handle ?? null;
  const nodeHandle = (nodeId: string | null) => (nodeId ? (members.find((row) => row.nodeId === nodeId)?.handle ?? null) : null);
  const from = { accountId: request.fromAccountId, name: who.get(request.fromAccountId) ?? "Someone", handle: handle(request.fromAccountId), nodeId: request.fromNodeId, nodeHandle: nodeHandle(request.fromNodeId) };
  const to = { accountId: request.toAccountId, name: who.get(request.toAccountId) ?? "Someone", handle: handle(request.toAccountId), leadNodeId: request.toNodeId, leadHandle: nodeHandle(request.toNodeId) };
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
    answerMessageId: request.answerMessageId,
    taskId: request.taskId,
    mode: request.mode,
    updatedAt: request.updatedAt.toISOString(),
  };
  const state = (statusLine[request.status] ?? request.status).replace("{to}", to.name);
  const body = `${from.name} asked ${to.name} (${request.kind}): ${truncateText(request.text, 600)}\n${state}`;
  return { data, body };
}

/** How the accepted work went, from its mission: for the target owner only. */
async function workView(db: Db, request: NodePeerRequest): Promise<{ outcome: string | null; requirements: Array<{ text: string; status: string }> }> {
  const mission = request.missionId ? await db.nodeMission.findUnique({ where: { id: request.missionId }, select: { status: true } }) : null;
  if (!mission) return { outcome: null, requirements: [] };
  const plan = await loadPlan(db, request.missionId!);
  return { outcome: missionEnded(mission.status) ? mission.status : null, requirements: (plan?.data.requirements ?? []).map((row) => ({ text: truncateText(row.text, 200), status: row.status })) };
}

/**
 * The request as one person sees it: everyone what the public card shows; the two people also the decline
 * note (`answer`); the target owner also their own words for their lead (`brief`), how the work went and its cards.
 */
export async function wireRequest(db: Db, request: NodePeerRequest, viewerId: string) {
  const { data } = await cardView(db, request);
  const target = viewerId === request.toAccountId;
  const party = target || viewerId === request.fromAccountId;
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
    answerMessageId: request.answerMessageId,
    answer: party ? request.answer : null,
    cardId: request.cardId,
    taskId: request.taskId,
    mode: request.mode,
    ...(target ? { brief: request.brief, ...(await workView(db, request)), ownerCardId: request.ownerCardId, missionId: request.missionId } : {}),
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
  // Its proposed task in the room's space follows it (node/room-space.ts).
  await syncRequestTask(app, request);
  const card = request.cardId ? await prisma.nodeMessage.findUnique({ where: { id: request.cardId } }) : null;
  if (card) {
    const { data, body } = await cardView(prisma, request);
    // Cards made before carried more than the requester's words: the card is rebuilt, never merged into.
    const { answer: _answer, outcome: _outcome, requirements: _requirements, ...kept } = (card.data ?? {}) as Record<string, unknown>;
    await updateMessageData(prisma, { ...card, data: kept as Prisma.JsonValue }, { ...data, ...extra }, body);
  }
  const ownerCard = request.ownerCardId ? await prisma.nodeMessage.findUnique({ where: { id: request.ownerCardId } }) : null;
  const next = OWNER_CARD_STATUS[request.status];
  const now = (ownerCard?.data as { status?: unknown } | null)?.status;
  if (ownerCard && next && now !== next && now !== "expired") {
    await updateMessageData(prisma, ownerCard, { status: next, text: request.text, ...(request.brief ? { brief: request.brief } : {}), ...(request.status === "declined" ? { note: request.answer } : {}) });
  }
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
  // The card links to the public answer; a copy would outlive the answer's deletion.
  const moved = await app.prisma.nodePeerRequest.updateMany({
    where: { id: requestId, status: { in: UNDECIDED } },
    data: { status: "answered", answerMessageId: message.id, decidedAt: new Date() },
  });
  if (moved.count) await refreshCards(app, requestId);
}

// ── making a request ──────────────────────────────────────────────────────────────────────────

export type NewRequestInput = z.infer<typeof NewRequest> & {
  room: NodeRoom;
  fromAccountId: string;
  fromNodeId?: string | null;
  /** False when who asked rests on a lead's reading of several people's messages: it then never starts at once. */
  mayAutoAccept?: boolean;
};

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
  // Between two editors of the room's space, work becomes a proposed task there; a review's result goes on the requester's own task (node/room-space.ts).
  const taskId = input.kind === "work" ? await proposeTask(app, request, room) : input.kind === "review" ? await requesterTask(app, request, room) : null;
  await prisma.nodePeerRequest.update({ where: { id: request.id }, data: { cardId: card.id, ...(taskId ? { taskId } : {}) } });
  if (taskId) request.taskId = taskId;
  if (WORK.has(input.kind)) {
    const target = await personRow(prisma, room.id, to);
    const prefs = prefsOf(target);
    const trust = trustFor(prefs, input.fromAccountId);
    // Work its owner chose to accept from this person starts at once, unless they are away (or their lead is paused): then it waits for them.
    if (input.mayAutoAccept !== false && trust.workRequests === "accept" && trust.acceptKinds.includes(input.kind) && !awayNow(prefs) && lead.node?.status === "active") {
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
    // The whole request: the owner accepts exactly what their lead's planning turn reads.
    body: `${fromName} asks for ${request.kind === "review" ? "a review" : "work"}: “${request.text}”${refsLine(request)}${pinned ? ` (candidate: ${pinned})` : ""}. Accept, edit or decline.`,
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
      // A proposed task in the room's space: accepting asks one question, private work with a shared result (default) or a shared run.
      ...(request.taskId && request.kind === "work" ? { taskId: request.taskId, modes: ["private", "shared"], defaultMode: "private" } : {}),
      // A review of work on the requester's own task: its result goes on that task (node/room-results.ts).
      ...(request.taskId && request.kind === "review" ? { taskId: request.taskId, resultTo: "requester_task" } : {}),
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
  const room = await prisma.nodeRoom.findUnique({ where: { id: request.roomId } });
  const candidate = request.candidate as Candidate | null;
  // Where it runs: the proposed task's own space (wherever the room links now), shared only while they can edit there.
  const space = request.kind === "work" ? await requestSpace(prisma, request) : null;
  const where = space ? modeLine({ ...request, mode: space.shared ? "shared" : "private" }, (await nodeSpace(prisma, request.toAccountId, space.spaceId))?.name ?? null) : "";
  // The owner's edit is the brief; what was asked stays in view.
  const asked = request.brief ? ` Those are your owner's words; ${from} asked: “${request.text}”.` : "";
  const note =
    request.kind === "review"
      ? `Your owner accepted ${from}'s request in “${room?.title ?? "the room"}” for a review: “${request.brief ?? request.text}”${refsLine(request)}.${asked} The candidate: ${candidateLine(candidate)}. ` +
        "Plan it now with node_plan for your owner, on their computer: one checking step (kind other, since nothing in this plan builds the candidate) for the node that tests, which checks out exactly that candidate in a fresh clone, with no secrets in its environment, sandboxed, with network only for what the checks need, and reports each check with its verdict (pass or fail). Fix nothing: the repair stays with the person who asked. The mission's constraints carry this. " +
        "When it ends, the request's card in the room says only that it ended; your detailed report stays here with your owner."
      : `Your owner accepted ${from}'s request in “${room?.title ?? "the room"}” for work: “${request.brief ?? request.text}”${refsLine(request)}.${asked}${where} ` +
        "Plan it now with node_plan for your owner (their nodes, their computer, their credits). When it ends, the request's card in the room says only that it ended; your detailed report stays here with your owner, who can share it to the room.";
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
export async function acceptRequest(app: FastifyInstance, accountId: string, requestId: string, input: { text?: string; always?: boolean; mode?: "private" | "shared" }): Promise<NodePeerRequest> {
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
    // An edit is the owner's own brief for their lead: the room keeps what was asked.
    data: { status: "approved", decidedAt: new Date(), toNodeId: lead.node.id, ...(text ? { brief: truncateText(text, 4000) } : {}), ...(request.taskId && request.kind === "work" ? { mode: input.mode ?? "private" } : {}) },
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
  const note = input.note?.trim() ? truncateText(input.note.trim(), 1000) : null;
  const declined = await app.prisma.nodePeerRequest.updateMany({ where: { id: request.id, status: { in: UNDECIDED } }, data: { status: "declined", answer: note, decidedAt: new Date() } });
  if (!declined.count) throw fail("That request was already settled.", 409);
  await refreshCards(app, request.id);
  // The note is for the person who asked: in their My crew, not on the public card.
  if (note) {
    const who = await names(app.prisma, [request.toAccountId]);
    await postMessage(app.prisma, {
      roomId: request.roomId,
      userId: request.fromAccountId,
      authorKind: "system",
      kind: "status",
      body: `${who.get(request.toAccountId) ?? "They"} declined your ${request.kind} request (“${truncateText(request.text, 200)}”): ${note}`,
      data: { requestId: request.id, declineNote: true },
      visibleTo: [request.fromAccountId],
    });
  }
  return (await app.prisma.nodePeerRequest.findUnique({ where: { id: request.id } }))!;
}

/**
 * A requested task moved on a board (services/tasks.ts `answerRequestedMove`): the person asked moving it
 * to To do or In progress accepts it, as Accept · private work does; dropping it declines it. Anyone else,
 * or any other column, is refused with why. Null when its request is no longer waiting (an ordinary move).
 */
export async function answerFromBoard(app: FastifyInstance, input: { accountId: string; task: Task; status: string }): Promise<{ task: Task; message: string } | null> {
  const prisma = app.prisma;
  const request = input.task.peerRequestId ? await prisma.nodePeerRequest.findUnique({ where: { id: input.task.peerRequestId } }) : null;
  if (!request || !UNDECIDED.includes(request.status) || request.taskId !== input.task.id) return null;
  const who = await names(prisma, [request.fromAccountId, request.toAccountId]);
  const [from, to] = [who.get(request.fromAccountId) ?? "Someone", who.get(request.toAccountId) ?? "the person asked"];
  if (input.accountId !== request.toAccountId) throw fail(`${from} asked ${to} for this: only ${to} accepts or declines it.`, 403);
  let message: string;
  if (input.status === "todo" || input.status === "in_progress") {
    await acceptRequest(app, input.accountId, request.id, {});
    message = `Accepted ${from}'s request: your lead plans it in Ensemble Node, as private work whose result comes back to this task.`;
  } else if (input.status === "dropped") {
    await declineRequest(app, input.accountId, request.id, {});
    message = `Declined ${from}'s request.`;
  } else {
    throw fail(`${from} asked you for this: accept it (move it to To do or In progress) or decline it first.`, 409);
  }
  return { task: await prisma.task.findUniqueOrThrow({ where: { id: input.task.id } }), message };
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

/**
 * `node_peer_request`. In My crew it drafts a request to another person for the owner (`draft`, the turn's
 * lineage): an owner-wide turn read private things, so the request reaches the room only when the owner
 * sends it, in the words they approved (`sendRequestDraft`). When the owner asked in public, a room-bound
 * turn asks for them at once. In a room-bound turn it also records a request someone here made of the
 * owner: `from` names their message, which must be one this turn read from a person other than the owner
 * (`batch`); its author is who asked. The person who asked is never the turn's.
 */
export function peerRequestTool(input: {
  node: NodeAgent;
  room: NodeRoom;
  askerId: string;
  batch?: ReadonlyArray<{ seq: number; userId: string }>;
  draft?: { rootMessageId: string | null; botDepth: number };
}): AnyHubTool {
  const { node, room, askerId } = input;
  const batch = input.batch ?? null;
  const ownerAsks = askerId === node.userId;
  return defineTool({
    name: "node_peer_request",
    area: "context",
    description: batch
      ? "Record a request for work or a review that someone here made of your owner, for your owner to decide: from is the #number of their message. Nothing runs until your owner accepts. Then tell them in a line that it waits for your owner." +
        (ownerAsks ? " Your owner asked here too: to ask someone else something for your owner, give to (their handle or their lead's) instead of from." : "")
      : input.draft
        ? "Draft a request to another person in this room, through their lead, for your owner: a question, a share (an artefact), a review of your owner's candidate (a commit or URL), or work. Your owner sees the draft and sends it (or edits or discards it); only then does it show as a card in the room, attributed to them. Write only what your owner would say in the room."
        : "Ask another person in this room something, through their lead, for your owner: a question, a share (an artefact), a review of your owner's candidate (a commit or URL), or work. It is attributed to your owner and shows as a card in the room.",
    input: z.object({
      kind: z.enum(PEER_KINDS),
      text: z.string().trim().min(1).max(4000).describe("The request, standing alone."),
      ...(batch ? { from: z.number().int().min(1).optional().describe("The #number of the message the request comes from.") } : {}),
      to: z.string().trim().max(80).optional().describe(batch && !ownerAsks ? "Leave out: it is for your owner." : "The person: their handle or their lead's handle."),
      refs: z.array(Ref).max(10).optional(),
      candidate: Candidate.optional().describe("For a review: the repository and exact commit, or a URL."),
    }).strict(),
    isWrite: false,
    risk: "low",
    async run(ctx, raw) {
      const value = raw as { kind: PeerKind; text: string; from?: number; to?: string; refs?: z.infer<typeof Ref>[]; candidate?: z.infer<typeof Candidate> };
      const recording = Boolean(batch) && (value.from !== undefined || !ownerAsks);
      let fromAccountId = node.userId;
      if (recording) {
        if (!WORK.has(value.kind)) throw new ToolBlockedError("Answer questions yourself, within what this room may see; ask your owner (node_ask_owner) for anything private.");
        const source = batch!.find((row) => row.seq === value.from);
        if (!source) throw new ToolBlockedError(value.from === undefined ? "Give from: the #number of the message the request comes from." : `#${value.from} is not a message someone here wrote to your owner in this conversation.`);
        if (value.to && (await resolvePerson(ctx.prisma, room.id, value.to)) !== node.userId) throw new ToolBlockedError("You record requests for your owner only. Other people's leads answer for them.");
        if (!(await personIn(ctx.prisma, room.id, source.userId))) throw new ToolBlockedError("They are no longer in this room.");
        fromAccountId = source.userId;
      } else if (!value.to) {
        throw new ToolBlockedError("Name who it is for (their handle, or their lead's).");
      }
      if (!recording && input.draft) {
        const to = await resolvePerson(ctx.prisma, room.id, value.to!);
        if (!to) throw new ToolBlockedError(`There is nobody called ${value.to} in this room.`);
        if (to === node.userId) throw new ToolBlockedError("That is your owner: work for them here as usual.");
        if (value.kind === "review" && !value.candidate?.commit && !value.candidate?.url) throw new ToolBlockedError("A review needs the exact candidate: a commit (with its repository) or a URL.");
        const card = await draftRequest(ctx.prisma, { node, room, to, kind: value.kind, text: value.text, refs: value.refs ?? [], candidate: value.candidate ?? null, lineage: input.draft });
        return toolOk("Drafted for your owner: it reaches the room only when they send it from the card, and they may edit it first. Say so in a line.", { draft: card.id });
      }
      try {
        const request = await createPeerRequest(ctx.app, {
          room,
          fromAccountId,
          fromNodeId: recording ? null : node.id,
          to: recording ? node.userId : value.to!,
          kind: value.kind,
          text: value.text,
          ...(value.refs ? { refs: value.refs } : {}),
          ...(value.candidate ? { candidate: value.candidate } : {}),
          // Several people wrote in this conversation: who asked is the lead's reading, so the owner decides.
          ...(recording ? { mayAutoAccept: new Set(batch!.map((row) => row.userId)).size === 1 } : {}),
        });
        return toolOk(
          request.status === "approved"
            ? "Recorded and accepted at once (your owner's setting); it is planned in their My crew."
            : WORK.has(request.kind)
              ? `Recorded: it waits for ${recording ? "your owner" : "them"} to accept or decline. Say so in a line; promise nothing.`
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

/**
 * A request drafted in My crew: the owner's card (`post`, with `request`). Its body is everything the room
 * would read, refs and candidate included, so the owner approves exactly that.
 */
async function draftRequest(
  db: PrismaClient,
  input: { node: NodeAgent; room: NodeRoom; to: string; kind: PeerKind; text: string; refs: z.infer<typeof Ref>[]; candidate: Candidate | null; lineage: { rootMessageId: string | null; botDepth: number } },
): Promise<NodeMessage> {
  const owner = input.node.userId;
  const who = await names(db, [input.to]);
  const handle = (await db.nodeRoomMember.findFirst({ where: { roomId: input.room.id, userId: input.to, nodeId: null }, select: { handle: true } }))?.handle ?? null;
  const about = input.refs.length ? `\nAbout: ${input.refs.map((row) => `${row.title}${row.url ? ` <${row.url}>` : ""}`).join("; ")}` : "";
  const pinned = input.candidate ? `\nCandidate: ${candidateLine(input.candidate)}` : "";
  const { message } = await postMessage(db, {
    roomId: input.room.id,
    userId: owner,
    authorKind: "node",
    authorNodeId: input.node.id,
    kind: "approval",
    body: truncateText(`${input.text.trim()}${about}${pinned}`, 4000),
    data: { type: "post", status: "pending", request: { kind: input.kind, to: { accountId: input.to, name: who.get(input.to) ?? "Someone", handle }, candidate: input.candidate } },
    visibleTo: [owner],
    rootMessageId: input.lineage.rootMessageId,
    botDepth: input.lineage.botDepth,
  });
  return message;
}

/**
 * The owner sends a request their lead drafted: in exactly the words they approved (refs are in them), with
 * the candidate only while every value of it is still in those words.
 */
export async function sendRequestDraft(app: FastifyInstance, card: NodeMessage, node: NodeAgent, edited: string | undefined): Promise<{ request: NodePeerRequest; text: string }> {
  const draft = (card.data as { request?: { kind?: unknown; to?: { accountId?: unknown }; candidate?: unknown } } | null)?.request;
  const kind = draft?.kind;
  const to = draft?.to?.accountId;
  if (typeof kind !== "string" || !(PEER_KINDS as readonly string[]).includes(kind) || typeof to !== "string") throw fail("That draft is not available.", 404);
  const text = truncateText((edited ?? card.body).trim(), 4000);
  if (!text) throw fail("The request is empty.", 400);
  const pinned = Candidate.safeParse(draft?.candidate);
  const candidate = pinned.success && Object.values(pinned.data).every((value) => !value || text.includes(value)) ? pinned.data : undefined;
  const room = await app.prisma.nodeRoom.findUnique({ where: { id: card.roomId } });
  if (!room || room.archivedAt) throw fail("That room is not available.", 404);
  const request = await createPeerRequest(app, { room, fromAccountId: node.userId, fromNodeId: node.id, to, kind: kind as PeerKind, text, ...(candidate ? { candidate } : {}) });
  return { request, text };
}

// ── missions made for a request ─────────────────────────────────────────────────────────────

type TurnLink = Pick<NodeTurn, "id" | "nodeId" | "roomId" | "reason" | "note" | "attempt" | "operationId" | "peerRequestId" | "originTurnId">;

/**
 * A turn's operation and peer request, or those of the turn it continues: a rate-limited turn tried
 * again, or a turn resumed after a restart, is a new row pointing at the first (`originTurnId`;
 * node/queue.ts `retryLater`, `recoverTurns`). Older retries are found by their note.
 */
export async function turnOrigin(db: Db, turn: TurnLink): Promise<{ operationId: string | null; peerRequestId: string | null }> {
  if (turn.originTurnId) {
    const origin = await db.nodeTurn.findUnique({ where: { id: turn.originTurnId }, select: { operationId: true, peerRequestId: true } });
    if (origin) return { operationId: turn.operationId ?? origin.operationId, peerRequestId: turn.peerRequestId ?? origin.peerRequestId };
  }
  if (turn.operationId || turn.peerRequestId || !turn.attempt || !turn.note) return { operationId: turn.operationId, peerRequestId: turn.peerRequestId };
  const first = await db.nodeTurn.findFirst({
    where: { nodeId: turn.nodeId, roomId: turn.roomId, reason: turn.reason, note: turn.note, attempt: 0, id: { not: turn.id } },
    orderBy: { createdAt: "desc" },
    select: { operationId: true, peerRequestId: true },
  });
  return { operationId: first?.operationId ?? null, peerRequestId: first?.peerRequestId ?? null };
}

/** A work request's proposed task's space, and whether its run is shared there (chosen, and the person asked can still edit there). */
async function requestSpace(db: Db, request: Pick<NodePeerRequest, "taskId" | "mode" | "toAccountId">): Promise<{ spaceId: string; shared: boolean } | null> {
  if (!request.taskId) return null;
  const task = await db.task.findFirst({ where: { id: request.taskId, deletedAt: null }, select: { userId: true } });
  if (!task) return null;
  const role = request.mode === "shared" ? await roleIn(request.toAccountId, task.userId) : null;
  return { spaceId: task.userId, shared: role === "owner" || role === "editor" };
}

export type MissionOrigin = {
  spaceId?: string;
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
  const turn = await db.nodeTurn
    .findUnique({ where: { id: turnId.split(":")[0]! }, select: { id: true, nodeId: true, roomId: true, reason: true, note: true, attempt: true, operationId: true, peerRequestId: true, originTurnId: true, userId: true, private: true, triggerMessageId: true } })
    .catch(() => null);
  if (!turn) return {};
  const link = await turnOrigin(db, turn);
  const requestId = link.peerRequestId ?? /^request:([0-9a-f-]{36}):accepted$/.exec(link.operationId ?? "")?.[1];
  // Not a request: perhaps the owner's own task on the room's board (node/room-results.ts).
  if (!requestId) return roomTaskOrigin(db, turn, link.operationId);
  const request = await db.nodePeerRequest.findUnique({ where: { id: requestId } });
  if (!request || request.status !== "approved" || request.toAccountId !== turn.userId || !WORK.has(request.kind)) return {};
  const owner = request.toAccountId;
  const candidate = request.candidate as Candidate | null;
  // A shared run works in its task's own space, while the person asked can still edit there; private work keeps the mission in the owner's own (null).
  const space = request.kind === "work" ? await requestSpace(db, request) : null;
  const sharedSpace = space?.shared ? space.spaceId : null;
  return {
    requestedBy: { accountId: request.fromAccountId, nodeId: request.fromNodeId, roomId: request.roomId, requestId: request.id, kind: request.kind, ...(candidate ? { candidate } : {}) },
    deliverTo: { roomId: request.roomId, audience: "room", ...(request.taskId ? { taskId: request.taskId } : {}) },
    principals: { data: owner, billing: owner, executionDevice: owner, approver: owner },
    ...(sharedSpace ? { spaceId: sharedSpace } : {}),
    ...(request.kind === "review" ? { constraints: reviewConstraints(constraints ?? {}, candidate) as Prisma.InputJsonValue } : {}),
  };
}

/** A mission linked to a request: links it, and when it has ended marks the request done (code, no model). */
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
  // Nothing from the work goes on the card: its result reaches the room only as the owner posts it.
  const done = await prisma.nodePeerRequest.updateMany({
    where: { id: request.id, status: "approved" },
    data: here ? { status: "done", missionId: mission.id } : { status: "cancelled", missionId: mission.id, answer: "They left the room." },
  });
  if (done.count) await refreshCards(app, request.id);
}

/** Requests whose missions ended while nobody was listening (a restart): settled on a sweep. */
export async function syncPeerMissions(app: FastifyInstance): Promise<void> {
  const prisma = app.prisma;
  // Linked ones are checked by id; one not linked yet (its plan card's change was missed) only while recent.
  const linked = await prisma.nodePeerRequest.findMany({ where: { status: "approved", missionId: { not: null } }, orderBy: { updatedAt: "desc" }, take: 200, select: { missionId: true } });
  const recent = await prisma.nodePeerRequest.findMany({ where: { status: "approved", missionId: null, decidedAt: { gte: new Date(Date.now() - 86_400_000) } }, orderBy: { decidedAt: "desc" }, take: 50, select: { id: true } });
  const ids = new Set(linked.map((row) => row.missionId!));
  for (const request of recent) {
    const mission = await prisma.nodeMission.findFirst({ where: { requestedBy: { path: ["requestId"], equals: request.id } }, orderBy: { createdAt: "desc" }, select: { id: true } });
    if (mission) ids.add(mission.id);
  }
  for (const id of ids) await missionDelivered(app, id);
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
    inBackground(app, async () => {
      await missionDelivered(app, message.id as string);
      // Its result onto the room's board and into the room (node/room-results.ts).
      await followMission(app, message.id as string);
    });
  });
  const sweep = setInterval(
    () =>
      inBackground(app, async () => {
        await syncPeerMissions(app);
        await syncMissionResults(app);
      }),
    60_000,
  );
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
  await forgetPerson(tx, roomId, accountId);
  await dropStewardOf(tx, roomId, accountId);
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
  const source = (original.data ?? {}) as { refs?: unknown; files?: unknown; media?: unknown };
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
      // The media this message showed its owner: sharing the message is their choice to show it here too (node/media.ts mediaReadable).
      ...(Array.isArray(source.media) && source.media.length ? { media: source.media } : {}),
    },
    clientId: `share:${original.id}:${as}`,
  });
  return message;
}
