/**
 * A secret the person typed on the web for this computer (`secret.save`, docs/35 §8.7): stored here,
 * encrypted with this computer's key, and used by its agent runs. A box sealed in the browser for this
 * computer's key (credentials/seal.ts) is opened only here, after checking it is for this computer, its
 * current key and the request it answers, typed on a site this computer trusts, not expired and not
 * seen before. A computer too old for that got the value over TLS through the server (`value`); that
 * path stays for servers that still send it. The answer says only whether it was saved; the value
 * never goes back.
 */
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config.js";
import { prisma as defaultPrisma } from "../lib/prisma.js";
import { appendLedger } from "../lib/ledger.js";
import { MAX_SECRET_BYTES, saveRunSecret } from "../lib/run-secrets.js";
import { trustedOrigins } from "../credentials/origins.js";
import { takeOnce } from "../credentials/replay.js";
import { checkAad, openSealed, SealedShape, SealError } from "../credentials/seal.js";
import { loadSealKey } from "../credentials/seal-key.js";
import { remoteApiBase, type HostedClient } from "./client.js";
import { loadSettings } from "./store.js";

/** `capabilities.secrets`: 1 takes `secret.save` frames; 2 also opens sealed boxes (with `sealKey`) and keeps allowed destinations. */
export const SECRETS_API = 2;

const Allow = z.array(z.string().max(300)).max(20);
const PlainSave = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(64), value: z.string().min(1).max(16 * 1024), allow: Allow.optional() });
const SealedSave = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(64), decisionId: z.string().min(1).max(100), sealed: SealedShape });
/** What a sealed box for a secret holds. */
const SecretPayload = z.object({ value: z.string().min(1), allow: Allow.optional() }).strict();

type Db = Pick<PrismaClient, "runSecret">;

/** Opens a sealed `secret.save` box and checks it; the value and its destinations, or a SealError. */
export function openSecretBox(frame: z.infer<typeof SealedSave>, now = Date.now()): { value: string; allow?: string[]; origin: string; nonce: string; expiresAt: string } {
  const key = loadSealKey();
  if (!key) throw new SealError("key", "This computer has no key for encrypted values. Update Ensemble here, or pair it again.");
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? key.deviceId;
  if (!deviceId) throw new SealError("device", "This computer does not know its own id. Pair it again.");
  const { aad, plaintext } = openSealed(frame.sealed, { kid: key.info.kid, privateKey: key.privateKey });
  try {
    checkAad(aad, { deviceId, kid: key.info.kid, decisionId: frame.decisionId, purpose: "secret", name: frame.name, origins: trustedOrigins(remoteApiBase() ?? settings.apiBase), now });
    let payload: z.infer<typeof SecretPayload>;
    try {
      payload = SecretPayload.parse(JSON.parse(plaintext.toString("utf8")));
    } catch {
      throw new SealError("shape", "That encrypted value could not be read.");
    }
    if (Buffer.byteLength(payload.value) > MAX_SECRET_BYTES) throw new SealError("shape", "A secret is 1 byte to 16 KB.");
    return { value: payload.value, ...(payload.allow ? { allow: payload.allow } : {}), origin: aad.origin, nonce: aad.nonce, expiresAt: aad.expiresAt };
  } finally {
    plaintext.fill(0);
  }
}

/** Saves what a `secret.save` frame carries, once; the answer for the web, never holding the value. */
export async function secretSaveAnswer(data: unknown, db: Db = defaultPrisma, now = Date.now()): Promise<{ status: number; body: Record<string, unknown> }> {
  const userId = env.ENSEMBLE_DEV_USER_ID;
  const sealed = SealedSave.safeParse(data);
  try {
    if (sealed.success) {
      const box = openSecretBox(sealed.data, now);
      const saved = await takeOnce({ decisionId: sealed.data.decisionId, nonce: box.nonce, expiresAt: box.expiresAt }, () => saveRunSecret(db as PrismaClient, userId, sealed.data.name, box.value, box.allow ? { allow: box.allow } : {}), now);
      await appendLedger({ userId, actor: "me", action: "secret.save", payload: { name: sealed.data.name, from: "web", sealed: true, origin: box.origin, allow: saved.allow } }).catch(() => undefined);
      return { status: 200, body: { saved: true, name: sealed.data.name, sealed: true, allow: saved.allow } };
    }
    const plain = PlainSave.safeParse(data);
    if (!plain.success) return { status: 400, body: { error: "That secret could not be read." } };
    const saved = await saveRunSecret(db as PrismaClient, userId, plain.data.name, plain.data.value, plain.data.allow ? { allow: plain.data.allow } : {});
    await appendLedger({ userId, actor: "me", action: "secret.save", payload: { name: plain.data.name, from: "web", sealed: false, allow: saved.allow } }).catch(() => undefined);
    return { status: 200, body: { saved: true, name: plain.data.name, sealed: false, allow: saved.allow } };
  } catch (error) {
    if (error instanceof SealError) {
      await appendLedger({ userId, actor: "system", action: "secret.refused", payload: { name: sealed.success ? sealed.data.name : null, reason: error.code } }).catch(() => undefined);
      return { status: error.statusCode, body: { error: error.message, code: `seal_${error.code}` } };
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return { status, body: { error: error instanceof Error ? error.message.slice(0, 300) : "This computer could not save it." } };
  }
}

export async function answerSecretSave(client: HostedClient, data: unknown): Promise<void> {
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id) return;
  await client.answerCode(id, await secretSaveAnswer(data));
}
