/**
 * Ensemble's takeover channel, version 1 (design B21, docs/35 §8.16.2): the owner's browser and their
 * computer talk end to end while the owner controls a browser tab from the web. The browser makes a
 * 32-byte secret, sends it to the computer in a sealed box (seal.ts, purpose `takeover`), and both
 * derive one AES-256-GCM key per direction with HKDF-SHA-256 (salt: the takeover's id; info: the
 * direction). Every message carries a sequence number that its associated data binds, with the
 * takeover's id and direction: the relay can neither read, change, replay nor reorder a message
 * unnoticed. Frames from the computer are a JPEG with a small JSON header; input from the browser is
 * JSON.
 *
 * Pure WebCrypto, no imports: the Hub may use this file and the Ensemble Node website keeps an
 * identical copy (apps/node-web/lib/takeover-channel.ts). Both are checked against the same fixed
 * vectors, and the computer has its own node:crypto version (hub-api src/takeover/channel.ts).
 */

export const TAKEOVER_VERSION = 1 as const;
export type TakeoverDirection = "d2w" | "w2d";
/** One message as it travels through the relay: every binary field base64url. */
export type ChannelMessage = { seq: number; iv: string; ct: string };

type Subtle = typeof globalThis.crypto.subtle;
type Key = Awaited<ReturnType<Subtle["importKey"]>>;
export type ChannelKeys = { d2w: Key; w2d: Key };

function subtle(): Subtle {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("This browser cannot encrypt here (it needs a secure https page).");
  return value;
}

function copy(from: ArrayLike<number> | ArrayBuffer): Uint8Array<ArrayBuffer> {
  const view = from instanceof ArrayBuffer ? new Uint8Array(from) : from;
  const out = new Uint8Array(view.length);
  for (let index = 0; index < view.length; index += 1) out[index] = view[index]!;
  return out;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return copy(new TextEncoder().encode(text));
}

export function channelBase64Url(data: ArrayLike<number> | ArrayBuffer): string {
  const view = copy(data);
  let binary = "";
  for (let index = 0; index < view.length; index += 0x8000) binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function channelFromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Not base64url.");
  const base = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base + "=".repeat((4 - (base.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** HKDF's salt: the version and the takeover's id. */
export function takeoverSalt(takeoverId: string): Uint8Array<ArrayBuffer> {
  return utf8(`ensemble-takeover-v1|${takeoverId}`);
}

/** HKDF's info: one label per direction, so each direction has its own key. */
export function takeoverInfo(direction: TakeoverDirection): Uint8Array<ArrayBuffer> {
  return utf8(`ensemble-takeover-v1|${direction}`);
}

/** A message's associated data: JSON in a fixed key order. */
export function channelAad(takeoverId: string, direction: TakeoverDirection, seq: number): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify({ v: TAKEOVER_VERSION, t: takeoverId, d: direction, s: seq }));
}

/** The two keys of a takeover from its 32-byte secret. Not extractable. */
export async function takeoverKeys(secret: Uint8Array, takeoverId: string): Promise<ChannelKeys> {
  if (secret.length !== 32) throw new Error("A takeover's secret is 32 bytes.");
  const sub = subtle();
  const ikm = await sub.importKey("raw", copy(secret), "HKDF", false, ["deriveKey"]);
  const derive = (direction: TakeoverDirection) =>
    sub.deriveKey({ name: "HKDF", hash: "SHA-256", salt: takeoverSalt(takeoverId), info: takeoverInfo(direction) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { d2w: await derive("d2w"), w2d: await derive("w2d") };
}

/** A fresh 32-byte secret for a new takeover. */
export function newTakeoverSecret(): Uint8Array<ArrayBuffer> {
  return copy(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** Encrypts one message. Sequence numbers are positive integers, each used once per direction. */
export async function sealMessage(key: Key, takeoverId: string, direction: TakeoverDirection, seq: number, plaintext: Uint8Array, iv?: Uint8Array): Promise<ChannelMessage> {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("A sequence number is a positive integer.");
  const nonce = copy(iv ?? globalThis.crypto.getRandomValues(new Uint8Array(12)));
  if (nonce.length !== 12) throw new Error("The IV is 12 bytes.");
  const ct = await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: channelAad(takeoverId, direction, seq), tagLength: 128 }, key, copy(plaintext));
  return { seq, iv: channelBase64Url(nonce), ct: channelBase64Url(ct) };
}

/** Decrypts one message; throws when it was changed, made for another takeover or direction, or claims another sequence number. */
export async function openMessage(key: Key, takeoverId: string, direction: TakeoverDirection, message: ChannelMessage): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(message.seq) || message.seq < 1) throw new Error("A sequence number is a positive integer.");
  const iv = channelFromBase64Url(message.iv);
  if (iv.length !== 12) throw new Error("The IV is 12 bytes.");
  try {
    return copy(await subtle().decrypt({ name: "AES-GCM", iv, additionalData: channelAad(takeoverId, direction, message.seq), tagLength: 128 }, key, channelFromBase64Url(message.ct)));
  } catch {
    throw new Error("That message could not be opened: it was changed on the way, or made for another takeover.");
  }
}

/** A frame or other message with a JSON header and optional bytes (a JPEG): a 4-byte length, the header, the bytes. */
export function packMessage(header: Record<string, unknown>, payload?: Uint8Array): Uint8Array<ArrayBuffer> {
  const head = utf8(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + (payload?.length ?? 0));
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  if (payload) out.set(payload, 4 + head.length);
  return out;
}

export function unpackMessage(bytes: Uint8Array): { header: Record<string, unknown>; payload: Uint8Array<ArrayBuffer> } {
  if (bytes.length < 4) throw new Error("That message is too short.");
  const view = copy(bytes);
  const length = new DataView(view.buffer).getUint32(0);
  if (4 + length > view.length) throw new Error("That message is cut short.");
  const header = JSON.parse(new TextDecoder().decode(view.subarray(4, 4 + length))) as unknown;
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error("That message has no header.");
  return { header: header as Record<string, unknown>, payload: view.slice(4 + length) };
}
