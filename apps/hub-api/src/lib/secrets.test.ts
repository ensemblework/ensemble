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

test("ENSEMBLE_SECRET_KEY_FILE keeps the generated key outside the install folder", async () => {
  const { mkdtempSync, readFileSync, rmSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "ensemble-key-"));
  const previous = { key: process.env.ENSEMBLE_SECRET_KEY, file: process.env.ENSEMBLE_SECRET_KEY_FILE };
  try {
    delete process.env.ENSEMBLE_SECRET_KEY;
    process.env.ENSEMBLE_SECRET_KEY_FILE = join(dir, "data", "secret.key");
    resetSecretKeyCacheForTests();
    const sealed = encrypt("device-token");
    const file = process.env.ENSEMBLE_SECRET_KEY_FILE;
    assert.equal(Buffer.from(readFileSync(file, "utf8").trim(), "base64").length, 32);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    resetSecretKeyCacheForTests();
    assert.equal(decrypt(sealed), "device-token");
  } finally {
    if (previous.key === undefined) delete process.env.ENSEMBLE_SECRET_KEY;
    else process.env.ENSEMBLE_SECRET_KEY = previous.key;
    if (previous.file === undefined) delete process.env.ENSEMBLE_SECRET_KEY_FILE;
    else process.env.ENSEMBLE_SECRET_KEY_FILE = previous.file;
    resetSecretKeyCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
