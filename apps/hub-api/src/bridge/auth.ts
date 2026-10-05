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
  if (scope === "full" || scope === "bridge" || scope === "device") return scope;
  return null;
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

export function bridgeMethodRejected(method: string, path: string): boolean {
  if (!path.startsWith("/api/bridge")) return false;
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/** A `bridge`-scoped key may only read the Context Bridge. It cannot mint tokens or change data. */
export function readOnlyTokenRejected(scope: string | undefined, method: string, path: string): string | null {
  if (scope !== "bridge") return null;
  const clean = (path.split("?")[0] ?? path).replace(/\/+$/, "") || "/";
  const read = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (read && (clean === "/api/bridge" || clean.startsWith("/api/bridge/"))) return null;
  return "This key is read-only. It can only look at Ensemble.";
}
