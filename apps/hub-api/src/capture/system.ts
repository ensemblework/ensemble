/**
 * Small process helpers for capture: finding programs on PATH and running a short command with a
 * time limit and bounded output.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type RunResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: string };

/** Runs a program (no shell) and collects its output. Never rejects: a failure is in the result. */
export function runCommand(
  program: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: Buffer | string; maxBytes?: number; cwd?: string } = {},
): Promise<RunResult> {
  const maxBytes = options.maxBytes ?? 1_000_000;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, args, { env: options.env ?? process.env, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (outBytes < maxBytes) out.push(chunk.subarray(0, maxBytes - outBytes));
      outBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errBytes < maxBytes) err.push(chunk.subarray(0, maxBytes - errBytes));
      errBytes += chunk.length;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 10_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

export type ExecutableCheck = (path: string) => boolean;

export const isExecutable: ExecutableCheck = (path) => {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The first program called `name` on PATH (with Windows extensions), or null. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, executable: ExecutableCheck = isExecutable): string | null {
  if (isAbsolute(name)) return executable(name) ? name : null;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const names = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((ext) => `${name}${ext.toLowerCase()}`).concat(name) : [name];
  for (const dir of dirs) {
    for (const candidate of names) {
      const path = join(dir, candidate);
      if (executable(path)) return path;
    }
  }
  return null;
}

export type Distro = { id: string; like: string[] };

/** The Linux distribution from /etc/os-release, for the right install command. */
export function linuxDistro(read: () => string = () => readFileSync("/etc/os-release", "utf8")): Distro | null {
  let text: string;
  try {
    text = read();
  } catch {
    return null;
  }
  const field = (key: string) => new RegExp(`^${key}=("?)([^"\\n]*)\\1$`, "m").exec(text)?.[2]?.toLowerCase() ?? "";
  const id = field("ID");
  if (!id) return null;
  return { id, like: field("ID_LIKE").split(/\s+/).filter(Boolean) };
}
