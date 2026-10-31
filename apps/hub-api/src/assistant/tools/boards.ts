/**
 * Custom boards (`/board?board=<id>`, docs/02 §3.2) for the assistant and, through the space gateway,
 * for Ensemble Node: list and read them, make, change and delete them and their columns, and put a
 * task's page or a note on a column, move it, or take it off. They share pages/boards.ts with
 * routes/page-boards.ts, so a call checks and changes a board exactly as the Board screen does, in the
 * space the call acts in (`ctx.userId`). A card's column is the board's own: a task keeps its status.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { BoardColor, PageBoardColumns, PageBoardTiles, type PageBoardColumn, type PageBoardRecord } from "@ensemble/shared-types";
import { assignBoardPage, createBoard, deleteBoard, ownedBoard, updateBoard, visibleBoardPages, boardDto, listBoards } from "../../pages/boards.js";
import { TaskPageError } from "../../pages/store.js";
import { hubUrl } from "../../bridge/text.js";
import { sseHub } from "../../lib/sse.js";
import { defineTool, inTransaction, toolOk, ToolBlockedError, type ToolContext } from "../types.js";

type Db = Prisma.TransactionClient | ToolContext["prisma"];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BoardRef = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe("The board: its id, its link (…/board?board=<id>, pasted as it is) or its exact title.");
const ColumnRef = z.string().trim().min(1).max(120).describe("A column of that board: its name or id.");

/** The id in a pasted board link (`/board?board=<id>`) or a bare id; null for a title. */
export function boardIdIn(text: string): string | null {
  const linked = /[?&]board=([0-9a-f-]{36})/i.exec(text)?.[1];
  if (linked && UUID.test(linked)) return linked.toLowerCase();
  const bare = text.trim();
  return new RegExp(`^${UUID.source}$`, "i").test(bare) ? bare.toLowerCase() : null;
}

/** Names compare by their letters and digits, any case, with a trailing "board" left off: "Ensemble Work board" finds “EnsembleWork”. */
const nameKey = (name: string): string => name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const titleKeys = (name: string): string[] => {
  const key = nameKey(name);
  return key.endsWith("board") && key.length > 5 ? [key, key.slice(0, -5)] : [key];
};

const boardUrl = (id: string) => hubUrl(`/board?board=${id}`);
/** A board's read stays within one tool result (assistant/agent.ts, 6,000 characters). */
const READ_CHARS = 5_600;

function notHere(ctx: ToolContext, what: string): ToolBlockedError {
  // A node acts in several spaces: its board may be in another one.
  return new ToolBlockedError(
    `${what} is not in ${ctx.space ? `“${ctx.space.name}”` : "this space"}.`,
    ctx.space ? "Boards belong to one space: call hub_list_boards with another space your owner can open." : "Call hub_list_boards and use a board it returns.",
  );
}

/** The board a call names, by id, link or title, in this call's space. */
async function findBoard(ctx: ToolContext, db: Db, ref: string, lock = false) {
  const id = boardIdIn(ref);
  if (id) {
    try {
      return await ownedBoard(db as Prisma.TransactionClient, ctx.userId, id, lock);
    } catch (error) {
      if (error instanceof TaskPageError && error.code === "BOARD_NOT_FOUND") throw notHere(ctx, "That board");
      throw error;
    }
  }
  const boards = await db.pageBoard.findMany({ where: { userId: ctx.userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const wanted = titleKeys(ref);
  const named = boards.filter((board) => titleKeys(board.title).some((key) => wanted.includes(key)));
  if (named.length > 1) throw new ToolBlockedError(`More than one board is called “${ref}”.`, `Name it by id: ${named.map((board) => `“${board.title}” ${board.id}`).join(", ")}.`);
  if (!named.length) {
    const list = boards.map((board) => `“${board.title}”`).join(", ");
    throw new ToolBlockedError(
      `No board called “${ref}” in ${ctx.space ? `“${ctx.space.name}”` : "this space"}.`,
      boards.length ? `Its boards: ${list}.${ctx.space ? " Boards belong to one space: another space may have it." : ""}` : `It has no custom boards.${ctx.space ? " Another space your owner can open may have it (hub_list_boards with space)." : ""}`,
    );
  }
  return lock ? ownedBoard(db as Prisma.TransactionClient, ctx.userId, named[0]!.id, true) : named[0]!;
}

function findColumn(columns: readonly PageBoardColumn[], ref: string, board: string): PageBoardColumn {
  const key = nameKey(ref);
  const found = columns.find((column) => column.id === ref.trim().toLowerCase()) ?? columns.find((column) => nameKey(column.name) === key);
  if (!found) throw new ToolBlockedError(`“${board}” has no column “${ref}”.`, `Its columns: ${columns.map((column) => `“${column.name}”`).join(", ")}.`);
  return found;
}

const columnsOf = (board: { columns: unknown }) => PageBoardColumns.parse(board.columns);

/** A colour that reads as the column's name: done green, in progress blue, review violet, blocked rose; else gray. */
function colorFor(name: string): z.infer<typeof BoardColor> {
  if (/\b(done|complete[d]?|shipped|finished|closed|released)\b/i.test(name)) return "green";
  if (/\b(in progress|doing|active|ongoing|on-going|working)\b/i.test(name)) return "blue";
  if (/\b(review|testing|qa|check)\b/i.test(name)) return "violet";
  if (/\b(blocked|stuck|waiting)\b/i.test(name)) return "rose";
  if (/\b(next|ready|planned|up next)\b/i.test(name)) return "amber";
  return "gray";
}

const itemSelect = {
  id: true, title: true, taskId: true, boardColumnId: true, boardOrder: true,
  task: { select: { id: true, title: true, status: true, due: true, priority: true, owner: true } },
} satisfies Prisma.TaskPageSelect;
type Item = Prisma.TaskPageGetPayload<{ select: typeof itemSelect }>;

/** A card as the model reads it: a task (with its status) or a note, by the id other tools take. */
function card(item: Item) {
  if (item.task) {
    return {
      kind: "task" as const,
      id: item.task.id,
      title: item.task.title || item.title || "Untitled",
      status: item.task.status,
      ...(item.task.due ? { due: item.task.due.toISOString().slice(0, 10) } : {}),
      // The usual values are left out to keep a long board readable: priority p1 (Medium), owner me.
      ...(item.task.priority !== "p1" ? { priority: item.task.priority } : {}),
      ...(item.task.owner !== "me" ? { owner: item.task.owner } : {}),
    };
  }
  return { kind: "page" as const, id: item.id, title: item.title || "Untitled" };
}

/** The card a call names: a task (taskId) or a note (pageId), with its title and where it is now. */
async function findCard(ctx: ToolContext, db: Db, input: { taskId?: string; pageId?: string }) {
  if (input.taskId) {
    const task = await db.task.findFirst({ where: { id: input.taskId, userId: ctx.userId, deletedAt: null }, select: { id: true, title: true, page: { select: { boardId: true, boardColumnId: true } } } });
    if (!task) throw new ToolBlockedError(`That task is not in ${ctx.space ? `“${ctx.space.name}”` : "this space"}.`, "Call hub_list_tasks (or hub_read_board) and use an id it returns.");
    return { kind: "task" as const, id: task.id, title: task.title || "Untitled", boardId: task.page?.boardId ?? null, columnId: task.page?.boardColumnId ?? null };
  }
  const page = await db.taskPage.findFirst({ where: { id: input.pageId!, userId: ctx.userId, taskId: null, deletedAt: null }, select: { id: true, title: true, boardId: true, boardColumnId: true } });
  if (!page) throw new ToolBlockedError(`That note is not in ${ctx.space ? `“${ctx.space.name}”` : "this space"}.`, "Call hub_list_pages (or hub_read_board) and use an id it returns.");
  return { kind: "page" as const, id: page.id, title: page.title || "Untitled", boardId: page.boardId, columnId: page.boardColumnId };
}

const Card = {
  taskId: z.string().uuid().optional().describe("A task: its card is the task's page."),
  pageId: z.string().uuid().optional().describe("A note (standalone page)."),
};
const oneCard = (value: { taskId?: string; pageId?: string }) => Boolean(value.taskId) !== Boolean(value.pageId);
const ONE_CARD = { message: "Give taskId or pageId (one of them)." };

/** Readable failures from the board rules (a column that still has cards, a page moved meanwhile). */
async function boardRules<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TaskPageError) {
      if (error.code === "COLUMN_NOT_EMPTY") throw new ToolBlockedError("That column still has cards (pages in Trash count too).", "Move them to another column first with hub_move_to_board, or take them off with hub_remove_from_board.");
      throw new ToolBlockedError(error.message);
    }
    throw error;
  }
}

function changed(ctx: ToolContext, taskId?: string) {
  sseHub.publish(ctx.userId, { event: "board", data: {} });
  if (taskId) sseHub.publish(ctx.userId, { event: "task", data: { id: taskId, action: "board" } });
}

const INVALIDATE = ["boards", "pages", "tasks"];

const ColumnEdit = z
  .object({
    action: z.enum(["add", "rename", "move", "remove", "color"]),
    column: ColumnRef.optional().describe("The column to rename, move, recolour or remove (its name or id). Not for add."),
    name: z.string().trim().min(1).max(80).optional().describe("add: the new column's name. rename: its new name."),
    color: BoardColor.optional().describe("add or color: gray, blue, violet, amber, green or rose."),
    position: z.number().int().min(1).max(20).optional().describe("add or move: its place from the left, 1 first. add without it: at the end."),
  })
  .refine((edit) => (edit.action === "add" ? Boolean(edit.name) : Boolean(edit.column)), { message: "add needs name; the others need column." })
  .refine((edit) => edit.action !== "rename" || Boolean(edit.name), { message: "rename needs name." })
  .refine((edit) => edit.action !== "move" || edit.position !== undefined, { message: "move needs position." })
  .refine((edit) => edit.action !== "color" || Boolean(edit.color), { message: "color needs color." });
type ColumnEdit = z.infer<typeof ColumnEdit>;

/** The columns after these edits, in order; each edit refers to the columns as the previous edits left them. */
function editColumns(current: readonly PageBoardColumn[], edits: readonly ColumnEdit[], board: string): { columns: PageBoardColumn[]; said: string[] } {
  const columns = [...current];
  const said: string[] = [];
  for (const edit of edits) {
    if (edit.action === "add") {
      if (columns.some((column) => nameKey(column.name) === nameKey(edit.name!))) throw new ToolBlockedError(`“${board}” already has a column “${edit.name}”.`);
      const added = { id: randomUUID(), name: edit.name!, color: edit.color ?? colorFor(edit.name!) };
      columns.splice(edit.position ? Math.min(edit.position, columns.length + 1) - 1 : columns.length, 0, added);
      said.push(`add column “${added.name}”`);
      continue;
    }
    const column = findColumn(columns, edit.column!, board);
    const at = columns.indexOf(column);
    if (edit.action === "rename") {
      columns[at] = { ...column, name: edit.name! };
      said.push(`rename “${column.name}” to “${edit.name}”`);
    } else if (edit.action === "color") {
      columns[at] = { ...column, color: edit.color! };
      said.push(`colour “${column.name}” ${edit.color}`);
    } else if (edit.action === "move") {
      columns.splice(at, 1);
      columns.splice(Math.min(edit.position!, columns.length + 1) - 1, 0, column);
      said.push(`move “${column.name}” to place ${Math.min(edit.position!, columns.length)}`);
    } else {
      columns.splice(at, 1);
      said.push(`remove column “${column.name}”`);
    }
  }
  const parsed = PageBoardColumns.safeParse(columns);
  if (!parsed.success) throw new ToolBlockedError(columns.length ? "A board has 1 to 20 columns, each with a name." : "A board keeps at least one column.");
  return { columns: parsed.data, said };
}

const CardPlace = z
  .object({
    board: BoardRef,
    column: ColumnRef,
    ...Card,
    after: z.string().uuid().optional().describe("Place it just below this card (a task or note id in that column)."),
    before: z.string().uuid().optional().describe("Place it just above this card (a task or note id in that column)."),
    position: z.enum(["top", "bottom"]).optional().describe("Without after or before: top, or bottom (the default)."),
  })
  .refine(oneCard, ONE_CARD);

export const boardTools = [
  defineTool({
    name: "hub_list_boards",
    area: "tasks",
    description:
      "List the custom boards in this space (the person's own boards, opened at /board?board=<id>, beside the Ensemble board): title, description, columns and how many cards each has. query matches the title. A board's cards: hub_read_board.",
    input: z.object({ query: z.string().trim().min(1).max(200).optional() }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const all = await listBoards(ctx.prisma, ctx.userId);
      const wanted = input.query ? nameKey(input.query) : "";
      const boards = wanted ? all.filter((board) => titleKeys(board.title).some((key) => key.includes(wanted) || (key.length >= 3 && wanted.includes(key)))) : all;
      const rows = boards.map((board) => ({
        id: board.id,
        title: board.title,
        ...(board.description ? { description: board.description } : {}),
        columns: board.columns.map((column) => column.name),
        cards: board.pageCount,
        url: boardUrl(board.id),
      }));
      const summary = rows.length
        ? `Listed ${rows.length} custom board${rows.length === 1 ? "" : "s"}${input.query ? ` matching “${input.query}”` : ""}.`
        : all.length
          ? `No custom board matches “${input.query}”; this space has ${all.length}: ${all.map((board) => `“${board.title}”`).join(", ")}.`
          : "This space has no custom boards. Its tasks on the Ensemble board: hub_list_tasks.";
      return toolOk(summary, { boards: rows });
    },
  }),
  defineTool({
    name: "hub_read_board",
    area: "tasks",
    description:
      "Read one custom board: its columns in order and the cards in each, top first: tasks (kind task: id, title, status, due, priority, owner) and notes (kind page: id, title). board is its id, its link as pasted (https://…/board?board=<id>) or its exact title. column reads one column only; limit and offset are per column.",
    input: z.object({
      board: BoardRef,
      column: ColumnRef.optional(),
      limit: z.number().int().min(1).max(100).default(30),
      offset: z.number().int().min(0).max(5000).default(0).describe("Skip this many cards in each column: the next part of a long column."),
    }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const board = await findBoard(ctx, ctx.prisma, input.board);
      const columns = columnsOf(board);
      const shown = input.column ? [findColumn(columns, input.column, board.title)] : columns;
      const items = await ctx.prisma.taskPage.findMany({
        where: { ...visibleBoardPages(ctx.userId), boardId: board.id, ...(input.column ? { boardColumnId: shown[0]!.id } : {}) },
        select: itemSelect,
        orderBy: [{ boardOrder: "asc" }, { id: "asc" }],
      });
      const total = input.column ? await ctx.prisma.taskPage.count({ where: { ...visibleBoardPages(ctx.userId), boardId: board.id } }) : items.length;
      const record: PageBoardRecord = boardDto(board, total);
      const read = (limit: number) => {
        const lanes = shown.map((column) => {
          const here = items.filter((item) => item.boardColumnId === column.id);
          return {
            id: column.id,
            name: column.name,
            count: here.length,
            cards: here.slice(input.offset, input.offset + limit).map(card),
            ...(here.length > input.offset + limit ? { more: here.length - input.offset - limit } : {}),
          };
        });
        return {
          board: { id: record.id, title: record.title, ...(record.description ? { description: record.description } : {}), url: boardUrl(record.id) },
          columns: lanes,
          ...(input.column ? { otherColumns: columns.filter((column) => column.id !== shown[0]!.id).map((column) => column.name) } : {}),
        };
      };
      // Whole cards in every column rather than a cut-off text: fewer per column until the answer fits one tool result.
      let limit = input.limit;
      let data = read(limit);
      while (limit > 1 && JSON.stringify(data).length > READ_CHARS) data = read((limit = Math.max(1, Math.floor(limit * 0.7))));
      const cut = data.columns.some((lane) => "more" in lane);
      return toolOk(
        `Read board “${board.title}”: ${columns.length} column${columns.length === 1 ? "" : "s"}, ${total} card${total === 1 ? "" : "s"}${input.column ? `; column “${shown[0]!.name}” has ${data.columns[0]!.count}` : ""}.${cut ? ` Some columns show ${input.offset ? "part of their cards" : "their top cards only"} (more: how many are left after them): read one column with column and offset ${input.offset + limit} for the next.` : ""}`,
        data,
        { href: `/board?board=${board.id}` },
      );
    },
  }),
  defineTool({
    name: "hub_create_board",
    area: "tasks",
    description:
      "Make a custom board: a title, an optional description and its columns in order (names; default To do, In progress, Done). Cards are added with hub_move_to_board.",
    input: z.object({
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).optional(),
      columns: z.array(z.string().trim().min(1).max(80)).min(1).max(20).optional().describe("Column names, left to right."),
    }),
    isWrite: true,
    risk: "low",
    preview(_ctx, input) {
      return `Make board “${input.title}” with columns ${(input.columns ?? ["To do", "In progress", "Done"]).map((name) => `“${name}”`).join(", ")}`;
    },
    async run(ctx, input) {
      const names = input.columns ?? ["To do", "In progress", "Done"];
      if (new Set(names.map(nameKey)).size !== names.length) throw new ToolBlockedError("Give each column a different name.");
      const board = await inTransaction(ctx, (tx) =>
        createBoard(tx, ctx.userId, { title: input.title, description: input.description ?? "", columns: names.map((name) => ({ id: randomUUID(), name, color: colorFor(name) })) }),
      );
      changed(ctx);
      return toolOk(
        `Made board “${board.title}” with ${board.columns.length} column${board.columns.length === 1 ? "" : "s"}.`,
        { board: { id: board.id, title: board.title, columns: board.columns.map((column) => ({ id: column.id, name: column.name })), url: boardUrl(board.id) } },
        { href: `/board?board=${board.id}`, invalidate: INVALIDATE },
      );
    },
  }),
  defineTool({
    name: "hub_update_board",
    area: "tasks",
    description:
      "Change a custom board: its title, description, overview tiles, and columns with edits in order: add {name, color?, position?}, rename {column, name}, move {column, position} (1 is leftmost), color {column, color}, remove {column} (only an empty column: move its cards first). Cards stay where they are.",
    input: z.object({
      board: BoardRef,
      title: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(500).optional(),
      columns: z.array(ColumnEdit).min(1).max(20).optional(),
      tiles: PageBoardTiles.optional().describe("The board's overview tiles, all of them, in order (at most 4): count, distribution (by column), flow, recent."),
    }),
    isWrite: true,
    risk: "low",
    async prepare(ctx, input) {
      const board = await findBoard(ctx, ctx.prisma, input.board);
      return { ...input, board: board.id };
    },
    async preview(ctx, input) {
      const board = await findBoard(ctx, ctx.prisma, input.board);
      const said = [
        input.title && input.title !== board.title ? `rename it “${input.title}”` : "",
        input.description !== undefined ? "change its description" : "",
        input.tiles ? `tiles ${input.tiles.join(", ") || "none"}` : "",
        ...(input.columns ? editColumns(columnsOf(board), input.columns, board.title).said : []),
      ].filter(Boolean);
      return `Change board “${board.title}”${said.length ? `: ${said.join("; ")}` : ""}`;
    },
    async run(ctx, input) {
      if (input.title === undefined && input.description === undefined && !input.columns && !input.tiles) throw new ToolBlockedError("Say what to change: title, description, columns or tiles.");
      const done = await inTransaction(ctx, (tx) =>
        boardRules(async () => {
          const board = await findBoard(ctx, tx, input.board, true);
          const edited = input.columns ? editColumns(columnsOf(board), input.columns, board.title) : null;
          const saved = await updateBoard(tx, ctx.userId, board.id, board.revision, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.tiles ? { tiles: input.tiles } : {}),
            ...(edited ? { columns: edited.columns } : {}),
          });
          return { before: board.title, saved, said: edited?.said ?? [] };
        }),
      );
      changed(ctx);
      const said = [done.saved.title !== done.before ? `renamed it “${done.saved.title}”` : "", input.description !== undefined ? "changed its description" : "", input.tiles ? `tiles ${input.tiles.join(", ") || "none"}` : "", ...done.said.map((line) => line.replace(/^add /, "added ").replace(/^rename /, "renamed ").replace(/^move /, "moved ").replace(/^remove /, "removed ").replace(/^colour /, "coloured "))].filter(Boolean);
      return toolOk(
        `Changed board “${done.before}”${said.length ? `: ${said.join("; ")}` : ""}.`,
        { board: { id: done.saved.id, title: done.saved.title, columns: done.saved.columns.map((column) => ({ id: column.id, name: column.name })), url: boardUrl(done.saved.id) } },
        { href: `/board?board=${done.saved.id}`, invalidate: INVALIDATE },
      );
    },
  }),
  defineTool({
    name: "hub_delete_board",
    area: "tasks",
    description:
      "Delete a custom board. Its cards are kept: notes stay in Pages, task pages go back to the Ensemble board. It cannot be undone, so it always waits for the person's Apply.",
    input: z.object({ board: BoardRef }),
    isWrite: true,
    risk: "medium",
    alwaysHold: true,
    async prepare(ctx, input) {
      return { board: (await findBoard(ctx, ctx.prisma, input.board)).id };
    },
    async preview(ctx, input) {
      const board = await findBoard(ctx, ctx.prisma, input.board);
      const cards = await ctx.prisma.taskPage.count({ where: { ...visibleBoardPages(ctx.userId), boardId: board.id } });
      return `Delete board “${board.title}” (${cards} card${cards === 1 ? "" : "s"}: notes stay in Pages, tasks go back to the Ensemble board)`;
    },
    async run(ctx, input) {
      const title = await inTransaction(ctx, async (tx) => {
        const board = await findBoard(ctx, tx, input.board, true);
        await deleteBoard(tx, ctx.userId, board.id);
        return board.title;
      });
      changed(ctx);
      sseHub.publish(ctx.userId, { event: "task", data: { action: "board" } });
      return toolOk(`Deleted board “${title}”. Its notes are in Pages and its tasks are back on the Ensemble board.`, { board: { title } }, { href: "/board", invalidate: INVALIDATE });
    },
  }),
  defineTool({
    name: "hub_move_to_board",
    area: "tasks",
    description:
      "Put a task (taskId) or a note (pageId) on a custom board's column, or move it to another column or place: after or before another card in that column, or position top or bottom. A card is on one board at a time: putting it on another board takes it off the first. A task's status does not change (use hub_update_task for that).",
    input: CardPlace,
    isWrite: true,
    risk: "low",
    async prepare(ctx, input) {
      const board = await findBoard(ctx, ctx.prisma, input.board);
      return { ...input, board: board.id, column: findColumn(columnsOf(board), input.column, board.title).id };
    },
    async preview(ctx, input) {
      const board = await findBoard(ctx, ctx.prisma, input.board);
      const column = findColumn(columnsOf(board), input.column, board.title);
      const item = await findCard(ctx, ctx.prisma, input);
      return `${item.boardId === board.id ? "Move" : "Put"} “${item.title}” ${item.boardId === board.id ? "to" : "on"} “${board.title}” in “${column.name}”`;
    },
    async run(ctx, input) {
      const done = await inTransaction(ctx, (tx) =>
        boardRules(async () => {
          const board = await findBoard(ctx, tx, input.board);
          const column = findColumn(columnsOf(board), input.column, board.title);
          const item = await findCard(ctx, tx, input);
          const from = item.boardId === board.id ? columnsOf(board).find((row) => row.id === item.columnId) ?? null : null;
          if (input.after === item.id || input.before === item.id) throw new ToolBlockedError("Place it next to another card, not itself.");
          // The cards it lands between, as the Board screen sends them: the one above (beforeId) and the one below (afterId).
          let beforeId: string | null = input.after ?? null;
          let afterId: string | null = input.before ?? null;
          if (beforeId || afterId || input.position === "top") {
            const lane = (await tx.taskPage.findMany({
              where: { ...visibleBoardPages(ctx.userId), boardId: board.id, boardColumnId: column.id, NOT: item.kind === "task" ? { taskId: item.id } : { id: item.id } },
              orderBy: [{ boardOrder: "asc" }, { id: "asc" }],
              select: { id: true, taskId: true },
            })).map((row) => row.taskId ?? row.id);
            const at = (id: string) => {
              const index = lane.indexOf(id);
              if (index < 0) throw new ToolBlockedError(`That card is not in “${column.name}” on “${board.title}”.`, "Name a card from that column (hub_read_board), or use position top or bottom.");
              return index;
            };
            if (beforeId && !afterId) afterId = lane[at(beforeId) + 1] ?? null;
            else if (afterId && !beforeId) beforeId = lane[at(afterId) - 1] ?? null;
            else if (!beforeId && !afterId) afterId = lane[0] ?? null;
          }
          await assignBoardPage(tx, ctx.userId, item.kind, item.id, { boardId: board.id, columnId: column.id, beforeId, afterId });
          const left = item.boardId && item.boardId !== board.id ? await tx.pageBoard.findFirst({ where: { id: item.boardId, userId: ctx.userId }, select: { title: true } }) : null;
          return { board, column, item, from, left };
        }),
      );
      changed(ctx, done.item.kind === "task" ? done.item.id : undefined);
      const what = `“${done.item.title}”`;
      const summary = done.from
        ? done.from.id === done.column.id
          ? `Moved ${what} within “${done.column.name}” on “${done.board.title}”.`
          : `Moved ${what} from “${done.from.name}” to “${done.column.name}” on “${done.board.title}”.`
        : `Put ${what} on “${done.board.title}” in “${done.column.name}”${done.left ? ` (off “${done.left.title}”)` : ""}.`;
      return toolOk(
        summary,
        { card: { kind: done.item.kind, id: done.item.id, title: done.item.title }, board: { id: done.board.id, title: done.board.title, url: boardUrl(done.board.id) }, column: done.column.name },
        { href: `/board?board=${done.board.id}`, invalidate: INVALIDATE },
      );
    },
  }),
  defineTool({
    name: "hub_remove_from_board",
    area: "tasks",
    description: "Take a task (taskId) or a note (pageId) off its custom board. Nothing is deleted: a note stays in Pages, a task goes back to the Ensemble board.",
    input: z.object(Card).refine(oneCard, ONE_CARD),
    isWrite: true,
    risk: "low",
    async preview(ctx, input) {
      const item = await findCard(ctx, ctx.prisma, input);
      const board = item.boardId ? await ctx.prisma.pageBoard.findFirst({ where: { id: item.boardId, userId: ctx.userId }, select: { title: true } }) : null;
      return board ? `Take “${item.title}” off “${board.title}”` : `“${item.title}” is on no custom board`;
    },
    async run(ctx, input) {
      const done = await inTransaction(ctx, (tx) =>
        boardRules(async () => {
          const item = await findCard(ctx, tx, input);
          if (!item.boardId) return { item, board: null };
          const board = await tx.pageBoard.findFirst({ where: { id: item.boardId, userId: ctx.userId }, select: { title: true } });
          await assignBoardPage(tx, ctx.userId, item.kind, item.id, { boardId: null, columnId: null });
          return { item, board };
        }),
      );
      if (!done.board) return toolOk(`“${done.item.title}” is on no custom board.`, { card: { kind: done.item.kind, id: done.item.id, title: done.item.title } });
      changed(ctx, done.item.kind === "task" ? done.item.id : undefined);
      return toolOk(
        `Took “${done.item.title}” off “${done.board.title}”: ${done.item.kind === "task" ? "the task is back on the Ensemble board" : "the note stays in Pages"}.`,
        { card: { kind: done.item.kind, id: done.item.id, title: done.item.title } },
        { invalidate: INVALIDATE },
      );
    },
  }),
];

/** The custom board a Hub path opens (`/board?board=<id>`), for hub_read_surface. */
export function boardOfPath(url: URL): string | null {
  const id = url.searchParams.get("board");
  return id && boardIdIn(id) ? id : null;
}
