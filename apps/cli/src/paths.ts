import { constants as fsConstants, existsSync } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { envOf, homeOf, pathApi, platformOf, type PlatformInput } from "./platform.js";

export type CliPaths = {
  configDir: string;
  dataHome: string;
  configFile: string;
  credentialsFile: string;
  discoveryFile: string;
  pidFile: string;
  logsDir: string;
  runnerLog: string;
  updateCacheFile: string;
};

export function resolveConfigDir(input: PlatformInput = {}): string {
  const platform = platformOf(input);
  const env = envOf(input);
  const home = homeOf(input) || homedir();
  const path = pathApi(platform);
  const explicit = env.ENSEMBLE_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  if (platform === "win32") return path.join(env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"), "Ensemble");
  return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), "ensemble");
}

export function resolveDataHome(input: PlatformInput = {}): string {
  const platform = platformOf(input);
  const env = envOf(input);
  const home = homeOf(input) || homedir();
  const path = pathApi(platform);
  const explicit = env.ENSEMBLE_DATA_HOME?.trim();
  if (explicit) return explicit;
  if (platform === "win32") return path.join(env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local"), "Ensemble");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Ensemble CLI");
  return path.join(env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share"), "ensemble");
}

export function resolveCliPaths(input: PlatformInput = {}): CliPaths {
  const platform = platformOf(input);
  const path = pathApi(platform);
  const configDir = resolveConfigDir(input);
  const dataHome = resolveDataHome(input);
  const logsDir = path.join(dataHome, "logs");
  return {
    configDir,
    dataHome,
    configFile: path.join(configDir, "config.json"),
    credentialsFile: path.join(configDir, "credentials.json"),
    discoveryFile: path.join(dataHome, "api.json"),
    pidFile: path.join(dataHome, "runner.pid"),
    logsDir,
    runnerLog: path.join(logsDir, "runner.log"),
    updateCacheFile: path.join(dataHome, "update-check.json"),
  };
}

export async function ensureDir(path: string, mode = 0o700): Promise<void> {
  await mkdir(path, { recursive: true, mode });
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJsonFile(path: string, value: unknown, mode = 0o600): Promise<void> {
  await ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temp, path);
  try {
    await chmod(path, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

export async function removeFileIfExists(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function fileExistsSync(path: string): boolean {
  return existsSync(path);
}

export async function backupOnce(path: string): Promise<string | null> {
  if (!(await fileExists(path))) return null;
  const backup = `${path}.ensemble-backup`;
  if (!(await fileExists(backup))) await copyFile(path, backup);
  return backup;
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}
