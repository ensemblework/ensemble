/**
 * Where the desktop app publishes the local API port and launch token.
 * The Rust shell, hub-api, the Context Bridge, and the editor hook all use
 * this path. A missing file means "use 127.0.0.1:4000", which is today's dev default.
 *
 * The folder matches Tauri's app data dir for identifier `com.ensemblework.desktop`.
 */

export const DESKTOP_IDENTIFIER = "com.ensemblework.desktop";
export const DISCOVERY_FILE_NAME = "api.json";

export type DesktopDiscovery = {
  port: number;
  token: string;
};

export function desktopDataDir(input: {
  platform: string;
  home: string;
  env?: { APPDATA?: string; XDG_DATA_HOME?: string; ENSEMBLE_DISCOVERY_FILE?: string };
}): string {
  const env = input.env ?? {};
  if (input.platform === "win32") {
    const base = env.APPDATA && env.APPDATA.trim() ? env.APPDATA : `${input.home}\\AppData\\Roaming`;
    return joinPath(input.platform, base, DESKTOP_IDENTIFIER);
  }
  if (input.platform === "darwin") {
    return joinPath(input.platform, input.home, "Library", "Application Support", DESKTOP_IDENTIFIER);
  }
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() ? env.XDG_DATA_HOME : joinPath(input.platform, input.home, ".local", "share");
  return joinPath(input.platform, base, DESKTOP_IDENTIFIER);
}

export function desktopDiscoveryPath(input: {
  platform: string;
  home: string;
  env?: { APPDATA?: string; XDG_DATA_HOME?: string; ENSEMBLE_DISCOVERY_FILE?: string };
}): string {
  const override = input.env?.ENSEMBLE_DISCOVERY_FILE?.trim();
  if (override) return override;
  return joinPath(input.platform, desktopDataDir(input), DISCOVERY_FILE_NAME);
}

const DEV_API = "http://127.0.0.1:4000";

/**
 * The editor hook keeps an explicit URL. The dev default, or a missing URL,
 * follows the desktop discovery file when that file is present.
 */
export function resolveHookTarget(input: {
  configUrl?: string;
  configToken?: string;
  discovery: DesktopDiscovery | null;
}): { base: string; token: string } {
  const configured = (input.configUrl ?? DEV_API).replace(/\/$/, "");
  const useDiscovery = Boolean(input.discovery) && (!input.configUrl || configured === DEV_API);
  return {
    base: useDiscovery && input.discovery ? `http://127.0.0.1:${input.discovery.port}` : configured,
    token: input.configToken || (useDiscovery && input.discovery ? input.discovery.token : ""),
  };
}

export function parseDesktopDiscovery(raw: string): DesktopDiscovery | null {
  let value: { port?: unknown; token?: unknown };
  try {
    value = JSON.parse(raw) as { port?: unknown; token?: unknown };
  } catch {
    return null;
  }
  const port = typeof value.port === "number" ? value.port : Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof value.token !== "string" || value.token.length < 16) return null;
  return { port, token: value.token };
}

function joinPath(platform: string, ...parts: string[]): string {
  const sep = platform === "win32" ? "\\" : "/";
  return parts
    .filter((part) => part !== "")
    .map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}
