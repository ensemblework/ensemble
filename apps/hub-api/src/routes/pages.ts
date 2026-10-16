import { pageVersionRoutes } from "../pages/version-routes.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sseHub } from "../lib/sse.js";
import {
  createStandalonePage,
  convertPage,
  deleteStandalonePage,
  trashStandalonePages,
  getStandalonePage,
  listStandalonePages,
  renameStandalonePage,
  saveStandalonePage,
  TaskPageError,
} from "../pages/store.js";
import { appendLedger } from "../lib/ledger.js";
import { collabHub } from "../pages/live.js";

const RenamePage = z.object({
  title: z.string().trim().min(1).max(200),
});

export async function pageRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;
  await pageVersionRoutes(app);

  app.post("/api/pages/:kind/:id/convert", async (request, reply) => {
    const { kind, id } = z.object({ kind: z.enum(["page", "task"]), id: z.string().uuid() }).parse(request.params);
    const { revision } = z.object({ revision: z.number().int().nonnegative() }).parse(request.body);
    try {
      // The editor flushed before asking; this also writes back what others typed since.
      await collabHub.flush({ space: request.userId, kind, id }).catch(() => undefined);
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
    const { q } = z.object({ q: z.string().max(200).optional() }).parse(request.query ?? {});
    return { pages: await listStandalonePages(prisma, request.userId, q ?? "") };
  });

  app.post("/api/pages", async (request, reply) => {
    const page = await createStandalonePage(prisma, request.userId);
    sseHub.publish(request.userId, { event: "page", data: { id: page.id, action: "create" } });
    return reply.code(201).send({ page });
  });

  app.post("/api/pages/delete-many", async (request) => {
    const { pageIds } = z.object({ pageIds: z.array(z.string().uuid()).min(1).max(100) }).parse(request.body);
    // Nested pages go too: write back every page open live in the space first.
    await collabHub.flushSpace(request.userId);
    const result = await prisma.$transaction((tx) => trashStandalonePages(tx, request.userId, pageIds));
    sseHub.publish(request.userId, { event: "page", data: { action: "delete", ids: result.pages.map((page) => page.id) } });
    return { deleted: result.pages.length, undoEntryId: result.undoEntryId };
  });

  app.get("/api/pages/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    // `?trashed=1`: a page in Trash, to read before restoring it.
    const { trashed } = z.object({ trashed: z.enum(["1", "true"]).optional() }).parse(request.query ?? {});
    try {
      return await getStandalonePage(prisma, request.userId, id, { trashed: Boolean(trashed) });
    } catch (error) {
      if (error instanceof TaskPageError) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
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
      sseHub.publish(request.userId, { event: "page", data: { id, action: "save", revision: page.revision } });
      return page;
    } catch (error) {
      if (error instanceof TaskPageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/api/pages/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await collabHub.flushSpace(request.userId);
      await deleteStandalonePage(prisma, request.userId, id);
      sseHub.publish(request.userId, { event: "page", data: { id, action: "delete" } });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof TaskPageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
