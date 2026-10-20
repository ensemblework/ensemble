/**
 * Where a file's original bytes live. By default they sit on its Document row (`original`, bytea;
 * PGlite on the desktop). With the server's blob store on (lib/blob-store.ts), every new or
 * replaced original goes there and the row keeps only `blobKey`. Rows written before that keep
 * their bytes and still read. A blob no row points at any more (a replaced version, a purged file,
 * a deleted account, an upload whose row was refused) is removed by sweepOrphanOriginals.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { blobStore, FileStorageError, storageUnreachable } from "../lib/blob-store.js";

/** Select these with any read that needs a file's bytes, then call originalBytes. */
export const ORIGINAL_SELECT = { original: true, blobKey: true } as const satisfies Prisma.DocumentSelect;
export type StoredOriginal = { original: Uint8Array | null; blobKey: string | null };

export const ORIGINALS_PREFIX = "documents/";
/** Longer than any upload takes to reach its row, so a blob whose row is still being written stays. */
export const SWEEP_GRACE_MS = 60 * 60_000;

/** Puts new original bytes where this server keeps them. The result is the row's storage fields. */
export async function storeOriginal(
  userId: string,
  documentId: string,
  sha256: string,
  bytes: Buffer<ArrayBuffer>,
  mediaType: string,
): Promise<{ original: Buffer<ArrayBuffer> | null; blobKey: string | null }> {
  const store = await blobStore();
  if (!store) return { original: bytes, blobKey: null };
  const blobKey = `${ORIGINALS_PREFIX}${userId}/${documentId}/${sha256}`;
  try {
    await store.put(blobKey, bytes, mediaType);
  } catch (error) {
    throw storageUnreachable(error);
  }
  return { original: null, blobKey };
}

/** A file's original bytes, from its row or its blob. */
export async function originalBytes(row: StoredOriginal): Promise<Buffer> {
  if (row.original !== null) return Buffer.from(row.original.buffer, row.original.byteOffset, row.original.byteLength);
  if (!row.blobKey) throw new Error("This file has no stored original.");
  const store = await blobStore();
  if (!store) throw new FileStorageError("This file is kept in blob storage, which this server is not set up to read.");
  let bytes: Buffer | null;
  try {
    bytes = await store.get(row.blobKey);
  } catch (error) {
    throw storageUnreachable(error);
  }
  if (!bytes) throw new FileStorageError("This file's original is missing from storage.", { statusCode: 404 });
  return bytes;
}

/** Removes a blob nothing will point at. Best effort: the sweep removes anything left. */
export async function discardOriginal(blobKey: string | null | undefined): Promise<void> {
  if (!blobKey) return;
  const store = await blobStore().catch(() => null);
  await store?.delete(blobKey).catch(() => undefined);
}

/** Removes original blobs no Document row points at, once they are an hour old. Returns how many. */
export async function sweepOrphanOriginals(db: PrismaClient, options: { now?: number } = {}): Promise<number> {
  const store = await blobStore();
  if (!store) return 0;
  const now = options.now ?? Date.now();
  let removed = 0;
  let batch: string[] = [];
  const flush = async () => {
    const kept = await db.document.findMany({ where: { blobKey: { in: batch } }, select: { blobKey: true } });
    const keep = new Set(kept.map((row) => row.blobKey));
    for (const key of batch) {
      if (keep.has(key)) continue;
      await store.delete(key);
      removed += 1;
    }
    batch = [];
  };
  for await (const blob of store.list(ORIGINALS_PREFIX)) {
    if (now - blob.modifiedAt.getTime() < SWEEP_GRACE_MS) continue;
    batch.push(blob.key);
    if (batch.length >= 200) await flush();
  }
  if (batch.length) await flush();
  return removed;
}
