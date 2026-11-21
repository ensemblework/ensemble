/**
 * A node turn's trace for its owner (docs/35 §5.6): `GET /api/node/turns/:turnId/trace`, the turn's
 * outcome and placement, its trace and the decisions about it (node/trace.ts). Sharing class `personal`
 * (src/sharing/policy.ts), like every Node route: whichever space is open, a turn of someone else's node,
 * or none at all, answers 404.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isUuid } from "@ensemble/shared-types";
import { turnTrace } from "./trace.js";

export function registerTraceRoutes(app: FastifyInstance, account: (request: FastifyRequest) => string): void {
  app.get("/api/node/turns/:turnId/trace", async (request, reply) => {
    const accountId = account(request);
    const { turnId } = request.params as { turnId: string };
    const found = isUuid(turnId) ? await turnTrace(app.prisma, accountId, turnId) : null;
    if (!found) return reply.code(404).send({ error: "That turn is not available." });
    return found;
  });
}
