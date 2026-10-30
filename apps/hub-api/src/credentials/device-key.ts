/**
 * The web's record of each paired computer's sealing key (B12, docs/35 §8.7). The first key a
 * computer reports, when it is paired or on its first report after an update, is pinned on its
 * `devices` row: the web encrypts secrets only for that key until the computer is paired again (a
 * new pairing is a new row with its own key). A later report of a different key changes nothing and
 * shows on the computer as a mismatch, so someone holding a stolen device token cannot swap in their
 * own key. The key's id and fingerprint are worked out here from the key itself, never taken on trust.
 */
import { createPublicKey } from "node:crypto";
import { Prisma, type Device, type PrismaClient } from "@prisma/client";
import { SEAL_ALG, type SealKeyInfo } from "@ensemble/shared-types";
import { appendLedger } from "../lib/ledger.js";
import { sealKeyInfo } from "./seal.js";

export type PinnedSealKey = SealKeyInfo & { pinnedAt: string };

/** The key a computer reported in its capabilities, checked: an EC P-256 public key whose id is its own SHA-256. Null for anything else. */
export function reportedSealKey(capabilities: unknown): SealKeyInfo | null {
  const raw = capabilities && typeof capabilities === "object" ? (capabilities as { sealKey?: unknown }).sealKey : undefined;
  if (!raw || typeof raw !== "object") return null;
  const { kid, alg, spki } = raw as { kid?: unknown; alg?: unknown; spki?: unknown };
  if (alg !== SEAL_ALG || typeof spki !== "string" || spki.length > 400 || !/^[A-Za-z0-9_-]+$/.test(spki)) return null;
  try {
    const der = Buffer.from(spki, "base64url");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    const info = sealKeyInfo(der);
    return info.kid === kid ? info : null;
  } catch {
    return null;
  }
}

/** The pinned key on a computer's row, when it has one. */
export function pinnedSealKey(device: Pick<Device, "sealKey">): PinnedSealKey | null {
  const value = device.sealKey as Partial<PinnedSealKey> | null;
  if (!value || typeof value !== "object" || typeof value.kid !== "string" || typeof value.spki !== "string" || typeof value.fingerprint !== "string") return null;
  return { kid: value.kid, alg: value.alg ?? SEAL_ALG, spki: value.spki, fingerprint: value.fingerprint, pinnedAt: value.pinnedAt ?? "" };
}

/** What the web shows for a computer: its pinned key, and whether it now reports another one. */
export function sealKeyView(device: Pick<Device, "sealKey" | "capabilities">): { sealKey: PinnedSealKey | null; sealKeyMismatch: boolean } {
  const pinned = pinnedSealKey(device);
  const reported = reportedSealKey(device.capabilities);
  return { sealKey: pinned, sealKeyMismatch: Boolean(pinned && reported && reported.kid !== pinned.kid) };
}

/** The data that pins a new computer's key, for its row when it is paired. */
export function sealKeyOnPairing(capabilities: unknown): { sealKey: Prisma.InputJsonValue } | Record<string, never> {
  const reported = reportedSealKey(capabilities);
  return reported ? { sealKey: { ...reported, pinnedAt: new Date().toISOString() } } : {};
}

/**
 * On a computer's report: pins the key it reports when it has none yet (a computer paired before keys,
 * now updated). A different key from the pinned one is kept out, and noted in the ledger once.
 */
export async function pinReportedSealKey(prisma: Pick<PrismaClient, "device">, device: Pick<Device, "id" | "userId" | "name" | "sealKey" | "capabilities">, capabilities: unknown): Promise<void> {
  const reported = reportedSealKey(capabilities);
  if (!reported) return;
  const pinned = pinnedSealKey(device);
  if (!pinned) {
    const won = await prisma.device.updateMany({ where: { id: device.id, revokedAt: null, sealKey: { equals: Prisma.DbNull } }, data: { sealKey: { ...reported, pinnedAt: new Date().toISOString() } } });
    if (won.count) await appendLedger({ userId: device.userId, actor: "system", action: "device.seal_key", payload: { deviceId: device.id, kid: reported.kid, fingerprint: reported.fingerprint } }).catch(() => undefined);
    return;
  }
  if (pinned.kid === reported.kid) return;
  const reportedBefore = reportedSealKey(device.capabilities);
  if (reportedBefore?.kid !== reported.kid) {
    await appendLedger({ userId: device.userId, actor: "system", action: "device.seal_key_mismatch", payload: { deviceId: device.id, name: device.name, pinned: pinned.kid, reported: reported.kid } }).catch(() => undefined);
  }
}
