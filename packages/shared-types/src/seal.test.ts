import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fromBase64Url, sealAadBytes, sealFingerprint, sealFor, sealKeyId, toBase64Url, SEAL_MAX_TTL_MS, type Sealed } from "./seal.js";

const vectors = JSON.parse(readFileSync(new URL("./seal-vectors.json", import.meta.url), "utf8")) as {
  device: { spki: string; kid: string; fingerprint: string };
  ephemeral: { pkcs8: string; raw: string };
  iv: string;
  nonce: string;
  now: number;
  ttlMs: number;
  context: { purpose: string; deviceId: string; decisionId: string; name: string; origin: string };
  payload: unknown;
  sealed: Sealed;
};

async function ephemeralPair() {
  const curve = { name: "ECDH", namedCurve: "P-256" } as const;
  return {
    privateKey: await crypto.subtle.importKey("pkcs8", fromBase64Url(vectors.ephemeral.pkcs8), curve, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", fromBase64Url(vectors.ephemeral.raw), curve, true, []),
  };
}

test("the browser's sealed box matches the fixed vector byte for byte", async () => {
  const made = await sealFor(vectors.device, vectors.context, vectors.payload, {
    now: vectors.now,
    ttlMs: vectors.ttlMs,
    iv: fromBase64Url(vectors.iv),
    nonce: fromBase64Url(vectors.nonce),
    ephemeral: await ephemeralPair(),
  });
  assert.deepEqual(made.sealed, vectors.sealed);
  assert.equal(made.fingerprint, vectors.device.fingerprint);
  assert.equal(made.expiresAt, new Date(vectors.now + vectors.ttlMs).toISOString());
});

test("a key's id and fingerprint come from the SHA-256 of its SPKI; a key whose id does not match is refused", async () => {
  assert.equal(await sealKeyId(vectors.device.spki), vectors.device.kid);
  assert.equal(await sealFingerprint(vectors.device.spki), vectors.device.fingerprint);
  assert.match(vectors.device.fingerprint, /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
  await assert.rejects(sealFor({ spki: vectors.device.spki, kid: "0000000000000000" }, vectors.context, { value: "x" }), /does not match its id/);
});

test("each box is fresh, expires within the limit, and binds its context in a fixed order", async () => {
  const one = await sealFor(vectors.device, vectors.context, { value: "same" });
  const two = await sealFor(vectors.device, vectors.context, { value: "same" });
  assert.notEqual(one.sealed.ct, two.sealed.ct);
  assert.notEqual(one.sealed.epk, two.sealed.epk);
  const aad = JSON.parse(new TextDecoder().decode(fromBase64Url(one.sealed.aad)));
  assert.deepEqual(Object.keys(aad), ["v", "purpose", "kid", "deviceId", "decisionId", "name", "origin", "expiresAt", "nonce"]);
  const long = await sealFor(vectors.device, vectors.context, { value: "x" }, { ttlMs: 24 * 3600_000, now: 0 });
  assert.equal(Date.parse(long.expiresAt), SEAL_MAX_TTL_MS);
  const unnamed = sealAadBytes({ v: 1, purpose: "secret", kid: "k", deviceId: "d", decisionId: "c", origin: "o", expiresAt: "e", nonce: "n" });
  assert.equal(new TextDecoder().decode(unnamed), '{"v":1,"purpose":"secret","kid":"k","deviceId":"d","decisionId":"c","origin":"o","expiresAt":"e","nonce":"n"}');
  await assert.rejects(sealFor(vectors.device, vectors.context, { value: "x".repeat(21 * 1024) }), /too long/);
});

test("base64url round-trips any bytes", () => {
  const all = new Uint8Array(256).map((_, index) => index);
  assert.deepEqual(Array.from(fromBase64Url(toBase64Url(all))), Array.from(all));
  assert.equal(toBase64Url(new Uint8Array([251, 255])), "-_8");
  assert.throws(() => fromBase64Url("a+b/"), /base64url/);
});
