/**
 * Google Antigravity's agent: an ACP server Google publishes (no CLI to install by hand), which
 * Ensemble downloads from dl.google.com, checks against a pinned SHA-256 and keeps under its own
 * state folder. Its sign-in is the person's Google account: the server prints a Google sign-in link,
 * Ensemble opens it in the browser on this computer, and Google's answer comes back to the server's
 * own 127.0.0.1 address. The sign-in stays in Antigravity's own file under Ensemble's state folder
 * (`GEMINI_HOME`); Ensemble never reads it.
 *
 * Release table, environment and sign-in handshake follow T3 Code (`antigravityRelease.ts`,
 * `antigravityAuthSupport.ts` in pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { stateDir } from "../remote/store.js";
import { RpcConnection } from "../workspace/engines/rpc.js";
import { agentEnv } from "./detect.js";

export const ANTIGRAVITY_VERSION = "1.3.0";
/** The server prints this, then the Google sign-in link, when it has no sign-in. */
export const ANTIGRAVITY_AUTH_PREFIX = "Open the following link to authenticate the ACP server: ";

type Asset = { url: string; sha256: string; executable: string; harness: string };

const BASE = "https://dl.google.com/agy-extensions/releases";
const ASSETS: Record<string, Asset> = {
  "darwin-arm64": { url: `${BASE}/macos/agy-acp-server-1.3.0-darwin-arm64.zip`, sha256: "7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88", executable: "agy_acp_server.par", harness: "localharness_external" },
  "darwin-x64": { url: `${BASE}/macos/agy-acp-server-1.3.0-darwin-x86_64.zip`, sha256: "bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646", executable: "agy_acp_server.par", harness: "localharness_external" },
  "linux-x64": { url: `${BASE}/linux/agy-acp-server-1.3.0-linux-x86_64.zip`, sha256: "9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96", executable: "agy_acp_server.par", harness: "localharness_external" },
  "linux-arm64": { url: `${BASE}/linux/agy-acp-server-1.3.0-linux-arm64.zip`, sha256: "500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf", executable: "agy_acp_server.par", harness: "localharness_external" },
  "win32-x64": { url: `${BASE}/windows/agy-acp-server-1.3.0-windows-x86_64.zip`, sha256: "65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9", executable: "agy_acp_server.exe", harness: "localharness_external.exe" },
  "win32-arm64": { url: `${BASE}/windows/agy-acp-server-1.3.0-windows-arm64.zip`, sha256: "4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3", executable: "agy_acp_server.exe", harness: "localharness_external.exe" },
};

export function antigravityAsset(platform = process.platform, arch = process.arch): Asset | null {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

/** Ensemble's folder for Antigravity: the installed versions, its own home (sign-in, settings) and scratch space. */
export function antigravityDir(): string {
  return join(stateDir(), "agents", "antigravity");
}

export type AntigravityInstall = { executable: string; harness: string; version: string };

/** The installed server for this computer, or null. */
export function antigravityInstalled(dir = antigravityDir()): AntigravityInstall | null {
  const asset = antigravityAsset();
  if (!asset) return null;
  const folder = join(dir, "versions", ANTIGRAVITY_VERSION);
  const executable = join(folder, asset.executable);
  const harness = join(folder, asset.harness);
  return existsSync(executable) && existsSync(harness) ? { executable, harness, version: ANTIGRAVITY_VERSION } : null;
}

/** Whether Antigravity keeps a sign-in here (the file's presence only; Ensemble never reads it). */
export function antigravitySignedIn(dir = antigravityDir()): boolean {
  return existsSync(join(dir, "home", "antigravity-acp", "acp_token.json"));
}

/** The server's environment: its own home under Ensemble's folder, file storage for the sign-in, no API keys. */
export function antigravityEnv(install: AntigravityInstall, extra: Record<string, string> = {}, dir = antigravityDir()): NodeJS.ProcessEnv {
  const env = agentEnv(extra);
  for (const key of Object.keys(env)) if (key.startsWith("AGY_ACP_") || key === "GEMINI_HOME" || key.startsWith("GOOGLE_CLOUD_") || key === "GOOGLE_APPLICATION_CREDENTIALS") delete env[key];
  const tmp = join(dir, "tmp");
  return {
    ...env,
    GEMINI_HOME: join(dir, "home"),
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    ANTIGRAVITY_HARNESS_PATH: install.harness,
    PYTHONUNBUFFERED: "1",
    ...(process.platform === "win32" ? { TEMP: tmp, TMP: tmp } : { TMPDIR: tmp }),
  };
}

export function antigravityArgs(platform = process.platform): string[] {
  return platform === "linux" ? ["--uid="] : [];
}

/** The Google sign-in link in one line of the server's output, or null. */
export function antigravityAuthLink(line: string): string | null {
  const at = line.indexOf(ANTIGRAVITY_AUTH_PREFIX);
  if (at < 0) return null;
  const link = line.slice(at + ANTIGRAVITY_AUTH_PREFIX.length).trim();
  try {
    const url = new URL(link);
    return url.protocol === "https:" && /(^|\.)google\.com$/.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

function run(command: string, args: string[], cwd: string): boolean {
  const result = spawnSync(command, args, { cwd, stdio: "ignore", windowsHide: true, timeout: 10 * 60_000 });
  return result.status === 0;
}

/** Unzips with what the computer has: ditto on macOS, unzip or Python on Linux, tar on Windows and elsewhere. */
function unzip(archive: string, into: string): boolean {
  if (process.platform === "darwin" && run("/usr/bin/ditto", ["-x", "-k", archive, into], into)) return true;
  if (process.platform !== "win32" && run("unzip", ["-q", "-o", archive, "-d", into], into)) return true;
  if (run(process.platform === "win32" ? "python" : "python3", ["-m", "zipfile", "-e", archive, into], into)) return true;
  return run("tar", ["-xf", archive, "-C", into], into);
}

async function findFile(folder: string, name: string, depth = 3): Promise<string | null> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) if (entry.isFile() && entry.name === name) return join(folder, entry.name);
  if (depth <= 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(join(folder, entry.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

let installing: Promise<AntigravityInstall> | null = null;

/** Downloads and checks the server for this computer (a few hundred MB), once. */
export function installAntigravity(onProgress: (text: string) => void = () => undefined, dir = antigravityDir(), fetcher: typeof fetch = fetch): Promise<AntigravityInstall> {
  const present = antigravityInstalled(dir);
  if (present) return Promise.resolve(present);
  installing ??= (async () => {
    const asset = antigravityAsset();
    if (!asset) throw new Error(`Google publishes no Antigravity agent for ${process.platform} on ${process.arch}.`);
    const work = join(dir, `download-${process.pid}-${Date.now()}`);
    await mkdir(work, { recursive: true });
    try {
      onProgress("Downloading Google Antigravity's agent…");
      const response = await fetcher(asset.url);
      if (!response.ok || !response.body) throw new Error(`Google's download answered ${response.status}.`);
      const archive = join(work, "agent.zip");
      const hash = createHash("sha256");
      const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      body.on("data", (chunk: Buffer) => hash.update(chunk));
      await pipeline(body, createWriteStream(archive));
      if (hash.digest("hex") !== asset.sha256) throw new Error("The downloaded Antigravity agent did not match its published checksum, so it was not installed.");
      onProgress("Unpacking Antigravity's agent…");
      const unpacked = join(work, "unpacked");
      await mkdir(unpacked);
      if (!unzip(archive, unpacked)) throw new Error("Could not unpack Antigravity's agent: install unzip (or Python 3) and try again.");
      const executable = await findFile(unpacked, asset.executable);
      const harness = await findFile(unpacked, asset.harness);
      if (!executable || !harness) throw new Error("Antigravity's download did not hold its agent and harness.");
      const target = join(dir, "versions", ANTIGRAVITY_VERSION);
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      await rename(executable, join(target, asset.executable));
      await rename(harness, join(target, asset.harness));
      if (process.platform !== "win32") {
        await chmod(join(target, asset.executable), 0o755);
        await chmod(join(target, asset.harness), 0o755);
      }
      await mkdir(join(dir, "home"), { recursive: true, mode: 0o700 });
      await mkdir(join(dir, "tmp"), { recursive: true });
      return { executable: join(target, asset.executable), harness: join(target, asset.harness), version: ANTIGRAVITY_VERSION };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
      installing = null;
    }
  })();
  return installing;
}

/**
 * Signs in to Antigravity with the person's Google account: installs the agent when needed, starts
 * it, asks it to sign in (`authenticate` with `oauth-personal`), and opens the Google link it prints.
 * Resolves when the sign-in is kept, or rejects with the reason.
 */
export async function signInAntigravity(open: (url: string) => Promise<void>, onProgress: (text: string) => void = () => undefined, timeoutMs = 6 * 60_000): Promise<void> {
  const install = await installAntigravity(onProgress);
  const child = spawn(install.executable, antigravityArgs(), { cwd: join(antigravityDir(), "tmp"), env: antigravityEnv(install), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdin.on("error", () => undefined);
  const rpc = new RpcConnection((line) => child.stdin.writable && child.stdin.write(line), { jsonrpc: true });
  let opened = false;
  const onLine = (line: string) => {
    const link = antigravityAuthLink(line);
    if (link && !opened) {
      opened = true;
      onProgress("Google's sign-in page opened in the browser.");
      void open(link).catch(() => undefined);
      return;
    }
    void rpc.receive(line);
  };
  createInterface({ input: child.stdout }).on("line", onLine);
  createInterface({ input: child.stderr }).on("line", (line) => {
    const link = antigravityAuthLink(line);
    if (link) onLine(line);
  });
  child.once("close", () => rpc.close("Antigravity's agent stopped before the sign-in finished."));
  const timer = setTimeout(() => rpc.close("The Antigravity sign-in was not finished in time."), timeoutMs);
  try {
    await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "ensemble", version: "1" } });
    await rpc.request("authenticate", { methodId: "oauth-personal" });
    for (let i = 0; i < 20 && !antigravitySignedIn(); i += 1) await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
  }
}

/** Antigravity's models: Gemini with the thinking level in the name (T3 Code's manifest). */
export const ANTIGRAVITY_MODELS = [
  { id: "default", label: "Antigravity's default", isDefault: true },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-pro-agent", label: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
];
