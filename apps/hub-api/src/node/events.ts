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
