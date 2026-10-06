import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, openSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJson, HttpError } from "./http.js";
import { fileExists, resolveCliPaths, type CliPaths } from "./paths.js";
import { VERSION } from "./version.js";

export type Discovery = {
  port: number;
  token: string;
  /** Written by sidecars from CLI 0.1.0 on; absent in older ones. */
  pid?: number;
};

export type RunnerPid = {
  pid: number;
  startedAt: string;
};

export type SidecarSession = {
  discovery: Discovery;
  child?: ChildProcess;
  stop: () => Promise<void>;
};

const LOG_LIMIT = 10 * 1024 * 1024;

export function defaultSidecarDir(bundleUrlOrPath: string = import.meta.url): string {
  const bundlePath = bundleUrlOrPath.startsWith("file:") ? fileURLToPath(bundleUrlOrPath) : bundleUrlOrPath;
  return join(dirname(bundlePath), "..", "sidecar");
}

export function resolveSidecarDir(bundleUrlOrPath: string = import.meta.url, env: NodeJS.ProcessEnv = process.env): string {
  return env.ENSEMBLE_SIDECAR_DIR?.trim() || defaultSidecarDir(bundleUrlOrPath);
}

export async function sidecarAvailable(sidecarDir: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const node = join(sidecarDir, platform === "win32" ? "node.exe" : "node");
  const main = join(sidecarDir, "app", "src", "desktop", "main.ts");
  return (await fileExists(node)) && (await fileExists(main));
}

export async function readDiscovery(file: string): Promise<Discovery | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { port?: unknown; token?: unknown; pid?: unknown };
    const port = typeof value.port === "number" ? value.port : Number(value.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof value.token !== "string" || value.token.length < 16) return null;
    const pid = typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : undefined;
    return pid ? { port, token: value.token, pid } : { port, token: value.token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function checkHealth(discovery: Discovery, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${discovery.port}/health`, {
      headers: { authorization: `Bearer ${discovery.token}` },
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runningRunner(paths: CliPaths = resolveCliPaths()): Promise<Discovery | null> {
  const discovery = await readDiscovery(paths.discoveryFile);
  if (!discovery) return null;
  return (await checkHealth(discovery)) ? discovery : null;
}

export async function readRunnerPid(paths: CliPaths = resolveCliPaths()): Promise<RunnerPid | null> {
  try {
    const raw = (await readFile(paths.pidFile, "utf8")).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return { pid: Number(raw), startedAt: "" };
    const parsed = JSON.parse(raw) as Partial<RunnerPid>;
    return typeof parsed.pid === "number" ? { pid: parsed.pid, startedAt: parsed.startedAt || "" } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeRunnerPid(pid: RunnerPid, paths: CliPaths = resolveCliPaths()): Promise<void> {
  await mkdir(dirname(paths.pidFile), { recursive: true });
  await writeFile(paths.pidFile, `${JSON.stringify(pid)}\n`, { mode: 0o600 });
  try {
    await chmod(paths.pidFile, 0o600);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

export async function clearRunnerPid(paths: CliPaths = resolveCliPaths()): Promise<void> {
  await rm(paths.pidFile, { force: true });
}

export async function rotateLog(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (size < LOG_LIMIT) return;
  for (let index = 2; index >= 1; index -= 1) {
    const from = `${file}.${index}`;
    const to = `${file}.${index + 1}`;
    try {
      await rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    await rename(file, `${file}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sidecarEnv(input: {
  paths: CliPaths;
  token: string;
  adminOnly?: boolean;
  apiBase?: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ENSEMBLE_DATA_DIR: join(input.paths.dataHome, "pglite"),
    ENSEMBLE_BACKUP_DIR: join(input.paths.dataHome, "backups"),
    ENSEMBLE_DISCOVERY_FILE: input.paths.discoveryFile,
    ENSEMBLE_REMOTE_STATE_DIR: input.paths.dataHome,
    ENSEMBLE_APP_VERSION: `cli-${VERSION}`,
    HUB_API_PORT: "0",
    REDIS_URL: "memory://cli",
    ENSEMBLE_DEV_AUTH_BYPASS: "false",
    ENSEMBLE_DESKTOP_TOKEN: input.token,
    ENSEMBLE_LOG_LEVEL: process.env.ENSEMBLE_LOG_LEVEL ?? "info",
  };
  if (input.apiBase) env.ENSEMBLE_REMOTE_API = input.apiBase;
  if (input.adminOnly) {
    env.ENSEMBLE_REMOTE_LOOP = "off";
    env.ENSEMBLE_AGENT_QUEUE = "off";
    env.ENSEMBLE_SCHEDULER = "off";
  }
  return env;
}

export async function spawnSidecar(input: {
  sidecarDir: string;
  paths?: CliPaths;
  foreground?: boolean;
  adminOnly?: boolean;
  apiBase?: string;
  logPath?: string;
  timeoutMs?: number;
}): Promise<SidecarSession> {
  const paths = input.paths ?? resolveCliPaths();
  if (!(await sidecarAvailable(input.sidecarDir))) {
    throw new Error("The packaged Ensemble sidecar is not installed. Install the full Ensemble CLI from https://ensemblework.com/download.");
  }
  await mkdir(paths.logsDir, { recursive: true });
  await mkdir(paths.dataHome, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  const logPath = input.logPath ?? paths.runnerLog;
  await rotateLog(logPath);
  const logFd = openSync(logPath, "a", 0o600);
  const node = join(input.sidecarDir, process.platform === "win32" ? "node.exe" : "node");
  const child = spawn(node, ["--import", "tsx", "src/desktop/main.ts"], {
    cwd: join(input.sidecarDir, "app"),
    env: sidecarEnv({ paths, token, adminOnly: input.adminOnly, apiBase: input.apiBase }),
    detached: !input.foreground,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  if (!input.foreground) child.unref();
  const discovery = await waitForSidecar(paths.discoveryFile, token, input.timeoutMs ?? 30_000, child);
  return {
    discovery,
    child,
    stop: async () => {
      if (!child.killed && child.pid) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    },
  };
}

async function waitForSidecar(file: string, expectedToken: string, timeoutMs: number, child: ChildProcess): Promise<Discovery> {
  const started = Date.now();
  let lastError = "Sidecar did not publish a discovery file.";
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Sidecar exited with code ${child.exitCode}.`);
    const discovery = await readDiscovery(file);
    if (discovery?.token === expectedToken && (await checkHealth(discovery))) return discovery;
    if (discovery && discovery.token !== expectedToken) lastError = "Sidecar discovery file belongs to another launch.";
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(lastError);
}

export async function startRunner(input: { sidecarDir: string; paths?: CliPaths; foreground?: boolean }): Promise<SidecarSession | null> {
  const paths = input.paths ?? resolveCliPaths();
  const running = await runningRunner(paths);
  if (running) return null;
  const session = await spawnSidecar({ sidecarDir: input.sidecarDir, paths, foreground: input.foreground });
  if (session.child?.pid) await writeRunnerPid({ pid: session.child.pid, startedAt: new Date().toISOString() }, paths);
  return session;
}

/**
 * Signals only a process proven to be this runner: the discovery file must
 * answer /health with its token, and the pid comes from that file when the
 * sidecar wrote one. A stale pid file is never trusted on its own, because
 * the operating system may have handed that number to another program.
 */
export async function stopRunner(paths: CliPaths = resolveCliPaths(), waitMs = 10_000): Promise<boolean> {
  const recorded = await readRunnerPid(paths);
  const live = await runningRunner(paths);
  const pid = live ? (live.pid ?? recorded?.pid) : undefined;
  if (!live || !pid) {
    await clearRunnerPid(paths);
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && (await checkHealth(live))) await new Promise((resolve) => setTimeout(resolve, 250));
  await clearRunnerPid(paths);
  return true;
}

/** Removes the pid file only when it still names this process. */
export async function clearRunnerPidIf(pid: number, paths: CliPaths = resolveCliPaths()): Promise<void> {
  const recorded = await readRunnerPid(paths).catch(() => null);
  if (recorded?.pid === pid) await clearRunnerPid(paths);
}

export async function withLocalApi<T>(input: {
  sidecarDir: string;
  paths?: CliPaths;
  apiBase?: string;
  adminOnly?: boolean;
  run: (discovery: Discovery) => Promise<T>;
}): Promise<T> {
  const paths = input.paths ?? resolveCliPaths();
  const running = await runningRunner(paths);
  if (running) return input.run(running);
  const session = await spawnSidecar({
    sidecarDir: input.sidecarDir,
    paths,
    adminOnly: input.adminOnly ?? true,
    apiBase: input.apiBase,
    logPath: join(paths.logsDir, "admin.log"),
  });
  try {
    return await input.run(session.discovery);
  } finally {
    await session.stop();
  }
}

export async function localJson<T>(discovery: Discovery, path: string, init: RequestInit = {}): Promise<T> {
  return fetchJson<T>(`http://127.0.0.1:${discovery.port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${discovery.token}`, ...init.headers },
  });
}

export async function tailLog(file: string, lines = 20): Promise<string[]> {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const start = Math.max(0, size - 64 * 1024);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file, { start });
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return Buffer.concat(chunks).toString("utf8").trimEnd().split(/\r?\n/).slice(-lines);
}

export function sidecarErrorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function defaultFolderLabel(folderPath: string): string {
  return basename(folderPath) || "folder";
}
