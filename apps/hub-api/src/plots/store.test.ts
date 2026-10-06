import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cachedTable } from "./cache.js";
import { eraseUserDatasetFiles, readOriginal, readTable, writeTable, type StoredTable } from "./store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.ensemble/plots");
const user = () => `erase-test-${randomUUID()}`;
const table: StoredTable = { columns: [{ name: "value", type: "number" }], rows: [[42]] };

test("account erasure removes every owned dataset file and cache entry without needing SQL rows", () => {
  const owner = user();
  const other = user();
  const ids = [randomUUID(), randomUUID()];
  const otherId = randomUUID();
  const hashes = ids.map((id) => writeTable(owner, id, table, Buffer.from("private original")));
  const otherHash = writeTable(other, otherId, table, Buffer.from("other original"));
  try {
    for (let index = 0; index < ids.length; index++) assert.deepEqual(cachedTable(ids[index]!, hashes[index]!), table.rows);
    eraseUserDatasetFiles(owner);
    assert.equal(existsSync(join(root, owner)), false);
    for (let index = 0; index < ids.length; index++) assert.equal(cachedTable(ids[index]!, hashes[index]!), null);
    assert.deepEqual(cachedTable(otherId, otherHash), table.rows);
    assert.deepEqual(readTable(other, otherId, otherHash), table);
    assert.equal(readOriginal(other, otherId)?.toString(), "other original");
    assert.doesNotThrow(() => eraseUserDatasetFiles(owner));
  } finally {
    eraseUserDatasetFiles(owner);
    eraseUserDatasetFiles(other);
  }
});

test("account erasure rejects blank, traversal and absolute user paths without touching another user", () => {
  const owner = user();
  const id = randomUUID();
  writeTable(owner, id, table, Buffer.from("keep"));
  try {
    for (const invalid of ["", ".", "..", "../outside", "a/b", "a\\b", "/tmp", root, "x".repeat(129)]) {
      assert.throws(() => eraseUserDatasetFiles(invalid), /invalid user id/);
    }
    assert.equal(readOriginal(owner, id)?.toString(), "keep");
  } finally {
    eraseUserDatasetFiles(owner);
  }
});

test("account erasure refuses a symlinked user directory and preserves the target", () => {
  const owner = user();
  const path = join(root, owner);
  const target = mkdtempSync(join(tmpdir(), "ensemble-erase-target-"));
  const sentinel = join(target, "private.bin");
  mkdirSync(root, { recursive: true });
  writeFileSync(sentinel, "do not erase");
  try {
    symlinkSync(target, path, "junction");
    assert.throws(() => eraseUserDatasetFiles(owner), /symbolic link/);
    assert.equal(readFileSync(sentinel, "utf8"), "do not erase");
  } finally {
    rmSync(path, { force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("account erasure unlinks nested symbolic links without deleting their targets", () => {
  const owner = user();
  const path = join(root, owner);
  const target = mkdtempSync(join(tmpdir(), "ensemble-erase-child-"));
  const sentinel = join(target, "keep.bin");
  writeTable(owner, randomUUID(), table);
  writeFileSync(sentinel, "keep target");
  try {
    symlinkSync(target, join(path, "outside-link"), "junction");
    eraseUserDatasetFiles(owner);
    assert.equal(existsSync(path), false);
    assert.equal(readFileSync(sentinel, "utf8"), "keep target");
  } finally {
    eraseUserDatasetFiles(owner);
    rmSync(target, { recursive: true, force: true });
  }
});

test("account erasure rejects a non-directory target instead of hiding storage corruption", () => {
  const owner = user();
  const path = join(root, owner);
  mkdirSync(root, { recursive: true });
  writeFileSync(path, "unexpected file");
  try {
    assert.throws(() => eraseUserDatasetFiles(owner), /not a directory/);
    assert.equal(readFileSync(path, "utf8"), "unexpected file");
  } finally {
    rmSync(path, { force: true });
  }
});
