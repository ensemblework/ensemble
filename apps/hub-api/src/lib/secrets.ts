/**
 * Encryption at rest for connector tokens and OAuth client secrets.
 * Same format and key as agent-runtime's vault.py, so either side can read
 * what the other wrote: "v1:" + base64(nonce[12] + ciphertext + tag[16]).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const DEFAULT_KEY_FILE = resolve(REPO_ROOT, ".ensemble/secret.key");

let cached: Buffer | null = null;

function keyFile(): string {
  return process.env.ENSEMBLE_SECRET_KEY_FILE?.trim() || DEFAULT_KEY_FILE;
}

function key(): Buffer {
  if (cached) return cached;
  let raw = process.env.ENSEMBLE_SECRET_KEY?.trim() ?? "";
  if (!raw) {
    const file = keyFile();
    if (existsSync(file)) {
      raw = readFileSync(file, "utf8").trim();
    } else {
      mkdirSync(dirname(file), { recursive: true });
      raw = randomBytes(32).toString("base64");
      writeFileSync(file, `${raw}\n`, { mode: 0o600, flag: "wx" });
    }
  }
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length !== 32) throw new Error("ENSEMBLE_SECRET_KEY must be 32 bytes, base64-encoded.");
  cached = buffer;
  return buffer;
}

export function encrypt(plain: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64")}`;
}

/** True when a stored secret still needs the one-time encryption script. */
export function secretNeedsEncryption(value: string | null | undefined): boolean {
  return typeof value === "string" && value.length > 0 && !value.startsWith("v1:");
}

export function decrypt(value: string): string {
  if (secretNeedsEncryption(value) || !value.startsWith("v1:")) {
    throw new Error(
      "Stored secret is not encrypted. Expected a v1: value. Run pnpm secrets:encrypt once with the same ENSEMBLE_SECRET_KEY.",
    );
  }
  const blob = Buffer.from(value.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]).toString("utf8");
}

/** Tests set a key after another file may have cached one. */
export function resetSecretKeyCacheForTests(): void {
  cached = null;
}
