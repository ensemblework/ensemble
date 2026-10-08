import type { FastifyCorsOptions } from "@fastify/cors";
import { DESKTOP_WEBVIEW_ORIGINS } from "./desktop-guard.js";

/** Browser origins allowed to read credentialed hub-api responses. */
export function webOrigins(hubWebOrigin: string): Set<string> {
  const origins = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== "*") origins.add(trimmed);
  };
  add(hubWebOrigin);
  add(hubWebOrigin.replaceAll("localhost", "127.0.0.1"));
  add(hubWebOrigin.replaceAll("127.0.0.1", "localhost"));
  return origins;
}

/** True when this process is the desktop sidecar (`ENSEMBLE_DESKTOP=1`). */
export function isDesktopMode(): boolean {
  return process.env.ENSEMBLE_DESKTOP === "1";
}

/**
 * The one CORS allowlist for hub-api. The Fastify CORS plugin and every
 * response written after `reply.hijack()` must use this, so they agree.
 * The desktop webview origins are added only in desktop mode; the hosted
 * build allows the web origin alone.
 */
export function allowedOrigins(hubWebOrigin: string, desktop: boolean = isDesktopMode()): Set<string> {
  const origins = webOrigins(hubWebOrigin);
  if (desktop) {
    for (const origin of DESKTOP_WEBVIEW_ORIGINS) origins.add(origin);
  }
  return origins;
}

/**
 * Echo the request origin only when it is on the allowlist.
 * A missing or foreign origin gets no header, never `*`.
 */
export function allowOriginHeader(requestOrigin: string | undefined, allowed: ReadonlySet<string>): string | undefined {
  if (!requestOrigin) return undefined;
  return allowed.has(requestOrigin) ? requestOrigin : undefined;
}

/**
 * Cross-origin EventSource and fetch with credentials need the specific
 * origin plus Allow-Credentials. A foreign origin gets neither header.
 */
export function credentialedCorsHeaders(requestOrigin: string | undefined, allowed: ReadonlySet<string>): Record<string, string> {
  const allow = allowOriginHeader(requestOrigin, allowed);
  if (!allow) return {};
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

/**
 * Desktop mode and the allowlist, worked out together. The running hub keeps
 * one of these for the whole process (`hubCorsPolicy()` in hub-cors.ts) and
 * gives the same object to @fastify/cors and to every hijacked response, so
 * they cannot drift apart.
 */
export type CorsPolicy = {
  readonly desktop: boolean;
  readonly origins: ReadonlySet<string>;
};

export function corsPolicy(hubWebOrigin: string, desktop: boolean = isDesktopMode()): CorsPolicy {
  return Object.freeze({ desktop, origins: allowedOrigins(hubWebOrigin, desktop) });
}

/** Options for @fastify/cors, from the same policy the hijacked responses use. */
export function corsPluginOptions(policy: CorsPolicy): FastifyCorsOptions {
  return {
    // Cookies ride on these requests, so only the Hub's own origin may read responses.
    origin: (origin, done) => done(null, !origin || policy.origins.has(origin)),
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-ensemble-user", "x-ensemble-internal", "x-ensemble-share", "x-ensemble-link", "x-ensemble-visitor"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  };
}

/**
 * CORS headers for a response written with `reply.hijack()` and
 * `reply.raw.writeHead()`. Hijacking skips @fastify/cors, so these
 * responses must add the headers themselves, from the same allowlist.
 * The CORS headers only, like `credentialedCorsHeaders`; routes use
 * `streamCorsHeaders`, which adds `Vary: Origin`.
 */
export function hijackedCorsHeaders(
  requestOrigin: string | string[] | undefined,
  hubWebOrigin: string,
  desktop: boolean = isDesktopMode(),
): Record<string, string> {
  return policyCorsHeaders(requestOrigin, corsPolicy(hubWebOrigin, desktop));
}

function policyCorsHeaders(requestOrigin: string | string[] | undefined, policy: CorsPolicy): Record<string, string> {
  const origin = typeof requestOrigin === "string" ? requestOrigin : undefined;
  return credentialedCorsHeaders(origin, policy.origins);
}

/**
 * Headers for every hijacked streaming response (SSE, streamed replies,
 * the terminal). `Vary: Origin` is always sent, also when the origin is
 * refused or missing, as @fastify/cors does, so a cache never hands one
 * origin's response to another. Routes pass `hubCorsPolicy()`.
 */
export function streamCorsHeaders(requestOrigin: string | string[] | undefined, policy: CorsPolicy): Record<string, string> {
  return { Vary: "Origin", ...policyCorsHeaders(requestOrigin, policy) };
}
