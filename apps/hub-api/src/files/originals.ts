/**
 * Where a file's original bytes live. By default they sit on its Document row (`original`, bytea;
 * PGlite on the desktop). With ENSEMBLE_FILE_STORAGE=azure-blob, every new or replaced original goes
 * to an Azure Blob container and the row keeps only `blobKey`. Rows written before that keep their
 * bytes and still read. A blob no row points at any more (a replaced version, a purged file, a
 * deleted account, an upload whose row was refused) is removed by sweepOrphanOriginals.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export interface OriginalStore {
  put(key: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  list(prefix: string): AsyncIterable<{ key: string; modifiedAt: Date }>;
}

export type FileStorageMode = "database" | "azure-blob";

/** Select these with any read that needs a file's bytes, then call originalBytes. */
export const ORIGINAL_SELECT = { original: true, blobKey: true } as const satisfies Prisma.DocumentSelect;
export type StoredOriginal = { original: Uint8Array | null; blobKey: string | null };

const PREFIX = "documents/";
const DEFAULT_CONTAINER = "ensemble-files";
const SWEEP_EVERY_MS = 60 * 60_000;
/** Longer than any upload takes to reach its row, so a blob whose row is still being written stays. */
const SWEEP_GRACE_MS = 60 * 60_000;

export class FileStorageError extends Error {
  readonly expose = true;
  readonly statusCode = 503;
}

/** Why the file storage settings cannot work, or null when they can. Checked at production start. */
export function fileStorageProblem(env: NodeJS.ProcessEnv): string | null {
  const mode = (env.ENSEMBLE_FILE_STORAGE ?? "").trim().toLowerCase();
  if (!mode || mode === "database") return null;
  if (mode !== "azure-blob") return `ENSEMBLE_FILE_STORAGE must be database or azure-blob, not "${mode}".`;
  if (!env.AZURE_STORAGE_CONNECTION_STRING?.trim()) return "ENSEMBLE_FILE_STORAGE=azure-blob needs AZURE_STORAGE_CONNECTION_STRING.";
  return null;
}

export function fileStorageMode(env: NodeJS.ProcessEnv = process.env): FileStorageMode {
  const problem = fileStorageProblem(env);
  if (problem) throw new FileStorageError(problem);
  return (env.ENSEMBLE_FILE_STORAGE ?? "").trim().toLowerCase() === "azure-blob" ? "azure-blob" : "database";
}

async function azureStore(): Promise<OriginalStore> {
  // Loaded only when configured, so the desktop and local servers never load the SDK.
  const { BlobServiceClient } = await import("@azure/storage-blob");
  const container = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING!.trim()).getContainerClient(
    process.env.AZURE_STORAGE_CONTAINER?.trim() || DEFAULT_CONTAINER,
  );
  return {
    async put(key, bytes, mediaType) {
      await container.getBlockBlobClient(key).uploadData(bytes, { blobHTTPHeaders: { blobContentType: mediaType } });
    },
    get: (key) => container.getBlobClient(key).downloadToBuffer(),
    async delete(key) {
      await container.getBlobClient(key).deleteIfExists();
    },
    async *list(prefix) {
      for await (const blob of container.listBlobsFlat({ prefix })) yield { key: blob.name, modifiedAt: blob.properties.lastModified };
    },
  };
}

let override: OriginalStore | null | undefined;
let configured: Promise<OriginalStore | null> | undefined;
let lastSweep = 0;

/** Tests swap in a store; undefined goes back to the environment's. */
export function setOriginalStoreForTests(store: OriginalStore | null | undefined): void {
  override = store;
  configured = undefined;
  lastSweep = 0;
}

/** The blob store this server writes new originals to, or null when they stay on the row. */
export function originalStore(): Promise<OriginalStore | null> {
  if (override !== undefined) return Promise.resolve(override);
  configured ??= (async () => (fileStorageMode() === "azure-blob" ? azureStore() : null))();
  return configured;
}

const unreachable = (cause: unknown) => new FileStorageError("File storage is not reachable right now. Try again in a minute.", { cause });

/** Puts new original bytes where this server keeps them. The result is the row's storage fields. */
export async function storeOriginal(
  userId: string,
  documentId: string,
  sha256: string,
  bytes: Buffer<ArrayBuffer>,
  mediaType: string,
): Promise<{ original: Buffer<ArrayBuffer> | null; blobKey: string | null }> {
  const store = await originalStore();
  if (!store) return { original: bytes, blobKey: null };
  const blobKey = `${PREFIX}${userId}/${documentId}/${sha256}`;
  try {
    await store.put(blobKey, bytes, mediaType);
  } catch (error) {
    throw unreachable(error);
  }
  return { original: null, blobKey };
}

/** A file's original bytes, from its row or its blob. */
export async function originalBytes(row: StoredOriginal): Promise<Buffer> {
  if (row.original !== null) return Buffer.from(row.original.buffer, row.original.byteOffset, row.original.byteLength);
  if (!row.blobKey) throw new Error("This file has no stored original.");
  const store = await originalStore();
  if (!store) throw new FileStorageError("This file is kept in blob storage, which this server is not set up to read.");
  try {
    return await store.get(row.blobKey);
  } catch (error) {
    throw unreachable(error);
  }
}

/** Removes a blob nothing will point at. Best effort: the sweep removes anything left. */
export async function discardOriginal(blobKey: string | null | undefined): Promise<void> {
  if (!blobKey) return;
  const store = await originalStore().catch(() => null);
  await store?.delete(blobKey).catch(() => undefined);
}

/**
 * Removes blobs no Document row points at, once they are an hour old. Runs at most hourly
 * unless forced; the scheduler calls it every tick. Returns how many it removed.
 */
export async function sweepOrphanOriginals(db: PrismaClient, options: { now?: number; force?: boolean } = {}): Promise<number> {
  const store = await originalStore();
  if (!store) return 0;
  const now = options.now ?? Date.now();
  if (!options.force && now - lastSweep < SWEEP_EVERY_MS) return 0;
  lastSweep = now;
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
  for await (const blob of store.list(PREFIX)) {
    if (now - blob.modifiedAt.getTime() < SWEEP_GRACE_MS) continue;
    batch.push(blob.key);
    if (batch.length >= 200) await flush();
  }
  if (batch.length) await flush();
  return removed;
}
