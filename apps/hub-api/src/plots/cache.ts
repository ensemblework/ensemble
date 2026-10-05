import { createHash } from "node:crypto";

type Entry = { hash: string; bytes: number; at: number; rows: Array<Array<string | number | null>> };

const MAX_ENTRIES = 8;
const MAX_BYTES = 64 * 1024 * 1024;
const TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, Entry>();

function weight(): number {
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes;
  return total;
}

/** Bounded LRU of parsed tables. Keyed by dataset id and content hash. */
export function rememberTable(id: string, hash: string, rows: Array<Array<string | number | null>>): void {
  const bytes = Buffer.byteLength(JSON.stringify(rows));
  if (bytes > MAX_BYTES) return;
  cache.delete(id);
  cache.set(id, { hash, bytes, at: Date.now(), rows });
  while (cache.size > MAX_ENTRIES || weight() > MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function cachedTable(id: string, hash: string): Array<Array<string | number | null>> | null {
  const entry = cache.get(id);
  if (!entry) return null;
  if (entry.hash !== hash || Date.now() - entry.at > TTL_MS) {
    cache.delete(id);
    return null;
  }
  cache.delete(id);
  entry.at = Date.now();
  cache.set(id, entry);
  return entry.rows;
}

export function forgetTable(id: string): void {
  cache.delete(id);
}

export function hashBytes(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
