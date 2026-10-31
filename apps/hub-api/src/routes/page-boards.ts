import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CreatePageBoard, PatchPageBoard } from "@ensemble/shared-types";
import { assignBoardPage, boardPageDto, boardWithPages, createBoard, deleteBoard, listBoards, ownedBoard, updateBoard } from "../pages/boards.js";
import { createStandalonePage } from "../pages/store.js";
import { createTask } from "../services/tasks.js";
import { sseHub } from "../lib/sse.js";

const Id = z.object({ id: z.string().uuid() });
const Membership = z.object({
  boardId: z.string().uuid().nullable(),
  columnId: z.string().uuid().nullable(),
  beforeId: z.string().uuid().nullish(),
  afterId: z.string().uuid().nullish(),
});

export async function pageBoardRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const changed = (userId: string) => sseHub.publish(userId, { event: "board", data: {} });

  app.get("/api/boards", async (request) => ({ boards: await listBoards(prisma, request.userId) }));
  app.post("/api/boards", async (request, reply) => {
    const board = await createBoard(prisma, request.userId, CreatePageBoard.parse(request.body));
    changed(request.userId);
    return reply.code(201).send({ board });
  });
  app.get("/api/boards/:id", async (request) => {
    const { id } = Id.parse(request.params);
    return prisma.$transaction((tx) => boardWithPages(tx, request.userId, id), { isolationLevel: "RepeatableRead" });
  });
  app.patch("/api/boards/:id", async (request) => {
    const { id } = Id.parse(request.params);
    const { revision, ...body } = PatchPageBoard.parse(request.body);
    const result = await prisma.$transaction((tx) => updateBoard(tx, request.userId, id, revision, body));
    changed(request.userId);
    return { board: result };
  });
  app.delete("/api/boards/:id", async (request, reply) => {
    const { id } = Id.parse(request.params);
    await prisma.$transaction((tx) => deleteBoard(tx, request.userId, id));
    changed(request.userId);
    sseHub.publish(request.userId, { event: "task", data: { action: "board" } });
    return reply.code(204).send();
  });
  app.post("/api/boards/:id/pages", async (request, reply) => {
    const { id } = Id.parse(request.params);
    // `task`: a task page in that column, with owner, priority, due date and agents like any task.
    const { columnId, kind } = z.object({ columnId: z.string().uuid(), kind: z.enum(["page", "task"]).default("page") }).parse(request.body);
    const page = await prisma.$transaction(async (tx) => {
      await ownedBoard(tx, request.userId, id, true);
      if (kind === "task") {
        const task = await createTask(tx, request.userId, { title: "Untitled", status: "todo", sourceKind: "manual" }, "me");
        return assignBoardPage(tx, request.userId, "task", task.id, { boardId: id, columnId });
      }
      const created = await createStandalonePage(tx, request.userId);
      return assignBoardPage(tx, request.userId, "page", created.id, { boardId: id, columnId });
    });
    changed(request.userId);
    sseHub.publish(request.userId, { event: kind === "task" ? "task" : "page", data: { id: page.id, action: "create" } });
    return reply.code(201).send({ page: boardPageDto(page) });
  });
  app.put("/api/pages/:kind/:id/board", async (request) => {
    const { kind, id } = z.object({ kind: z.enum(["page", "task"]), id: z.string().uuid() }).parse(request.params);
    const body = Membership.parse(request.body);
    const page = await prisma.$transaction((tx) => assignBoardPage(tx, request.userId, kind, id, body));
    changed(request.userId);
    if (kind === "task") sseHub.publish(request.userId, { event: "task", data: { id, action: "board" } });
    return { page: boardPageDto(page) };
  });
}
