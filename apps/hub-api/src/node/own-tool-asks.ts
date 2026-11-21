/**
 * The owner's answer for one of the agent's own calls (its shell, files, web) in a node's turn on their
 * AI plan (docs/35 §8.13). The computer judged the call by the node's folder policy and asks here
 * (subscriptions/node-own-tools.ts, `POST /api/devices/self/assistant-turns/:id/ask`). An answer the
 * owner already gave for that folder (from then on, or for this run) settles it at once, a no for this
 * run too; otherwise one owner-only card in the chat where the node is talking (node/device-tool-decisions.ts:
 * one question per node, computer, folder and run, answered with one press) and the call waits for it, at
 * most 90 seconds, so a proxy in front of the web never cuts the request. Not answered by then: the call
 * is refused with a note to stop, the turn parks, and the answer wakes the same conversation in the same
 * agent session ("Allowed: … Do it now.").
 */
import type { AgentDecision, NodeAgent, NodeRoom, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { OwnAnswer, OwnAsk } from "../subscriptions/bridge.js";
import { askOwner, awaitAnswer, computerCard, grantScope, markGrantsUsed, NODE_TOOL_DECISION, noticeAsked, ownerName, ownPlace, permissionWaitMs, waitForOwner, watchDecision, type NodeToolCard } from "./device-tool-decisions.js";
import { holdForCard, markActed, requestPark } from "./queue.js";
import { missionOf } from "./device-tools.js";
import type { Lineage } from "./tools.js";

/** The longest a call waits for its owner's answer in one request: a proxy in front of the web cuts a request at 100 seconds. */
export const OWN_ASK_MS = 90_000;
/** Answers older than this are not used for a new call (as the computer's answers, device-tool-decisions.ts). */
const ANSWER_DAYS = 30;

export function ownAskWaitMs(): number {
  return Math.min(permissionWaitMs(), OWN_ASK_MS);
}

export type OwnAskScope = {
  node: Pick<NodeAgent, "id" | "slug" | "userId">;
  room: Pick<NodeRoom, "id">;
  privateTo: string[] | null;
  lineage: Pick<Lineage, "rootMessageId" | "botDepth">;
  turnId: string;
  plan: { planId: string; planStep: string | null } | null;
  /** The owner started the turn and only they read it: an answer for the folder from then on counts too. */
  trusted: boolean;
};

const detailOf = (row: Pick<AgentDecision, "detail">) => ((row.detail && typeof row.detail === "object" && !Array.isArray(row.detail) ? row.detail : {}) as { nodeTool?: NodeToolCard });

/** Whether an answer for `known` covers `target`: the same address or program, or a folder that holds it. */
function covers(known: string, target: string): boolean {
  if (known === target) return true;
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(known)) return false;
  const base = known.replace(/[\\/]+$/, "");
  return target.startsWith(`${base}/`) || target.startsWith(`${base}\\`);
}

/** The owner's answer already given for this call: allowed for the folder from then on or for this run, or not allowed in this run. */
async function knownAnswer(prisma: Pick<PrismaClient, "agentDecision">, scope: OwnAskScope, deviceId: string, request: OwnAsk, mission: string): Promise<{ row: AgentDecision; card: NodeToolCard } | null> {
  const rows = await prisma.agentDecision.findMany({
    where: { userId: scope.node.userId, toolName: NODE_TOOL_DECISION, status: "decided", decidedAt: { gte: new Date(Date.now() - ANSWER_DAYS * 86_400_000) } },
    orderBy: { decidedAt: "desc" },
    take: 200,
  });
  for (const row of rows) {
    const card = detailOf(row).nodeTool;
    if (!card || card.nodeId !== scope.node.id || card.deviceId !== deviceId || card.scope !== request.scope || !covers(card.target, request.target)) continue;
    const answer = grantScope(row);
    if (answer === "once") continue;
    if (card.mission === mission || (answer === "always" && scope.trusted)) return { row, card };
  }
  return null;
}

/** Asks the owner about one of the agent's own calls in this turn, on `computer`. */
export function ownToolAsker(app: FastifyInstance, scope: OwnAskScope): (request: OwnAsk, computer: { id: string; name: string }) => Promise<OwnAnswer> {
  const owner = scope.node.userId;
  const mission = missionOf({ plan: scope.plan, room: scope.room, privateTo: scope.privateTo });
  const isPrivate = Boolean(scope.privateTo);
  const lane = { roomId: scope.room.id, private: isPrivate, planId: scope.plan?.planId ?? null, planStep: scope.plan?.planStep ?? null, retry: null };
  const allowed = async (row: AgentDecision, card: NodeToolCard): Promise<OwnAnswer> => {
    await markGrantsUsed(app.prisma, [row.id]);
    await markActed(app, scope.turnId);
    return { decision: "allow", grant: { id: row.id, scope: grantScope(row) ?? "once", target: card.target } };
  };
  return async (request, computer) => {
    const what = `${request.what}${ownPlace(request)}`;
    const known = await knownAnswer(app.prisma, scope, computer.id, request, mission);
    if (known && known.row.decision === "allow") return allowed(known.row, known.card);
    if (known) return { decision: "deny", message: `Your owner chose not to allow this in this run: ${what}. Go on without it, or say what cannot be done without it.` };
    // From here on another person's message never stops this turn: the card waits for its owner.
    holdForCard(scope.turnId);
    const card = {
      nodeId: scope.node.id,
      nodeSlug: scope.node.slug,
      roomId: scope.room.id,
      private: isPrivate,
      planId: lane.planId,
      planStep: lane.planStep,
      mission,
      deviceId: computer.id,
      deviceName: computer.name,
      capability: request.capability,
      target: request.target,
      label: request.label,
      scope: request.scope,
      own: { what: request.what },
    };
    const asked = await askOwner(app, owner, card, request.operation, false);
    const message = await computerCard(app, asked.row, { node: scope.node, roomId: scope.room.id, private: isPrivate, rootMessageId: scope.lineage.rootMessageId, botDepth: scope.lineage.botDepth, call: request.operation, planId: lane.planId, planStep: lane.planStep });
    if (asked.created) await noticeAsked(app, asked.row, scope.room.id, message.id);
    const answered = await waitForOwner(
      { turnId: scope.turnId, ownerId: owner, nodeId: scope.node.id, roomId: scope.room.id, private: isPrivate, threadRootId: scope.lineage.rootMessageId },
      message.id,
      (signal) => awaitAnswer(app, asked.row.id, signal, ownAskWaitMs(), lane),
    );
    if (answered?.status === "decided" && answered.decision === "allow") return allowed(answered, detailOf(answered).nodeTool ?? { ...card, delivered: false, announced: false });
    if (answered?.status === "decided") return { decision: "deny", message: `Your owner chose not to allow this: ${what}. Go on without it, or say what cannot be done without it.` };
    if (answered) return { decision: "deny", message: `Your owner did not answer the card about ${what}, and it closed. Go on without it, or ask again later if it is still needed.` };
    // Not answered yet: the answer wakes this conversation or step later, in the same agent session.
    watchDecision(app, asked.row.id);
    const waits = `Waiting for ${await ownerName(app.prisma, owner)} to answer the card about ${what}.`;
    requestPark(scope.turnId, waits);
    return { decision: "deny", waiting: true, message: `${waits} Stop here: end your turn now without a reply. You go on when they answer.` };
  };
}
