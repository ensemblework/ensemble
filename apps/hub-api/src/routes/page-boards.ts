import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CreatePageBoard, PatchPageBoard, PageBoardColumns } from "@ensemble/shared-types";
import { assignBoardPage, boardDto, boardPageDto, boardPageSelect, ownedBoard, visibleBoardPages } from "../pages/boards.js";
import { createStandalonePage, TaskPageError } from "../pages/store.js";
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

  app.get("/api/boards", async (request) => {
    const boards = await prisma.pageBoard.findMany({
      where: { userId: request.userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { _count: { select: { pages: { where: visibleBoardPages(request.userId) } } } },
    });
    return { boards: boards.map((board) => boardDto(board, board._count.pages)) };
  });
  app.post("/api/boards", async (request, reply) => {
    const body = CreatePageBoard.parse(request.body);
    const board = await prisma.pageBoard.create({ data: { userId: request.userId, ...body } });
    changed(request.userId);
    return reply.code(201).send({ board: boardDto(board, 0) });
  });
  app.get("/api/boards/:id", async (request) => {
    const { id } = Id.parse(request.params);
    return prisma.$transaction(async (tx) => {
      const board = await ownedBoard(tx, request.userId, id);
      const pages = await tx.taskPage.findMany({ where: { ...visibleBoardPages(request.userId), boardId: id }, select: boardPageSelect, orderBy: [{ boardOrder: "asc" }, { id: "asc" }] });
      return { board: boardDto(board, pages.length), pages: pages.map(boardPageDto) };
    }, { isolationLevel: "RepeatableRead" });
  });
  app.patch("/api/boards/:id", async (request) => {
    const { id } = Id.parse(request.params);
    const { revision, ...body } = PatchPageBoard.parse(request.body);
    const result = await prisma.$transaction(async (tx) => {
      const existing = await ownedBoard(tx, request.userId, id, true);
      if (existing.revision !== revision) throw new TaskPageError("BOARD_CONFLICT", "This board changed in another tab. Reload it before saving.", 409);
      if (body.columns) {
        const removed = PageBoardColumns.parse(existing.columns).filter((column) => !body.columns!.some((next) => next.id === column.id));
        if (removed.length && await tx.taskPage.count({ where: { userId: request.userId, boardId: id, boardColumnId: { in: removed.map((column) => column.id) } } })) {
          throw new TaskPageError("COLUMN_NOT_EMPTY", "Move the pages out of a column before removing it. Pages in Trash keep their column too.", 409);
        }
      }
      const board = await tx.pageBoard.update({ where: { id }, data: { ...body, revision: { increment: 1 } } });
      return boardDto(board, await tx.taskPage.count({ where: { ...visibleBoardPages(request.userId), boardId: id } }));
    });
    changed(request.userId);
    return { board: result };
  });
  app.delete("/api/boards/:id", async (request, reply) => {
    const { id } = Id.parse(request.params);
    await prisma.$transaction(async (tx) => {
      await ownedBoard(tx, request.userId, id, true);
      // Organizational cleanup must not invalidate a page's pending Trash undo timestamp.
      await tx.$executeRaw`UPDATE task_pages SET board_id = NULL, board_column_id = NULL, board_order = 0 WHERE user_id = ${request.userId} AND board_id = ${id}`;
      await tx.pageBoard.delete({ where: { id } });
    });
    changed(request.userId);
    sseHub.publish(request.userId, { event: "task", data: { action: "board" } });
    return reply.code(204).send();
  });
  app.post("/api/boards/:id/pages", async (request, reply) => {
    const { id } = Id.parse(request.params);
    const { columnId } = z.object({ columnId: z.string().uuid() }).parse(request.body);
    const page = await prisma.$transaction(async (tx) => {
      await ownedBoard(tx, request.userId, id, true);
      const created = await createStandalonePage(tx, request.userId);
      return assignBoardPage(tx, request.userId, "page", created.id, { boardId: id, columnId });
    });
    changed(request.userId);
    sseHub.publish(request.userId, { event: "page", data: { id: page.id, action: "create" } });
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
