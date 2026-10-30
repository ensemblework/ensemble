/**
 * The takeover channel on the computer (design B21): the same messages as the browser's WebCrypto
 * module (`@ensemble/shared-types` takeover.ts, checked against the same fixed vectors), with
 * node:crypto. One AES-256-GCM key per direction from the 32-byte secret the owner's browser sealed for
 * this computer; each message's sequence number, direction and takeover are its associated data.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export type TakeoverDirection = "d2w" | "w2d";
export type ChannelMessage = { seq: number; iv: string; ct: string };
export type ChannelKeys = { d2w: Buffer; w2d: Buffer };

export class ChannelError extends Error {}

export function channelAad(takeoverId: string, direction: TakeoverDirection, seq: number): Buffer {
  return Buffer.from(JSON.stringify({ v: 1, t: takeoverId, d: direction, s: seq }), "utf8");
}

export function takeoverKeys(secret: Buffer, takeoverId: string): ChannelKeys {
  if (secret.length !== 32) throw new ChannelError("A takeover's secret is 32 bytes.");
  const salt = Buffer.from(`ensemble-takeover-v1|${takeoverId}`, "utf8");
  const derive = (direction: TakeoverDirection) => Buffer.from(hkdfSync("sha256", secret, salt, Buffer.from(`ensemble-takeover-v1|${direction}`, "utf8"), 32));
  return { d2w: derive("d2w"), w2d: derive("w2d") };
}

export function sealMessage(key: Buffer, takeoverId: string, direction: TakeoverDirection, seq: number, plaintext: Buffer, iv: Buffer = randomBytes(12)): ChannelMessage {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new ChannelError("A sequence number is a positive integer.");
  if (iv.length !== 12) throw new ChannelError("The IV is 12 bytes.");
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(channelAad(takeoverId, direction, seq));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { seq, iv: iv.toString("base64url"), ct: body.toString("base64url") };
}

export function openMessage(key: Buffer, takeoverId: string, direction: TakeoverDirection, message: ChannelMessage): Buffer {
  if (!Number.isSafeInteger(message.seq) || message.seq < 1) throw new ChannelError("A sequence number is a positive integer.");
  const iv = Buffer.from(message.iv, "base64url");
  const body = Buffer.from(message.ct, "base64url");
  if (iv.length !== 12 || body.length < 16) throw new ChannelError("That message could not be read.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(channelAad(takeoverId, direction, message.seq));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  } catch {
    throw new ChannelError("That message could not be opened: it was changed on the way, or made for another takeover.");
  }
}

/** A JSON header and optional bytes: a 4-byte length, the header, the bytes (the browser's `packMessage`). */
export function packMessage(header: Record<string, unknown>, payload?: Buffer): Buffer {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(head.length);
  return Buffer.concat([length, head, payload ?? Buffer.alloc(0)]);
}

export function unpackMessage(bytes: Buffer): { header: Record<string, unknown>; payload: Buffer } {
  if (bytes.length < 4) throw new ChannelError("That message is too short.");
  const length = bytes.readUInt32BE(0);
  if (4 + length > bytes.length) throw new ChannelError("That message is cut short.");
  const header = JSON.parse(bytes.subarray(4, 4 + length).toString("utf8")) as unknown;
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new ChannelError("That message has no header.");
  return { header: header as Record<string, unknown>, payload: bytes.subarray(4 + length) };
}
