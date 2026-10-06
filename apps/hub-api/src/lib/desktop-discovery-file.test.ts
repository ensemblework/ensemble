import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeDiscoveryFile } from "./desktop-discovery-file.js";

test("the discovery file is mode 0600 and holds the port, token and process id", () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-discovery-"));
  const file = join(dir, "api.json");
  const previous = process.env.ENSEMBLE_DISCOVERY_FILE;
  process.env.ENSEMBLE_DISCOVERY_FILE = file;
  try {
    const written = writeDiscoveryFile(54321, "abcdefghijklmnop");
    assert.equal(written, file);
    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
    const dirMode = statSync(dir).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { port: 54321, token: "abcdefghijklmnop", pid: process.pid });
  } finally {
    if (previous === undefined) delete process.env.ENSEMBLE_DISCOVERY_FILE;
    else process.env.ENSEMBLE_DISCOVERY_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
