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
  labelKey,
  labelTone,
  nextLabelColor,
  type BoardLabelList,
  type BoardLabelRecord,
} from "@ensemble/shared-types";
import { currentScope } from "../sharing/context.js";

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Someone a single page or task is shared with, or a public link's visitor. They see an item's labels
 * but do not change them: a label write adds to the owner's board list, which is the space's.
 */
export function labelsRefused(): boolean {
  const kind = currentScope()?.access.kind;
  return kind === "share" || kind === "link";
}
export const LABELS_REFUSED = "Only the people in this space change labels.";

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

/** Cleaned names, each once whatever its case, at most `cap` (an item holds MAX_TASK_LABELS). */
export function cleanNames(names: Iterable<string>, cap = MAX_TASK_LABELS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of names) {
    const name = cleanLabelName(value);
    if (!name || seen.has(labelKey(name))) continue;
    seen.add(labelKey(name));
    out.push(name);
    if (out.length >= cap) break;
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

  /** The colours of a board's labels by key, for carrying them to another board. */
  async colors(key: string): Promise<Map<string, LabelColor>> {
    const board = await this.load(key);
    return new Map([...board.values()].map((row) => [row.nameKey, colorOf(row)]));
  }

  /**
   * Puts cleaned names on a board's list, any number: a name it lacks is added with the colour in
   * `colors` (by key) or the next free one. Returns the board's spelling by key.
   */
  async ensure(key: string, names: readonly string[], colors?: ReadonlyMap<string, LabelColor>): Promise<Map<string, string>> {
    const board = await this.load(key);
    const missing = names.filter((name) => !board.has(labelKey(name)));
    if (missing.length) {
      const used = [...board.values()].map(colorOf);
      let position = Math.max(-1, ...[...board.values()].map((row) => row.position)) + 1;
      const data = missing.map((name) => {
        const color = colors?.get(labelKey(name)) ?? nextLabelColor(name, used);
        used.push(color);
        return { userId: this.userId, boardKey: key, name, nameKey: labelKey(name), color, position: position++ };
      });
      // Another write may add the same name at the same moment: keep whichever landed first.
      await this.db.boardLabel.createMany({ data, skipDuplicates: true });
      const rows = await this.db.boardLabel.findMany({ where: { userId: this.userId, boardKey: key, nameKey: { in: missing.map(labelKey) } }, select: labelSelect });
      for (const row of rows) board.set(row.nameKey, row);
    }
    return new Map(names.map((name) => [labelKey(name), board.get(labelKey(name))?.name ?? name]));
  }

  /** One item's names as the board spells them, each once; names the board lacks are added to it. */
  async resolve(key: string, names: Iterable<string>, colors?: ReadonlyMap<string, LabelColor>): Promise<string[]> {
    const wanted = cleanNames(names);
    if (!wanted.length) return [];
    const spelled = await this.ensure(key, wanted, colors);
    return wanted.map((name) => spelled.get(labelKey(name)) ?? name);
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

/** Which items a label rewrite reaches: every item of a board (Trash included), or one task or note. */
type Scope = { board: string } | { task: string } | { note: string };

function taskWhere(userId: string, scope: Scope): Prisma.Sql | null {
  if ("note" in scope) return null;
  if ("task" in scope) return Prisma.sql`t.user_id = ${userId} AND t.id = ${scope.task}`;
  return scope.board
    ? Prisma.sql`t.user_id = ${userId} AND EXISTS (SELECT 1 FROM task_pages p WHERE p.task_id = t.id AND p.board_id = ${scope.board})`
    : Prisma.sql`t.user_id = ${userId} AND NOT EXISTS (SELECT 1 FROM task_pages p WHERE p.task_id = t.id AND p.board_id IS NOT NULL)`;
}

function noteWhere(userId: string, scope: Scope): Prisma.Sql | null {
  if ("task" in scope) return null;
  if ("note" in scope) return Prisma.sql`n.user_id = ${userId} AND n.task_id IS NULL AND n.id = ${scope.note}`;
  return scope.board
    ? Prisma.sql`n.user_id = ${userId} AND n.task_id IS NULL AND n.board_id = ${scope.board}`
    : Prisma.sql`n.user_id = ${userId} AND n.task_id IS NULL AND n.board_id IS NULL`;
}

/** Deliverables are on no board: they use the Ensemble board's list. */
function deliverableWhere(userId: string, scope: Scope): Prisma.Sql | null {
  return "board" in scope && !scope.board ? Prisma.sql`d.user_id = ${userId}` : null;
}

/** Every spelling the items in scope hold (Trash included), each once. */
async function scopeLabels(db: Db, userId: string, scope: Scope): Promise<string[]> {
  const parts: Prisma.Sql[] = [];
  const tasks = taskWhere(userId, scope), notes = noteWhere(userId, scope), deliverables = deliverableWhere(userId, scope);
  if (tasks) parts.push(Prisma.sql`SELECT unnest(t.labels) AS l FROM tasks t WHERE ${tasks}`);
  if (notes) parts.push(Prisma.sql`SELECT unnest(n.labels) AS l FROM task_pages n WHERE ${notes}`);
  if (deliverables) parts.push(Prisma.sql`SELECT unnest(d.labels) AS l FROM deliverables d WHERE ${deliverables}`);
  const rows = await db.$queryRaw<Array<{ l: string }>>`SELECT DISTINCT x.l FROM (${Prisma.join(parts, " UNION ALL ")}) x`;
  return rows.map((row) => row.l);
}

/**
 * Rewrites labels in scope with one statement per table: each `from` spelling becomes its `to` (null
 * removes it), each label kept once, in order. The new array is computed from the row being written,
 * so a write landing at the same moment is not lost. `updated_at` is left alone: a label rename is
 * not an edit of the item, and pending Undo entries (lib/undo.ts) refuse a row whose version moved.
 */
async function remapLabels(db: Db, userId: string, scope: Scope, pairs: ReadonlyArray<readonly [string, string | null]>): Promise<number> {
  const changes = pairs.filter(([from, to]) => from !== to);
  if (!changes.length) return 0;
  const from = changes.map(([name]) => name);
  const to = changes.map(([, name]) => name ?? "");
  const next = (column: Prisma.Sql) => Prisma.sql`(
    SELECT coalesce(array_agg(y.v ORDER BY y.first), '{}'::text[]) FROM (
      SELECT NULLIF(coalesce(m.to_name, u.l), '') AS v, min(u.ord) AS first
      FROM unnest(${column}) WITH ORDINALITY AS u(l, ord)
      LEFT JOIN unnest(${from}::text[], ${to}::text[]) AS m(from_name, to_name) ON m.from_name = u.l
      GROUP BY 1
    ) y WHERE y.v IS NOT NULL)`;
  let changed = 0;
  const tasks = taskWhere(userId, scope), notes = noteWhere(userId, scope), deliverables = deliverableWhere(userId, scope);
  if (tasks) changed += await db.$executeRaw`UPDATE tasks t SET labels = ${next(Prisma.sql`t.labels`)} WHERE ${tasks} AND t.labels && ${from}::text[]`;
  if (notes) changed += await db.$executeRaw`UPDATE task_pages n SET labels = ${next(Prisma.sql`n.labels`)} WHERE ${notes} AND n.labels && ${from}::text[]`;
  if (deliverables) changed += await db.$executeRaw`UPDATE deliverables d SET labels = ${next(Prisma.sql`d.labels`)} WHERE ${deliverables} AND d.labels && ${from}::text[]`;
  return changed;
}

/** For each spelling, the destination board's label (created with the source's colour when missing). */
async function carryPairs(book: LabelBook, from: string, to: string, spellings: string[]): Promise<Array<[string, string]>> {
  const names = cleanNames(spellings, Number.POSITIVE_INFINITY);
  if (!names.length) return [];
  const spelled = await book.ensure(to, names, await book.colors(from));
  return spellings.map((label) => [label, spelled.get(labelKey(cleanLabelName(label))) ?? label]);
}

/** Moves a task's or a note's labels to the board it is moving to. Call before the move is written. */
export async function carryItemLabels(db: Db, userId: string, item: { kind: "task" | "page"; id: string }, from: string, to: string): Promise<void> {
  if (from === to) return;
  const scope: Scope = item.kind === "task" ? { task: item.id } : { note: item.id };
  const labels = await scopeLabels(db, userId, scope);
  if (!labels.length) return;
  await remapLabels(db, userId, scope, await carryPairs(new LabelBook(db, userId), from, to, labels));
}

/**
 * A custom board is going away: its tasks return to the Ensemble board and its notes become
 * independent, so their labels move to the Ensemble board's list with their colours. Then its own list goes.
 */
export async function retireBoardLabels(db: Db, userId: string, boardId: string): Promise<void> {
  const scope: Scope = { board: boardId };
  const labels = await scopeLabels(db, userId, scope);
  if (labels.length) await remapLabels(db, userId, scope, await carryPairs(new LabelBook(db, userId), boardId, ENSEMBLE_KEY, labels));
  await db.boardLabel.deleteMany({ where: { userId, boardKey: boardId } });
}

function recordOf(row: Stored, count: number): BoardLabelRecord {
  return { id: row.id, name: row.name, color: colorOf(row), count };
}

/** How many of a board's items (Trash left out) have each label, by key. */
async function labelCounts(db: Db, userId: string, key: string): Promise<Map<string, number>> {
  const scope: Scope = { board: key };
  const parts: Prisma.Sql[] = [Prisma.sql`SELECT unnest(t.labels) AS l FROM tasks t WHERE ${taskWhere(userId, scope)!} AND t.deleted_at IS NULL`];
  parts.push(Prisma.sql`SELECT unnest(n.labels) AS l FROM task_pages n WHERE ${noteWhere(userId, scope)!} AND n.deleted_at IS NULL`);
  const deliverables = deliverableWhere(userId, scope);
  if (deliverables) parts.push(Prisma.sql`SELECT unnest(d.labels) AS l FROM deliverables d WHERE ${deliverables} AND d.deleted_at IS NULL`);
  // Grouped by the stored text; the key is computed here, the one way names are compared.
  const rows = await db.$queryRaw<Array<{ l: string; n: number }>>`SELECT x.l, count(*)::int AS n FROM (${Prisma.join(parts, " UNION ALL ")}) x GROUP BY x.l`;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(labelKey(row.l), (counts.get(labelKey(row.l)) ?? 0) + Number(row.n));
  return counts;
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
  const existing = await db.boardLabel.findFirst({ where: { userId, boardKey: key, nameKey: labelKey(name) }, select: labelSelect });
  if (existing) return { label: recordOf(existing, (await labelCounts(db, userId, key)).get(existing.nameKey) ?? 0), created: false };
  await new LabelBook(db, userId).ensure(key, [name], input.color ? new Map([[labelKey(name), input.color]]) : undefined);
  const row = await db.boardLabel.findFirstOrThrow({ where: { userId, boardKey: key, nameKey: labelKey(name) }, select: labelSelect });
  return { label: recordOf(row, 0), created: true };
}

async function ownedLabel(db: Db, userId: string, id: string, lock = false): Promise<Stored & { boardKey: string }> {
  if (lock) await db.$queryRaw`SELECT id FROM board_labels WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`;
  const row = await db.boardLabel.findFirst({ where: { id, userId }, select: { ...labelSelect, boardKey: true } });
  if (!row) throw new LabelError("Label not found.", 404);
  return row;
}

/** Renames or recolours a label. A rename reaches every item of the board that has it, Trash included. */
export async function updateBoardLabel(db: Db, userId: string, id: string, patch: { name?: string; color?: LabelColor }): Promise<{ label: BoardLabelRecord; boardKey: string; changed: number }> {
  const row = await ownedLabel(db, userId, id, true);
  const name = patch.name === undefined ? row.name : cleanLabelName(patch.name);
  if (!name) throw new LabelError("Give the label a name.");
  const nameKey = labelKey(name);
  if (nameKey !== row.nameKey && await db.boardLabel.findFirst({ where: { userId, boardKey: row.boardKey, nameKey }, select: { id: true } })) {
    throw new LabelError(`This board already has a label called “${name}”.`, 409);
  }
  let changed = 0;
  if (name !== row.name) {
    // Any spelling of the old name, or of the new one, becomes the new name.
    const spellings = (await scopeLabels(db, userId, { board: row.boardKey })).filter((label) => [row.nameKey, nameKey].includes(labelKey(label)));
    changed = await remapLabels(db, userId, { board: row.boardKey }, spellings.map((label) => [label, name] as const));
  }
  const updated = await db.boardLabel.update({ where: { id }, data: { name, nameKey, ...(patch.color ? { color: patch.color } : {}) }, select: labelSelect });
  const counts = await labelCounts(db, userId, row.boardKey);
  return { label: recordOf(updated, counts.get(updated.nameKey) ?? 0), boardKey: row.boardKey, changed };
}

/** Deletes a label from its board and from every item there that has it, Trash included. */
export async function deleteBoardLabel(db: Db, userId: string, id: string): Promise<{ boardKey: string; changed: number }> {
  const row = await ownedLabel(db, userId, id, true);
  const spellings = (await scopeLabels(db, userId, { board: row.boardKey })).filter((label) => labelKey(label) === row.nameKey);
  const changed = await remapLabels(db, userId, { board: row.boardKey }, spellings.map((label) => [label, null] as const));
  await db.boardLabel.delete({ where: { id } });
  return { boardKey: row.boardKey, changed };
}

/** Every spelling of a label the space's boards have, for filters that match names exactly. */
export async function labelSpellings(db: Db, userId: string, name: string): Promise<string[]> {
  const cleaned = cleanLabelName(name.replace(/^#/, ""));
  if (!cleaned) return [];
  const rows = await db.boardLabel.findMany({ where: { userId, nameKey: labelKey(cleaned) }, select: { name: true } });
  return [...new Set([cleaned, ...rows.map((row) => row.name)])];
}

/**
 * Labels whose stored key is not `labelKey(name)`. The migration keyed existing labels with SQL
 * `lower()`, which folds only ASCII on a database with the C locale (the desktop's PGlite), so
 * "Über" and "über" may have become two labels. Each gets its key fixed, or merges into the board's
 * label that has that key (its items take that spelling). Idempotent; only non-ASCII names can differ.
 */
export async function repairLabelKeys(db: PrismaClient): Promise<number> {
  const rows = await db.$queryRaw<Array<{ id: string; user_id: string; board_key: string; name: string; name_key: string }>>`
    SELECT id, user_id, board_key, name, name_key FROM board_labels WHERE octet_length(name) <> char_length(name) ORDER BY created_at, id`;
  let fixed = 0;
  for (const row of rows) {
    const key = labelKey(row.name);
    if (key === row.name_key) continue;
    await db.$transaction(async (tx) => {
      const other = await tx.boardLabel.findFirst({ where: { userId: row.user_id, boardKey: row.board_key, nameKey: key, NOT: { id: row.id } }, select: { name: true } });
      if (other) {
        await remapLabels(tx, row.user_id, { board: row.board_key }, [[row.name, other.name]]);
        await tx.boardLabel.delete({ where: { id: row.id } });
      } else {
        await tx.boardLabel.update({ where: { id: row.id }, data: { nameKey: key } });
      }
    });
    fixed += 1;
  }
  return fixed;
}
