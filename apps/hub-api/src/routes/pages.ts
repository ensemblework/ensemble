import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sseHub } from "../lib/sse.js";
import {
  createStandalonePage,
  deleteStandalonePage,
  getStandalonePage,
  listStandalonePages,
  renameStandalonePage,
  saveStandalonePage,
  TaskPageError,
} from "../pages/store.js";

const RenamePage = z.object({
  title: z.string().trim().min(1).max(200),
});

export async function pageRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/pages", async (request) => {
    return { pages: await listStandalonePages(prisma, request.userId) };
  });

  app.post("/api/pages", async (request, reply) => {
    const page = await createStandalonePage(prisma, request.userId);
    sseHub.publish(request.userId, { event: "page", data: { id: page.id, action: "create" } });
    return reply.code(201).send({ page });
  });

  app.get("/api/pages/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await getStandalonePage(prisma, request.userId, id);
    } catch (error) {
      if (error instanceof TaskPageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.patch("/api/pages/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = RenamePage.parse(request.body);
    try {
      const page = await renameStandalonePage(prisma, request.userId, id, body.title);
      sseHub.publish(request.userId, { event: "page", data: { id, action: "rename" } });
      return { page };
    } catch (error) {
      if (error instanceof TaskPageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.put("/api/pages/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const page = await saveStandalonePage(prisma, request.userId, id, request.body);
      sseHub.publish(request.userId, { event: "page", data: { id, action: "save" } });
      return page;
    } catch (error) {
      if (error instanceof TaskPageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/api/pages/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await deleteStandalonePage(prisma, request.userId, id);
      sseHub.publish(request.userId, { event: "page", data: { id, action: "delete" } });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof TaskPageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
