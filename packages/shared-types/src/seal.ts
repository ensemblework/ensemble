/**
 * Ensemble's sealed box, version 1: a value typed in the browser, encrypted for one paired computer
 * (docs/35 §8.7). The computer's key is ECDH P-256; each box uses a fresh ephemeral key, HKDF-SHA-256
 * and AES-256-GCM. The associated data binds the box to the computer, its key, the request it answers,
 * the site it was typed on and an expiry, so the hosted relay can carry it but not read it, change
 * it or use it anywhere else.
 *
 * Pure WebCrypto, no imports: the Hub uses this file and the Ensemble Node website keeps an identical
 * copy (apps/node-web/lib/seal.ts). Both are checked against the same fixed vectors, and the computer
 * opens boxes with its own code (hub-api src/credentials/seal.ts).
 */

export const SEAL_VERSION = 1 as const;
export const SEAL_ALG = "ECDH-P256+HKDF-SHA256+A256GCM";
/** A box is good for this long after it is made. */
export const SEAL_TTL_MS = 10 * 60_000;
/** The computer refuses a box whose expiry is further away than this. */
export const SEAL_MAX_TTL_MS = 15 * 60_000;
/** The most a box's plaintext may be (a 16 KB secret and its settings). */
export const SEAL_MAX_PLAINTEXT_BYTES = 20 * 1024;

/** A computer's public key as the web is given it. `spki` is base64url DER; `kid` and `fingerprint` come from its SHA-256. */
export type SealKeyInfo = { kid: string; alg: string; spki: string; fingerprint: string };

/** What a box is bound to. Serialised in this key order (`sealAadBytes`). */
export type SealAad = {
  v: typeof SEAL_VERSION;
  /** What the box is for: `secret` (a run secret for a node's request). */
  purpose: string;
  kid: string;
  deviceId: string;
  /** The request it answers: the secret card's message id. */
  decisionId: string;
  /** The secret's name, when the box carries one. */
  name?: string;
  /** The site the value was typed on, as its `location.origin`. */
  origin: string;
  expiresAt: string;
  nonce: string;
};

/** The box as it travels: every binary field base64url. */
export type Sealed = { v: typeof SEAL_VERSION; kid: string; epk: string; iv: string; ct: string; aad: string };

type Subtle = typeof globalThis.crypto.subtle;
type Key = Awaited<ReturnType<Subtle["importKey"]>>;
type KeyPair = { publicKey: Key; privateKey: Key };

function subtle(): Subtle {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("This browser cannot encrypt here (it needs a secure https page).");
  return value;
}

function bytes(from: ArrayLike<number> | ArrayBuffer): Uint8Array<ArrayBuffer> {
  const view = from instanceof ArrayBuffer ? new Uint8Array(from) : from;
  const out = new Uint8Array(view.length);
  for (let index = 0; index < view.length; index += 1) out[index] = view[index]!;
  return out;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return bytes(new TextEncoder().encode(text));
}

export function toBase64Url(data: ArrayLike<number> | ArrayBuffer): string {
  const view = bytes(data);
  let binary = "";
  for (let index = 0; index < view.length; index += 0x8000) binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Not base64url.");
  const base = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base + "=".repeat((4 - (base.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A key's id: the first 16 hex digits of the SHA-256 of its SPKI. */
export async function sealKeyId(spki: string): Promise<string> {
  return (await sha256Hex(fromBase64Url(spki))).slice(0, 16);
}

/** The fingerprint people compare: the same 16 hex digits, in four groups of four ("3F2A 9C01 77DE 4B10"). */
export async function sealFingerprint(spki: string): Promise<string> {
  const hex = (await sealKeyId(spki)).toUpperCase();
  return hex.match(/.{4}/g)!.join(" ");
}

/** The associated data's exact bytes: JSON in a fixed key order, `name` left out when there is none. */
export function sealAadBytes(aad: SealAad): Uint8Array<ArrayBuffer> {
  const ordered = {
    v: aad.v,
    purpose: aad.purpose,
    kid: aad.kid,
    deviceId: aad.deviceId,
    decisionId: aad.decisionId,
    ...(aad.name === undefined ? {} : { name: aad.name }),
    origin: aad.origin,
    expiresAt: aad.expiresAt,
    nonce: aad.nonce,
  };
  return utf8(JSON.stringify(ordered));
}

/** HKDF info: the version and the key the box is for. */
export function sealInfo(kid: string): Uint8Array<ArrayBuffer> {
  return utf8(`ensemble-seal-v1|${kid}`);
}

export type SealContext = { purpose: string; deviceId: string; decisionId: string; name?: string; origin: string };

/** Tests make a box byte for byte: a fixed ephemeral key, IV, nonce and time. */
export type SealOptions = { now?: number; ttlMs?: number; iv?: Uint8Array; nonce?: Uint8Array; ephemeral?: KeyPair };

/**
 * Encrypts `payload` (any JSON) for the computer whose key is `target`. Checks first that the key's id
 * is the SHA-256 of its SPKI, so the fingerprint shown is the key actually used.
 */
export async function sealFor(target: Pick<SealKeyInfo, "kid" | "spki">, context: SealContext, payload: unknown, options: SealOptions = {}): Promise<{ sealed: Sealed; fingerprint: string; expiresAt: string }> {
  const sub = subtle();
  if ((await sealKeyId(target.spki)) !== target.kid) throw new Error("The computer's key does not match its id. Reload the page; if this stays, pair the computer again.");
  const plain = utf8(JSON.stringify(payload));
  if (plain.length > SEAL_MAX_PLAINTEXT_BYTES) throw new Error("That is too long to send (at most 16 KB).");
  const now = options.now ?? Date.now();
  const expiresAt = new Date(now + Math.min(options.ttlMs ?? SEAL_TTL_MS, SEAL_MAX_TTL_MS)).toISOString();
  const nonce = toBase64Url(options.nonce ?? globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const iv = bytes(options.iv ?? globalThis.crypto.getRandomValues(new Uint8Array(12)));
  if (iv.length !== 12) throw new Error("The IV is 12 bytes.");
  const recipient = await sub.importKey("spki", fromBase64Url(target.spki), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = options.ephemeral ?? ((await sub.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as KeyPair);
  const epk = bytes(await sub.exportKey("raw", ephemeral.publicKey));
  const shared = await sub.deriveBits({ name: "ECDH", public: recipient }, ephemeral.privateKey, 256);
  const ikm = await sub.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await sub.deriveKey({ name: "HKDF", hash: "SHA-256", salt: epk, info: sealInfo(target.kid) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const aad = sealAadBytes({ v: SEAL_VERSION, purpose: context.purpose, kid: target.kid, deviceId: context.deviceId, decisionId: context.decisionId, ...(context.name === undefined ? {} : { name: context.name }), origin: context.origin, expiresAt, nonce });
  const ct = await sub.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, plain);
  return {
    sealed: { v: SEAL_VERSION, kid: target.kid, epk: toBase64Url(epk), iv: toBase64Url(iv), ct: toBase64Url(ct), aad: toBase64Url(aad) },
    fingerprint: await sealFingerprint(target.spki),
    expiresAt,
  };
}
