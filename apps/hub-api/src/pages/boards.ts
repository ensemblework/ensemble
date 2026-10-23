import { Prisma, type PrismaClient, type PageBoard } from "@prisma/client";
import { PageBoardColumns, PageBoardTiles, type BoardPage, type DirectoryPage, type PageBoardRecord } from "@ensemble/shared-types";
import { hidesSignupStarters } from "../marketplace/starters.js";
import { pageSearchText } from "./markdown.js";
import { searchSnippet, TaskPageError, taskForPage } from "./store.js";

type Db = Prisma.TransactionClient;
export const boardPageSelect = {
  id: true, title: true, taskId: true, boardId: true, boardColumnId: true, boardOrder: true,
  parentId: true, createdAt: true, updatedAt: true,
  board: { select: { id: true, title: true } },
  task: { select: { id: true, title: true, createdAt: true, updatedAt: true } },
} satisfies Prisma.TaskPageSelect;
type StoredBoardPage = Prisma.TaskPageGetPayload<{ select: typeof boardPageSelect }>;

export function boardPageDto(page: StoredBoardPage): BoardPage {
  return {
    id: page.taskId ?? page.id, kind: page.taskId ? "task" : "page",
    title: page.task?.title || page.title || "Untitled", columnId: page.boardColumnId,
    boardOrder: page.boardOrder, createdAt: (page.task?.createdAt ?? page.createdAt).toISOString(),
    updatedAt: new Date(Math.max(page.updatedAt.getTime(), page.task?.updatedAt.getTime() ?? 0)).toISOString(),
  };
}

export const visibleBoardPages = (userId: string): Prisma.TaskPageWhereInput => ({
  userId, deletedAt: null, OR: [{ taskId: null }, { task: { userId, deletedAt: null } }],
});

export function boardDto(board: PageBoard, pageCount: number): PageBoardRecord {
  return {
    id: board.id, title: board.title, description: board.description, revision: board.revision,
    columns: PageBoardColumns.parse(board.columns), tiles: PageBoardTiles.parse(board.tiles),
    pageCount, createdAt: board.createdAt.toISOString(), updatedAt: board.updatedAt.toISOString(),
  };
}

export async function ownedBoard(db: Db, userId: string, id: string, lock = false) {
  if (lock) await db.$queryRaw`SELECT id FROM page_boards WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`;
  const board = await db.pageBoard.findFirst({ where: { id, userId } });
  if (!board) throw new TaskPageError("BOARD_NOT_FOUND", "Board not found.", 404);
  return board;
}

/** Board membership does not rewrite a page's document or its live-editor revision. */
export async function assignBoardPage(db: Db, userId: string, kind: "page" | "task", id: string, input: {
  boardId: string | null; columnId: string | null; beforeId?: string | null; afterId?: string | null;
}) {
  // Lock boards in a stable order before locking page rows, including the board being left.
  const current = await db.taskPage.findFirst({ where: { userId, ...(kind === "task" ? { taskId: id } : { id, taskId: null }) }, select: { boardId: true } });
  const boards = new Map<string, PageBoard>();
  for (const boardId of [...new Set([current?.boardId, input.boardId].filter((value): value is string => Boolean(value)))].sort()) {
    boards.set(boardId, await ownedBoard(db, userId, boardId, true));
  }
  if (input.boardId) {
    const columns = PageBoardColumns.parse(boards.get(input.boardId)!.columns);
    if (!columns.some((column) => column.id === input.columnId)) throw new TaskPageError("COLUMN_NOT_FOUND", "Choose a column on this board.", 400);
  } else if (input.columnId) {
    throw new TaskPageError("COLUMN_WITHOUT_BOARD", "Choose a board before choosing a column.");
  }
  const task = kind === "task" ? await taskForPage(db, userId, id, true) : null;
  await db.$queryRaw`SELECT id FROM task_pages WHERE user_id = ${userId} AND (id = ${id} OR task_id = ${id}) FOR UPDATE`;
  let page = await db.taskPage.findFirst({
    where: { userId, deletedAt: null, ...(task ? { taskId: id } : { id, taskId: null }) },
  });
  if (!page && !task) throw new TaskPageError("PAGE_NOT_FOUND", "Page not found.", 404);
  if (page && page.boardId !== (current?.boardId ?? null)) throw new TaskPageError("BOARD_CONFLICT", "This page moved in another tab. Try again.", 409);
  if (!page && task) {
    page = await db.taskPage.create({
      data: { userId, taskId: id, revision: 0, title: task.title, notesSnapshot: task.notes, searchText: pageSearchText(task.title, null, task.notes) },
    });
  }
  const neighbour = async (neighbourId: string | null | undefined) => {
    if (!neighbourId) return null;
    if (!input.boardId || neighbourId === id) throw new TaskPageError("INVALID_NEIGHBOUR", "Choose another page on this column.");
    const found = await db.taskPage.findFirst({
      where: { ...visibleBoardPages(userId), boardId: input.boardId, boardColumnId: input.columnId, OR: [{ id: neighbourId, taskId: null }, { taskId: neighbourId, task: { deletedAt: null } }] },
    });
    if (!found) throw new TaskPageError("NEIGHBOUR_NOT_FOUND", "The neighbouring page moved. Try again.", 409);
    return found;
  };
  const [before, after] = await Promise.all([neighbour(input.beforeId), neighbour(input.afterId)]);
  if (before && after && before.boardOrder >= after.boardOrder) throw new TaskPageError("INVALID_ORDER", "The column changed. Try again.", 409);
  const last = input.boardId && !before && !after ? await db.taskPage.aggregate({
    where: { userId, boardId: input.boardId, boardColumnId: input.columnId }, _max: { boardOrder: true },
  }) : null;
  const boardOrder = before && after ? (before.boardOrder + after.boardOrder) / 2
    : before ? before.boardOrder + 1 : after ? after.boardOrder - 1 : (last?._max.boardOrder ?? -1) + 1;
  return db.taskPage.update({
    where: { id: page!.id },
    data: { boardId: input.boardId, boardColumnId: input.columnId, boardOrder },
    select: boardPageSelect,
  });
}

export async function pageDirectory(prisma: PrismaClient, userId: string, query: string): Promise<DirectoryPage[]> {
  const hideStarters = await hidesSignupStarters(prisma, userId);
  const [pages, tasks] = await Promise.all([
    prisma.taskPage.findMany({
      where: { userId, taskId: null, deletedAt: null, ...(query ? { searchText: { contains: query, mode: "insensitive" } } : {}) },
      select: { ...boardPageSelect, searchText: true },
    }),
    prisma.task.findMany({
      where: {
        userId, deletedAt: null,
        ...(hideStarters ? { NOT: { sourceRef: { startsWith: "template:" } } } : {}),
        ...(query ? { OR: [{ title: { contains: query, mode: "insensitive" } }, { notes: { contains: query, mode: "insensitive" } }, { page: { searchText: { contains: query, mode: "insensitive" } } }] } : {}),
      },
      select: { id: true, title: true, createdAt: true, updatedAt: true, notes: true, page: { select: { ...boardPageSelect, searchText: true } } },
    }),
  ]);
  return [
    ...pages.map((page): DirectoryPage => ({ ...boardPageDto(page), parentId: page.parentId, board: page.board, ...(query ? { snippet: searchSnippet(page.searchText ?? "", page.title, query) } : {}) })),
    ...tasks.map((task): DirectoryPage => ({
      ...(task.page ? boardPageDto(task.page) : { id: task.id, kind: "task", title: task.title || "Untitled", columnId: null, boardOrder: 0, createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString() }),
      parentId: null, board: task.page?.board ?? { id: "ensemble", title: "Ensemble board" },
      ...(query ? { snippet: searchSnippet(task.page?.searchText ?? task.notes, task.title, query) } : {}),
    })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
