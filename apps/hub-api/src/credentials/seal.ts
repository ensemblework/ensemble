/**
 * The computer's side of Ensemble's sealed box v1 (docs/35 §8.7; the browser side is
 * `@ensemble/shared-types` seal.ts). The computer keeps an ECDH P-256 key pair; the web encrypts a value
 * for its public key with an ephemeral key, HKDF-SHA-256 and AES-256-GCM, binding the box to this
 * computer, its key, the request it answers, the site it was typed on and an expiry. This file opens a
 * box and checks what it is bound to. It uses node:crypto, not WebCrypto, so the two sides are separate
 * implementations of one format, checked against the same fixed vectors.
 */
import { createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";
import { z } from "zod";
import { SEAL_ALG, SEAL_MAX_PLAINTEXT_BYTES, SEAL_MAX_TTL_MS, SEAL_VERSION, type SealAad, type SealKeyInfo, type Sealed } from "@ensemble/shared-types";

export type SealProblem = "shape" | "key" | "device" | "decision" | "purpose" | "name" | "origin" | "expired" | "replay" | "open";

/** A box this computer will not open, and why. The message is for the owner; it never holds the value. */
export class SealError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: SealProblem,
    message: string,
  ) {
    super(message);
    this.name = "SealError";
    this.statusCode = code === "shape" ? 400 : code === "replay" || code === "key" ? 409 : 403;
  }
}

const B64U = /^[A-Za-z0-9_-]+$/;
const b64u = (min: number, max: number) => z.string().min(min).max(max).regex(B64U);
/** The most ciphertext a box carries (the plaintext limit and the tag), as base64url. */
const MAX_CT_CHARS = Math.ceil(((SEAL_MAX_PLAINTEXT_BYTES + 16) * 4) / 3);

/** A box as it travels: an uncompressed P-256 point (65 bytes), a 12-byte IV, ciphertext with its 16-byte tag, the associated data. */
export const SealedShape = z
  .object({
    v: z.literal(SEAL_VERSION),
    kid: z.string().regex(/^[0-9a-f]{16}$/),
    epk: b64u(87, 87),
    iv: b64u(16, 16),
    ct: b64u(23, MAX_CT_CHARS),
    aad: b64u(8, 2800),
  })
  .strict();

export const SealAadShape = z
  .object({
    v: z.literal(SEAL_VERSION),
    purpose: z.string().min(1).max(40),
    kid: z.string().regex(/^[0-9a-f]{16}$/),
    deviceId: z.string().min(1).max(100),
    decisionId: z.string().min(1).max(100),
    name: z.string().min(1).max(64).optional(),
    origin: z.string().min(1).max(300),
    expiresAt: z.string().min(1).max(40),
    nonce: b64u(16, 64),
  })
  .strict();

function fromB64u(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

/** The key's id: the first 16 hex digits of the SHA-256 of its SPKI (DER). */
export function sealKeyIdOf(spki: Buffer): string {
  return createHash("sha256").update(spki).digest("hex").slice(0, 16);
}

/** The fingerprint people compare, as the web shows it: "3F2A 9C01 77DE 4B10". */
export function sealFingerprintOf(spki: Buffer): string {
  return sealKeyIdOf(spki).toUpperCase().match(/.{4}/g)!.join(" ");
}

export function sealKeyInfo(spki: Buffer): SealKeyInfo {
  return { kid: sealKeyIdOf(spki), alg: SEAL_ALG, spki: spki.toString("base64url"), fingerprint: sealFingerprintOf(spki) };
}

/** A new key pair: the private key as PKCS#8 DER (kept encrypted on this computer), the public key's details for the web. */
export function newSealKeyPair(): { info: SealKeyInfo; pkcs8: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { info: sealKeyInfo(publicKey.export({ type: "spki", format: "der" })), pkcs8: privateKey.export({ type: "pkcs8", format: "der" }) };
}

/** The associated data a box carries, read and checked for shape (it is authenticated when the box is opened). */
export function readAad(sealed: Pick<Sealed, "aad">): SealAad {
  let value: unknown;
  try {
    value = JSON.parse(fromB64u(sealed.aad).toString("utf8"));
  } catch {
    throw new SealError("shape", "That encrypted value could not be read.");
  }
  const parsed = SealAadShape.safeParse(value);
  if (!parsed.success) throw new SealError("shape", "That encrypted value could not be read.");
  return parsed.data as SealAad;
}

/** What a box must be bound to, here and now. */
export type SealExpect = {
  deviceId: string;
  kid: string;
  decisionId: string;
  purpose: string;
  name?: string;
  /** The sites this computer accepts boxes from (credentials/origins.ts). */
  origins: readonly string[];
  now?: number;
};

/** Refuses a box bound to something else: another computer or key, another request or name, a site this computer does not trust, or past its expiry. */
export function checkAad(aad: SealAad, expect: SealExpect): void {
  const now = expect.now ?? Date.now();
  if (aad.kid !== expect.kid) throw new SealError("key", "This computer's key changed since the page was loaded. Reload the page and type it again.");
  if (aad.deviceId !== expect.deviceId) throw new SealError("device", "That value was encrypted for another computer.");
  if (aad.decisionId !== expect.decisionId) throw new SealError("decision", "That value was encrypted for another request.");
  if (aad.purpose !== expect.purpose) throw new SealError("purpose", "That value was encrypted for something else.");
  if ((aad.name ?? null) !== (expect.name ?? null)) throw new SealError("name", "That value was encrypted for another name.");
  if (!expect.origins.includes(aad.origin)) throw new SealError("origin", `This computer does not take values typed on ${aad.origin.slice(0, 120)}.`);
  const expires = Date.parse(aad.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) throw new SealError("expired", "That encrypted value expired. Type it again.");
  if (expires - now > SEAL_MAX_TTL_MS) throw new SealError("expired", "That encrypted value is valid for too long, so it was refused.");
}

/** The ephemeral public key of a box, from its raw uncompressed point; OpenSSL refuses a point that is not on the curve. */
function ephemeralKey(raw: Buffer): KeyObject {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new SealError("shape", "That encrypted value could not be read.");
  try {
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  } catch {
    throw new SealError("shape", "That encrypted value could not be read.");
  }
}

/**
 * Opens a box with this computer's private key. Only the key it names can open it, and only with its
 * exact associated data: anything changed on the way fails here. The plaintext is returned, never kept.
 */
export function openSealed(sealed: Sealed, key: { kid: string; privateKey: KeyObject }): { aad: SealAad; plaintext: Buffer } {
  const shape = SealedShape.safeParse(sealed);
  if (!shape.success) throw new SealError("shape", "That encrypted value could not be read.");
  if (sealed.kid !== key.kid) throw new SealError("key", "This computer's key changed since the page was loaded. Reload the page and type it again.");
  const aad = readAad(sealed);
  if (aad.kid !== sealed.kid) throw new SealError("key", "That encrypted value names two keys.");
  const epk = fromB64u(sealed.epk);
  const iv = fromB64u(sealed.iv);
  const body = fromB64u(sealed.ct);
  if (iv.length !== 12 || body.length < 17) throw new SealError("shape", "That encrypted value could not be read.");
  try {
    const shared = diffieHellman({ privateKey: key.privateKey, publicKey: ephemeralKey(epk) });
    const aesKey = Buffer.from(hkdfSync("sha256", shared, epk, Buffer.from(`ensemble-seal-v1|${key.kid}`, "utf8"), 32));
    const decipher = createDecipheriv("aes-256-gcm", aesKey, iv, { authTagLength: 16 });
    decipher.setAAD(fromB64u(sealed.aad));
    decipher.setAuthTag(body.subarray(body.length - 16));
    const plaintext = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
    return { aad, plaintext };
  } catch (error) {
    if (error instanceof SealError) throw error;
    throw new SealError("open", "That encrypted value could not be opened here: it was changed on the way, or made for another key.");
  }
}
