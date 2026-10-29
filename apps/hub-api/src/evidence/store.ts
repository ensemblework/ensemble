/**
 * Evidence on the web (docs/32 §7): the bytes a computer uploaded for a run, in the same blob store
 * Files uses (lib/blob-store.ts, keys evidence/<userId>/<jobId>/<id>), or on the row when this server
 * keeps uploads in the database. The run's card in Ensemble Node lists them (`data.evidence`).
 */
import type { JobEvidence, PrismaClient } from "@prisma/client";
import { blobStore, FileStorageError, storageUnreachable } from "../lib/blob-store.js";
import { updateMessageData } from "../node/store.js";
import { MAX_EVIDENCE_PER_JOB } from "./limits.js";

export const EVIDENCE_PREFIX = "evidence/";
/** Longer than any upload takes to reach its row, so a blob whose row is still being written stays. */
const SWEEP_GRACE_MS = 60 * 60_000;

export function evidenceKey(userId: string, jobId: string, id: string): string {
  return `${EVIDENCE_PREFIX}${userId}/${jobId}/${id}`;
}

/** Puts the bytes where this server keeps uploads: the blob store, else (null back) on the row. */
export async function putEvidence(key: string, bytes: Buffer, mime: string): Promise<{ onRow: Buffer | null }> {
  const store = await blobStore();
  if (!store) return { onRow: bytes };
  try {
    await store.put(key, bytes, mime);
  } catch (error) {
    throw storageUnreachable(error);
  }
  return { onRow: null };
}

/** A blob nothing will point at. Best effort: the sweep removes anything left. */
export async function discardEvidence(key: string): Promise<void> {
  const store = await blobStore().catch(() => null);
  await store?.delete(key).catch(() => undefined);
}

/** The uploaded bytes of one row. */
export async function evidenceContent(row: Pick<JobEvidence, "bytes" | "storageKey" | "local">): Promise<Buffer> {
  if (row.bytes) return Buffer.from(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength);
  if (row.local) throw new FileStorageError("This file stayed on the computer.", { statusCode: 409 });
  const store = await blobStore();
  if (!store) throw new FileStorageError("This file is kept in blob storage, which this server is not set up to read.");
  let bytes: Buffer | null;
  try {
    bytes = await store.get(row.storageKey);
  } catch (error) {
    throw storageUnreachable(error);
  }
  if (!bytes) throw new FileStorageError("This file is missing from storage.", { statusCode: 404 });
  return bytes;
}

/** Evidence blobs no row points at any more (a deleted run or account), once they are an hour old. */
export async function sweepOrphanEvidence(db: Pick<PrismaClient, "jobEvidence">, options: { now?: number } = {}): Promise<number> {
  const store = await blobStore();
  if (!store) return 0;
  const now = options.now ?? Date.now();
  let removed = 0;
  let batch: string[] = [];
  const flush = async () => {
    const kept = await db.jobEvidence.findMany({ where: { storageKey: { in: batch } }, select: { storageKey: true } });
    const keep = new Set(kept.map((row) => row.storageKey));
    for (const key of batch) {
      if (keep.has(key)) continue;
      await store.delete(key);
      removed += 1;
    }
    batch = [];
  };
  for await (const blob of store.list(EVIDENCE_PREFIX)) {
    if (now - blob.modifiedAt.getTime() < SWEEP_GRACE_MS) continue;
    batch.push(blob.key);
    if (batch.length >= 200) await flush();
  }
  if (batch.length) await flush();
  return removed;
}

/** One item as a run card and the evidence list show it. `local`: on the computer, not uploaded. */
export type CardEvidence = { id: string; kind: string; name: string; mime: string; size: number; caption?: string; requirementId?: string; createdAt: string; local?: true };

export function cardEvidence(row: Pick<JobEvidence, "id" | "kind" | "name" | "mime" | "size" | "caption" | "requirementId" | "createdAt" | "local">): CardEvidence {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    mime: row.mime,
    size: row.size,
    ...(row.caption ? { caption: row.caption } : {}),
    ...(row.requirementId ? { requirementId: row.requirementId } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.local ? { local: true as const } : {}),
  };
}

/** A run's evidence, oldest first, for its owner. */
export async function evidenceOf(prisma: Pick<PrismaClient, "jobEvidence">, jobId: string, accountId: string): Promise<CardEvidence[]> {
  const rows = await prisma.jobEvidence.findMany({
    where: { jobId, userId: accountId },
    orderBy: { createdAt: "asc" },
    take: MAX_EVIDENCE_PER_JOB,
    select: { id: true, kind: true, name: true, mime: true, size: true, caption: true, requirementId: true, createdAt: true, local: true },
  });
  return rows.map(cardEvidence);
}

/**
 * The run's card in Ensemble Node (node/sessions.ts) lists its evidence: read again from the rows each
 * time, so two uploads at once both show. Only the owner sees a run card, so its evidence stays theirs.
 */
export async function refreshRunCard(prisma: PrismaClient, jobId: string): Promise<void> {
  const run = await prisma.nodeRun.findUnique({ where: { jobId }, select: { messageId: true, userId: true } });
  if (!run?.messageId) return;
  const card = await prisma.nodeMessage.findUnique({ where: { id: run.messageId } });
  if (!card) return;
  await updateMessageData(prisma, card, { evidence: await evidenceOf(prisma, jobId, run.userId) });
}
