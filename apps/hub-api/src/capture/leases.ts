/**
 * Leases for what capture starts outside the browser: virtual displays, their window managers,
 * launched apps and recordings. Each is a process group the runtime started (spawned detached), and
 * each lease says how long it may live. The janitor stops a lease when it expires, when its process
 * ends (taking dependent leases with it) and, at start-up, whatever a runtime that crashed left
 * behind, from a small state file in the data folder. A recorded process is only signalled while
 * its start time still matches, so a reused process id is never hit. When its leader is gone, its
 * group is signalled only if a member still carries the lease's marker in its environment
 * (`ENSEMBLE_CAPTURE_LEASE`, readable on Linux).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type LeaseKind = "display" | "window-manager" | "app" | "recording";

/** Set in the environment of every process capture starts, to the id of its lease. */
export const LEASE_ENV = "ENSEMBLE_CAPTURE_LEASE";

/** A lease id, made before its process starts so the process can carry it. */
export function newLeaseId(kind: LeaseKind): string {
  return `${kind}-${randomBytes(6).toString("hex")}`;
}

export type LeaseRecord = {
  id: string;
  kind: LeaseKind;
  /** The process group leader (the child was spawned detached). */
  pid: number;
  /** The process's start identity when it was recorded; null where the platform has none. */
  identity: string | null;
  /** The runtime that holds the lease. */
  owner: { pid: number; identity: string | null };
  operation?: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  /** Files removed when the lease ends (an X authority cookie, a stale lock file). */
  files?: string[];
  /** Another lease this one belongs to: ending that one ends this one. */
  parent?: string;
};

export type ProcessOps = {
  selfPid: number;
  alive(pid: number): boolean;
  groupAlive(pid: number): boolean;
  identity(pid: number): string | null;
  /** Processes in the group (Linux; empty where it cannot be read). */
  groupMembers(pgid: number): number[];
  /** Whether the process's environment has this `NAME=value` entry (Linux; false where it cannot be read). */
  environHas(pid: number, entry: string): boolean;
  signalGroup(pid: number, signal: NodeJS.Signals): void;
  removeFile(path: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
};

/** A process's start time: field 22 of /proc/<pid>/stat on Linux, `ps -o lstart=` elsewhere. */
export function processIdentity(pid: number, platform: string = process.platform): string | null {
  try {
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ?? null;
    }
    if (platform === "darwin") {
      const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
      return result.status === 0 ? result.stdout.trim() || null : null;
    }
  } catch {
    return null;
  }
  return null;
}

function signalOk(target: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Linux: the processes whose process group is `pgid` (field 5 of /proc/<pid>/stat). */
export function linuxGroupMembers(pgid: number): number[] {
  if (process.platform !== "linux") return [];
  const members: number[] = [];
  for (const name of readdirSafe("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) === pgid) members.push(Number(name));
    } catch {
      // It ended while we looked.
    }
  }
  return members;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function linuxEnvironHas(pid: number, entry: string): boolean {
  if (process.platform !== "linux") return false;
  try {
    return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(entry);
  } catch {
    return false;
  }
}

export const realProcessOps = (): ProcessOps => ({
  selfPid: process.pid,
  alive: (pid) => signalOk(pid, 0),
  groupAlive: (pid) => (process.platform === "win32" ? signalOk(pid, 0) : signalOk(-pid, 0)),
  identity: (pid) => processIdentity(pid),
  groupMembers: (pgid) => linuxGroupMembers(pgid),
  environHas: (pid, entry) => linuxEnvironHas(pid, entry),
  signalGroup: (pid, signal) => {
    signalOk(process.platform === "win32" ? pid : -pid, signal);
  },
  removeFile: (path) => rmSync(path, { force: true, recursive: true }),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

type StateFile = { version: 1; leases: LeaseRecord[] };

export class LeaseTable {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly selfIdentity: string | null;
  private janitor: NodeJS.Timeout | null = null;
  /** Called when the janitor ends a lease, so the owner can drop its handle. */
  onEnded: ((record: LeaseRecord, reason: string) => void) | null = null;

  constructor(
    private readonly stateFile: string,
    private readonly ops: ProcessOps = realProcessOps(),
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.selfIdentity = ops.identity(ops.selfPid);
  }

  private read(): LeaseRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<StateFile>;
      return Array.isArray(parsed.leases) ? parsed.leases.filter((lease) => lease && typeof lease.pid === "number" && typeof lease.id === "string") : [];
    } catch {
      return [];
    }
  }

  private mine(record: LeaseRecord): boolean {
    return record.owner.pid === this.ops.selfPid && record.owner.identity === this.selfIdentity;
  }

  /** Writes this runtime's leases, keeping other runtimes' leases except those in `drop`. */
  private write(drop: ReadonlySet<string> = new Set()): void {
    const others = this.read().filter((record) => !this.mine(record) && !this.leases.has(record.id) && !drop.has(record.id));
    const state: StateFile = { version: 1, leases: [...others, ...this.leases.values()] };
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
      const temp = `${this.stateFile}.${this.ops.selfPid}.${randomBytes(3).toString("hex")}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.stateFile);
    } catch (error) {
      this.log(`capture: could not save leases: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  add(input: Omit<LeaseRecord, "owner" | "createdAt" | "identity" | "id"> & { id?: string }): LeaseRecord {
    const record: LeaseRecord = {
      ...input,
      id: input.id ?? newLeaseId(input.kind),
      identity: this.ops.identity(input.pid),
      owner: { pid: this.ops.selfPid, identity: this.selfIdentity },
      createdAt: this.ops.now(),
    };
    this.leases.set(record.id, record);
    this.write();
    return record;
  }

  get(id: string): LeaseRecord | undefined {
    return this.leases.get(id);
  }

  list(operation?: string): LeaseRecord[] {
    return [...this.leases.values()].filter((record) => !operation || record.operation === operation);
  }

  renew(id: string, ms: number): void {
    const record = this.leases.get(id);
    if (!record) return;
    record.expiresAt = Math.max(record.expiresAt, this.ops.now() + ms);
    for (const child of this.leases.values()) if (child.parent === id) child.expiresAt = Math.max(child.expiresAt, record.expiresAt);
    this.write();
  }

  /** Whether the recorded process is still the one we started. */
  private same(record: { pid: number; identity: string | null }): boolean {
    if (!this.ops.alive(record.pid)) return false;
    return record.identity === null || this.ops.identity(record.pid) === record.identity;
  }

  /**
   * Whether signalling the record's process group hits only what we started: its leader is the
   * process we recorded, or the leader is gone and a member still carries this lease's marker.
   */
  private ours(record: LeaseRecord): boolean {
    if (this.same(record)) return true;
    if (this.ops.alive(record.pid) || !this.ops.groupAlive(record.pid)) return false;
    return this.ops.groupMembers(record.pid).some((member) => this.ops.environHas(member, `${LEASE_ENV}=${record.id}`));
  }

  private async stopGroup(record: LeaseRecord, graceMs: number): Promise<void> {
    if (!this.ours(record)) return;
    this.ops.signalGroup(record.pid, "SIGTERM");
    const deadline = this.ops.now() + graceMs;
    while (this.ops.groupAlive(record.pid) && this.ops.now() < deadline) await this.ops.sleep(50);
    if (this.ops.groupAlive(record.pid)) this.ops.signalGroup(record.pid, "SIGKILL");
  }

  private cleanFiles(record: LeaseRecord): void {
    for (const file of record.files ?? []) {
      try {
        this.ops.removeFile(file);
      } catch {
        // Already gone.
      }
    }
  }

  /** Stops a lease's process group, then the leases that belong to it, and forgets them. */
  async end(id: string, reason = "released", graceMs = 2_000): Promise<string[]> {
    const record = this.leases.get(id);
    if (!record) return [];
    const ended: string[] = [];
    for (const child of [...this.leases.values()].filter((item) => item.parent === id)) ended.push(...(await this.end(child.id, reason, graceMs)));
    // Ending a child can end its parent too (an app's display goes with it).
    if (!this.leases.has(id)) return ended;
    this.leases.delete(id);
    await this.stopGroup(record, graceMs);
    this.cleanFiles(record);
    this.write();
    this.log(`capture: ended ${record.label} (${reason})`);
    this.onEnded?.(record, reason);
    ended.push(id);
    return ended;
  }

  /** The janitor's pass: leases past their time, and leases whose process has ended. */
  async sweep(): Promise<string[]> {
    const now = this.ops.now();
    const ended: string[] = [];
    for (const record of [...this.leases.values()]) {
      if (!this.leases.has(record.id)) continue;
      if (record.expiresAt <= now) ended.push(...(await this.end(record.id, "lease expired")));
      else if (!this.ops.groupAlive(record.pid)) ended.push(...(await this.end(record.id, "process ended")));
    }
    return ended;
  }

  /**
   * At start-up: stops what runtimes that are gone left behind (displays, apps, recordings), and
   * removes their files. Leases of a runtime that is still running are left alone.
   */
  async reapLeftovers(graceMs = 1_000): Promise<string[]> {
    const reaped: string[] = [];
    for (const record of this.read()) {
      if (this.leases.has(record.id)) continue;
      const ownerAlive = !this.mine(record) && this.same(record.owner);
      if (ownerAlive) continue;
      await this.stopGroup(record, graceMs);
      this.cleanFiles(record);
      reaped.push(record.id);
      this.log(`capture: removed ${record.label}, left by a runtime that stopped`);
    }
    if (reaped.length) this.write(new Set(reaped));
    return reaped;
  }

  /** Runs `sweep` on a timer (unref'd, so it never keeps the process alive). */
  startJanitor(intervalMs = 10_000): void {
    if (this.janitor) return;
    this.janitor = setInterval(() => void this.sweep().catch((error: unknown) => this.log(`capture janitor: ${String(error)}`)), intervalMs);
    this.janitor.unref();
  }

  stopJanitor(): void {
    if (this.janitor) clearInterval(this.janitor);
    this.janitor = null;
  }

  /** On process exit: kills every group this runtime holds, at once, and records that. */
  endAllSync(): void {
    for (const record of this.leases.values()) {
      if (this.ours(record)) this.ops.signalGroup(record.pid, "SIGKILL");
      this.cleanFiles(record);
    }
    this.leases.clear();
    this.write();
  }

  async endAll(reason = "shutting down"): Promise<void> {
    for (const record of [...this.leases.values()].filter((item) => !item.parent || !this.leases.has(item.parent))) await this.end(record.id, reason);
  }
}
