/**
 * Upload ids for evidence the web asks a computer for (protocol 7, docs/25 §4.11): the files a node's
 * browser or capture tool writes (`new`, for that node's tool operation), and a held or kept file the
 * owner releases (`release`) or previews (`preview`). Each id names the computer, the account and what
 * it may carry, and lives in Redis for a short while; the computer posts to `ROUTES.evidenceUpload`
 * with it. Nothing else lets a computer add evidence outside a run's lease.
 */
import { randomUUID } from "node:crypto";

type Redisish = { get(key: string): Promise<string | null>; set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>; del(...keys: string[]): Promise<unknown> };

export type UploadGrant =
  | { mode: "new"; deviceId: string; ownerId: string; nodeId: string; operation: string }
  | { mode: "release"; deviceId: string; ownerId: string; evidenceId: string }
  | { mode: "preview"; deviceId: string; ownerId: string; evidenceId: string };

const key = (uploadId: string) => `ensemble:evidence:upload:${uploadId}`;

/** A node's capture call may take a two-minute video and its upload; a release or preview is answered at once. */
const TTL_SECONDS = { new: 60 * 60, release: 15 * 60, preview: 5 * 60 } as const;

export async function grantUpload(redis: Redisish, grant: UploadGrant): Promise<string> {
  const uploadId = randomUUID();
  await redis.set(key(uploadId), JSON.stringify(grant), "EX", TTL_SECONDS[grant.mode]);
  return uploadId;
}

export async function grantOf(redis: Pick<Redisish, "get">, uploadId: string): Promise<UploadGrant | null> {
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) return null;
  const raw = await redis.get(key(uploadId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UploadGrant;
  } catch {
    return null;
  }
}

export async function dropGrant(redis: Pick<Redisish, "del">, uploadId: string): Promise<void> {
  await redis.del(key(uploadId)).catch(() => undefined);
}

const previewKey = (evidenceId: string) => `ensemble:evidence:preview:${evidenceId}`;

/** A held file's bytes for its owner's preview: kept in Redis for five minutes, never in the database or the blob store. */
export const PREVIEW_TTL_SECONDS = 5 * 60;
/** The largest file previewed from its computer; a larger held video previews by its poster. */
export const PREVIEW_MAX_BYTES = 32 * 1024 * 1024;

export async function keepPreview(redis: Redisish, evidenceId: string, mime: string, bytes: Buffer): Promise<void> {
  await redis.set(previewKey(evidenceId), JSON.stringify({ mime, data: bytes.toString("base64") }), "EX", PREVIEW_TTL_SECONDS);
}

export async function previewOf(redis: Pick<Redisish, "get">, evidenceId: string): Promise<{ mime: string; bytes: Buffer } | null> {
  const raw = await redis.get(previewKey(evidenceId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { mime: string; data: string };
    return { mime: parsed.mime, bytes: Buffer.from(parsed.data, "base64") };
  } catch {
    return null;
  }
}

export async function dropPreview(redis: Pick<Redisish, "del">, evidenceId: string): Promise<void> {
  await redis.del(previewKey(evidenceId)).catch(() => undefined);
}
