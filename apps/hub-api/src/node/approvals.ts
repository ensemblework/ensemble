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

export const NOT_APPROVED = "Not approved by the person.";

const ToolsCard = z.object({
  type: z.literal("tools"),
  status: z.string(),
  conversationId: z.string(),
  private: z.boolean().optional(),
  calls: z.array(z.object({ callId: z.string(), name: z.string(), summary: z.string(), input: z.record(z.unknown()) })),
}).passthrough();

const PostCard = z.object({ type: z.literal("post"), status: z.string(), fromNonOwner: z.boolean().optional() }).passthrough();

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
    const { message } = await postMessage(prisma, {
      roomId: card.roomId,
      userId: node.userId,
      authorKind: "node",
      authorNodeId: node.id,
      kind: "run",
      body: job.task.title,
      data: { jobId: job.id, taskId, status: job.status, computer: job.device?.name ?? null, progress: job.progress, summary: null, error: null, private: isPrivate },
      visibleTo,
      rootMessageId: card.rootMessageId,
      botDepth: card.botDepth,
    });
    await prisma.nodeRun.create({ data: { userId: node.userId, nodeId: node.id, roomId: card.roomId, messageId: message.id, jobId: job.id, taskId, status: job.status } });
  }
}

export type Decision = { decision: "approve" | "discard"; callIds?: string[]; body?: string };

export async function settleApproval(app: FastifyInstance, accountId: string, messageId: string, input: Decision): Promise<NodeMessage> {
  const prisma = app.prisma;
  const { card, node } = await ownCard(app, accountId, messageId);
  const type = (card.data as { type?: unknown }).type;

  if (type === "post") {
    PostCard.parse(card.data);
    const data = await claim(app, card);
    if (input.decision === "discard") return updateMessageData(prisma, { ...card, data: data as Prisma.JsonValue }, { status: "discarded" });
    const body = (input.body ?? card.body).trim();
    if (!body) {
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
      data: { approvedBy: accountId },
      mentions: mentionsFor(body, members, []),
      rootMessageId: card.rootMessageId,
      botDepth: card.botDepth,
    });
    await dispatchMessage(app, message);
    return updateMessageData(prisma, { ...card, data: data as Prisma.JsonValue }, { status: "posted", postedMessageId: message.id }, body);
  }

  const parsed = ToolsCard.parse(card.data);
  const chosen = input.callIds?.length ? parsed.calls.filter((call) => input.callIds!.includes(call.callId)) : parsed.calls;
  if (!chosen.length) throw new ApprovalError("Pick at least one change to apply.", 400);
  const data = await claim(app, card);
  const current = { ...card, data: data as Prisma.JsonValue };
  const spaceId = node.userId;
  if (input.decision === "discard") {
    await markCalls(app, parsed.conversationId, spaceId, new Set(parsed.calls.map((call) => call.callId)), NOT_APPROVED);
    return updateMessageData(prisma, current, { status: "discarded" });
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
    // The summary names records by title; their ids follow as links for the node's next calls.
    note: `Your owner approved and it was applied: ${(result.summary || "done").replace(/\.+$/, "")}.${refsNote(savedRefs(result.refs)) ? ` ${refsNote(savedRefs(result.refs))}` : ""}${failures ? ` These failed: ${failures}.` : ""}${assigned.length ? " The computer run started; you will hear when it ends." : ""} Continue the plan if there is more to do; otherwise reply ${"(no reply)"}.`,
    private: parsed.private === true,
  });
  return updated;
}
