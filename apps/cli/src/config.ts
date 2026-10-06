import { DEFAULT_API_BASE, DEFAULT_APP_URL } from "./version.js";
import { readJsonFile, removeFileIfExists, resolveCliPaths, writeJsonFile, type CliPaths } from "./paths.js";

export type AccountInfo = {
  email?: string | null;
  name?: string | null;
};

export type CliConfig = {
  apiBase: string;
  appUrl: string;
  account?: AccountInfo | null;
  tokenId?: string | null;
  deviceName?: string | null;
  pairedAt?: string | null;
};

export type CliCredentials = {
  token: string;
};

export function normalizeApiBase(value: string | undefined | null): string {
  const trimmed = value?.trim() || DEFAULT_API_BASE;
  return trimmed.replace(/\/+$/, "");
}

export async function loadConfig(paths: CliPaths = resolveCliPaths()): Promise<CliConfig> {
  const saved = await readJsonFile<Partial<CliConfig>>(paths.configFile);
  return {
    apiBase: normalizeApiBase(process.env.ENSEMBLE_API_URL || saved?.apiBase),
    appUrl: (saved?.appUrl || DEFAULT_APP_URL).replace(/\/+$/, ""),
    account: saved?.account ?? null,
    tokenId: saved?.tokenId ?? null,
    deviceName: saved?.deviceName ?? null,
    pairedAt: saved?.pairedAt ?? null,
  };
}

export async function saveConfig(config: CliConfig, paths: CliPaths = resolveCliPaths()): Promise<void> {
  await writeJsonFile(paths.configFile, config, 0o600);
}

export async function loadToken(paths: CliPaths = resolveCliPaths()): Promise<string | null> {
  const envToken = process.env.ENSEMBLE_TOKEN?.trim() || process.env.ENSEMBLE_BRIDGE_TOKEN?.trim();
  if (envToken) return envToken;
  const credentials = await readJsonFile<Partial<CliCredentials>>(paths.credentialsFile);
  return typeof credentials?.token === "string" && credentials.token.trim() ? credentials.token.trim() : null;
}

export async function saveToken(token: string, paths: CliPaths = resolveCliPaths()): Promise<void> {
  await writeJsonFile(paths.credentialsFile, { token }, 0o600);
}

export async function clearToken(paths: CliPaths = resolveCliPaths()): Promise<void> {
  await removeFileIfExists(paths.credentialsFile);
}
