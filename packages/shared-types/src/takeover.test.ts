import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { channelBase64Url, channelFromBase64Url, openMessage, packMessage, sealMessage, takeoverKeys, unpackMessage, type ChannelMessage, type TakeoverDirection } from "./takeover.js";

const vectors = JSON.parse(readFileSync(new URL("./takeover-vectors.json", import.meta.url), "utf8")) as {
  secret: string;
  takeoverId: string;
  header: Record<string, unknown>;
  jpeg: string;
  messages: Array<{ direction: TakeoverDirection; seq: number; iv: string; plaintext: string; message: ChannelMessage }>;
};

test("the browser's channel makes the fixed vectors byte for byte, and opens them", async () => {
  const keys = await takeoverKeys(channelFromBase64Url(vectors.secret), vectors.takeoverId);
  for (const item of vectors.messages) {
    const key = keys[item.direction];
    const made = await sealMessage(key, vectors.takeoverId, item.direction, item.seq, channelFromBase64Url(item.plaintext), channelFromBase64Url(item.iv));
    assert.deepEqual(made, item.message, `${item.direction} ${item.seq}`);
    assert.equal(channelBase64Url(await openMessage(key, vectors.takeoverId, item.direction, item.message)), item.plaintext);
  }
  const frame = vectors.messages.find((item) => item.direction === "d2w")!;
  const unpacked = unpackMessage(channelFromBase64Url(frame.plaintext));
  assert.deepEqual(unpacked.header, vectors.header);
  assert.equal(channelBase64Url(unpacked.payload), vectors.jpeg);
  assert.equal(channelBase64Url(packMessage(vectors.header, channelFromBase64Url(vectors.jpeg))), frame.plaintext);
});

test("a message opens only with its direction's key, its takeover, its sequence number and unchanged", async () => {
  const keys = await takeoverKeys(channelFromBase64Url(vectors.secret), vectors.takeoverId);
  const input = vectors.messages[0]!;
  await assert.rejects(openMessage(keys.d2w, vectors.takeoverId, "w2d", input.message), /could not be opened/, "the other direction's key");
  await assert.rejects(openMessage(keys.w2d, vectors.takeoverId, "d2w", input.message), /could not be opened/, "the other direction");
  await assert.rejects(openMessage(keys.w2d, "another-takeover", "w2d", input.message), /could not be opened/);
  await assert.rejects(openMessage(keys.w2d, vectors.takeoverId, "w2d", { ...input.message, seq: 9 }), /could not be opened/, "a renumbered message");
  const ct = channelFromBase64Url(input.message.ct);
  ct[0] = ct[0]! ^ 1;
  await assert.rejects(openMessage(keys.w2d, vectors.takeoverId, "w2d", { ...input.message, ct: channelBase64Url(ct) }), /could not be opened/, "a changed ciphertext");
  const other = await takeoverKeys(new Uint8Array(32), vectors.takeoverId);
  await assert.rejects(openMessage(other.w2d, vectors.takeoverId, "w2d", input.message), /could not be opened/, "another secret");
  await assert.rejects(takeoverKeys(new Uint8Array(16), vectors.takeoverId), /32 bytes/);
  await assert.rejects(sealMessage(keys.w2d, vectors.takeoverId, "w2d", 0, new Uint8Array(1)), /positive integer/);
});
