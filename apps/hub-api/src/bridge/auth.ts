import type { AuthVia, TokenScope } from "../lib/auth.js";

/** Same sentence `POST /api/connect/token` has always returned. */
export const BROWSER_SESSION_REQUIRED = "Create this key from the Ensemble page you are signed in to.";

/**
 * Minting a personal key (full or bridge) needs a signed-in page: a session
 * cookie, the local no-login bypass, or the desktop shell. A `ens_` bearer,
 * and the internal service token, must not be able to mint another key.
 */
export function requireBrowserSession(request: { authVia?: AuthVia }): void {
  if (request.authVia === "session" || request.authVia === "bypass" || request.authVia === "desktop") return;
  throw Object.assign(new Error(BROWSER_SESSION_REQUIRED), { statusCode: 403 });
}

/**
 * Only `full`, `bridge`, and `device` grant access. Any other stored scope is
 * rejected. `device` is not `full`: `deviceTokenRejected` limits where it can go.
 */
export function knownTokenScope(scope: string): TokenScope | null {
  if (scope === "full" || scope === "bridge" || scope === "device" || scope === "hooks") return scope;
  return null;
}

/**
 * A `hooks` key is what an agent's hook signs in with: it can open a Needs me card, wait on it,
 * withdraw it, and report what happened in its session. It can never answer a card itself.
 */
export function hooksTokenRejected(scope: string | undefined, method: string, path: string): string | null {
  if (scope !== "hooks") return null;
  const clean = (path.split("?")[0] ?? path).replace(/\/+$/, "") || "/";
  if (method === "POST" && (clean === "/api/decisions" || clean === "/api/decisions/activity")) return null;
  if (method === "GET" && /^\/api\/decisions\/[^/]+\/wait$/.test(clean)) return null;
  if (method === "POST" && /^\/api\/decisions\/[^/]+\/cancel$/.test(clean)) return null;
  return "This key is for an agent's hook. It can only ask Ensemble, not answer or read.";
}

/**
 * A `device` key may only call its own computer's routes. It cannot mint
 * tokens, assign work, or read the rest of the account.
 */
export function deviceTokenRejected(scope: string | undefined, _method: string, path: string): string | null {
  if (scope !== "device") return null;
  const clean = (path.split("?")[0] ?? path).replace(/\/+$/, "") || "/";
  if (clean === "/api/devices/self" || clean.startsWith("/api/devices/self/")) return null;
  return "This key is for your computer. It can only reach that computer's own routes.";
}

export const DEFAULT_INTERNAL_TOKEN = "dev-internal-token";

/**
 * The bridge accepts a session or a personal `ens_` token.
 * It refuses the dev-auth bypass and the well-known default internal token
 * unless that default is explicitly opted into. A private internal token is
 * still a service credential (it can call write routes elsewhere); personal
 * tokens are the path editor configs should use.
 */
export function bridgeAuthRejected(
  via: AuthVia | undefined,
  internalToken: string,
  allowDefaultInternal = process.env.ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN === "true",
): string | null {
  if (!via) return "Sign in to Ensemble first.";
  if (via === "bypass") {
    return "The Context Bridge does not accept ENSEMBLE_DEV_AUTH_BYPASS. Create a read-only key under Connect your apps and set ENSEMBLE_BRIDGE_TOKEN.";
  }
  if (via === "internal" && internalToken === DEFAULT_INTERNAL_TOKEN && !allowDefaultInternal) {
    return "The Context Bridge refuses the default internal token \"dev-internal-token\". Create a personal token (it starts with ens_) and set ENSEMBLE_BRIDGE_TOKEN. Set a private ENSEMBLE_INTERNAL_TOKEN for agent-runtime. ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN=true overrides this check for a local demo only.";
  }
  return null;
}

/** Task writes an editor makes through the Context Bridge (bridge/write-routes.ts). */
export const BRIDGE_WRITE_PREFIX = "/api/bridge/write/";

/**
 * Actions an editor runs through the Context Bridge (bridge/actions.ts): Ensemble's own tools on an
 * allowlist and the connected apps' tools. Any bridge key may call them; each action checks the key's
 * grants itself (writes need canWrite, apps need canUseApps).
 */
export const BRIDGE_ACT_PREFIX = "/api/bridge/act/";

function cleanPath(path: string): string {
  return (path.split("?")[0] ?? path).replace(/\/+$/, "") || "/";
}

function isBridgeWrite(method: string, path: string): boolean {
  return (method === "POST" || method === "PATCH") && `${cleanPath(path)}/`.startsWith(BRIDGE_WRITE_PREFIX);
}

function isBridgeAct(method: string, path: string): boolean {
  return method === "POST" && cleanPath(path).startsWith(BRIDGE_ACT_PREFIX);
}

export function bridgeMethodRejected(method: string, path: string): boolean {
  if (!path.startsWith("/api/bridge")) return false;
  if (isBridgeWrite(method, path) || isBridgeAct(method, path)) return false;
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export const READ_ONLY_KEY = "This key is read-only. It can only look at Ensemble.";

/**
 * A `bridge`-scoped key may read the Context Bridge. A key made with task updates allowed may also
 * write under /api/bridge/write/. It cannot mint tokens or change anything else.
 */
export function readOnlyTokenRejected(scope: string | undefined, method: string, path: string, canWrite = false): string | null {
  if (scope !== "bridge") return null;
  const clean = cleanPath(path);
  const read = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (read && (clean === "/api/bridge" || clean.startsWith("/api/bridge/"))) return null;
  if (clean === "/mcp" && (method === "POST" || method === "GET" || method === "DELETE")) return null;
  if (clean === "/api/cli/logout" && method === "POST") return null;
  if (isBridgeAct(method, path)) return null;
  if (canWrite && isBridgeWrite(method, path)) return null;
  return READ_ONLY_KEY;
}

/**
 * Who may use the bridge's write routes: a signed-in page, the desktop shell, a full key, the internal
 * service token, or a bridge key made with task updates allowed. Device and hook keys never.
 */
export function bridgeWriteRejected(request: { authVia?: AuthVia; tokenScope?: TokenScope; tokenCanWrite?: boolean }): string | null {
  const via = request.authVia;
  if (via === "session" || via === "desktop" || via === "internal") return null;
  if (via !== "token") return "Sign in to Ensemble first.";
  if (request.tokenScope === "full") return null;
  if (request.tokenScope === "bridge") {
    return request.tokenCanWrite
      ? null
      : `${READ_ONLY_KEY} To let editors and agents make changes, make a key with “Let editors and agents make changes” ticked (Connect your apps, or run ensemble login again).`;
  }
  return "This key cannot change anything in Ensemble.";
}

/**
 * Who may use the connected apps through the bridge (Gmail, Outlook, Notion, GitHub, an app's MCP
 * server…): the same callers as writes, and a bridge key only when made with apps allowed.
 */
export function bridgeAppsRejected(request: { authVia?: AuthVia; tokenScope?: TokenScope; tokenCanUseApps?: boolean }): string | null {
  const via = request.authVia;
  if (via === "session" || via === "desktop" || via === "internal") return null;
  if (via !== "token") return "Sign in to Ensemble first.";
  if (request.tokenScope === "full") return null;
  if (request.tokenScope === "bridge") {
    return request.tokenCanUseApps
      ? null
      : "This key cannot use your connected apps. To let editors and agents use them through Ensemble, make a key with “Let editors and agents use your connected apps” ticked (Connect your apps, or run ensemble login again).";
  }
  return "This key cannot use your connected apps.";
}
