/**
 * Receiving a computer's local-only data in an account (docs/DESKTOP.md §1.3). The rows come from a
 * computer the account's owner approved, but every row is checked as if it were hostile:
 *
 * - every column naming an account becomes this account;
 * - a reference to another row stays only when that row is this account's (or arrives later in the
 *   move: it is cleared now and returned as a patch for /finish);
 * - a row whose id is already another account's gets a new id, and the computer is told;
 * - a row matching one of this account's by a unique key (same skill slug, same repo, same person…)
 *   merges into it: the account's values win, the computer's fill only what is empty.
 *
 * Each batch is one transaction; a row that still fails is skipped and counted, not fatal.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { validateLayout } from "@ensemble/shared-types/widgets";
import { isHosted } from "../lib/hosted-access.js";
import { assertFileRoom, checkDatasetBytes, HostedLimitError } from "../lib/hosted-limits.js";
import { maxFileBytes } from "../files/store.js";
import { writeTable, type StoredTable } from "../plots/store.js";
import { isTransferTable, quoteIdent, remapIds, shapeOf, type TableShape, type TransferTable } from "./schema.js";

export type TransferRow = Record<string, unknown>;
export type TransferBatch = { table: string; rows: TransferRow[] };
export type TransferPatch = { table: string; id: string; column: string; value: string };
export type TableCount = { added: number; merged: number; skipped: number };
export type TransferResult = {
  counts: Record<string, TableCount>;
  /** Source id → the id it has in the account (merged into an existing row, or given a new id). */
  ids: Record<string, string>;
  /** References to rows that had not arrived yet: send them back to /finish. */
  patches: TransferPatch[];
  /** Sentences for the person: what did not fit, what was paused. */
  notes: string[];
};

/** Extra fields a row may carry that are not columns: a dataset's table and original bytes. */
export const DATASET_TABLE = "$table";
export const DATASET_ORIGINAL = "$original";

type Column = { name: string; type: string; nullable: boolean; hasDefault: boolean };
type Tx = Prisma.TransactionClient;

const columnCache = new Map<string, Promise<Map<string, Column>>>();

/** The receiving database's own columns (so an older or newer computer's extra columns are dropped). Generated columns are left out. */
function columnsOf(db: Tx | PrismaClient, table: TransferTable): Promise<Map<string, Column>> {
  let found = columnCache.get(table);
  if (!found) {
    found = db
      .$queryRawUnsafe<Array<{ name: string; type: string; nullable: boolean; generated: boolean; has_default: boolean }>>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, a.attgenerated <> '' AS generated, a.atthasdef AS has_default
           FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
        quoteIdent(table),
      )
      .then((rows) => new Map(rows.filter((row) => !row.generated).map((row) => [row.name, { name: row.name, type: row.type, nullable: row.nullable, hasDefault: row.has_default }])));
    found.catch(() => columnCache.delete(table));
    columnCache.set(table, found);
  }
  return found;
}

const SKIP_FILL = new Set(["id", "created_at", "updated_at", "deleted_at", "revision"]);

function empty(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
}

function count(result: TransferResult, table: string): TableCount {
  return (result.counts[table] ??= { added: 0, merged: 0, skipped: 0 });
}

function note(result: TransferResult, text: string): void {
  if (!result.notes.includes(text)) result.notes.push(text);
}

/** Where `id` is: this account's, another account's, or not here (yet). */
async function ownerOf(tx: Tx, table: string, id: unknown, accountId: string, depth = 0): Promise<"mine" | "other" | "missing"> {
  if (typeof id !== "string" || !id) return "missing";
  if (!isTransferTable(table)) return "other";
  const shape = shapeOf(table);
  if (shape.key.length !== 1 || shape.key[0] !== "id") return "other";
  if (shape.account) {
    const rows = await tx.$queryRawUnsafe<Array<{ account: string }>>(`SELECT ${quoteIdent(shape.account)} AS account FROM ${quoteIdent(table)} WHERE id = $1`, id);
    if (!rows.length) return "missing";
    return rows[0]!.account === accountId ? "mine" : "other";
  }
  if (!shape.owner || depth > 2) return "other";
  const rows = await tx.$queryRawUnsafe<Array<{ parent: string }>>(`SELECT ${quoteIdent(shape.owner.column)} AS parent FROM ${quoteIdent(table)} WHERE id = $1`, id);
  if (!rows.length) return "missing";
  return (await ownerOf(tx, shape.owner.table, rows[0]!.parent, accountId, depth + 1)) === "mine" ? "mine" : "other";
}

async function existingRow(tx: Tx, table: TransferTable, where: Array<[string, unknown]>, columns: Map<string, Column>): Promise<TransferRow | null> {
  const clauses = where.map(([column], index) => `${quoteIdent(column)} = $${index + 1}::${columns.get(column)!.type}`);
  const rows = await tx.$queryRawUnsafe<Array<{ row: TransferRow }>>(
    `SELECT to_jsonb(t) AS row FROM ${quoteIdent(table)} t WHERE ${clauses.join(" AND ")} LIMIT 1`,
    ...where.map(([, value]) => (typeof value === "object" && value !== null ? JSON.stringify(value) : value)),
  );
  return rows[0]?.row ?? null;
}

async function update(tx: Tx, table: TransferTable, shape: TableShape, existing: TransferRow, values: TransferRow): Promise<void> {
  const names = Object.keys(values);
  if (!names.length) return;
  const keys = shape.key.map(quoteIdent).join(", ");
  await tx.$executeRawUnsafe(
    `UPDATE ${quoteIdent(table)} SET (${names.map(quoteIdent).join(", ")}) = (SELECT ${names.map(quoteIdent).join(", ")} FROM jsonb_populate_record(NULL::${quoteIdent(table)}, $1::jsonb))
      WHERE (${keys}) = (SELECT ${keys} FROM jsonb_populate_record(NULL::${quoteIdent(table)}, $2::jsonb))`,
    JSON.stringify(values),
    JSON.stringify(existing),
  );
}

/** The account's row wins; the computer's values fill what it left empty. */
async function fillEmpty(tx: Tx, table: TransferTable, shape: TableShape, existing: TransferRow, incoming: TransferRow): Promise<void> {
  const fills: TransferRow = {};
  for (const [column, value] of Object.entries(incoming)) {
    if (SKIP_FILL.has(column) || shape.key.includes(column) || shape.accountColumns.includes(column)) continue;
    if (empty(existing[column]) && !empty(value)) fills[column] = value;
  }
  await update(tx, table, shape, existing, fills);
}

function deepFill(target: unknown, source: unknown): unknown {
  if (target && source && typeof target === "object" && typeof source === "object" && !Array.isArray(target) && !Array.isArray(source)) {
    const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) out[key] = key in out ? deepFill(out[key], value) : value;
    return out;
  }
  return target;
}

type Merge = { into: TransferRow } | { rename: TransferRow } | null;

/** Rules for rows people recognise as "the same thing" without a database key. */
async function customMerge(tx: Tx, table: TransferTable, row: TransferRow, accountId: string, columns: Map<string, Column>): Promise<Merge> {
  if (table === "projects" && !row.external_source && typeof row.name === "string" && row.name.trim()) {
    const rows = await tx.$queryRawUnsafe<Array<{ row: TransferRow }>>(
      `SELECT to_jsonb(t) AS row FROM projects t WHERE user_id = $1 AND external_source IS NULL AND deleted_at IS NULL AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
      accountId, row.name,
    );
    return rows[0] ? { into: rows[0].row } : null;
  }
  if (table === "people" && typeof row.name === "string") {
    const email = typeof row.email === "string" && row.email.trim() ? row.email.trim() : null;
    const rows = await tx.$queryRawUnsafe<Array<{ row: TransferRow }>>(
      `SELECT to_jsonb(t) AS row FROM people t WHERE user_id = $1 AND deleted_at IS NULL
         AND (($2::text IS NOT NULL AND lower(email) = lower($2::text)) OR (($2::text IS NULL OR email IS NULL) AND lower(btrim(name)) = lower(btrim($3))))
       ORDER BY (email IS NOT NULL AND lower(email) = lower($2::text)) DESC LIMIT 1`,
      accountId, email, row.name,
    );
    return rows[0] ? { into: rows[0].row } : null;
  }
  if (table === "skills" && typeof row.slug === "string") {
    const existing = await existingRow(tx, table, [["user_id", accountId], ["slug", row.slug]], columns);
    if (!existing) return null;
    if (existing.body === row.body) return { into: existing };
    for (let n = 1; n < 50; n += 1) {
      const slug = `${row.slug}-from-computer${n > 1 ? `-${n}` : ""}`.slice(0, 120);
      if (!(await existingRow(tx, table, [["user_id", accountId], ["slug", slug]], columns))) {
        return { rename: { slug, name: `${String(row.name ?? row.slug)} (from this computer)` } };
      }
    }
    return null;
  }
  if (table === "page_boards" && typeof row.title === "string") {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM page_boards WHERE user_id = $1 AND lower(btrim(title)) = lower(btrim($2)) LIMIT 1`, accountId, row.title);
    return rows[0] ? { rename: { title: `${row.title} (from this computer)` } } : null;
  }
  if (table === "preferences" && typeof row.key === "string") {
    const existing = await existingRow(tx, table, [["user_id", accountId], ["key", row.key]], columns);
    if (!existing) return null;
    const merged = deepFill(existing.value, row.value);
    if (JSON.stringify(merged) !== JSON.stringify(existing.value)) await update(tx, table, shapeOf(table), existing, { value: merged });
    return { into: existing };
  }
  if (table === "widget_layouts" && typeof row.surface === "string") {
    const existing = await existingRow(tx, table, [["user_id", accountId], ["surface", row.surface]], columns);
    if (!existing) return null;
    const mine = existing.document as { placements?: Array<{ type?: string }> } | null;
    const theirs = row.document as { placements?: Array<{ type?: string }> } | null;
    const have = new Set((mine?.placements ?? []).map((placement) => placement.type));
    const extra = (theirs?.placements ?? []).filter((placement) => !have.has(placement.type));
    if (mine && extra.length) {
      const checked = validateLayout(row.surface, { ...mine, placements: [...(mine.placements ?? []), ...extra] });
      if (checked.ok) await update(tx, table, shapeOf(table), existing, { document: checked.document });
    }
    return { into: existing };
  }
  return null;
}

async function uniqueMerge(tx: Tx, table: TransferTable, shape: TableShape, row: TransferRow, columns: Map<string, Column>): Promise<TransferRow | null> {
  for (const unique of shape.uniques) {
    if (!unique.every((column) => row[column] !== null && row[column] !== undefined && columns.has(column))) continue;
    const found = await existingRow(tx, table, unique.map((column) => [column, row[column]]), columns);
    if (found) return found;
  }
  return null;
}

async function insert(tx: Tx, table: TransferTable, row: TransferRow): Promise<void> {
  const names = Object.keys(row).map(quoteIdent).join(", ");
  await tx.$executeRawUnsafe(
    `INSERT INTO ${quoteIdent(table)} (${names}) SELECT ${names} FROM jsonb_populate_record(NULL::${quoteIdent(table)}, $1::jsonb)`,
    JSON.stringify(row),
  );
}

/** Quotas a hosted account has: files and datasets that do not fit stay on the computer. */
async function roomFor(tx: Tx, table: TransferTable, row: TransferRow, accountId: string, result: TransferResult): Promise<boolean> {
  if (!isHosted()) return true;
  try {
    if (table === "context_documents") {
      const bytes = Number(row.byte_size ?? 0);
      if (bytes > maxFileBytes()) throw new HostedLimitError("too large");
      if (!row.deleted_at) await assertFileRoom(tx, accountId, { files: 1, bytes });
    }
    if (table === "plot_datasets") await checkDatasetBytes(tx, accountId, Number(row.byte_size ?? 0));
    return true;
  } catch (error) {
    if (!(error instanceof HostedLimitError)) throw error;
    note(result, table === "context_documents" ? "Some files did not fit your account's file limits. They are still in this computer's local data." : "Some datasets did not fit your account's dataset limit. They are still in this computer's local data.");
    return false;
  }
}

/** One batch of rows, in one transaction. */
export async function importBatch(db: PrismaClient, accountId: string, batch: TransferBatch[]): Promise<TransferResult> {
  const result: TransferResult = { counts: {}, ids: {}, patches: [], notes: [] };
  const known = new Map<string, string>();
  for (const part of batch) if (!isTransferTable(part.table)) throw Object.assign(new Error(`${part.table} is not moved between computers and accounts.`), { statusCode: 400 });
  await db.$transaction(
    async (tx) => {
      for (const part of batch) {
        const table = part.table as TransferTable;
        const shape = shapeOf(table);
        const columns = await columnsOf(tx, table);
        rows: for (const source of part.rows) {
          const tally = count(result, table);
          const extras = { table: source[DATASET_TABLE], original: source[DATASET_ORIGINAL] };
          let row: TransferRow = {};
          for (const [column, value] of Object.entries(remapIds(source, known))) if (columns.has(column)) row[column] = value;
          for (const column of shape.accountColumns) if (column in row && row[column] !== null) row[column] = accountId;
          if (shape.account) row[shape.account] = accountId;
          // A required time the database does not fill itself (Prisma's @updatedAt), missing from an older computer's row.
          for (const column of columns.values()) if (!column.nullable && !column.hasDefault && !(column.name in row) && column.type.startsWith("timestamp")) row[column.name] = new Date().toISOString();
          const sourceId = typeof row.id === "string" ? row.id : null;
          for (const reference of shape.references) {
            const value = row[reference.column];
            if (value === null || value === undefined) continue;
            const where = await ownerOf(tx, reference.table, value, accountId);
            if (where === "mine") continue;
            if (!reference.nullable) {
              tally.skipped += 1;
              continue rows;
            }
            row[reference.column] = null;
            if (where === "missing" && isTransferTable(reference.table) && sourceId) result.patches.push({ table, id: sourceId, column: reference.column, value: String(value) });
          }
          if (shape.key.length === 1 && shape.key[0] === "id" && sourceId) {
            const where = await ownerOf(tx, table, sourceId, accountId);
            if (where === "mine") {
              tally.merged += 1;
              continue;
            }
            if (where === "other") {
              const id = randomUUID();
              row.id = id;
              known.set(sourceId.toLowerCase(), id);
              result.ids[sourceId] = id;
              for (const patch of result.patches) if (patch.id === sourceId && patch.table === table) patch.id = id;
            }
          }
          const custom = await customMerge(tx, table, row, accountId, columns);
          if (custom && "rename" in custom) row = { ...row, ...custom.rename };
          const into = custom && "into" in custom ? custom.into : await uniqueMerge(tx, table, shape, row, columns);
          if (into) {
            if (!(custom && "into" in custom && (table === "preferences" || table === "widget_layouts"))) await fillEmpty(tx, table, shape, into, row);
            const target = typeof into.id === "string" ? into.id : null;
            if (target && typeof row.id === "string" && target !== row.id) {
              known.set(String(sourceId ?? row.id).toLowerCase(), target);
              result.ids[String(sourceId ?? row.id)] = target;
            }
            tally.merged += 1;
            continue;
          }
          if (!(await roomFor(tx, table, row, accountId, result))) {
            tally.skipped += 1;
            continue;
          }
          if (table === "assistant_routines" && row.status === "active") {
            row.status = "paused";
            note(result, "Scheduled routines were moved paused. Turn them back on in Settings → Assistant once the account's models are set.");
          }
          if (table === "plot_datasets") {
            const stored = extras.table as StoredTable | undefined;
            if (!stored || !Array.isArray(stored.columns) || !Array.isArray(stored.rows)) {
              tally.skipped += 1;
              continue;
            }
            const original = typeof extras.original === "string" ? Buffer.from(extras.original, "base64") : undefined;
            row.content_hash = await writeTable(accountId, String(row.id), stored, original);
          }
          await tx.$executeRawUnsafe("SAVEPOINT transfer_row");
          try {
            await insert(tx, table, row);
            await tx.$executeRawUnsafe("RELEASE SAVEPOINT transfer_row");
            tally.added += 1;
          } catch {
            await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT transfer_row");
            tally.skipped += 1;
          }
        }
      }
    },
    { timeout: 180_000, maxWait: 20_000 },
  );
  return result;
}

/** References that pointed ahead of the move: set now if both rows are this account's. */
export async function applyPatches(db: PrismaClient, accountId: string, patches: TransferPatch[]): Promise<number> {
  let applied = 0;
  for (const patch of patches) {
    if (!isTransferTable(patch.table)) continue;
    const shape = shapeOf(patch.table);
    const reference = shape.references.find((item) => item.column === patch.column);
    if (!reference || shape.key.length !== 1 || shape.key[0] !== "id") continue;
    if ((await ownerOf(db as unknown as Tx, patch.table, patch.id, accountId)) !== "mine") continue;
    if ((await ownerOf(db as unknown as Tx, reference.table, patch.value, accountId)) !== "mine") continue;
    applied += await db.$executeRawUnsafe(`UPDATE ${quoteIdent(patch.table)} SET ${quoteIdent(patch.column)} = $1 WHERE id = $2 AND ${quoteIdent(patch.column)} IS NULL`, patch.value, patch.id);
  }
  return applied;
}
