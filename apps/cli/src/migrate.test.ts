import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateLegacyData } from "./migrate.js";
import { resolveCliPaths } from "./paths.js";

function setup() {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-migrate-"));
  const legacy = join(root, "legacy");
  const paths = resolveCliPaths({ platform: "linux", home: root, env: { ENSEMBLE_DATA_HOME: join(root, "shared"), ENSEMBLE_CONFIG_DIR: join(root, "config") } });
  return { root, legacy, paths };
}

test("an older CLI's database, key and pairing move to the shared folder once", async () => {
  const { root, legacy, paths } = setup();
  try {
    mkdirSync(join(legacy, "pglite"), { recursive: true });
    writeFileSync(join(legacy, "pglite", "PG_VERSION"), "17");
    writeFileSync(join(legacy, "secret.key"), "key-a");
    writeFileSync(join(legacy, "remote.json"), "{}");
    const result = await migrateLegacyData(paths, { legacy });
    assert.equal(result.status, "moved");
    assert.equal(readFileSync(join(paths.dataHome, "pglite", "PG_VERSION"), "utf8"), "17");
    assert.equal(readFileSync(join(paths.dataHome, "secret.key"), "utf8"), "key-a");
    assert.ok(existsSync(join(legacy, "MOVED.txt")));
    assert.equal((await migrateLegacyData(paths, { legacy })).status, "none");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("when the app already has a database, both stay where they are", async () => {
  const { root, legacy, paths } = setup();
  try {
    mkdirSync(join(legacy, "pglite"), { recursive: true });
    mkdirSync(join(paths.dataHome, "pglite"), { recursive: true });
    const result = await migrateLegacyData(paths, { legacy });
    assert.equal(result.status, "kept-both");
    assert.ok(existsSync(join(legacy, "pglite")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a different encryption key in the shared folder stops the move", async () => {
  const { root, legacy, paths } = setup();
  try {
    mkdirSync(join(legacy, "pglite"), { recursive: true });
    writeFileSync(join(legacy, "secret.key"), "key-a");
    mkdirSync(paths.dataHome, { recursive: true });
    writeFileSync(join(paths.dataHome, "secret.key"), "key-b");
    assert.equal((await migrateLegacyData(paths, { legacy })).status, "kept-both");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runner still running from the old folder is left alone", async () => {
  const { root, legacy, paths } = setup();
  try {
    mkdirSync(join(legacy, "pglite"), { recursive: true });
    const result = await migrateLegacyData(paths, { legacy, legacyRunning: async () => true });
    assert.equal(result.status, "skipped-running");
    assert.ok(existsSync(join(legacy, "pglite")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
