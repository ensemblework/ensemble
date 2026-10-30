/**
 * One-time codes from a saved seed (RFC 6238 TOTP: HMAC-SHA-1, 30-second steps, 6 digits), for a
 * saved login whose site asks for a code after the password. The seed is the base32 text a site shows
 * beside its QR code (or an otpauth:// address); it stays encrypted in `logins.json` with the login.
 */
import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The seed as base32 without spaces or padding; throws for anything else. Takes an otpauth:// address too. */
export function normalizeTotpSeed(input: string): string {
  let text = input.trim();
  if (/^otpauth:\/\//i.test(text)) {
    try {
      text = new URL(text).searchParams.get("secret") ?? "";
    } catch {
      text = "";
    }
  }
  const seed = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (seed.length < 16 || seed.length > 128 || ![...seed].every((char) => BASE32.includes(char))) {
    throw Object.assign(new Error("That one-time-code seed is not base32 text (the letters and digits a site shows beside its QR code)."), { statusCode: 400 });
  }
  return seed;
}

function base32Bytes(seed: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of seed) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The HOTP value of a raw key at a counter (RFC 4226), `digits` long. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The current code for a base32 seed. */
export function totpCode(seed: string, now = Date.now(), digits = 6, stepSeconds = 30): string {
  return hotp(base32Bytes(normalizeTotpSeed(seed)), Math.floor(now / 1000 / stepSeconds), digits);
}
