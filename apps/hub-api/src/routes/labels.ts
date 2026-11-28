import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CreateBoardLabel, PatchBoardLabel } from "@ensemble/shared-types";
import { boardKeyFor, boardLabelList, createBoardLabel, deleteBoardLabel, ENSEMBLE_BOARD_TITLE, ENSEMBLE_KEY, itemBoardKey, updateBoardLabel } from "../labels/board-labels.js";
import { sseHub } from "../lib/sse.js";

/** One way to name the list: a board (`ensemble` or a custom board's id), or the item that picks from it. */
const ListQuery = z
  .object({
    board: z.string().min(1).max(64).optional(),
    task: z.string().uuid().optional(),
    page: z.string().uuid().optional(),
    deliverable: z.string().uuid().optional(),
  })
  .refine((query) => [query.board, query.task, query.page, query.deliverable].filter(Boolean).length === 1, "Name one board, task, page or deliverable.");
const Id = z.object({ id: z.string().uuid() });

/** Board labels (labels/board-labels.ts): each board's list of labels its items pick from. */
export async function labelRoutes(app: FastifyInstance) {
  const { prisma } = app;
  // Items' names may change too (a rename or a delete reaches every item that has the label).
  const changed = (userId: string) => sseHub.publish(userId, { event: "labels", data: {} });

  app.get("/api/labels", async (request) => {
    const query = ListQuery.parse(request.query ?? {});
    const userId = request.userId;
    return prisma.$transaction(async (tx) => {
      if (query.board) return boardLabelList(tx, userId, await boardKeyFor(tx, userId, query.board));
      const item = query.task ? { kind: "task" as const, id: query.task } : query.page ? { kind: "page" as const, id: query.page } : { kind: "deliverable" as const, id: query.deliverable! };
      const key = await itemBoardKey(tx, userId, item);
      return boardLabelList(tx, userId, key === ENSEMBLE_KEY ? { key, title: ENSEMBLE_BOARD_TITLE } : await boardKeyFor(tx, userId, key));
    }, { isolationLevel: "RepeatableRead" });
  });

  app.post("/api/labels", async (request, reply) => {
    const body = CreateBoardLabel.parse(request.body);
    const userId = request.userId;
    const result = await prisma.$transaction(async (tx) => {
      const board = await boardKeyFor(tx, userId, body.board);
      return createBoardLabel(tx, userId, board.key, { name: body.name, color: body.color });
    });
    if (result.created) changed(userId);
    return reply.code(result.created ? 201 : 200).send({ label: result.label });
  });

  app.patch("/api/labels/:id", async (request) => {
    const { id } = Id.parse(request.params);
    const body = PatchBoardLabel.parse(request.body);
    const result = await prisma.$transaction((tx) => updateBoardLabel(tx, request.userId, id, body));
    changed(request.userId);
    return { label: result.label, changed: result.changed };
  });

  app.delete("/api/labels/:id", async (request) => {
    const { id } = Id.parse(request.params);
    const result = await prisma.$transaction((tx) => deleteBoardLabel(tx, request.userId, id));
    changed(request.userId);
    return { changed: result.changed };
  });
}
