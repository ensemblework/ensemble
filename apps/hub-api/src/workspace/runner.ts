/**
 * Runs one checked argv, sandboxed on macOS, and can kill it at once.
 *
 * Every child starts its own process group so Stop kills the whole tree —
 * a test runner's workers included — not just the parent. The process itself
 * is started by `startSandboxed`, the only agent spawn. On Linux that spawn
 * is refused when a sandbox was requested: there is no OS sandbox yet.
 */
import { type ChildProcess } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import { cacheDir, childEnv, sandboxAvailable, ENSEMBLE_SOURCE, GuardError, within } from "./guard.js";
import { hostExecutable } from "./policy.js";
import { capabilities, startSandboxed } from "./sandbox/spawn.js";
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
const found = new Map<string, string>();

/** A program from the trusted PATH, never one that lives inside the folder being worked on. */
async function findProgram(name: string, path: string, root: string): Promise<string> {
  const key = `${name}\0${path}`;
  const cached = found.get(key);
  if (cached && !within(root, cached)) return cached;
  for (const dir of path.split(":")) {
    if (!dir) continue;
    try {
      const candidate = await realpath(join(dir, name));
      if (within(root, candidate) || !(await stat(candidate)).isFile()) continue;
      found.set(key, candidate);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return hostExecutable(name).catch(() => {
    throw new GuardError(`${name} is not installed on this Mac (or not on the PATH Ensemble uses).`);
  });
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Kills every process started for this group. Returns how many were running. */
export function killGroup(group: string): number {
  const set = live.get(group);
  if (!set) return 0;
  for (const child of set) killTree(child);
  const count = set.size;
  live.delete(group);
  return count;
}

export async function runCommand(options: RunOptions): Promise<RunResult> {
  if (options.who === "human" && options.userId) await requireHostTerminal(options.userId);
  await requireHostAccess(options.userId, "Host commands");
  if (options.sandboxed && !sandboxAvailable) {
    throw new GuardError(`${capabilities().reason} Choose “This machine” to run without the sandbox.`);
  }
  const started = Date.now();
  const baseEnv = await childEnv(options.root, { useCredentials: options.useCredentials, who: options.who });
  const env = { ...baseEnv, ...options.extraEnv };
  if (options.who === "agent" && baseEnv.HOME) env.HOME = baseEnv.HOME;
  const program = await findProgram(options.argv[0]!, env.PATH ?? "", options.root);
  await mkdir(env.TMPDIR!, { recursive: true });
  const cache = await cacheDir();
  await mkdir(join(cache, "home"), { recursive: true });
  const readWrite = [...(options.readWrite ?? [options.root])];
  if (!readWrite.includes(cache)) readWrite.push(cache);
  const home = homedir();

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
        askpassPath: join(cache, "git-askpass.sh"),
        confined: options.sandboxed,
      },
      { program, args: options.argv.slice(1) },
    );
    const group = options.group;
    if (group) {
      const set = live.get(group) ?? new Set();
      set.add(child);
      live.set(group, set);
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
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (group) live.get(group)?.delete(child);
      const sandboxDenied = options.sandboxed && /Operation not permitted|deny\(1\)/.test(output);
      resolvePromise({
        exitCode: code ?? (signal ? 137 : 1),
        output: sandboxDenied ? `${output}\n[Ensemble] The sandbox blocked access outside the allowed folder.` : output,
        truncated,
        timedOut,
        killed,
        ms: Date.now() - started,
      });
    });
  });
}
