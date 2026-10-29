/**
 * Approval cards (docs/35 §8). Only the node's owner sees and settles them, once. Held Ensemble
 * writes are applied by Ensemble's own Apply route (same checks, dedupe, undo and ledger as the
 * Hub); a drafted post goes to the room exactly as approved. Nothing is decided by a model here.
 */
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeMessage, Prisma } from "@prisma/client";
import { z } from "zod";
import { internalHeaders } from "./brain.js";
import { dispatchMessage, enqueueTurn } from "./queue.js";
import { mentionsFor, postMessage, updateMessageData } from "./store.js";
import { refsNote, savedRefs } from "../assistant/refs.js";
import { sessionOfJob } from "../workspace/sessions.js";
import { ownerContext, runSessionCall, SendInput, StartInput, type SessionCall } from "./sessions.js";
import { declineSecret } from "./node-secrets.js";
import { finishStep, planLinkOf } from "./plans.js";
import { makeCrew, makeNode, NewCrew, NewNode } from "./helpers.js";
import { noteTold } from "./dispatch.js";
import { ToolBlockedError } from "../assistant/types.js";
import { roomDraftPosted, settleRoomCard } from "./audience.js";

export const NOT_APPROVED = "Not approved by the person.";

const ToolsCard = z.object({
  type: z.literal("tools"),
  status: z.string(),
  conversationId: z.string(),
  private: z.boolean().optional(),
  calls: z.array(z.object({ callId: z.string(), name: z.string(), summary: z.string(), input: z.record(z.unknown()) })),
}).passthrough();

const PostCard = z.object({ type: z.literal("post"), status: z.string(), fromNonOwner: z.boolean().optional() }).passthrough();

const SessionCard = z.union([
  z.object({ type: z.literal("session"), status: z.string(), action: z.literal("start"), input: StartInput, private: z.boolean().optional() }).passthrough(),
  z.object({ type: z.literal("session"), status: z.string(), action: z.literal("send"), input: SendInput, private: z.boolean().optional() }).passthrough(),
]);

export class ApprovalError extends Error {
  constructor(message: string, readonly statusCode: 404 | 409 | 400) {
    super(message);
  }
}

/** The card, if this account may settle it: its owner, alone, still in the room. */
async function ownCard(app: FastifyInstance, accountId: string, messageId: string): Promise<{ card: NodeMessage; node: NodeAgent }> {
  const card = await app.prisma.nodeMessage.findUnique({ where: { id: messageId } });
  const own = card && card.kind === "approval" && card.userId === accountId && card.visibleTo.length === 1 && card.visibleTo[0] === accountId && card.authorNodeId;
  if (!own) throw new ApprovalError("That approval is not available.", 404);
  const [node, member] = await Promise.all([
    app.prisma.nodeAgent.findUnique({ where: { id: card.authorNodeId! } }),
    app.prisma.nodeRoomMember.findFirst({ where: { roomId: card.roomId, userId: accountId, nodeId: null }, select: { id: true } }),
  ]);
  if (!node || node.userId !== accountId || !member) throw new ApprovalError("That approval is not available.", 404);
  return { card, node };
}

/** Moves a pending card to `applying` exactly once. */
async function claim(app: FastifyInstance, card: NodeMessage): Promise<Record<string, unknown>> {
  const data = card.data as Record<string, unknown>;
  if (data.status !== "pending") throw new ApprovalError("This was already settled.", 409);
  const claimed = await app.prisma.nodeMessage.updateMany({
    where: { id: card.id, data: { path: ["status"], equals: "pending" } },
    data: { data: { ...data, status: "applying" } as Prisma.InputJsonValue },
  });
  if (claimed.count !== 1) throw new ApprovalError("This was already settled.", 409);
  return { ...data, status: "applying" };
}

async function markCalls(app: FastifyInstance, conversationId: string, spaceId: string, callIds: Set<string>, error: string): Promise<void> {
  const replies = await app.prisma.assistantMessage.findMany({ where: { conversationId, userId: spaceId, role: "assistant" }, orderBy: { createdAt: "desc" }, take: 12 });
  for (const reply of replies) {
    const calls = Array.isArray(reply.toolCalls) ? (reply.toolCalls as Array<Record<string, unknown>>) : [];
    let changed = false;
    const next = calls.map((call) => {
      if (typeof call.id !== "string" || !callIds.has(call.id) || call.state !== "awaiting_approval") return call;
      changed = true;
      return { ...call, state: "failed", error, summary: error };
    });
    if (changed) await app.prisma.assistantMessage.update({ where: { id: reply.id }, data: { toolCalls: next as Prisma.InputJsonValue } });
  }
}

/** A run card for each computer job a just-approved hub_assign_to_agent started. */
async function followRuns(app: FastifyInstance, node: NodeAgent, card: NodeMessage, taskIds: string[], since: Date, isPrivate: boolean): Promise<void> {
  const prisma = app.prisma;
  const people = await prisma.nodeRoomMember.findMany({ where: { roomId: card.roomId, nodeId: null }, select: { userId: true } });
  // The task and computer are the owner's: other people in the room do not see the card.
  const visibleTo = isPrivate || people.some((row) => row.userId !== node.userId) ? [node.userId] : [];
  for (const taskId of new Set(taskIds)) {
    const job = await prisma.workspaceJob.findFirst({
      where: { userId: node.userId, taskId, createdAt: { gte: new Date(since.getTime() - 60_000) } },
      orderBy: { createdAt: "desc" },
      include: { task: { select: { title: true } }, device: { select: { name: true } } },
    });
    if (!job || (await prisma.nodeRun.findUnique({ where: { jobId: job.id }, select: { id: true } }))) continue;
    const sessionId = (await sessionOfJob(prisma, job))?.id ?? null;
    const { message } = await postMessage(prisma, {
      roomId: card.roomId,
      userId: node.userId,
      authorKind: "node",
      authorNodeId: node.id,
      kind: "run",
      body: job.task.title,
      data: { jobId: job.id, taskId, sessionId, status: job.status, computer: job.device?.name ?? null, progress: job.progress, summary: null, error: null, private: isPrivate },
      visibleTo,
      rootMessageId: card.rootMessageId,
      botDepth: card.botDepth,
    });
    await prisma.nodeRun.create({ data: { userId: node.userId, nodeId: node.id, roomId: card.roomId, messageId: message.id, jobId: job.id, taskId, status: job.status, sessionId } });
  }
}

export type Decision = { decision: "approve" | "discard"; callIds?: string[]; body?: string };

export async function settleApproval(app: FastifyInstance, accountId: string, messageId: string, input: Decision): Promise<NodeMessage> {
  const prisma = app.prisma;
  const { card, node } = await ownCard(app, accountId, messageId);
  const type = (card.data as { type?: unknown }).type;
  // Rooms with other people: disclosure and peer-request cards (node/audience.ts, node/peer-requests.ts).
  const roomCard = await settleRoomCard(app, card, node, input);
  if (roomCard) return roomCard;

  if (type === "post") {
    PostCard.parse(card.data);
    const data = await claim(app, card);
    if (input.decision === "discard") return updateMessageData(prisma, { ...card, data: data as Prisma.JsonValue }, { status: "discarded" });
    const body = (input.body ?? card.body).trim();
    const shown = data as { media?: unknown; refs?: unknown };
    const carried = { ...(Array.isArray(shown.media) && shown.media.length ? { media: shown.media } : {}), ...(Array.isArray(shown.refs) && shown.refs.length ? { refs: shown.refs } : {}) };
    if (!body && !carried.media) {
      await updateMessageData(prisma, { ...card, data: data as Prisma.JsonValue }, { status: "pending" });
      throw new ApprovalError("The message is empty.", 400);
    }
    const members = await prisma.nodeRoomMember.findMany({ where: { roomId: card.roomId } });
    // The owner approved these exact words, so the post speaks for the owner.
    const { message } = await postMessage(prisma, {
      roomId: card.roomId,
      userId: node.userId,
      authorKind: "node",
      authorNodeId: node.id,
      body,
      data: { approvedBy: accountId, ...carried },
      mentions: mentionsFor(body, members, []),
      rootMessageId: card.rootMessageId,
      botDepth: card.botDepth,
    });
    await dispatchMessage(app, message);
    await roomDraftPosted(app, card, message);
    return updateMessageData(prisma, { ...card, data: data as Prisma.JsonValue }, { status: "posted", postedMessageId: message.id }, body);
  }

  if (type === "session") return settleSession(app, card, node, input);
  if (type === "node_proposal") return settleProposal(app, card, node, input);
  if (type === "secret") {
    if (input.decision === "discard") return declineSecret(app, accountId, messageId);
    throw new ApprovalError("Type the secret into its box: it goes straight to your computer.", 400);
  }

  const parsed = ToolsCard.parse(card.data);
  const chosen = input.callIds?.length ? parsed.calls.filter((call) => input.callIds!.includes(call.callId)) : parsed.calls;
  if (!chosen.length) throw new ApprovalError("Pick at least one change to apply.", 400);
  const data = await claim(app, card);
  const current = { ...card, data: data as Prisma.JsonValue };
  const spaceId = node.userId;
  if (input.decision === "discard") {
    await markCalls(app, parsed.conversationId, spaceId, new Set(parsed.calls.map((call) => call.callId)), NOT_APPROVED);
    const discarded = await updateMessageData(prisma, current, { status: "discarded" });
    await declinedInStep(app, node, card, "the changes it asked to make");
    return discarded;
  }
  const started = new Date();
  const response = await app.inject({
    method: "POST",
    url: "/api/assistant/apply",
    headers: { ...internalHeaders(spaceId), "content-type": "application/json" },
    payload: { conversationId: parsed.conversationId, calls: chosen.map((call) => ({ name: call.name, input: call.input, callId: call.callId })) },
  });
  let result: { summary?: string; href?: string | null; partial?: boolean; failed?: Array<{ name: string; error: string }>; error?: string; refs?: unknown } = {};
  try {
    result = response.json();
  } catch {
    result = {};
  }
  if (response.statusCode >= 400) {
    // Nothing ran: the owner can try again or discard.
    return updateMessageData(prisma, current, { status: "pending", error: result.error ?? `Could not apply (${response.statusCode}).` });
  }
  const failedNames = new Set((result.failed ?? []).map((row) => row.name));
  const landed = chosen.filter((call) => !failedNames.has(call.name));
  const skipped = parsed.calls.filter((call) => !chosen.includes(call));
  if (skipped.length) await markCalls(app, parsed.conversationId, spaceId, new Set(skipped.map((call) => call.callId)), NOT_APPROVED);
  const assigned = landed.filter((call) => call.name === "hub_assign_to_agent").map((call) => String(call.input.taskId ?? "")).filter(Boolean);
  if (assigned.length) await followRuns(app, node, card, assigned, started, parsed.private === true);
  const updated = await updateMessageData(prisma, current, {
    status: result.partial ? "partial" : "applied",
    error: null,
    result: { summary: result.summary ?? "", href: result.href ?? null, failed: result.failed ?? [] },
  });
  const failures = (result.failed ?? []).map((row) => `${row.name}: ${row.error}`).join("; ");
  await enqueueTurn(app, {
    nodeId: node.id,
    roomId: card.roomId,
    reason: "approval",
    ...(planLinkOf(card.data) ?? {}),
    // The summary names records by title; their ids follow as links for the node's next calls.
    note: `Your owner approved and it was applied: ${(result.summary || "done").replace(/\.+$/, "")}.${refsNote(savedRefs(result.refs)) ? ` ${refsNote(savedRefs(result.refs))}` : ""}${failures ? ` These failed: ${failures}.` : ""}${assigned.length ? " The computer run started; you will hear when it ends." : ""} Continue the plan if there is more to do; otherwise reply ${"(no reply)"}.`,
    private: parsed.private === true,
  });
  return updated;
}

/**
 * A session call the node held for its owner (node/sessions.ts): run exactly as shown once approved,
 * as the owner's own request, then the node hears what came of it.
 */
async function settleSession(app: FastifyInstance, card: NodeMessage, node: NodeAgent, input: Decision): Promise<NodeMessage> {
  const prisma = app.prisma;
  const parsed = SessionCard.parse(card.data);
  const data = await claim(app, card);
  const current = { ...card, data: data as Prisma.JsonValue };
  if (input.decision === "discard") {
    const discarded = await updateMessageData(prisma, current, { status: "discarded" });
    await declinedInStep(app, node, card, "the work it asked to start on the computer");
    return discarded;
  }
  const room = await prisma.nodeRoom.findUnique({ where: { id: card.roomId } });
  if (!room) throw new ApprovalError("That conversation is gone.", 404);
  const call = { action: parsed.action, input: parsed.input } as SessionCall;
  let done;
  try {
    done = await runSessionCall(
      {
        ctx: await ownerContext(app, node.userId),
        prisma,
        app,
        node,
        room,
        lineage: { rootMessageId: card.rootMessageId, botDepth: card.botDepth, fromNonOwner: false },
        privateTo: parsed.private ? [node.userId] : null,
        plan: planLinkOf(card.data),
      },
      call,
    );
  } catch (error) {
    // Nothing started: the owner can try again or discard.
    return updateMessageData(prisma, current, { status: "pending", error: error instanceof Error ? error.message : String(error) });
  }
  const updated = await updateMessageData(prisma, current, { status: "applied", error: null, result: { summary: done.summary, href: null, failed: [] } });
  // A packet code handed over (node/dispatch.ts): its run shows what the agent was told, and is asked for its result as any other.
  const told = (card.data as { told?: unknown }).told;
  if (typeof told === "string") await noteTold(prisma, done.data.jobId, told);
  await enqueueTurn(app, {
    nodeId: node.id,
    roomId: card.roomId,
    reason: "approval",
    note: `Your owner approved and it started: ${done.summary} Reply ${"(no reply)"} unless there is more to say.`,
    private: parsed.private === true,
    ...(planLinkOf(card.data) ?? {}),
  });
  return updated;
}

const ProposalCard = z.union([
  z.object({ type: z.literal("node_proposal"), status: z.string(), action: z.literal("node"), input: NewNode, private: z.boolean().optional() }).passthrough(),
  z.object({ type: z.literal("node_proposal"), status: z.string(), action: z.literal("crew"), input: NewCrew, private: z.boolean().optional() }).passthrough(),
]);

/** A node or crew a node proposed (node/helpers.ts): made exactly as shown once approved; the node hears it. */
async function settleProposal(app: FastifyInstance, card: NodeMessage, node: NodeAgent, input: Decision): Promise<NodeMessage> {
  const prisma = app.prisma;
  const parsed = ProposalCard.parse(card.data);
  const data = await claim(app, card);
  const current = { ...card, data: data as Prisma.JsonValue };
  if (input.decision === "discard") return updateMessageData(prisma, current, { status: "discarded" });
  let made: { summary: string; result: Record<string, unknown> };
  try {
    if (parsed.action === "node") {
      const created = await makeNode(prisma, node, parsed.input);
      made = { summary: `made @${created.slug} (${created.name}); its chat is in your owner's sidebar`, result: { nodeId: created.id, handle: created.slug } };
    } else {
      const room = await makeCrew(prisma, node.userId, parsed.input);
      made = { summary: `made the crew “${room.title}”`, result: { roomId: room.id } };
    }
  } catch (error) {
    // Nothing was made (a name taken meanwhile, a node gone): the owner can try again or discard.
    const message = error instanceof ToolBlockedError ? [error.message, error.remedy].filter(Boolean).join(" ") : error instanceof Error ? error.message : String(error);
    return updateMessageData(prisma, current, { status: "pending", error: message });
  }
  const updated = await updateMessageData(prisma, current, { status: "applied", error: null, result: { summary: made.summary, ...made.result } });
  await enqueueTurn(app, {
    nodeId: node.id,
    roomId: card.roomId,
    reason: "approval",
    note: `Your owner approved your proposal: ${made.summary}. Continue if there is more to do (node_delegate hands it work); otherwise reply ${"(no reply)"}.`,
    private: parsed.private === true,
  });
  return updated;
}

/** A plan step waits for its cards: when the owner says no to one, its node hears it and finishes the step. */
async function declinedInStep(app: FastifyInstance, node: NodeAgent, card: NodeMessage, what: string): Promise<void> {
  const link = planLinkOf(card.data);
  if (!link?.planStep) return;
  const queued = await enqueueTurn(app, {
    nodeId: node.id,
    roomId: card.roomId,
    reason: "approval",
    note: `Your owner declined ${what}. Finish your step without it (reply with what was done), or call node_step_blocked with why it cannot be done.`,
    ...link,
  });
  if (!queued) await finishStep(app, link.planId, link.planStep, { status: "blocked", result: `Your owner declined ${what}.` });
}

