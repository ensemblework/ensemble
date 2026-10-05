/**
 * The only place hub-api starts the person's Python.
 * A later change turns this function into the sandboxed choke point.
 * Ensemble does not bundle an interpreter.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface SpawnPythonRequest {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Written to the child's stdin, then the stream is closed. */
  input?: string | Buffer;
}

export interface SpawnPythonResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  /** python3 is not on PATH, or the process could not be started. */
  missing: boolean;
}

export function findPython3(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.ENSEMBLE_PYTHON?.trim();
  if (override) return override;
  const names = process.platform === "win32" ? ["python3.exe", "python.exe"] : ["python3"];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

let resolveInterpreter: () => string | null = () => findPython3();

export function setPythonInterpreterForTests(resolve: (() => string | null) | null): void {
  resolveInterpreter = resolve ?? (() => findPython3());
}

/** The interpreter spawn will use, including the test override. */
export function currentPython(): string | null {
  return resolveInterpreter();
}

function defaultSpawn(request: SpawnPythonRequest): Promise<SpawnPythonResult> {
  const bin = resolveInterpreter();
  if (!bin) {
    return Promise.resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, missing: true });
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, missing: true });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(true);
    }, request.timeoutMs ?? 12_000);
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: child.exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        missing: false,
      });
    };
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, missing: true });
    });
    child.on("close", () => finish(false));
    if (request.input !== undefined) child.stdin?.end(request.input);
  });
}

let spawnImpl = defaultSpawn;

export function setPythonSpawnForTests(spawnFn: ((request: SpawnPythonRequest) => Promise<SpawnPythonResult>) | null): void {
  spawnImpl = spawnFn ?? defaultSpawn;
}

export function spawnPython(request: SpawnPythonRequest): Promise<SpawnPythonResult> {
  return spawnImpl(request);
}

/** A long-lived interpreter. The caller owns the lifetime. Missing means python3 could not be started. */
export function openPython(request: { bin?: string | null; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean }): { missing: true } | { missing: false; child: ChildProcess } {
  const bin = request.bin ?? resolveInterpreter();
  if (!bin) return { missing: true };
  try {
    const child = spawn(bin, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Own process group, so shutdown can signal the worker and everything it started.
      detached: request.detached ?? false,
    });
    return { missing: false, child };
  } catch {
    return { missing: true };
  }
}
