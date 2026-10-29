/**
 * The stop path (ensemble-node docs/design B15, extension §3.5): Stop, or a message that is only
 * "stop" / "stop all", stops work at once without a model. "stop" stops what this conversation
 * started (its turns, plans and agent runs); "stop all" stops everything the owner's nodes here do,
 * in every room. What is done stays done; late results are fenced (their cards go quiet).
 */
import type { FastifyInstance } from "fastify";
import type { NodeRoom } from "@prisma/client";
import { abortAssistantTurn } from "../assistant/agent.js";
import { stopJob } from "../workspace/worker.js";
import { stopTurns } from "./queue.js";
import { stopPlans } from "./plans.js";
import { updateMessageData } from "./store.js";

const LIVE_JOB = ["queued", "claimed", "running", "waiting_approval"];

/** A message that is only a stop command: "stop", "stop all", "stop everything", optionally with "/" or punctuation. */
export function stopCommand(text: string): "room" | "all" | null {
  const match = /^\/?\s*stop(?:\s+(all|everything|it all))?\s*[.!]*\s*$/i.exec(text.trim());
  if (!match) return null;
  return match[1] ? "all" : "room";
}

export type Stopped = { turns: number; plans: number; runs: number };

export async function stopWork(app: FastifyInstance, room: NodeRoom, accountId: string, scope: "room" | "all"): Promise<Stopped> {
  const prisma = app.prisma;
  const mine = await prisma.nodeRoomMember.findMany({ where: { roomId: room.id, userId: accountId, nodeId: { not: null } } });
  const nodeIds = mine.map((row) => row.nodeId!);
  const memberships = scope === "all" ? await prisma.nodeRoomMember.findMany({ where: { nodeId: { in: nodeIds } } }) : mine;
  for (const member of memberships) {
    for (const conversationId of [member.conversationId, member.privateConversationId]) if (conversationId) abortAssistantTurn(conversationId);
  }
  let plans = 0;
  if (scope === "all") for (const nodeId of nodeIds) plans += await stopPlans(app, { nodeId, userId: accountId });
  else plans += await stopPlans(app, { roomId: room.id, userId: accountId });
  const runs = await prisma.nodeRun.findMany({ where: { nodeId: { in: nodeIds }, reportedAt: null, ...(scope === "room" ? { roomId: room.id } : {}) } });
  const live = runs.length ? await prisma.workspaceJob.findMany({ where: { id: { in: runs.map((row) => row.jobId) }, status: { in: LIVE_JOB as never }, cancelRequestedAt: null }, select: { id: true } }) : [];
  for (const job of live) await stopJob(app, accountId, job.id);
  for (const run of runs.filter((row) => live.some((job) => job.id === row.jobId))) {
    const card = run.messageId ? await prisma.nodeMessage.findUnique({ where: { id: run.messageId } }) : null;
    if (card && typeof (card.data as { quiet?: unknown }).quiet !== "string") await updateMessageData(prisma, card, { quiet: "stopped" });
  }
  const turns = await stopTurns(app, nodeIds, scope === "all" ? null : room.id);
  return { turns, plans, runs: live.length };
}

/** "Stopped 1 plan and 2 agent runs." — what the owner reads after a stop. */
export function stoppedLine(stopped: Stopped): string {
  const parts = [
    stopped.plans ? `${stopped.plans} plan${stopped.plans === 1 ? "" : "s"}` : "",
    stopped.runs ? `${stopped.runs} agent run${stopped.runs === 1 ? "" : "s"}` : "",
    stopped.turns && !stopped.plans && !stopped.runs ? "the reply in progress" : "",
  ].filter(Boolean);
  return parts.length ? `Stopped ${parts.join(" and ")}. What was already done stays.` : "Nothing was running.";
}
