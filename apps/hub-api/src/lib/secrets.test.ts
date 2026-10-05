import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decrypt, encrypt, resetSecretKeyCacheForTests, secretNeedsEncryption } from "./secrets.js";

const KEY = randomBytes(32).toString("base64");

test("encrypt and decrypt round-trip a v1 value", () => {
  process.env.ENSEMBLE_SECRET_KEY = KEY;
  resetSecretKeyCacheForTests();
  const sealed = encrypt("sk-live-key");
  assert.ok(sealed.startsWith("v1:"));
  assert.equal(decrypt(sealed), "sk-live-key");
  assert.equal(secretNeedsEncryption(sealed), false);
});

test("decrypt rejects plaintext and unprefixed values", () => {
  process.env.ENSEMBLE_SECRET_KEY = KEY;
  resetSecretKeyCacheForTests();
  const plain = "sk-plaintext-should-not-echo";
  assert.equal(secretNeedsEncryption(plain), true);
  assert.equal(secretNeedsEncryption(""), false);
  assert.equal(secretNeedsEncryption(null), false);
  assert.throws(() => decrypt(plain), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /v1:/);
    assert.equal(error.message.includes(plain), false);
    return true;
  });
  assert.throws(() => decrypt(""), /v1:/);
  assert.throws(() => decrypt("v1:not-a-real-cipher"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("not-a-real-cipher"), false);
    return true;
  });
});
