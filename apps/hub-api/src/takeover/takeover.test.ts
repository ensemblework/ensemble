/**
 * The takeover channel on the computer (B21): node:crypto makes the same fixed vectors as the browser's
 * WebCrypto module, byte for byte, and each side opens what the other made with a fresh secret.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { takeoverKeys as browserKeys, openMessage as browserOpen, sealMessage as browserSeal } from "@ensemble/shared-types";
import { ChannelError, openMessage, packMessage, sealMessage, takeoverKeys, unpackMessage, type TakeoverDirection } from "./channel.js";
import { takeoverMaxMs } from "./session.js";

const require = createRequire(import.meta.url);
const vectors = JSON.parse(readFileSync(require.resolve("@ensemble/shared-types/takeover").replace(/takeover\.ts$/, "takeover-vectors.json"), "utf8")) as {
  secret: string;
  takeoverId: string;
  header: Record<string, unknown>;
  jpeg: string;
  messages: Array<{ direction: TakeoverDirection; seq: number; iv: string; plaintext: string; message: { seq: number; iv: string; ct: string } }>;
};

test("the computer's channel makes the browser's fixed vectors byte for byte, and opens them", () => {
  const keys = takeoverKeys(Buffer.from(vectors.secret, "base64url"), vectors.takeoverId);
  for (const item of vectors.messages) {
    const plaintext = Buffer.from(item.plaintext, "base64url");
    assert.deepEqual(sealMessage(keys[item.direction], vectors.takeoverId, item.direction, item.seq, plaintext, Buffer.from(item.iv, "base64url")), item.message);
    assert.deepEqual(openMessage(keys[item.direction], vectors.takeoverId, item.direction, item.message), plaintext);
  }
  const frame = unpackMessage(Buffer.from(vectors.messages.find((item) => item.direction === "d2w")!.plaintext, "base64url"));
  assert.deepEqual(frame.header, vectors.header);
  assert.equal(frame.payload.toString("base64url"), vectors.jpeg);
  assert.throws(() => openMessage(keys.d2w, vectors.takeoverId, "w2d", vectors.messages[0]!.message), ChannelError);
  assert.throws(() => openMessage(keys.w2d, vectors.takeoverId, "w2d", { ...vectors.messages[0]!.message, seq: 2 }), ChannelError, "renumbered");
  assert.throws(() => takeoverKeys(Buffer.alloc(31), vectors.takeoverId), /32 bytes/);
});

test("with a fresh secret, the browser opens what the computer sealed and the other way round", async () => {
  const secret = randomBytes(32);
  const id = "0b9a7d3e-5f61-4c2a-8e1d-6c4b2a1f0e9d";
  const device = takeoverKeys(secret, id);
  const browser = await browserKeys(new Uint8Array(secret), id);
  const frame = packMessage({ t: "frame", w: 390, h: 844 }, randomBytes(2000));
  const fromDevice = sealMessage(device.d2w, id, "d2w", 7, frame);
  assert.deepEqual(Buffer.from(await browserOpen(browser.d2w, id, "d2w", fromDevice)), frame);
  const input = new TextEncoder().encode(JSON.stringify({ events: [{ t: "text", text: "héllo" }] }));
  const fromBrowser = await browserSeal(browser.w2d, id, "w2d", 1, input);
  assert.deepEqual(openMessage(device.w2d, id, "w2d", fromBrowser), Buffer.from(input));
  await assert.rejects(browserOpen(browser.w2d, id, "d2w", fromDevice), /could not be opened/, "each direction has its own key");
});

test("a takeover lasts 15 minutes unless set, between 2 seconds and an hour", () => {
  assert.equal(takeoverMaxMs({}), 900_000);
  assert.equal(takeoverMaxMs({ ENSEMBLE_TAKEOVER_SECONDS: "60" }), 60_000);
  assert.equal(takeoverMaxMs({ ENSEMBLE_TAKEOVER_SECONDS: "0" }), 2_000);
  assert.equal(takeoverMaxMs({ ENSEMBLE_TAKEOVER_SECONDS: "99999" }), 3_600_000);
  assert.equal(takeoverMaxMs({ ENSEMBLE_TAKEOVER_SECONDS: "soon" }), 900_000);
});
