/**
 * The server's blob store: a private Azure Blob container that holds what users upload, so the
 * server's own disk keeps only the database and code. Off by default (desktop, local servers):
 * then callers keep bytes where they always did. ENSEMBLE_FILE_STORAGE=azure-blob turns it on.
 *
 * Keys in use: documents/<userId>/<documentId>/<sha256> (files/originals.ts) and
 * plots/<userId>/<datasetId>.json.gz|.bin (plots/store.ts). jobs/blob-sweep.ts removes blobs
 * nothing uses any more.
 */

export interface BlobStore {
  put(key: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  /** Null when there is no blob with that key. */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): AsyncIterable<{ key: string; modifiedAt: Date }>;
}

export type FileStorageMode = "database" | "azure-blob";

const DEFAULT_CONTAINER = "ensemble-files";

export class FileStorageError extends Error {
  readonly expose = true;
  readonly statusCode: number;
  constructor(message: string, options?: { cause?: unknown; statusCode?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.statusCode = options?.statusCode ?? 503;
  }
}

/** Why the storage settings cannot work, or null when they can. Checked at production start. */
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

async function azureStore(): Promise<BlobStore> {
  // Loaded only when configured, so the desktop and local servers never load the SDK.
  const { BlobServiceClient } = await import("@azure/storage-blob");
  const container = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING!.trim()).getContainerClient(
    process.env.AZURE_STORAGE_CONTAINER?.trim() || DEFAULT_CONTAINER,
  );
  return {
    async put(key, bytes, mediaType) {
      await container.getBlockBlobClient(key).uploadData(bytes, { blobHTTPHeaders: { blobContentType: mediaType } });
    },
    async get(key) {
      try {
        return await container.getBlobClient(key).downloadToBuffer();
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) return null;
        throw error;
      }
    },
    async delete(key) {
      await container.getBlobClient(key).deleteIfExists();
    },
    async *list(prefix) {
      for await (const blob of container.listBlobsFlat({ prefix })) yield { key: blob.name, modifiedAt: blob.properties.lastModified };
    },
  };
}

let override: BlobStore | null | undefined;
let configured: Promise<BlobStore | null> | undefined;

/** Tests swap in a store; undefined goes back to the environment's. */
export function setBlobStoreForTests(store: BlobStore | null | undefined): void {
  override = store;
  configured = undefined;
}

/** The blob store this server writes to, or null when uploads stay in the database and on disk. */
export function blobStore(): Promise<BlobStore | null> {
  if (override !== undefined) return Promise.resolve(override);
  configured ??= (async () => (fileStorageMode() === "azure-blob" ? azureStore() : null))();
  return configured;
}

export function storageUnreachable(cause: unknown): FileStorageError {
  return new FileStorageError("File storage is not reachable right now. Try again in a minute.", { cause });
}
