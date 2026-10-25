/**
 * Runs one checked argv inside this computer's OS sandbox, and can kill it at once.
 *
 * Every child starts its own session (macOS, Linux) or is killed as a tree with taskkill
 * (Windows), so Stop and a timeout end everything the command started: a test runner's workers,
 * and a process that moved to a process group of its own (`timeout`, a shell with job control),
 * which stays in the session. A command is over when its own process exits: output still in the
 * pipes is read for a moment, and a process it left running cannot hold the result open. The
 * process itself is started by `startSandboxed`, the only agent spawn. A run that asked for the
 * sandbox on a computer without one is refused with the reason.
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import { askpassPath, cacheDir, childEnv, sandboxAvailable, sandboxRefusal, ENSEMBLE_SOURCE, GuardError, within } from "./guard.js";
import { hostExecutable } from "./policy.js";
import { startSandboxed } from "./sandbox/spawn.js";
import { requireHostAccess, requireHostTerminal } from "../lib/hosted-access.js";

export const OUTPUT_LIMIT = 60_000;

export interface RunOptions {
  userId?: string;
  argv: string[];
  cwd: string;
  /** Writes are confined to this folder when sandboxed. */
  root: string;
  sandboxed: boolean;
  network: boolean;
  useCredentials: boolean;
  who: "agent" | "human";
  /** Read-only grant, used for a review of a folder outside the workspace. */
  readOnly?: string[];
  /** Writable grant. Defaults to the job root plus the cache. */
  readWrite?: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  /** Groups children so a job or terminal session can be killed as one. */
  group?: string;
  onChunk?: (text: string) => void;
  extraEnv?: Record<string, string>;
}

export interface RunResult {
  exitCode: number;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  killed: boolean;
  ms: number;
}

const live = new Map<string, Set<ChildProcess>>();
/** The sessions each group started (a child's pid is its session id), kept until the group is killed. */
const sessions = new Map<string, Set<number>>();
/** How long output may still arrive after the command's own process exits. */
export const DRAIN_MS = 2_000;
const found = new Map<string, string>();

/** File names to try for a program: on Windows each PATHEXT extension (git.exe, npm.cmd), elsewhere the name. */
export function programNames(name: string, platform: string = process.platform, pathext = process.env.PATHEXT): string[] {
  if (platform !== "win32") return [name];
  const extensions = (pathext || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase());
  if (extensions.some((ext) => name.toLowerCase().endsWith(ext))) return [name];
  return extensions.map((ext) => `${name}${ext}`);
}

/** A program from the trusted PATH, never one that lives inside the folder being worked on. */
async function findProgram(name: string, path: string, root: string): Promise<string> {
  const key = `${name}\0${path}`;
  const cached = found.get(key);
  if (cached && !within(root, cached)) return cached;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const file of programNames(name)) {
      try {
        const candidate = await realpath(join(dir, file));
        if (within(root, candidate) || !(await stat(candidate)).isFile()) continue;
        found.set(key, candidate);
        return candidate;
      } catch {
        // not in this directory
      }
    }
  }
  return hostExecutable(name).catch(() => {
    throw new GuardError(`${name} is not installed on this computer (or not on the PATH Ensemble uses).`);
  });
}

/** The `stat` line of a Linux process: its session id (the fields after the command name, which may hold spaces). */
export function sessionOf(stat: string): number | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const session = Number(fields[3]);
  return Number.isInteger(session) ? session : null;
}

/** Every process still in a session: on Linux from /proc, elsewhere from `pgrep -s`. */
export function sessionMembers(session: number): number[] {
  if (process.platform === "win32" || session <= 1) return [];
  if (process.platform === "linux") {
    const found: number[] = [];
    let names: string[] = [];
    try {
      names = readdirSync("/proc");
    } catch {
      return found;
    }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (sessionOf(readFileSync(`/proc/${name}/stat`, "utf8")) === session) found.push(Number(name));
      } catch {
        // gone already
      }
    }
    return found;
  }
  const listed = spawnSync("pgrep", ["-s", String(session)], { encoding: "utf8", timeout: 5_000 });
  return (listed.stdout ?? "").split(/\s+/).filter((pid) => /^\d+$/.test(pid)).map(Number);
}

/** Kills a session: its process group, and each process that left the group but not the session. */
function killSession(session: number): void {
  try {
    process.kill(-session, "SIGKILL");
  } catch {
    // no such group any more
  }
  for (const pid of sessionMembers(session)) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // No process groups on Windows: end the tree by parent id.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  killSession(child.pid);
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/** Kills every process started for this group, including ones its commands left running. Returns how many commands were running. */
export function killGroup(group: string): number {
  const set = live.get(group);
  for (const child of set ?? []) killTree(child);
  if (process.platform !== "win32") for (const session of sessions.get(group) ?? []) killSession(session);
  sessions.delete(group);
  const count = set?.size ?? 0;
  live.delete(group);
  return count;
}

export async function runCommand(options: RunOptions): Promise<RunResult> {
  if (options.who === "human" && options.userId) await requireHostTerminal(options.userId);
  await requireHostAccess(options.userId, "Host commands");
  if (options.sandboxed && !sandboxAvailable()) throw new GuardError(sandboxRefusal());
  const started = Date.now();
  const baseEnv = await childEnv(options.root, { useCredentials: options.useCredentials, who: options.who });
  const env = { ...baseEnv, ...options.extraEnv };
  if (options.who === "agent" && baseEnv.HOME) env.HOME = baseEnv.HOME;
  const program = await findProgram(options.argv[0]!, env.PATH ?? "", options.root);
  await mkdir(env.TMPDIR ?? env.TEMP!, { recursive: true });
  const cache = await cacheDir();
  await mkdir(join(cache, "home"), { recursive: true });
  const readWrite = [...(options.readWrite ?? [options.root])];
  if (!readWrite.includes(cache)) readWrite.push(cache);
  const home = homedir();
  const askpass = await askpassPath();

  return new Promise<RunResult>((resolvePromise, reject) => {
    const { child } = startSandboxed(
      {
        runId: options.group ?? "command",
        cwd: options.cwd,
        readWrite,
        readOnly: options.readOnly ?? [],
        deny: [],
        network: options.network ? "outbound" : "none",
        env,
        who: options.who,
        home,
        ensembleSource: ENSEMBLE_SOURCE,
        appDataDir: desktopDataDir({ platform: process.platform, home }),
        askpassPath: askpass,
        confined: options.sandboxed,
      },
      { program, args: options.argv.slice(1) },
    );
    const group = options.group;
    if (group) {
      const set = live.get(group) ?? new Set();
      set.add(child);
      live.set(group, set);
      if (child.pid && process.platform !== "win32") {
        const started = sessions.get(group) ?? new Set();
        started.add(child.pid);
        sessions.set(group, started);
      }
    }
    let output = "";
    let truncated = false;
    let timedOut = false;
    let killed = false;
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      options.onChunk?.(text);
      if (output.length < OUTPUT_LIMIT) {
        output += text;
        if (output.length > OUTPUT_LIMIT) {
          output = output.slice(0, OUTPUT_LIMIT);
          truncated = true;
        }
      } else truncated = true;
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);
    const onAbort = () => {
      killed = true;
      killTree(child);
    };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let settled = false;
    let drain: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number | null, signal: NodeJS.Signals | null, leftRunning: number[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      options.signal?.removeEventListener("abort", onAbort);
      if (group) live.get(group)?.delete(child);
      const sandboxDenied = options.sandboxed && /Operation not permitted|deny\(1\)|Read-only file system|Access is denied/.test(output);
      const notes = [
        sandboxDenied ? "[Ensemble] The sandbox blocked access outside the allowed folder." : "",
        leftRunning.length
          ? `[Ensemble] The command ended, but ${leftRunning.length} process${leftRunning.length === 1 ? "" : "es"} it started ${leftRunning.length === 1 ? "is" : "are"} still running (pid ${leftRunning.slice(0, 8).join(", ")}). ${group ? "They are stopped when the run ends." : ""}`.trim()
          : "",
      ].filter(Boolean);
      resolvePromise({
        exitCode: code ?? (signal ? 137 : 1),
        output: notes.length ? `${output}\n${notes.join("\n")}` : output,
        truncated,
        timedOut,
        killed,
        ms: Date.now() - started,
      });
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      reject(error);
    });
    child.on("close", (code, signal) => finish(code, signal));
    // The command's own process ended: its output is read for a moment more, then it is over, even
    // when a process it left running (a server, a stuck test worker) still holds the pipes open.
    child.on("exit", (code, signal) => {
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        const left = child.pid && process.platform !== "win32" ? sessionMembers(child.pid) : [];
        finish(code, signal, left);
      }, DRAIN_MS);
      drain.unref?.();
    });
  });
}
