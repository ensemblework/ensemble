import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquireRuntimeLock, confirmRuntimeLock, holderAlive, LOCK_FILE_NAME, readLock, UNREADABLE_LOCK_MS } from "./runtime-lock.js";

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

test("a lock that exists but is still empty is held while it is new, and taken over once it is old", () => {
  const dir = folder();
  try {
    // An older runtime creates the file first and writes its record a moment later.
    writeFileSync(join(dir, LOCK_FILE_NAME), "");
    const early = acquireRuntimeLock(dir, "cli", () => false);
    assert.equal(early.ok, false, "a lock being written is never taken");
    if (!early.ok) assert.equal(early.holder.pid, 0);
    assert.equal(readFileSync(join(dir, LOCK_FILE_NAME), "utf8"), "", "and it is left as it is");
    const old = (Date.now() - UNREADABLE_LOCK_MS - 5_000) / 1000;
    utimesSync(join(dir, LOCK_FILE_NAME), old, old);
    const late = acquireRuntimeLock(dir, "cli", () => false);
    assert.equal(late.ok, true, "one left unreadable for longer is stale");
    assert.equal(readLock(dir)?.pid, process.pid);
    if (late.ok) late.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock this runtime may not open is judged by its age alone", (t) => {
  if (process.platform === "win32") return t.skip("file modes");
  const dir = folder();
  const file = join(dir, LOCK_FILE_NAME);
  try {
    writeFileSync(file, "", { mode: 0o000 });
    chmodSync(file, 0o000);
    assert.equal(acquireRuntimeLock(dir, "cli", () => false).ok, false, "a new one counts as held");
    const old = (Date.now() - UNREADABLE_LOCK_MS - 5_000) / 1000;
    utimesSync(file, old, old);
    const taken = acquireRuntimeLock(dir, "cli", () => false);
    assert.equal(taken.ok, true, "an old one is stale");
    assert.equal(readLock(dir)?.pid, process.pid);
    if (taken.ok) taken.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock never exists without its record, and no temporary files are left", () => {
  const dir = folder();
  try {
    const first = acquireRuntimeLock(dir, "desktop");
    assert.equal(first.ok, true);
    assert.deepEqual(readdirSync(dir), [LOCK_FILE_NAME]);
    assert.equal(JSON.parse(readFileSync(join(dir, LOCK_FILE_NAME), "utf8")).pid, process.pid);
    if (first.ok) first.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale lock replaced by another runtime's while it was judged is put back, not removed", () => {
  const dir = folder();
  const file = join(dir, LOCK_FILE_NAME);
  try {
    writeFileSync(file, JSON.stringify({ pid: 111, owner: "cli", startedAt: new Date().toISOString() }));
    const isAlive = (pid: number) => {
      if (pid === 111) {
        // While this runtime looks at the stale lock, another sets it aside and takes the lock.
        rmSync(file);
        writeFileSync(file, JSON.stringify({ pid: 222, owner: "desktop", startedAt: new Date().toISOString() }));
        const later = (Date.now() + 2_000) / 1000;
        utimesSync(file, later, later);
        return false;
      }
      return pid === 222;
    };
    const result = acquireRuntimeLock(dir, "cli", isAlive);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.holder.pid, 222);
    assert.equal(readLock(dir)?.pid, 222, "the other runtime still holds it");
    assert.deepEqual(readdirSync(dir), [LOCK_FILE_NAME]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtimes started at the same moment: exactly one gets the lock", async () => {
  const dir = folder();
  const lockModule = fileURLToPath(new URL("./runtime-lock.ts", import.meta.url));
  const script = join(dir, "start.mjs");
  writeFileSync(
    script,
    `const { acquireRuntimeLock } = await import(${JSON.stringify(lockModule)});
const at = Number(process.argv[2]);
await new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));
const result = acquireRuntimeLock(process.argv[3], "cli");
process.stdout.write(result.ok ? "held" : "refused");
setTimeout(() => process.exit(0), Math.max(0, at + 3_000 - Date.now()));
`,
  );
  const lockDir = join(dir, "data");
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(lockDir);
    const at = Date.now() + 3_000;
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, ["--import", "tsx", script, String(at), lockDir], { stdio: ["ignore", "pipe", "inherit"] });
          let out = "";
          child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
          child.once("error", reject);
          child.once("exit", () => resolve(out));
        }),
      ),
    );
    assert.equal(outcomes.filter((outcome) => outcome === "held").length, 1, `one runtime holds the folder: ${outcomes.join(", ")}`);
    assert.equal(outcomes.filter((outcome) => outcome === "refused").length, 5);
    assert.ok(!existsSync(join(lockDir, LOCK_FILE_NAME)) || readLock(lockDir) !== null, "the lock is never left without its record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a running runtime keeps checking its lock: another process named in it means stop; a missing one is taken again", () => {
  const dir = folder();
  try {
    const held = acquireRuntimeLock(dir, "cli");
    assert.equal(held.ok, true);
    assert.deepEqual(confirmRuntimeLock(dir, "cli"), { held: true });
    writeFileSync(join(dir, LOCK_FILE_NAME), JSON.stringify({ pid: 424242, owner: "desktop", startedAt: new Date().toISOString() }));
    const lost = confirmRuntimeLock(dir, "cli", () => true);
    assert.equal(lost.held, false);
    if (!lost.held) assert.equal(lost.holder.pid, 424242);
    rmSync(join(dir, LOCK_FILE_NAME));
    assert.deepEqual(confirmRuntimeLock(dir, "cli"), { held: true, retaken: true });
    assert.equal(readLock(dir)?.pid, process.pid);
    writeFileSync(join(dir, LOCK_FILE_NAME), "");
    assert.deepEqual(confirmRuntimeLock(dir, "cli"), { held: true }, "a lock being written is looked at again next time");
    if (held.ok) held.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
