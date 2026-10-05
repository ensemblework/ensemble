import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBridgeConfig, resolveAuth } from "../src/config.js";

test("resolveAuth does not read the discovery file", () => {
  assert.equal(resolveAuth({}).kind, "missing");
});

test("loadBridgeConfig uses a discovery file when no hub URL is set", () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-bridge-"));
  const file = join(dir, "api.json");
  writeFileSync(file, JSON.stringify({ port: 51234, token: "abcdefghijklmnop" }));
  try {
    const config = loadBridgeConfig({ ENSEMBLE_DISCOVERY_FILE: file });
    assert.equal(config.hubUrl, "http://127.0.0.1:51234");
    assert.deepEqual(config.auth, { kind: "bearer", token: "abcdefghijklmnop" });
    const explicit = loadBridgeConfig({ ENSEMBLE_DISCOVERY_FILE: file, HUB_API_URL: "http://127.0.0.1:4000" });
    assert.equal(explicit.hubUrl, "http://127.0.0.1:4000");
    assert.equal(explicit.auth.kind, "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
