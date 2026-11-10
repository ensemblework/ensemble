import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireRuntimeLock, holderAlive, LOCK_FILE_NAME, readLock } from "./runtime-lock.js";

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

test("a lock whose pid now belongs to another program is stale: written before the last boot, or before that process began", () => {
  const dir = folder();
  try {
    // After a reboot the old runtime's pid is reused (by a desktop shell, say): the pid is alive, the lock is not.
    writeFileSync(join(dir, LOCK_FILE_NAME), JSON.stringify({ pid: 424242, owner: "cli", startedAt: "2020-01-01T00:00:00.000Z" }));
    const after = acquireRuntimeLock(dir, "cli", () => true);
    assert.equal(after.ok, true, "a lock from before this computer last started never blocks a runtime");
    if (after.ok) after.release();
    // A process that is really there and started before its lock was written still holds it.
    assert.equal(holderAlive({ pid: process.pid, startedAt: new Date().toISOString() }), true);
    assert.equal(holderAlive({ pid: process.pid, startedAt: "" }), true, "an older lock without a time is trusted as before");
    // On Linux, a pid whose process began well after the lock was written is someone else's.
    if (process.platform === "linux" && uptime() > 600) {
      assert.equal(holderAlive({ pid: process.pid, startedAt: new Date(Date.now() - uptime() * 1000 + 120_000).toISOString() }), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
