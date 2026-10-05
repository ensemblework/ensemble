import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createDeskEntry, deleteDeskEntry } from "../desk/entries.js";
import { loadDeskLive } from "../desk/live.js";

export async function deskRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/desk/live", async (request) => loadDeskLive(prisma, request.userId));

  app.post("/api/desk/entries", async (request, reply) => {
    const body = z.object({ kind: z.string().min(1).max(40), fields: z.record(z.unknown()).default({}) }).parse(request.body);
    const created = await createDeskEntry(prisma, request.userId, body.kind, body.fields);
    return reply.code(201).send(created);
  });

  app.delete("/api/desk/entries/:kind/:id", async (request) => {
    const params = z.object({ kind: z.string(), id: z.string().uuid() }).parse(request.params);
    await deleteDeskEntry(prisma, request.userId, params.kind, params.id);
    return { ok: true };
  });
}
