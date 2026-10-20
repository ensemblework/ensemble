/**
 * Where a dataset's table (and, for a workbook with several sheets, its original) is kept: in the
 * server's blob store when it is on (lib/blob-store.ts, keys plots/<userId>/<id>.json.gz and .bin),
 * otherwise in .ensemble/plots/<userId>/ on disk. A table is read through the in-memory cache first.
 * Files kept on disk before the blob store was turned on are moved by moveLocalDatasetsToBlob and
 * read from disk until then.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { unzipSync, zipSync } from "fflate";
import type { PlotColumn } from "@ensemble/shared-types";
import { blobStore, storageUnreachable } from "../lib/blob-store.js";
import { cachedTable, forgetTable, hashBytes, rememberTable } from "./cache.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.ensemble/plots");
export const DATASETS_PREFIX = "plots/";
/** Longer than any import takes to reach its row, so a table whose row is still being written stays. */
const SWEEP_GRACE_MS = 60 * 60_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STORED_NAME = /^([A-Za-z0-9_-]{1,128})\.(json\.gz|bin)$/;

export type StoredTable = {
  columns: PlotColumn[];
  rows: Array<Array<string | number | null>>;
};

export function storedTableBytes(table: StoredTable, original?: Uint8Array): number {
  return zipSync({ "table.json": new TextEncoder().encode(JSON.stringify(table)) }).byteLength + (original?.byteLength ?? 0);
}

const tableName = (id: string) => `${id}.json.gz`;
const binName = (id: string) => `${id}.bin`;
const blobKey = (userId: string, name: string) => `${DATASETS_PREFIX}${userId}/${name}`;
const localPath = (userId: string, name: string) => resolve(ROOT, userId, name);
const mediaTypeOf = (name: string) => (name.endsWith(".bin") ? "application/octet-stream" : "application/zip");

async function putBytes(userId: string, name: string, bytes: Uint8Array): Promise<void> {
  const store = await blobStore();
  if (!store) {
    mkdirSync(resolve(ROOT, userId), { recursive: true });
    writeFileSync(localPath(userId, name), bytes);
    return;
  }
  try {
    await store.put(blobKey(userId, name), bytes, mediaTypeOf(name));
  } catch (error) {
    throw storageUnreachable(error);
  }
  // An older copy on disk must not be moved over this one later.
  rmSync(localPath(userId, name), { force: true });
}

async function getBytes(userId: string, name: string): Promise<Buffer | null> {
  const store = await blobStore();
  if (store) {
    let found: Buffer | null;
    try {
      found = await store.get(blobKey(userId, name));
    } catch (error) {
      throw storageUnreachable(error);
    }
    if (found) return found;
  }
  const path = localPath(userId, name);
  return existsSync(path) ? readFileSync(path) : null;
}

/** Best effort for the blob: sweepOrphanDatasets removes what a failed delete leaves. */
async function removeBytes(userId: string, name: string): Promise<void> {
  rmSync(localPath(userId, name), { force: true });
  const store = await blobStore().catch(() => null);
  await store?.delete(blobKey(userId, name)).catch(() => undefined);
}

export async function writeTable(userId: string, id: string, table: StoredTable, original?: Uint8Array): Promise<string> {
  const json = JSON.stringify(table);
  await putBytes(userId, tableName(id), zipSync({ "table.json": new TextEncoder().encode(json) }));
  if (original) await putBytes(userId, binName(id), original);
  const hash = hashBytes(json);
  rememberTable(id, hash, table.rows);
  return hash;
}

/** The table. With `columns` (the dataset row's), a cached table is returned without reading storage. */
export async function readTable(userId: string, id: string, hash: string, columns?: PlotColumn[]): Promise<StoredTable> {
  const hit = cachedTable(id, hash);
  if (hit && columns) return { columns, rows: hit };
  const zipped = await getBytes(userId, tableName(id));
  if (!zipped) throw Object.assign(new Error("That dataset is missing its table."), { statusCode: 404 });
  const json = new TextDecoder().decode(unzipSync(zipped)["table.json"]);
  const table = JSON.parse(json) as StoredTable;
  if (hit) return { columns: table.columns, rows: hit };
  rememberTable(id, hash, table.rows);
  return table;
}

export function readOriginal(userId: string, id: string): Promise<Buffer | null> {
  return getBytes(userId, binName(id));
}

export async function removeDatasetFiles(userId: string, id: string): Promise<void> {
  forgetTable(id);
  await removeBytes(userId, tableName(id));
  await removeBytes(userId, binName(id));
}

export async function eraseUserDatasetFiles(userId: string): Promise<void> {
  if (!SAFE_ID.test(userId)) {
    throw new Error("Refusing to erase dataset files for an invalid user id.");
  }
  const store = await blobStore().catch(() => null);
  if (store) {
    for await (const blob of store.list(`${DATASETS_PREFIX}${userId}/`)) {
      const match = STORED_NAME.exec(blob.key.slice(`${DATASETS_PREFIX}${userId}/`.length));
      if (match) forgetTable(match[1]!);
      await store.delete(blob.key).catch(() => undefined);
    }
  }
  const path = resolve(ROOT, userId);
  if (dirname(path) !== ROOT) throw new Error("Refusing to erase dataset files outside the user's storage.");
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error("Refusing to erase dataset files through a symbolic link.");
  if (!info.isDirectory()) throw new Error("The user's dataset storage is not a directory.");
  // SQL rows may already be gone; filenames retain the dataset ids for cache eviction.
  for (const name of readdirSync(path)) {
    const match = STORED_NAME.exec(name);
    if (match) forgetTable(match[1]!);
  }
  rmSync(path, { recursive: true });
}

/** Moves tables and originals kept on disk into the blob store, once it is on. Returns how many files moved. */
export async function moveLocalDatasetsToBlob(): Promise<number> {
  const store = await blobStore();
  if (!store || !existsSync(ROOT)) return 0;
  let moved = 0;
  for (const userId of readdirSync(ROOT)) {
    const dir = resolve(ROOT, userId);
    if (!SAFE_ID.test(userId) || !lstatSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      if (!STORED_NAME.test(name) || !lstatSync(path).isFile()) continue;
      await store.put(blobKey(userId, name), readFileSync(path), mediaTypeOf(name));
      rmSync(path, { force: true });
      moved += 1;
    }
    if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
  }
  return moved;
}

/** Removes dataset blobs whose dataset was deleted or never saved, once they are an hour old. */
export async function sweepOrphanDatasets(db: PrismaClient, options: { now?: number } = {}): Promise<number> {
  const store = await blobStore();
  if (!store) return 0;
  const now = options.now ?? Date.now();
  let removed = 0;
  let batch: Array<{ key: string; id: string }> = [];
  const flush = async () => {
    const live = await db.plotDataset.findMany({ where: { id: { in: [...new Set(batch.map((blob) => blob.id))] }, deletedAt: null }, select: { id: true } });
    const keep = new Set(live.map((row) => row.id));
    for (const blob of batch) {
      if (keep.has(blob.id)) continue;
      await store.delete(blob.key);
      removed += 1;
    }
    batch = [];
  };
  for await (const blob of store.list(DATASETS_PREFIX)) {
    if (now - blob.modifiedAt.getTime() < SWEEP_GRACE_MS) continue;
    const match = STORED_NAME.exec(blob.key.split("/").pop() ?? "");
    if (!match) continue;
    batch.push({ key: blob.key, id: match[1]! });
    if (batch.length >= 200) await flush();
  }
  if (batch.length) await flush();
  return removed;
}
