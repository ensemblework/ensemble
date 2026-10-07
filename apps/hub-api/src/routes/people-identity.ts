/**
 * One person across sources (docs/03 §4.7): merge suggestions computed from
 * identities, dismissing a suggestion, and merging two people on request.
 * Ingest never merges on its own.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { dismissSuggestion, identitySuggestions, mergePeople, MergeError } from "../people/identity.js";

const Pair = z.object({ personId: z.string().min(1).max(100), otherId: z.string().min(1).max(100) });
const Merge = z.object({ otherId: z.string().min(1).max(100) });

export async function peopleIdentityRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/people/identity-suggestions", async (request) => ({ suggestions: await identitySuggestions(request.userId, prisma) }));

  app.post("/api/people/identity-suggestions/dismiss", async (request, reply) => {
    const body = Pair.parse(request.body);
    const owned = await prisma.person.count({ where: { userId: request.userId, id: { in: [body.personId, body.otherId] } } });
    if (owned < 2 || body.personId === body.otherId) return reply.code(404).send({ error: "Person not found." });
    await dismissSuggestion(request.userId, body.personId, body.otherId, prisma);
    await appendLedger({ userId: request.userId, actor: "me", action: "person.merge.dismiss", payload: body });
    return { ok: true };
  });

  app.post("/api/people/:id/merge", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = Merge.parse(request.body);
    try {
      const result = await mergePeople(prisma, request.userId, id, body.otherId);
      const person = await prisma.person.findUnique({
        where: { id },
        select: { id: true, name: true, email: true, identities: { select: { kind: true, value: true, source: true, verified: true } } },
      });
      await appendLedger({ userId: request.userId, actor: "me", action: "person.merge", payload: { kept: id, removed: body.otherId, moved: result.moved } });
      sseHub.publish(request.userId, { event: "context", data: { kind: "people", id } });
      return { person, moved: result.moved };
    } catch (error) {
      if (error instanceof MergeError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
