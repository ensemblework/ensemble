import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { desktopDiscoveryPath, parseDesktopDiscovery, type DesktopDiscovery } from "@ensemble/shared-types/desktop-discovery";

export type BridgeAuth =
  | { kind: "bearer"; token: string }
  | { kind: "internal"; token: string; userId: string }
  | { kind: "missing"; message: string };

const DEFAULT_INTERNAL = "dev-internal-token";

export interface BridgeConfig {
  hubUrl: string;
  auth: BridgeAuth;
  httpHost: string;
  httpPort: number;
  httpToken: string | null;
}

function readDiscovery(env: NodeJS.ProcessEnv): DesktopDiscovery | null {
  const path = desktopDiscoveryPath({
    platform: process.platform,
    home: homedir(),
    env: {
      APPDATA: env.APPDATA,
      XDG_DATA_HOME: env.XDG_DATA_HOME,
      ENSEMBLE_DISCOVERY_FILE: env.ENSEMBLE_DISCOVERY_FILE,
    },
  });
  try {
    return parseDesktopDiscovery(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const discovery = readDiscovery(env);
  const explicit = env.HUB_API_URL?.trim();
  const hubUrl = (
    explicit
      ? explicit
      : discovery
        ? `http://127.0.0.1:${discovery.port}`
        : `http://${env.HUB_API_HOST ?? "127.0.0.1"}:${env.HUB_API_PORT ?? "4000"}`
  ).replace(/\/$/, "");
  let auth = resolveAuth(env);
  if (auth.kind === "missing" && discovery && !env.ENSEMBLE_BRIDGE_TOKEN?.trim() && !explicit) {
    auth = { kind: "bearer", token: discovery.token };
  }
  return {
    hubUrl,
    auth,
    httpHost: env.CONTEXT_BRIDGE_HOST ?? "127.0.0.1",
    httpPort: Number(env.CONTEXT_BRIDGE_PORT ?? "4010"),
    httpToken: env.CONTEXT_BRIDGE_HTTP_TOKEN?.trim() || null,
  };
}

export function resolveAuth(env: NodeJS.ProcessEnv): BridgeAuth {
  const personal = env.ENSEMBLE_BRIDGE_TOKEN?.trim();
  if (personal) {
    if (!personal.startsWith("ens_")) {
      return {
        kind: "missing",
        message:
          "ENSEMBLE_BRIDGE_TOKEN must be a personal Ensemble token starting with ens_. Create a read-only key under Connect your apps. The bridge will not send it.",
      };
    }
    return { kind: "bearer", token: personal };
  }
  if (env.ENSEMBLE_BRIDGE_USE_INTERNAL_TOKEN === "true") {
    const token = env.ENSEMBLE_INTERNAL_TOKEN?.trim() ?? "";
    if (!token) {
      return { kind: "missing", message: "ENSEMBLE_BRIDGE_USE_INTERNAL_TOKEN is set but ENSEMBLE_INTERNAL_TOKEN is empty." };
    }
    if (token === DEFAULT_INTERNAL && env.ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN !== "true") {
      return {
        kind: "missing",
        message:
          'Refusing the default internal token "dev-internal-token". Create a personal ens_ token and set ENSEMBLE_BRIDGE_TOKEN, or set a private ENSEMBLE_INTERNAL_TOKEN. ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN=true is a local demo override only.',
      };
    }
    return {
      kind: "internal",
      token,
      userId: env.ENSEMBLE_BRIDGE_USER_ID?.trim() || env.ENSEMBLE_DEV_USER_ID?.trim() || "local",
    };
  }
  return {
    kind: "missing",
    message:
      "Set ENSEMBLE_BRIDGE_TOKEN to a personal Ensemble token (ens_…). Create a read-only key in the Hub under Connect your apps. The bridge does not fall back to the default internal token.",
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `Context Bridge HTTP transport only binds to loopback (127.0.0.1, localhost, ::1). Refusing "${host}".`,
    );
  }
}
