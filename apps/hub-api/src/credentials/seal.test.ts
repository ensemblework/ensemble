/**
 * Ensemble's sealed box from the computer's side (credentials/seal.ts): it opens the fixed vector the
 * browsers must make byte for byte, and any box the browser module makes with WebCrypto; it refuses a
 * box that was changed on the way, made for another key, computer, request, name or site, or past its
 * expiry.
 */
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sealFor, type Sealed } from "@ensemble/shared-types";
import { checkAad, newSealKeyPair, openSealed, readAad, sealFingerprintOf, sealKeyIdOf, SealError, type SealExpect } from "./seal.js";

const vectors = JSON.parse(readFileSync(new URL("../../../../packages/shared-types/src/seal-vectors.json", import.meta.url), "utf8")) as {
  device: { pkcs8: string; spki: string; kid: string; fingerprint: string };
  now: number;
  context: { purpose: string; deviceId: string; decisionId: string; name: string; origin: string };
  payload: unknown;
  sealed: Sealed;
};

const deviceKey = { kid: vectors.device.kid, privateKey: createPrivateKey({ key: Buffer.from(vectors.device.pkcs8, "base64url"), format: "der", type: "pkcs8" }) };
const expect = (over: Partial<SealExpect> = {}): SealExpect => ({ deviceId: vectors.context.deviceId, kid: vectors.device.kid, decisionId: vectors.context.decisionId, purpose: "secret", name: "STRIPE_KEY", origins: ["https://node.ensemblework.com", "https://app.ensemblework.com"], now: vectors.now + 60_000, ...over });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SealError, String(error));
    return error.code;
  }
  return "opened";
};
const flip = (text: string, at: number) => {
  const raw = Buffer.from(text, "base64url");
  raw[at] = raw[at]! ^ 1;
  return raw.toString("base64url");
};

test("the computer opens the fixed vector: node:crypto reads what WebCrypto made", () => {
  const { aad, plaintext } = openSealed(vectors.sealed, deviceKey);
  assert.deepEqual(JSON.parse(plaintext.toString("utf8")), vectors.payload);
  checkAad(aad, expect());
  assert.equal(sealKeyIdOf(Buffer.from(vectors.device.spki, "base64url")), vectors.device.kid);
  assert.equal(sealFingerprintOf(Buffer.from(vectors.device.spki, "base64url")), vectors.device.fingerprint);
});

test("a box the browser module makes with a fresh key opens here, once per key", async () => {
  const pair = newSealKeyPair();
  const key = { kid: pair.info.kid, privateKey: createPrivateKey({ key: pair.pkcs8, format: "der", type: "pkcs8" }) };
  const context = { purpose: "secret", deviceId: "dev-1", decisionId: "card-1", name: "PAYMENTS_API_KEY", origin: "https://app.ensemblework.com" };
  const made = await sealFor(pair.info, context, { value: "canary-é-✓", allow: [] });
  assert.equal(made.fingerprint, pair.info.fingerprint);
  const opened = openSealed(made.sealed, key);
  assert.deepEqual(JSON.parse(opened.plaintext.toString("utf8")), { value: "canary-é-✓", allow: [] });
  checkAad(opened.aad, { deviceId: "dev-1", kid: pair.info.kid, decisionId: "card-1", purpose: "secret", name: "PAYMENTS_API_KEY", origins: ["https://app.ensemblework.com"] });
  // Another computer's key cannot open it, even when the box claims to be for that key.
  assert.equal(code(() => openSealed(made.sealed, deviceKey)), "key");
  assert.equal(code(() => openSealed({ ...made.sealed, kid: vectors.device.kid }, deviceKey)), "key", "the associated data still names the first key");
});

test("anything changed on the way stops the box from opening", () => {
  const box = vectors.sealed;
  assert.equal(code(() => openSealed({ ...box, ct: flip(box.ct, 3) }, deviceKey)), "open", "ciphertext");
  assert.equal(code(() => openSealed({ ...box, ct: flip(box.ct, Buffer.from(box.ct, "base64url").length - 1) }, deviceKey)), "open", "tag");
  assert.equal(code(() => openSealed({ ...box, iv: flip(box.iv, 0) }, deviceKey)), "open", "IV");
  // The associated data is authenticated: a relay that rewrites the origin, expiry or computer breaks the box.
  const aad = JSON.parse(Buffer.from(box.aad, "base64url").toString("utf8"));
  const rewritten = Buffer.from(JSON.stringify({ ...aad, origin: "https://evil.example" }), "utf8").toString("base64url");
  assert.equal(code(() => openSealed({ ...box, aad: rewritten }, deviceKey)), "open", "associated data");
  assert.equal(code(() => openSealed({ ...box, epk: flip(box.epk, 10) }, deviceKey)), "shape", "a point off the curve");
  assert.equal(code(() => openSealed({ ...box, epk: flip(box.epk, 0) }, deviceKey)), "shape", "a compressed or bad point");
  assert.equal(code(() => openSealed({ ...box, extra: 1 } as unknown as Sealed, deviceKey)), "shape");
  assert.equal(code(() => openSealed({ ...box, ct: "!!" }, deviceKey)), "shape");
});

test("a box bound to another computer, request, name, purpose or site, or past its expiry, is refused", () => {
  const aad = readAad(vectors.sealed);
  assert.equal(code(() => checkAad(aad, expect())), "opened");
  assert.equal(code(() => checkAad(aad, expect({ deviceId: "another-computer" }))), "device");
  assert.equal(code(() => checkAad(aad, expect({ kid: "0123456789abcdef" }))), "key");
  assert.equal(code(() => checkAad(aad, expect({ decisionId: "another-card" }))), "decision");
  assert.equal(code(() => checkAad(aad, expect({ name: "OTHER_KEY" }))), "name");
  assert.equal(code(() => checkAad(aad, expect({ purpose: "login" }))), "purpose");
  assert.equal(code(() => checkAad(aad, expect({ origins: ["https://app.ensemblework.com"] }))), "origin");
  assert.equal(code(() => checkAad(aad, expect({ now: vectors.now + 10 * 60_000 + 1 }))), "expired");
  assert.equal(code(() => checkAad({ ...aad, expiresAt: new Date(vectors.now + 16 * 60_000).toISOString() }, expect({ now: vectors.now }))), "expired", "valid for too long");
  assert.equal(code(() => checkAad({ ...aad, expiresAt: "not a date" }, expect())), "expired");
});
