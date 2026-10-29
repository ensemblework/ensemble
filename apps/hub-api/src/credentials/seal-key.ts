/**
 * This computer's sealing key (B12, docs/35 §8.7): the ECDH P-256 key pair the web encrypts secrets
 * for. A new pair is made when the computer is paired (and again on each new pairing); a computer
 * paired before this existed makes one the first time it reports to the web. The private key never
 * leaves this computer: it is kept in `seal-key.json` in Ensemble's data folder (mode 0600), encrypted
 * with the runtime's local key (lib/secrets.ts, `secret.key` beside it). Ensemble keeps no key in the
 * operating system's key store yet, so anyone who can read both files as this user can read it;
 * coding-agent runs and a node's commands cannot (the data folder is denied to them, docs/24 §3).
 * Unpairing deletes it (remote/store.ts `dropDeviceToken`).
 */
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SealKeyInfo } from "@ensemble/shared-types";
import { decrypt, encrypt } from "../lib/secrets.js";
import { SEAL_KEY_FILE, stateDir } from "../remote/store.js";
import { newSealKeyPair, sealKeyInfo } from "./seal.js";

type Stored = { v: 1; kid: string; alg: string; spki: string; fingerprint: string; createdAt: string; deviceId: string | null; pkcs8: string };

export type DeviceSealKey = { info: SealKeyInfo; privateKey: KeyObject; createdAt: string; deviceId: string | null };

/** A key pair made for a pairing that has not finished: saved only once the web accepted it. */
export type PendingSealKey = { info: SealKeyInfo; pkcs8: Buffer };

export function sealKeyPath(): string {
  return join(stateDir(), SEAL_KEY_FILE);
}

let cache: { path: string; raw: string; key: DeviceSealKey } | null = null;

/** The saved key, checked: its private key must give the public key and id it was saved with. Null when there is none or it cannot be read. */
export function loadSealKey(): DeviceSealKey | null {
  const path = sealKeyPath();
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (cache?.path === path && cache.raw === raw) return cache.key;
  try {
    const stored = JSON.parse(raw) as Stored;
    const privateKey = createPrivateKey({ key: Buffer.from(decrypt(stored.pkcs8), "base64"), format: "der", type: "pkcs8" });
    const info = sealKeyInfo(createPublicKey(privateKey).export({ type: "spki", format: "der" }));
    if (stored.v !== 1 || info.kid !== stored.kid || info.spki !== stored.spki) return null;
    const key = { info, privateKey, createdAt: stored.createdAt, deviceId: stored.deviceId ?? null };
    cache = { path, raw, key };
    return key;
  } catch {
    // Another runtime's local key, or a damaged file: this computer has no usable key until it makes one.
    return null;
  }
}

export function makeSealKey(): PendingSealKey {
  return newSealKeyPair();
}

/** Saves a key pair for this computer's pairing, replacing any earlier one. */
export function saveSealKey(pending: PendingSealKey, deviceId: string | null): DeviceSealKey {
  const path = sealKeyPath();
  const stored: Stored = { v: 1, ...pending.info, createdAt: new Date().toISOString(), deviceId, pkcs8: encrypt(pending.pkcs8.toString("base64")) };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  cache = null;
  const key = loadSealKey();
  if (!key) throw new Error("This computer's sealing key could not be saved.");
  return key;
}

/** The key, made now when a paired computer has none (it was paired before keys existed, or its file was lost). */
export function ensureSealKey(deviceId: string | null): DeviceSealKey {
  return loadSealKey() ?? saveSealKey(makeSealKey(), deviceId);
}

/** What the web is told (`capabilities.sealKey`): the public key, its id and fingerprint. Null when this computer is not paired. */
export function sealKeyCapability(paired: { pairedAt: string | null; deviceId: string | null }): SealKeyInfo | null {
  if (!paired.pairedAt) return null;
  try {
    return ensureSealKey(paired.deviceId).info;
  } catch {
    return null;
  }
}

export function resetSealKeyCacheForTests(): void {
  cache = null;
}
