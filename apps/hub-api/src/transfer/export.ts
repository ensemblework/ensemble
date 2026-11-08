/**
 * The computer's side of moving local-only data into an account (docs/DESKTOP.md §1.3): read every
 * moved table in order, in batches small enough for one request, and send them with the ids the
 * account has already given back.
 */
import type { PrismaClient } from "@prisma/client";
import { readOriginal, readTable } from "../plots/store.js";
import { DATASET_ORIGINAL, DATASET_TABLE, type TableCount, type TransferBatch, type TransferPatch, type TransferResult, type TransferRow } from "./import.js";
import { quoteIdent, remapIds, shapeOf, TRANSFER_TABLES, type TableShape, type TransferTable } from "./schema.js";

const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_ROWS = 400;

/** `FROM <table> t` and the condition that keeps one account's rows, through the parent when the table has no account column. */
function scope(shape: TableShape): { joins: string; where: string } {
  if (shape.account) return { joins: "", where: `t.${quoteIdent(shape.account)} = $1` };
  const parent = shape.owner ? shapeOf(shape.owner.table as TransferTable) : null;
  if (!shape.owner || !parent?.account) throw new Error(`Cannot scope ${shape.table} to an account.`);
  return { joins: `JOIN ${quoteIdent(parent.table)} p ON t.${quoteIdent(shape.owner.column)} = p.id`, where: `p.${quoteIdent(parent.account)} = $1` };
}

async function rowsOf(db: PrismaClient, table: TransferTable, userId: string): Promise<TransferRow[]> {
  const shape = shapeOf(table);
  const { joins, where } = scope(shape);
  const rows = await db.$queryRawUnsafe<Array<{ row: TransferRow }>>(`SELECT to_jsonb(t) AS row FROM ${quoteIdent(table)} t ${joins} WHERE ${where}`, userId);
  const list = rows.map((item) => item.row);
  const self = shape.references.find((reference) => reference.table === table);
  return self ? parentsFirst(list, self.column) : list;
}

/** Rows that point at another row of the same table (a sub-page, a reply) come after it. */
function parentsFirst(rows: TransferRow[], column: string): TransferRow[] {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const depth = new Map<string, number>();
  const depthOf = (row: TransferRow, seen = new Set<string>()): number => {
    const id = String(row.id);
    const known = depth.get(id);
    if (known !== undefined) return known;
    const parent = row[column];
    const next = typeof parent === "string" && byId.has(parent) && !seen.has(parent) ? depthOf(byId.get(parent)!, new Set([...seen, id])) + 1 : 0;
    depth.set(id, next);
    return next;
  };
  return [...rows].sort((a, b) => depthOf(a) - depthOf(b));
}

/** How much local data there is, by table, for the switch screen. */
export async function localDataCounts(db: PrismaClient, userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ["tasks", "task_pages", "projects", "people", "context_documents", "skills", "page_boards", "block_diagrams", "plots", "assistant_conversations", "meeting_notes"] as const) {
    const shape = shapeOf(table);
    const { joins, where } = scope(shape);
    const deleted = (await db.$queryRawUnsafe<Array<{ has: boolean }>>(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'deleted_at') AS has`, table))[0]?.has;
    const rows = await db.$queryRawUnsafe<Array<{ n: bigint | number }>>(`SELECT count(*) AS n FROM ${quoteIdent(table)} t ${joins} WHERE ${where}${deleted ? " AND t.deleted_at IS NULL" : ""}`, userId);
    counts[table] = Number(rows[0]?.n ?? 0);
  }
  return counts;
}

/** Every moved row, table by table, in request-sized batches. A dataset row carries its table and original. */
export async function* exportBatches(db: PrismaClient, userId: string): AsyncGenerator<TransferBatch[]> {
  let batch: TransferBatch[] = [];
  let bytes = 0;
  let rows = 0;
  for (const table of TRANSFER_TABLES) {
    for (const source of await rowsOf(db, table, userId)) {
      let row = source;
      if (table === "plot_datasets") {
        try {
          const stored = await readTable(userId, String(row.id), String(row.content_hash ?? ""));
          const original = await readOriginal(userId, String(row.id));
          row = { ...row, [DATASET_TABLE]: stored, ...(original ? { [DATASET_ORIGINAL]: original.toString("base64") } : {}) };
        } catch {
          continue;
        }
      }
      const size = JSON.stringify(row).length;
      if (rows && (bytes + size > BATCH_BYTES || rows >= BATCH_ROWS)) {
        yield batch;
        batch = [];
        bytes = 0;
        rows = 0;
      }
      const last = batch[batch.length - 1];
      if (last?.table === table) last.rows.push(row);
      else batch.push({ table, rows: [row] });
      bytes += size;
      rows += 1;
    }
  }
  if (rows) yield batch;
}

export type TransferProgress = { sent: number; counts: Record<string, TableCount>; notes: string[] };

/**
 * Sends this computer's local data to the account behind `token` (a one-purpose transfer key).
 * Retrying is safe: a row the account already has from this move is counted, not copied twice.
 */
export async function sendLocalData(input: {
  db: PrismaClient;
  userId: string;
  apiBase: string;
  token: string;
  onProgress?: (progress: TransferProgress) => void;
  fetchImpl?: typeof fetch;
}): Promise<TransferProgress & { patched: number }> {
  const send = input.fetchImpl ?? fetch;
  const ids = new Map<string, string>();
  const patches: TransferPatch[] = [];
  const progress: TransferProgress = { sent: 0, counts: {}, notes: [] };
  const post = async (path: string, body: unknown) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await send(`${input.apiBase}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(240_000),
        });
        const text = await response.text();
        if (response.ok) return JSON.parse(text) as unknown;
        let message = `Your account did not accept the data (HTTP ${response.status}).`;
        try {
          message = String((JSON.parse(text) as { error?: string; message?: string }).error ?? (JSON.parse(text) as { message?: string }).message ?? message);
        } catch {
          // keep the status sentence
        }
        if (response.status < 500 && response.status !== 429) throw Object.assign(new Error(message), { final: true });
        lastError = new Error(message);
      } catch (error) {
        if ((error as { final?: boolean }).final) throw error;
        lastError = error;
      }
      await new Promise((done) => setTimeout(done, 1500 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error("Could not reach your Ensemble account.");
  };
  for await (const batch of exportBatches(input.db, input.userId)) {
    const body = { batch: batch.map((part) => ({ table: part.table, rows: part.rows.map((row) => remapIds(row, ids)) })) };
    const result = (await post("/api/transfer/rows", body)) as TransferResult;
    for (const [from, to] of Object.entries(result.ids ?? {})) ids.set(from.toLowerCase(), to);
    patches.push(...(result.patches ?? []));
    for (const [table, tally] of Object.entries(result.counts ?? {})) {
      const total = (progress.counts[table] ??= { added: 0, merged: 0, skipped: 0 });
      total.added += tally.added;
      total.merged += tally.merged;
      total.skipped += tally.skipped;
    }
    for (const text of result.notes ?? []) if (!progress.notes.includes(text)) progress.notes.push(text);
    progress.sent += batch.reduce((sum, part) => sum + part.rows.length, 0);
    input.onProgress?.({ ...progress });
  }
  const finished = (await post("/api/transfer/finish", { patches: patches.map((patch) => remapIds(patch, ids)), counts: progress.counts })) as { patched?: number };
  return { ...progress, patched: finished.patched ?? 0 };
}
