/**
 * Stop a child that was spawned with `detached: true`, which on macOS and
 * Linux makes it the leader of its own process group (pgid = pid). Signals go
 * to the whole group, so anything it started without its own session goes too.
 *
 * Windows has no process groups here; the pid alone is signalled.
 *
 * Same helper PR #87 uses for plot-worker shutdown. The wall-clock kill of a
 * plot child stays in the Python worker; this is the Node side of that group.
 */
import type { ChildProcess } from "node:child_process";

/** Send `signal` to the group led by `pid`. False when the group is already gone. */
export function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals | 0): boolean {
  if (!pid) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
    return true;
  } catch (error) {
    // EPERM: the group still exists but holds a process we may not signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True while any process in the group led by `pid` is alive (or not yet reaped). */
export function processGroupAlive(pid: number | undefined): boolean {
  return signalProcessGroup(pid, 0);
}

async function waitUntil(gone: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!gone()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

export interface StopGroupOptions {
  /** Close the child's stdin first and give it this long to exit on its own. 0 skips. */
  stdinGraceMs?: number;
  /** After SIGTERM to the group, how long to wait before SIGKILL. */
  termGraceMs?: number;
}

/**
 * Close stdin (optional), SIGTERM the group, wait briefly, then SIGKILL the
 * group. Resolves once the group is gone or SIGKILL has been sent.
 */
export async function stopProcessGroup(child: ChildProcess, options: StopGroupOptions = {}): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  const gone = () => !processGroupAlive(pid);
  const stdinGraceMs = options.stdinGraceMs ?? 0;
  if (stdinGraceMs > 0 && child.stdin && !child.stdin.destroyed) {
    child.stdin.end();
    if (await waitUntil(gone, stdinGraceMs)) return;
  }
  if (!signalProcessGroup(pid, "SIGTERM")) return;
  if (await waitUntil(gone, options.termGraceMs ?? 1_000)) return;
  signalProcessGroup(pid, "SIGKILL");
  await waitUntil(gone, 1_000);
}
