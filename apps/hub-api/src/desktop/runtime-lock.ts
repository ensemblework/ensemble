/**
 * One local runtime per computer.
 *
 * The desktop app and the CLI runner start the same sidecar on the same data
 * folder (one database, one pairing, one trusted-folder list). PGlite is a
 * single-process database, so a second sidecar must not open it. The lock is a
 * file that holds the owner's pid; it is written to a temporary file first and
 * then linked into place, so it never exists without its record. A lock whose
 * process is gone is stale and is taken over. The second launcher reads the
 * discovery file and attaches to the runtime that is already running.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { join } from "node:path";
import { uptime } from "node:os";

export const LOCK_FILE_NAME = "runtime.lock";
/** Exit code when another runtime already holds the lock (EX_TEMPFAIL). Launchers attach instead. */
export const ALREADY_RUNNING_EXIT = 75;
/** A lock that cannot be read counts as held for this long: an older runtime creates the file before it writes its record. */
export const UNREADABLE_LOCK_MS = 10_000;
/** How often a running runtime checks that the lock still names it. */
export const LOCK_CHECK_MS = 30_000;

export type LockOwner = { pid: number; owner: string; startedAt: string };

export type LockResult = { ok: true; release: () => void } | { ok: false; holder: LockOwner };

/** A holder this process cannot name: a lock that is being written, or one it could not set aside. */
const UNKNOWN_HOLDER: LockOwner = { pid: 0, owner: "unknown", startedAt: "" };

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

function ownerOf(text: string): LockOwner | null {
  try {
    const value = JSON.parse(text) as Partial<LockOwner>;
    if (typeof value.pid !== "number") return null;
    return { pid: value.pid, owner: typeof value.owner === "string" ? value.owner : "unknown", startedAt: typeof value.startedAt === "string" ? value.startedAt : "" };
  } catch {
    return null;
  }
}

/** The lock as it is on disk. `identity` tells this very file from one put in its place since. */
type Found = { kind: "missing" } | { kind: "held"; owner: LockOwner; identity: string } | { kind: "unreadable"; ageMs: number; identity: string };

const identityOf = (stat: Stats) => `${stat.ino}:${stat.size}:${stat.mtimeMs}`;

function inspect(file: string): Found {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    if (code !== "EACCES" && code !== "EPERM" && code !== "EBUSY") throw error;
    // This process may not read it (another user's, or one being removed on Windows): judged by its age.
    try {
      const stat = statSync(file);
      return { kind: "unreadable", ageMs: Date.now() - stat.mtimeMs, identity: identityOf(stat) };
    } catch {
      return { kind: "unreadable", ageMs: 0, identity: "" };
    }
  }
  try {
    const stat = fstatSync(fd);
    const owner = ownerOf(readFileSync(fd, "utf8"));
    return owner ? { kind: "held", owner, identity: identityOf(stat) } : { kind: "unreadable", ageMs: Date.now() - stat.mtimeMs, identity: identityOf(stat) };
  } finally {
    closeSync(fd);
  }
}

export function readLock(dir: string): LockOwner | null {
  try {
    const found = inspect(join(dir, LOCK_FILE_NAME));
    return found.kind === "held" ? found.owner : null;
  } catch {
    return null;
  }
}

/** Creates the lock with its record in one step. False when a lock is already there. */
function create(file: string, record: LockOwner): boolean {
  const text = `${JSON.stringify(record)}\n`;
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    // A file system without hard links: create it in place. A reader that finds it still empty counts it as held.
    return createInPlace(file, text);
  } finally {
    rmSync(temp, { force: true });
  }
}

function createInPlace(file: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Moves a stale lock out of the way. Another runtime may have set the same one aside and taken the lock
 * meanwhile; what was moved is then not the file judged stale, and it is put back.
 */
function setAside(file: string, judged: string): void {
  const aside = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.stale`;
  try {
    renameSync(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const moved = inspect(aside);
    if (moved.kind !== "missing" && moved.identity !== judged) {
      try {
        linkSync(aside, file);
      } catch {
        // A third runtime took the lock in the moment it was gone; it holds it now.
      }
    }
  } finally {
    rmSync(aside, { force: true });
  }
}

export function acquireRuntimeLock(dir: string, owner: string, isAlive: (pid: number) => boolean = alive): LockResult {
  const file = join(dir, LOCK_FILE_NAME);
  const record: LockOwner = { pid: process.pid, owner, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (create(file, record)) {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (readLock(dir)?.pid === process.pid) rmSync(file, { force: true });
      };
      return { ok: true, release };
    }
    const found = inspect(file);
    if (found.kind === "missing") continue;
    if (found.kind === "held" && found.owner.pid !== process.pid && holderAlive(found.owner, isAlive)) return { ok: false, holder: found.owner };
    if (found.kind === "unreadable" && found.ageMs < UNREADABLE_LOCK_MS) return { ok: false, holder: UNKNOWN_HOLDER };
    // Stale (crash, reboot), or unreadable for too long.
    try {
      setAside(file, found.identity);
    } catch {
      // Could not move it (a reader has it open on Windows): look again.
    }
  }
  return { ok: false, holder: readLock(dir) ?? UNKNOWN_HOLDER };
}

/**
 * Whether this runtime still holds the lock it took at start. A lock that names another process means
 * two runtimes have the data folder: this one must stop. A missing lock is taken again; one that cannot
 * be read yet is looked at again next time.
 */
export function confirmRuntimeLock(dir: string, owner: string, isAlive: (pid: number) => boolean = alive): { held: true; retaken?: true } | { held: false; holder: LockOwner } {
  const found = inspect(join(dir, LOCK_FILE_NAME));
  if (found.kind === "held") return found.owner.pid === process.pid ? { held: true } : { held: false, holder: found.owner };
  if (found.kind === "unreadable" && found.ageMs < UNREADABLE_LOCK_MS) return { held: true };
  const again = acquireRuntimeLock(dir, owner, isAlive);
  return again.ok ? { held: true, retaken: true } : { held: false, holder: again.holder };
}
