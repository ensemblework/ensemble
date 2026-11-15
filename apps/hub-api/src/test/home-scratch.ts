/**
 * Scratch folders for tests whose paths must pass the workspace guard: under the home folder, since on
 * macOS the guard refuses the system temp folder (/private/var). Each folder goes when its test file
 * ends, however it ends. The file's last `after` hook calls `removeScratch` once the shells and
 * browsers its tests started are stopped, so none writes there again. A small watcher process removes
 * it once the test process is gone: no `after` hook runs when the file's setup throws or the run is
 * stopped, and a browser left open writes its profile there again as it closes.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Started with the folder and the test process's id, it starts itself again in a process group of its
 * own and exits, so the watcher is outside the test process's tree: stopping a run with all its child
 * processes (a timed-out command, Ctrl-C) leaves the watcher. It removes the folder once the test process
 * is gone, then again for 5 s while what the tests started closes.
 */
const WATCHER = `
const { spawn } = require("node:child_process");
const { existsSync, rmSync } = require("node:fs");
const [dir, pid, watching] = process.argv.slice(1);
if (!watching) {
  spawn(process.execPath, [...process.execArgv, dir, pid, "watching"], { detached: true, stdio: "ignore", env: {}, windowsHide: true }).unref();
} else {
  const alive = () => { try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === "EPERM"; } };
  const remove = () => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} };
  const waiting = setInterval(() => {
    if (alive()) return;
    clearInterval(waiting);
    remove();
    let checks = 10;
    const again = setInterval(() => {
      if (existsSync(dir)) remove();
      if (--checks === 0) clearInterval(again);
    }, 500);
  }, 250);
}
`;

/** A new folder `~/<prefix>XXXXXX`, removed when the test process ends at the latest. */
export function homeScratch(prefix: string): string {
  const dir = mkdtempSync(join(homedir(), prefix));
  const starter = spawn(process.execPath, ["-e", WATCHER, dir, String(process.pid)], { detached: true, stdio: "ignore", env: {}, windowsHide: true });
  starter.on("error", () => undefined);
  starter.unref();
  return dir;
}

/** Removes a scratch folder; retries while a process that just stopped finishes writing there. */
export function removeScratch(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
