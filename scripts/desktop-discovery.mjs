/**
 * Same path rules as packages/shared-types/src/desktop-discovery.ts.
 * The editor hook runs under plain Node, so this copy stays JavaScript.
 * desktop-discovery.test.ts checks the two agree.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export const DESKTOP_IDENTIFIER = "com.ensemblework.desktop";
export const DISCOVERY_FILE_NAME = "api.json";

function joinPath(platform, ...parts) {
  const sep = platform === "win32" ? "\\" : "/";
  return parts
    .filter((part) => part !== "")
    .map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}

export function desktopDiscoveryPath(input) {
  const env = input.env ?? {};
  const override = env.ENSEMBLE_DISCOVERY_FILE?.trim();
  if (override) return override;
  let dir;
  if (input.platform === "win32") {
    const base = env.APPDATA && env.APPDATA.trim() ? env.APPDATA : `${input.home}\\AppData\\Roaming`;
    dir = joinPath(input.platform, base, DESKTOP_IDENTIFIER);
  } else if (input.platform === "darwin") {
    dir = joinPath(input.platform, input.home, "Library", "Application Support", DESKTOP_IDENTIFIER);
  } else {
    const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() ? env.XDG_DATA_HOME : joinPath(input.platform, input.home, ".local", "share");
    dir = joinPath(input.platform, base, DESKTOP_IDENTIFIER);
  }
  return joinPath(input.platform, dir, DISCOVERY_FILE_NAME);
}

const DEV_API = "http://127.0.0.1:4000";

export function resolveHookTarget(input) {
  const discovery = input.discovery;
  const configured = (input.configUrl ?? DEV_API).replace(/\/$/, "");
  const useDiscovery = Boolean(discovery) && (!input.configUrl || configured === DEV_API);
  return {
    base: useDiscovery ? `http://127.0.0.1:${discovery.port}` : configured,
    token: input.configToken || (useDiscovery ? discovery.token : ""),
  };
}

export function parseDesktopDiscovery(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const port = typeof value.port === "number" ? value.port : Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof value.token !== "string" || value.token.length < 16) return null;
  return { port, token: value.token };
}

export function readDesktopDiscovery(env = process.env) {
  const path = desktopDiscoveryPath({
    platform: process.platform,
    home: homedir(),
    env,
  });
  try {
    return parseDesktopDiscovery(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
