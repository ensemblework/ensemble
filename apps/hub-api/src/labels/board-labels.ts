/**
 * Board labels (docs/02 §3.2): each board keeps its own list of labels that its pages, tasks and
 * deliverables pick from. Items keep label names (`Task.labels`, a standalone note's `TaskPage.labels`,
 * `Deliverable.labels`), so everything that reads names keeps working; this list gives each its colour.
 *
 * A board is a key: a custom board's id, or "" for the Ensemble board. Items on no board (standalone
 * notes off every board, deliverables) use the Ensemble board's list. Every write of names goes through
 * `resolveLabels`: a name the board has takes the board's spelling, a new one is added to the board.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ENSEMBLE_LABEL_BOARD,
  LabelColor,
  MAX_TASK_LABELS,
  cleanLabelName,
  labelTone,
  nextLabelColor,
  type BoardLabelList,
  type BoardLabelRecord,
} from "@ensemble/shared-types";

type Db = Prisma.TransactionClient | PrismaClient;

/** The Ensemble board's key. */
export const ENSEMBLE_KEY = "";
export const ENSEMBLE_BOARD_TITLE = "Ensemble board";

export class LabelError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export type LabelItem = { kind: "task" | "page" | "deliverable"; id: string };

/** The id clients use for a board key. */
export function boardIdOf(key: string): string {
  return key || ENSEMBLE_LABEL_BOARD;
}

/** A board id from a client (`ensemble` or a custom board's id) as a key, checked against the space. */
export async function boardKeyFor(db: Db, userId: string, board: string): Promise<{ key: string; title: string }> {
  if (board === ENSEMBLE_LABEL_BOARD || board === ENSEMBLE_KEY) return { key: ENSEMBLE_KEY, title: ENSEMBLE_BOARD_TITLE };
  const found = await db.pageBoard.findFirst({ where: { id: board, userId }, select: { id: true, title: true } });
  if (!found) throw new LabelError("Board not found.", 404);
  return { key: found.id, title: found.title };
}

/** The board an item takes its labels from. */
export async function itemBoardKey(db: Db, userId: string, item: LabelItem): Promise<string> {
  if (item.kind === "deliverable") {
    const found = await db.deliverable.findFirst({ where: { id: item.id, userId, deletedAt: null }, select: { id: true } });
    if (!found) throw new LabelError("Deliverable not found.", 404);
    return ENSEMBLE_KEY;
  }
  if (item.kind === "task") {
    const task = await db.task.findFirst({ where: { id: item.id, userId, deletedAt: null }, select: { page: { select: { boardId: true } } } });
    if (!task) throw new LabelError("Task not found.", 404);
    return task.page?.boardId ?? ENSEMBLE_KEY;
  }
  const page = await db.taskPage.findFirst({ where: { id: item.id, userId, taskId: null, deletedAt: null }, select: { boardId: true } });
  if (!page) throw new LabelError("Page not found.", 404);
  return page.boardId ?? ENSEMBLE_KEY;
}

/** The board a task's labels belong to, for a task that exists. */
export async function taskBoardKey(db: Db, userId: string, taskId: string): Promise<string> {
  const page = await db.taskPage.findFirst({ where: { userId, taskId }, select: { boardId: true } });
  return page?.boardId ?? ENSEMBLE_KEY;
}

const labelSelect = { id: true, name: true, nameKey: true, color: true, position: true } satisfies Prisma.BoardLabelSelect;
type Stored = Prisma.BoardLabelGetPayload<{ select: typeof labelSelect }>;

function colorOf(row: { name: string; color: string | null }): LabelColor {
  const parsed = LabelColor.safeParse(row.color);
  return parsed.success ? parsed.data : labelTone(row.name);
}

/** Cleaned names, each once whatever its case, at most MAX_TASK_LABELS. */
export function cleanNames(names: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of names) {
    const name = cleanLabelName(value.replace(/^#/, ""));
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= MAX_TASK_LABELS) break;
  }
  return out;
}

/**
 * Resolves names against boards, loading each board's list once. Imports and moves resolve many items
 * with one book; a single write uses `resolveLabels`.
 */
export class LabelBook {
  private boards = new Map<string, Map<string, Stored>>();

  constructor(private readonly db: Db, private readonly userId: string) {}

  private async load(key: string): Promise<Map<string, Stored>> {
    let board = this.boards.get(key);
    if (!board) {
      const rows = await this.db.boardLabel.findMany({ where: { userId: this.userId, boardKey: key }, select: labelSelect });
      board = new Map(rows.map((row) => [row.nameKey, row]));
      this.boards.set(key, board);
    }
    return board;
  }

  /** The colours of a board's labels by name, for carrying them to another board. */
  async colors(key: string): Promise<Map<string, LabelColor>> {
    const board = await this.load(key);
    return new Map([...board.values()].map((row) => [row.nameKey, colorOf(row)]));
  }

  /**
   * The names as the board spells them, each once. Names the board lacks are added to it, with the
   * colour in `colors` (by lower-case name) or the next free one.
   */
  async resolve(key: string, names: Iterable<string>, colors?: ReadonlyMap<string, LabelColor>): Promise<string[]> {
    const wanted = cleanNames(names);
    if (!wanted.length) return [];
    const board = await this.load(key);
    const missing = wanted.filter((name) => !board.has(name.toLowerCase()));
    if (missing.length) {
      const used = [...board.values()].map(colorOf);
      let position = Math.max(-1, ...[...board.values()].map((row) => row.position)) + 1;
      const data = missing.map((name) => {
        const color = colors?.get(name.toLowerCase()) ?? nextLabelColor(name, used);
        used.push(color);
        return { userId: this.userId, boardKey: key, name, nameKey: name.toLowerCase(), color, position: position++ };
      });
      // Another write may add the same name at the same moment: keep whichever landed first.
      await this.db.boardLabel.createMany({ data, skipDuplicates: true });
      const rows = await this.db.boardLabel.findMany({
        where: { userId: this.userId, boardKey: key, nameKey: { in: missing.map((name) => name.toLowerCase()) } },
        select: labelSelect,
      });
      for (const row of rows) board.set(row.nameKey, row);
    }
    return wanted.map((name) => board.get(name.toLowerCase())?.name ?? name);
  }
}

/** Names as the board spells them; names it lacks are added to it. */
export async function resolveLabels(db: Db, userId: string, key: string, names: Iterable<string>): Promise<string[]> {
  return new LabelBook(db, userId).resolve(key, names);
}

/** Labels moving with an item from one board to another: the destination's spelling, the source's colours. */
export async function carryLabels(book: LabelBook, from: string, to: string, names: string[]): Promise<string[]> {
  if (!names.length) return [];
  if (from === to) return book.resolve(to, names);
  return book.resolve(to, names, await book.colors(from));
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Moves a task's or a note's labels to the board it is moving to. Call before the move is written. */
export async function carryItemLabels(db: Db, userId: string, item: { kind: "task" | "page"; id: string }, from: string, to: string): Promise<void> {
  if (from === to) return;
  const book = new LabelBook(db, userId);
  if (item.kind === "task") {
    const task = await db.task.findFirst({ where: { id: item.id, userId }, select: { labels: true } });
    if (!task?.labels.length) return;
    const labels = await carryLabels(book, from, to, task.labels);
    if (!sameNames(labels, task.labels)) await db.task.update({ where: { id: item.id }, data: { labels } });
    return;
  }
  const page = await db.taskPage.findFirst({ where: { id: item.id, userId, taskId: null }, select: { labels: true } });
  if (!page?.labels.length) return;
  const labels = await carryLabels(book, from, to, page.labels);
  if (!sameNames(labels, page.labels)) await db.taskPage.update({ where: { id: item.id }, data: { labels } });
}

/**
 * A custom board is going away: its tasks return to the Ensemble board and its notes become
 * independent, so their labels move to the Ensemble board's list with their colours. Then its own list goes.
 */
export async function retireBoardLabels(db: Db, userId: string, boardId: string): Promise<void> {
  const book = new LabelBook(db, userId);
  const tasks = await db.task.findMany({ where: { userId, page: { is: { boardId } }, NOT: { labels: { isEmpty: true } } }, select: { id: true, labels: true } });
  for (const task of tasks) {
    const labels = await carryLabels(book, boardId, ENSEMBLE_KEY, task.labels);
    if (!sameNames(labels, task.labels)) await db.task.update({ where: { id: task.id }, data: { labels } });
  }
  const notes = await db.taskPage.findMany({ where: { userId, boardId, taskId: null, NOT: { labels: { isEmpty: true } } }, select: { id: true, labels: true } });
  for (const note of notes) {
    const labels = await carryLabels(book, boardId, ENSEMBLE_KEY, note.labels);
    if (!sameNames(labels, note.labels)) await db.taskPage.update({ where: { id: note.id }, data: { labels } });
  }
  await db.boardLabel.deleteMany({ where: { userId, boardKey: boardId } });
}

function recordOf(row: Stored, count: number): BoardLabelRecord {
  return { id: row.id, name: row.name, color: colorOf(row), count };
}

/** How many of a board's items (Trash left out) have each label, by lower-case name. */
async function labelCounts(db: Db, userId: string, key: string): Promise<Map<string, number>> {
  const rows = key
    ? await db.$queryRaw<Array<{ name_key: string; n: number }>>`
        SELECT name_key, count(*)::int AS n FROM (
          SELECT lower(l) AS name_key FROM tasks t JOIN task_pages p ON p.task_id = t.id, unnest(t.labels) AS l
          WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND p.board_id = ${key}
          UNION ALL
          SELECT lower(l) FROM task_pages p, unnest(p.labels) AS l
          WHERE p.user_id = ${userId} AND p.task_id IS NULL AND p.deleted_at IS NULL AND p.board_id = ${key}
        ) x GROUP BY name_key`
    : await db.$queryRaw<Array<{ name_key: string; n: number }>>`
        SELECT name_key, count(*)::int AS n FROM (
          SELECT lower(l) AS name_key FROM tasks t LEFT JOIN task_pages p ON p.task_id = t.id, unnest(t.labels) AS l
          WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND p.board_id IS NULL
          UNION ALL
          SELECT lower(l) FROM task_pages p, unnest(p.labels) AS l
          WHERE p.user_id = ${userId} AND p.task_id IS NULL AND p.deleted_at IS NULL AND p.board_id IS NULL
          UNION ALL
          SELECT lower(l) FROM deliverables d, unnest(d.labels) AS l
          WHERE d.user_id = ${userId} AND d.deleted_at IS NULL
        ) x GROUP BY name_key`;
  return new Map(rows.map((row) => [row.name_key, Number(row.n)]));
}

/** A board's labels in order, each with how many of its items have it. */
export async function listBoardLabels(db: Db, userId: string, key: string): Promise<BoardLabelRecord[]> {
  const [rows, counts] = await Promise.all([
    db.boardLabel.findMany({ where: { userId, boardKey: key }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: labelSelect }),
    labelCounts(db, userId, key),
  ]);
  return rows.map((row) => recordOf(row, counts.get(row.nameKey) ?? 0));
}

export async function boardLabelList(db: Db, userId: string, board: { key: string; title: string }): Promise<BoardLabelList> {
  return { board: { id: boardIdOf(board.key), title: board.title }, labels: await listBoardLabels(db, userId, board.key) };
}

/** Adds a label to a board, or returns the one it has by that name (any case). */
export async function createBoardLabel(db: Db, userId: string, key: string, input: { name: string; color?: LabelColor }): Promise<{ label: BoardLabelRecord; created: boolean }> {
  const name = cleanLabelName(input.name);
  if (!name) throw new LabelError("Give the label a name.");
  const existing = await db.boardLabel.findFirst({ where: { userId, boardKey: key, nameKey: name.toLowerCase() }, select: labelSelect });
  if (existing) return { label: recordOf(existing, (await labelCounts(db, userId, key)).get(existing.nameKey) ?? 0), created: false };
  const book = new LabelBook(db, userId);
  await book.resolve(key, [name], input.color ? new Map([[name.toLowerCase(), input.color]]) : undefined);
  const row = await db.boardLabel.findFirstOrThrow({ where: { userId, boardKey: key, nameKey: name.toLowerCase() }, select: labelSelect });
  return { label: recordOf(row, 0), created: true };
}

/** The ids of a board's items that carry a label (Trash included), by table. */
async function itemsWith(db: Db, userId: string, key: string, nameKey: string) {
  const tasks = key
    ? await db.$queryRaw<Array<{ id: string }>>`SELECT t.id FROM tasks t JOIN task_pages p ON p.task_id = t.id WHERE t.user_id = ${userId} AND p.board_id = ${key} AND EXISTS (SELECT 1 FROM unnest(t.labels) AS l WHERE lower(l) = ${nameKey})`
    : await db.$queryRaw<Array<{ id: string }>>`SELECT t.id FROM tasks t LEFT JOIN task_pages p ON p.task_id = t.id WHERE t.user_id = ${userId} AND p.board_id IS NULL AND EXISTS (SELECT 1 FROM unnest(t.labels) AS l WHERE lower(l) = ${nameKey})`;
  const notes = key
    ? await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM task_pages WHERE user_id = ${userId} AND task_id IS NULL AND board_id = ${key} AND EXISTS (SELECT 1 FROM unnest(labels) AS l WHERE lower(l) = ${nameKey})`
    : await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM task_pages WHERE user_id = ${userId} AND task_id IS NULL AND board_id IS NULL AND EXISTS (SELECT 1 FROM unnest(labels) AS l WHERE lower(l) = ${nameKey})`;
  const deliverables = key ? [] : await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM deliverables WHERE user_id = ${userId} AND EXISTS (SELECT 1 FROM unnest(labels) AS l WHERE lower(l) = ${nameKey})`;
  return { tasks: tasks.map((row) => row.id), notes: notes.map((row) => row.id), deliverables: deliverables.map((row) => row.id) };
}

/** Renames (`to`) or removes (`to` null) a label on every item of its board that has it. */
async function rewriteItems(db: Db, userId: string, key: string, nameKey: string, to: string | null): Promise<number> {
  const found = await itemsWith(db, userId, key, nameKey);
  const next = (labels: string[]) => {
    const out: string[] = [];
    for (const label of labels) {
      const value = label.toLowerCase() === nameKey ? to : label;
      if (value && !out.some((kept) => kept.toLowerCase() === value.toLowerCase())) out.push(value);
    }
    return out;
  };
  for (const id of found.tasks) {
    const row = await db.task.findUniqueOrThrow({ where: { id }, select: { labels: true } });
    await db.task.update({ where: { id }, data: { labels: next(row.labels) } });
  }
  for (const id of found.notes) {
    const row = await db.taskPage.findUniqueOrThrow({ where: { id }, select: { labels: true } });
    await db.taskPage.update({ where: { id }, data: { labels: next(row.labels) } });
  }
  for (const id of found.deliverables) {
    const row = await db.deliverable.findUniqueOrThrow({ where: { id }, select: { labels: true } });
    await db.deliverable.update({ where: { id }, data: { labels: next(row.labels) } });
  }
  return found.tasks.length + found.notes.length + found.deliverables.length;
}

async function ownedLabel(db: Db, userId: string, id: string, lock = false): Promise<Stored & { boardKey: string }> {
  if (lock) await db.$queryRaw`SELECT id FROM board_labels WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`;
  const row = await db.boardLabel.findFirst({ where: { id, userId }, select: { ...labelSelect, boardKey: true } });
  if (!row) throw new LabelError("Label not found.", 404);
  return row;
}

/** Renames or recolours a label. A rename reaches every item of the board that has it. */
export async function updateBoardLabel(db: Db, userId: string, id: string, patch: { name?: string; color?: LabelColor }): Promise<{ label: BoardLabelRecord; boardKey: string; changed: number }> {
  const row = await ownedLabel(db, userId, id, true);
  const name = patch.name === undefined ? row.name : cleanLabelName(patch.name);
  if (!name) throw new LabelError("Give the label a name.");
  const nameKey = name.toLowerCase();
  if (nameKey !== row.nameKey && await db.boardLabel.findFirst({ where: { userId, boardKey: row.boardKey, nameKey }, select: { id: true } })) {
    throw new LabelError(`This board already has a label called “${name}”.`, 409);
  }
  const changed = name !== row.name ? await rewriteItems(db, userId, row.boardKey, row.nameKey, name) : 0;
  const updated = await db.boardLabel.update({
    where: { id },
    data: { name, nameKey, ...(patch.color ? { color: patch.color } : {}) },
    select: labelSelect,
  });
  const counts = await labelCounts(db, userId, row.boardKey);
  return { label: recordOf(updated, counts.get(updated.nameKey) ?? 0), boardKey: row.boardKey, changed };
}

/** Deletes a label from its board and from every item there that has it. */
export async function deleteBoardLabel(db: Db, userId: string, id: string): Promise<{ boardKey: string; changed: number }> {
  const row = await ownedLabel(db, userId, id, true);
  const changed = await rewriteItems(db, userId, row.boardKey, row.nameKey, null);
  await db.boardLabel.delete({ where: { id } });
  return { boardKey: row.boardKey, changed };
}

/** Every spelling of a label the space's boards have, for filters that match names exactly. */
export async function labelSpellings(db: Db, userId: string, name: string): Promise<string[]> {
  const nameKey = cleanLabelName(name.replace(/^#/, "")).toLowerCase();
  if (!nameKey) return [];
  const rows = await db.boardLabel.findMany({ where: { userId, nameKey }, select: { name: true } });
  return [...new Set([cleanLabelName(name.replace(/^#/, "")), ...rows.map((row) => row.name)])];
}

