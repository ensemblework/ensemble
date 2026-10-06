import type { InjectOptions, RouteOptions } from "fastify";
import { isPublicAuthPath } from "./auth-public.js";
import { routeCoverage } from "../test/route-coverage.js";

export type RouteAuth = "public" | "cors-preflight" | "event-ticket-or-identity" | "device-registration-proof" | "connector-oauth-state" | "internal-token" | "identity";
export type HttpMethod = NonNullable<InjectOptions["method"]>;
export type InventoryRoute = {
  method: HttpMethod;
  path: string;
  mode: "hosted" | "desktop";
  auth: RouteAuth;
  hasId: boolean;
  hasTest: boolean;
  checks: string[];
};

export function routeAuth(method: string, path: string): RouteAuth {
  if (method === "OPTIONS") return "cors-preflight";
  if (path === "/api/events") return "event-ticket-or-identity";
  if (path === "/api/devices/register") return "device-registration-proof";
  if (/^\/api\/connectors\/[^/]+\/callback$/.test(path)) return "connector-oauth-state";
  if (path === "/health" || path === "/health/ready" || isPublicAuthPath(sampleRoutePath(path))) return "public";
  if (path.startsWith("/api/internal/")) return "internal-token";
  return "identity";
}

export function collectRoutes(mode: InventoryRoute["mode"], routes: InventoryRoute[]) {
  return (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const registeredMethod of methods) {
      const method = registeredMethod.toUpperCase();
      if (!isInjectMethod(method)) throw new Error(`Unsupported inventory HTTP method ${method}: ${route.url}`);
      const auth = routeAuth(method, route.url);
      const resourceChecks = routeCoverage[`${method} ${route.url}`] ?? [];
      const protectedRoute = auth === "identity" || auth === "internal-token" || auth === "event-ticket-or-identity";
      routes.push({
        method,
        path: route.url,
        mode,
        auth,
        hasId: /:id(?:\/|$)/.test(route.url),
        hasTest: resourceChecks.length > 0,
        checks: [
          ...(protectedRoute ? ["unauthenticated"] : []),
          ...(auth !== "cors-preflight" ? ["token-scopes"] : []),
          ...(["POST", "PUT", "PATCH", "DELETE"].includes(method) ? ["malformed-json-or-policy-rejection"] : []),
          ...resourceChecks,
        ],
      });
    }
  };
}

function isInjectMethod(method: string): method is HttpMethod {
  return ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE", "CONNECT"].includes(method);
}

export function sortedRoutes(routes: InventoryRoute[]): InventoryRoute[] {
  return [...routes].sort((a, b) => a.mode.localeCompare(b.mode) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

const PARAMS: Record<string, string> = { kind: "task", provider: "github", source: "github", key: "test", tier: "easy" };
export const MISSING_ID = "00000000-0000-4000-8000-000000000001";

export function sampleRoutePath(pattern: string): string {
  return pattern.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, name: string) => PARAMS[name] ?? MISSING_ID).replace(/\*/g, "inventory-test");
}
