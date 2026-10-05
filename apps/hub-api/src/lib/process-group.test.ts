/**
 * A child that ignores SIGTERM still dies when stopProcessGroup SIGKILLs its group.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { stopProcessGroup } from "./process-group.js";

const skip = process.platform === "win32" ? "no process groups on Windows" : false;

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("stopProcessGroup SIGKILLs a group that ignores SIGTERM", { skip }, async () => {
  const child = spawn(
    "python3",
    ["-c", "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"],
    { detached: true, stdio: "ignore" },
  );
  try {
    assert.ok(child.pid);
    const started = Date.now();
    await stopProcessGroup(child, { termGraceMs: 200 });
    assert.ok(Date.now() - started < 5_000);
    assert.equal(alive(child.pid), false);
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
});
