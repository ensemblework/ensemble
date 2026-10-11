import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireRuntimeLock, LOCK_FILE_NAME, readLock } from "./runtime-lock.js";

function folder(): string {
  return mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-lock-"));
}

test("the runtime records its owner and removes the lock when it stops", () => {
  const dir = folder();
  try {
    const first = acquireRuntimeLock(dir, "cli");
    assert.equal(first.ok, true);
    assert.equal(readLock(dir)?.owner, "cli");
    if (first.ok) first.release();
    assert.equal(readLock(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock held by another live process is refused", () => {
  const dir = folder();
  try {
    writeFileSync(join(dir, LOCK_FILE_NAME), JSON.stringify({ pid: 999_999, owner: "desktop", startedAt: "x" }));
    const result = acquireRuntimeLock(dir, "cli", () => true);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.holder.owner, "desktop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale lock from a process that is gone is taken over", () => {
  const dir = folder();
  try {
    writeFileSync(join(dir, LOCK_FILE_NAME), JSON.stringify({ pid: 999_999, owner: "desktop", startedAt: "x" }));
    const result = acquireRuntimeLock(dir, "cli", () => false);
    assert.equal(result.ok, true);
    assert.equal(readLock(dir)?.owner, "cli");
    if (result.ok) result.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
