/**
 * Previews live in memory for 30 minutes: one per person, holding the upload's
 * bytes (parsed again when needed, never kept parsed) or the pasted token, so
 * the import can start without sending either again. Nothing here is written
 * to the database or logged.
 */
import { randomUUID } from "node:crypto";
import type { UploadSummary } from "./files/index.js";
import { ImportError, type ImportContainer, type ImportSourceId, type SourceAuth, type SourceOptions } from "./types.js";

export const PREVIEW_TTL_MS = 30 * 60 * 1000;
/** Uploaded bytes held across everyone's previews. */
export const PREVIEW_TOTAL_BYTES = 300 * 1024 * 1024;
/** A preview untouched this long may make room for someone else's upload. */
const IDLE_EVICT_MS = 5 * 60 * 1000;
/** A stuck upload slot frees itself after this. */
const UPLOAD_SLOT_MS = 2 * 60 * 1000;
const ENTRY_OVERHEAD = 16 * 1024;

export interface PreviewEntry {
  id: string;
  userId: string;
  source: ImportSourceId;
  kind: "api" | "file";
  auth?: SourceAuth;
  options: SourceOptions;
  containers: ImportContainer[];
  /** The upload as received; parsed again for samples and at import start. */
  file?: { name: string; data: Uint8Array; hint: ImportSourceId };
  upload?: UploadSummary;
  fileName?: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

const entries = new Map<string, PreviewEntry>();
const limits = { totalBytes: PREVIEW_TOTAL_BYTES };

const sizeOf = (entry: Pick<PreviewEntry, "file">) => (entry.file?.data.byteLength ?? 0) + ENTRY_OVERHEAD;

function prune(now = Date.now()): void {
  for (const [id, entry] of entries) if (entry.expiresAt <= now) entries.delete(id);
}

function usedBytes(): number {
  let total = 0;
  for (const entry of entries.values()) total += sizeOf(entry);
  return total;
}

/**
 * Makes room for a new preview of `bytes`: drops this person's older preview,
 * then previews nobody has touched for five minutes, oldest first.
 */
export function assertPreviewRoom(userId: string, bytes: number): void {
  prune();
  for (const [id, entry] of entries) if (entry.userId === userId) entries.delete(id);
  const needed = bytes + ENTRY_OVERHEAD;
  if (needed > limits.totalBytes) throw new ImportError("That file is too large to preview right now.", 413);
  if (usedBytes() + needed <= limits.totalBytes) return;
  const cutoff = Date.now() - IDLE_EVICT_MS;
  const idle = [...entries.values()].filter((entry) => entry.lastUsedAt < cutoff).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  for (const entry of idle) {
    entries.delete(entry.id);
    if (usedBytes() + needed <= limits.totalBytes) return;
  }
  throw new ImportError("Ensemble is reading a lot of imports right now. Try again in a few minutes.", 503);
}

/** One preview per person: saving replaces their older one. */
export function savePreview(input: Omit<PreviewEntry, "id" | "createdAt" | "lastUsedAt" | "expiresAt">): PreviewEntry {
  assertPreviewRoom(input.userId, input.file?.data.byteLength ?? 0);
  const now = Date.now();
  const entry: PreviewEntry = { ...input, id: randomUUID(), createdAt: now, lastUsedAt: now, expiresAt: now + PREVIEW_TTL_MS };
  entries.set(entry.id, entry);
  return entry;
}

/** Only the owner gets an entry back; anyone else sees the same "expired" answer. */
export function getPreview(userId: string, id: string): PreviewEntry | null {
  prune();
  const entry = entries.get(id);
  if (!entry || entry.userId !== userId) return null;
  entry.lastUsedAt = Date.now();
  entry.expiresAt = entry.lastUsedAt + PREVIEW_TTL_MS;
  return entry;
}

export function dropPreview(id: string): void {
  entries.delete(id);
}

export function previewStats(): { entries: number; bytes: number } {
  prune();
  return { entries: entries.size, bytes: usedBytes() };
}

// ── one upload being read per person ────────────────────────────────────────

const uploads = new Map<string, number>();

/** False while this person already has an upload being read. */
export function beginUpload(userId: string): boolean {
  const since = uploads.get(userId);
  if (since !== undefined && Date.now() - since < UPLOAD_SLOT_MS) return false;
  uploads.set(userId, Date.now());
  return true;
}

export function endUpload(userId: string): void {
  uploads.delete(userId);
}

/** Runs `work` holding this person's upload slot, or refuses with 429 when it is taken. */
export async function withUploadSlot<T>(userId: string, work: () => T | Promise<T>): Promise<T> {
  if (!beginUpload(userId)) throw new ImportError("Ensemble is still reading your last upload. Wait a moment and try again.", 429);
  try {
    return await work();
  } finally {
    endUpload(userId);
  }
}

export function setPreviewLimitsForTests(next: Partial<typeof limits>): void {
  Object.assign(limits, next);
}

export function clearPreviewsForTests(): void {
  entries.clear();
  uploads.clear();
  limits.totalBytes = PREVIEW_TOTAL_BYTES;
}
