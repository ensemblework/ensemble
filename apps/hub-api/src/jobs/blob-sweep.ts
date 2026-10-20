/**
 * Hourly, when the server's blob store is on (lib/blob-store.ts): removes file originals and dataset
 * tables nothing uses any more, and moves dataset files still on disk into the store. The scheduler
 * calls it every tick; the first call after a start runs at once.
 */
import type { PrismaClient } from "@prisma/client";
import { blobStore } from "../lib/blob-store.js";
import { sweepOrphanOriginals } from "../files/originals.js";
import { moveLocalDatasetsToBlob, sweepOrphanDatasets } from "../plots/store.js";

const EVERY_MS = 60 * 60_000;
let last = 0;

export function resetBlobSweepForTests(): void {
  last = 0;
}

export async function sweepStoredBlobs(db: PrismaClient, now = Date.now()): Promise<{ moved: number; originals: number; datasets: number } | null> {
  if (now - last < EVERY_MS || !(await blobStore())) return null;
  last = now;
  const moved = await moveLocalDatasetsToBlob();
  const originals = await sweepOrphanOriginals(db, { now });
  const datasets = await sweepOrphanDatasets(db, { now });
  return { moved, originals, datasets };
}
