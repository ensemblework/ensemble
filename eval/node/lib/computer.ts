/** Starts the owner's computer process (computer-main.ts), talks to it over IPC, and can kill and start it again. */
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Computer = {
  sandbox: string | null;
  /** The agent screen can stream its frames: this user's PipeWire is linked into the computer's runtime folder. */
  pipewire: boolean;
  pair(apiBase: string, code: string, name: string): Promise<void>;
  unpair(): Promise<void>;
  /** Shares a folder under a label, as Settings does; resolves to its real path. */
  share(label: string, path: string, access: "read-write" | "review"): Promise<string>;
  unshare(label: string): Promise<void>;
  /** Stops the computer's connection to Ensemble (its remote loop), and starts it again. */
  offline(): Promise<void>;
  online(): Promise<void>;
  /** Kills the process and everything it started at once (SIGKILL), waits `downMs`, and starts it again on the same folders and database. */
  restart(downMs?: number): Promise<void>;
  /** What the computer's own database still holds: runs not ended, resource claims, leases on ended runs. */
  inspect(): Promise<{ liveJobs: number; claims: number; leases: number }>;
  close(): Promise<void>;
};

type Reply = { id?: number; ok?: boolean; result?: unknown; error?: string; ready?: boolean; sandbox?: string | null; pipewire?: boolean };
type Running = { child: ChildProcess; ready: Reply; call: (op: string, args?: Record<string, unknown>) => Promise<unknown>; gone: Promise<void>; exited: () => string | null };

const BOOT_MS = 180_000;
const CALL_MS = 120_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every process under `pid`, read from /proc (Linux): an agent the computer started in a process group of
 * its own is still the computer's, and goes with it. Elsewhere, none.
 */
export function descendants(pid: number): number[] {
  const children = new Map<number, number[]>();
  let names: string[] = [];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      children.set(parent, [...(children.get(parent) ?? []), Number(name)]);
    } catch {
      // Gone meanwhile.
    }
  }
  const out: number[] = [];
  const walk = (at: number) => {
    for (const child of children.get(at) ?? []) {
      if (out.includes(child)) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(pid);
  return out;
}

/** `durable`: the computer keeps its database on disk, so a restart finds what it had (needed only by runs that restart it). */
export async function startComputer(root: string, options: { durable?: boolean } = {}): Promise<Computer> {
  mkdirSync(root, { recursive: true });
  const out = createWriteStream(join(root, "computer.out"), { flags: "a" });
  // One key for every start of this computer: its device token is sealed with it.
  const key = randomBytes(32).toString("base64");

  async function spawnOne(restart: boolean): Promise<Running> {
    const child = fork(fileURLToPath(new URL("./computer-main.ts", import.meta.url)), [root, ...(restart ? ["restart"] : [])], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_EVAL_COMPUTER_KEY: key, NODE_EVAL_COMPUTER_DB: options.durable ? "disk" : "memory" },
      // Its own process group, so a restart kills what it started with it; it still ends with the run (IPC disconnect).
      detached: true,
    });
    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });
    const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let next = 0;
    let exited: string | null = null;
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const booted = new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The computer process did not start in time.")), BOOT_MS);
      child.on("message", (raw) => {
        const reply = raw as Reply;
        if (reply.ready) {
          clearTimeout(timer);
          resolve(reply);
          return;
        }
        const wait = reply.id === undefined ? undefined : waiting.get(reply.id);
        if (!wait) return;
        waiting.delete(reply.id!);
        if (reply.ok) wait.resolve(reply.result);
        else wait.reject(new Error(reply.error ?? "The computer could not do that."));
      });
      child.on("exit", (code, signal) => {
        exited = `The computer process ended (${signal ?? code}); see computer.out in the scratch folder.`;
        clearTimeout(timer);
        reject(new Error(exited));
        for (const wait of waiting.values()) wait.reject(new Error(exited));
        waiting.clear();
      });
    });
    const ready = await booted.catch((error: unknown) => {
      child.kill("SIGKILL");
      throw error;
    });
    const call = (op: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      if (exited) return Promise.reject(new Error(exited));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`The computer did not answer "${op}" in time.`));
        }, CALL_MS);
        waiting.set(id, {
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (error) => (clearTimeout(timer), reject(error)),
        });
        child.send({ id, op, ...args });
      });
    };
    return { child, ready, call, gone, exited: () => exited };
  }

  let current = await spawnOne(false);
  return {
    sandbox: current.ready.sandbox ?? null,
    pipewire: current.ready.pipewire === true,
    pair: async (apiBase, code, name) => void (await current.call("pair", { apiBase, code, name })),
    unpair: async () => void (await current.call("unpair")),
    share: async (label, path, access) => String(await current.call("share", { label, path, access })),
    unshare: async (label) => void (await current.call("unshare", { label })),
    offline: async () => void (await current.call("remote-stop")),
    online: async () => void (await current.call("remote-start")),
    async restart(downMs = 3000) {
      if (!options.durable) throw new Error("This run's computer keeps its database in memory: a restart would lose its pairing.");
      const old = current;
      const pid = old.child.pid!;
      const tree = descendants(pid);
      for (const target of [pid, ...tree]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Its group is gone with it.
      }
      await old.gone;
      await sleep(downMs);
      current = await spawnOne(true);
    },
    inspect: async () => (await current.call("inspect")) as { liveJobs: number; claims: number; leases: number },
    async close() {
      if (current.exited()) return;
      await current.call("close").catch(() => undefined);
      const timer = setTimeout(() => current.child.kill("SIGKILL"), 30_000);
      await current.gone;
      clearTimeout(timer);
    },
  };
}
