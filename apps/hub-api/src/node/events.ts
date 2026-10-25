/**
 * Live frames for Ensemble Node. Each account has its own channel (`node:<account>`), separate
 * from the space stream, so a frame reaches exactly the people a message is visible to.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { sseHandler, sseHub } from "../lib/sse.js";

export const nodeChannel = (accountId: string): string => `node:${accountId}`;

export function publishTo(accountIds: Iterable<string>, event: string, data: unknown): void {
  for (const accountId of new Set(accountIds)) sseHub.publish(nodeChannel(accountId), { event, data });
}

export function nodeEventStream(request: FastifyRequest, reply: FastifyReply, accountId: string): Promise<void> {
  return sseHandler(request, reply, nodeChannel(accountId), { accountId, owner: true });
}

/** Needs me changes on the person's own channel: run approvals and agents' questions. */
const NEEDS_EVENTS = new Set(["decision", "approval"]);
let mirroring = false;

/**
 * Needs me changes reach the person's Node stream too, as `node.needs` with no content (Node
 * re-reads its lists), so its badge and cards update at once instead of on the next poll.
 */
export function mirrorNeedsMe(): void {
  if (mirroring) return;
  mirroring = true;
  sseHub.onFrame(({ userId, frame }) => {
    if (!NEEDS_EVENTS.has(frame.event) || userId.startsWith("node:") || frame.to) return;
    sseHub.publish(nodeChannel(userId), { event: "node.needs", data: { kind: frame.event } });
  });
}
