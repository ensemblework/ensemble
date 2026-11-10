/**
 * One local runtime per computer.
 *
 * The desktop app and the CLI runner start the same sidecar on the same data
 * folder (one database, one pairing, one trusted-folder list). PGlite is a
 * single-process database, so a second sidecar must not open it. The lock is a
 * file created with O_EXCL that holds the owner's pid; a lock whose process is
 * gone is stale and is taken over. The second launcher reads the discovery
 * file and attaches to the runtime that is already running.
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { uptime } from "node:os";

export const LOCK_FILE_NAME = "runtime.lock";
/** Exit code when another runtime already holds the lock (EX_TEMPFAIL). Launchers attach instead. */
export const ALREADY_RUNNING_EXIT = 75;

export type LockOwner = { pid: number; owner: string; startedAt: string };

export type LockResult = { ok: true; release: () => void } | { ok: false; holder: LockOwner };

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else. Treat it as alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When this computer last started. */
function bootedAt(): number {
  return Date.now() - uptime() * 1000;
}

/** When a process started, from Linux's /proc (USER_HZ is 100 there); null elsewhere or when unknown. */
function processStartedAt(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    return Number.isFinite(ticks) && btime > 0 ? btime * 1000 + ticks * 10 : null;
  } catch {
    return null;
  }
}

/**
 * Whether the process that wrote a lock still holds it. Its pid being alive is not enough: after a
 * reboot, or long enough, the same pid belongs to another program (a desktop shell, say), and a runtime
 * that trusted it would refuse to start for good. A lock written before this computer last started is
 * stale, and so (on Linux) is one whose pid's process started after the lock was written.
 */
export function holderAlive(holder: { pid: number; startedAt?: string }, isAlive: (pid: number) => boolean = alive): boolean {
  if (!isAlive(holder.pid)) return false;
  const wrote = Date.parse(holder.startedAt ?? "");
  if (!Number.isFinite(wrote)) return true;
  if (wrote < bootedAt() - 60_000) return false;
  const began = processStartedAt(holder.pid);
  return began === null || began <= wrote + 60_000;
}

export function readLock(dir: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, LOCK_FILE_NAME), "utf8")) as Partial<LockOwner>;
    if (typeof value.pid !== "number") return null;
    return { pid: value.pid, owner: typeof value.owner === "string" ? value.owner : "unknown", startedAt: value.startedAt ?? "" };
  } catch {
    return null;
  }
}

export function acquireRuntimeLock(dir: string, owner: string, isAlive: (pid: number) => boolean = alive): LockResult {
  const file = join(dir, LOCK_FILE_NAME);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      const record: LockOwner = { pid: process.pid, owner, startedAt: new Date().toISOString() };
      writeSync(fd, `${JSON.stringify(record)}\n`);
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const current = readLock(dir);
        if (current?.pid === process.pid) rmSync(file, { force: true });
      };
      return { ok: true, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLock(dir);
      if (holder && holder.pid !== process.pid && holderAlive(holder, isAlive)) return { ok: false, holder };
      // Stale (crash, reboot) or unreadable: remove and try again.
      rmSync(file, { force: true });
    }
  }
  const holder = readLock(dir);
  return { ok: false, holder: holder ?? { pid: 0, owner: "unknown", startedAt: "" } };
}
