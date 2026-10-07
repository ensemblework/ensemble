import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sseHub } from "../lib/sse.js";
import {
  createStandalonePage,
  convertPage,
  deleteStandalonePage,
  getStandalonePage,
  listStandalonePages,
  renameStandalonePage,
  saveStandalonePage,
  TaskPageError,
} from "../pages/store.js";
import { appendLedger } from "../lib/ledger.js";

const RenamePage = z.object({
  title: z.string().trim().min(1).max(200),
});

export async function pageRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.post("/api/pages/:kind/:id/convert", async (request, reply) => {
    const { kind, id } = z.object({ kind: z.enum(["page", "task"]), id: z.string().uuid() }).parse(request.params);
    const { revision } = z.object({ revision: z.number().int().nonnegative() }).parse(request.body);
    try {
      const result = await convertPage(prisma, request.userId, kind, id, revision);
      await appendLedger({ userId: request.userId, actor: "me", action: "page.convert", payload: { fromKind: kind, fromId: id, ...result } });
      sseHub.publish(request.userId, { event: "page", data: { id: result.pageId, taskId: kind === "task" ? id : result.id, action: "convert" } });
      sseHub.publish(request.userId, { event: "task", data: { id: kind === "task" ? id : result.id, action: "convert" } });
      return result;
    } catch (error) {
      if (error instanceof TaskPageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

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
