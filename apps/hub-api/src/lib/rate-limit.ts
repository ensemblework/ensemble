import type { FastifyRequest } from "fastify";

export type RateBucket = "login" | "signup" | "email" | "model" | "token" | "device" | "cliStart" | "cliToken" | "cliApprove" | "mcp";

export type RateLimitConfig = Record<RateBucket, { limit: number; windowMs: number; error: string }>;

type Slot = { count: number; resetAt: number };

export class MemoryRateLimiter {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly now: () => number = Date.now) {}

  /** @returns retry-after milliseconds when the caller is over the limit. */
  take(key: string, limit: number, windowMs: number): number | null {
    if (limit <= 0 || windowMs <= 0) return null;
    const now = this.now();
    const slot = this.slots.get(key);
    if (!slot || slot.resetAt <= now) {
      this.slots.set(key, { count: 1, resetAt: now + windowMs });
      this.prune(now);
      return null;
    }
    if (slot.count >= limit) return Math.max(1, slot.resetAt - now);
    slot.count += 1;
    return null;
  }

  private prune(now: number): void {
    if (this.slots.size < 2000) return;
    for (const [key, slot] of this.slots) {
      if (slot.resetAt <= now) this.slots.delete(key);
    }
  }
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

export function rateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  return {
    login: {
      limit: intEnv(env, "ENSEMBLE_RATE_LOGIN_LIMIT", 30),
      windowMs: intEnv(env, "ENSEMBLE_RATE_LOGIN_WINDOW_SEC", 900) * 1000,
      error: "Too many sign-in attempts. Wait a moment and try again.",
    },
    signup: {
      limit: intEnv(env, "ENSEMBLE_RATE_SIGNUP_LIMIT", 60),
      windowMs: intEnv(env, "ENSEMBLE_RATE_SIGNUP_WINDOW_SEC", 3600) * 1000,
      error: "Too many accounts were created from here. Wait a moment and try again.",
    },
    email: {
      limit: intEnv(env, "ENSEMBLE_RATE_EMAIL_LIMIT", 5),
      windowMs: intEnv(env, "ENSEMBLE_RATE_EMAIL_WINDOW_SEC", 3600) * 1000,
      error: "Too many account emails were requested. Wait before trying again.",
    },
    model: {
      limit: intEnv(env, "ENSEMBLE_RATE_MODEL_LIMIT", 120),
      windowMs: intEnv(env, "ENSEMBLE_RATE_MODEL_WINDOW_SEC", 60) * 1000,
      error: "Too many model requests. Wait a moment and try again.",
    },
    token: {
      limit: intEnv(env, "ENSEMBLE_RATE_TOKEN_LIMIT", 20),
      windowMs: intEnv(env, "ENSEMBLE_RATE_TOKEN_WINDOW_SEC", 900) * 1000,
      error: "Too many keys were created. Wait a moment and try again.",
    },
    device: {
      limit: intEnv(env, "ENSEMBLE_RATE_DEVICE_LIMIT", 120),
      windowMs: intEnv(env, "ENSEMBLE_RATE_DEVICE_WINDOW_SEC", 60) * 1000,
      error: "Too many updates from this computer. Wait a moment and try again.",
    },
    cliStart: {
      limit: intEnv(env, "ENSEMBLE_RATE_CLI_START_LIMIT", 10),
      windowMs: intEnv(env, "ENSEMBLE_RATE_CLI_START_WINDOW_SEC", 600) * 1000,
      error: "Too many CLI login requests. Wait a moment and try again.",
    },
    cliToken: {
      limit: intEnv(env, "ENSEMBLE_RATE_CLI_TOKEN_LIMIT", 120),
      windowMs: intEnv(env, "ENSEMBLE_RATE_CLI_TOKEN_WINDOW_SEC", 60) * 1000,
      error: "Too many CLI login polls. Wait a moment and try again.",
    },
    cliApprove: {
      limit: intEnv(env, "ENSEMBLE_RATE_CLI_APPROVE_LIMIT", 30),
      windowMs: intEnv(env, "ENSEMBLE_RATE_CLI_APPROVE_WINDOW_SEC", 600) * 1000,
      error: "Too many CLI login codes were checked. Wait a few minutes and try again.",
    },
    mcp: {
      limit: intEnv(env, "ENSEMBLE_RATE_MCP_LIMIT", 240),
      windowMs: intEnv(env, "ENSEMBLE_RATE_MCP_WINDOW_SEC", 60) * 1000,
      error: "Too many MCP requests. Wait a moment and try again.",
    },
  };
}

/**
 * Credential minting. Scoped API keys (`POST /api/tokens`) and MCP bridge keys
 * (`POST /api/connect/token`) exist today. App sign-in tokens use the same
 * bucket when that route is added: `POST /api/auth/app-token` or
 * `POST /api/apps/:id/token`.
 */
export function isTokenMint(path: string): boolean {
  if (path === "/api/tokens" || path === "/api/connect/token" || path === "/api/auth/app-token" || path === "/api/devices/register") return true;
  return /^\/api\/apps\/[^/]+\/token$/.test(path);
}

/** Heartbeat and progress. About 120 a minute per device, in this process. */
export function isDeviceWrite(path: string): boolean {
  if (path === "/api/devices/self/heartbeat") return true;
  return /^\/api\/devices\/self\/jobs\/[^/]+\/progress$/.test(path);
}

export function classifyRateLimit(method: string, path: string): RateBucket | null {
  if (method === "POST" && (path === "/api/auth/login" || path === "/api/auth/reset" || path === "/api/auth/verify-email")) return "login";
  if (method === "GET" && /^\/api\/auth\/oauth\/[^/]+\/start$/.test(path)) return "login";
  if (method === "GET" && /^\/api\/auth\/oauth\/[^/]+\/callback$/.test(path)) return "signup";
  if (method === "POST" && path === "/api/auth/signup") return "signup";
  if (method === "POST" && (path === "/api/auth/forgot" || path === "/api/auth/resend-verification")) return "email";
  if (method === "POST" && path === "/api/cli/auth/start") return "cliStart";
  if (method === "POST" && path === "/api/cli/auth/token") return "cliToken";
  if ((method === "GET" && path === "/api/cli/auth/request") || (method === "POST" && path === "/api/cli/auth/approve")) return "cliApprove";
  if (method === "POST" && path === "/mcp") return "mcp";
  if (method === "POST" && (path === "/api/assistant/turn" || path === "/api/models/test")) return "model";
  if (method === "GET" && path === "/api/models") return "model";
  if (method === "PUT" && /^\/api\/model-keys\/[^/]+$/.test(path)) return "model";
  if (method === "POST" && isTokenMint(path)) return "token";
  if (method === "POST" && isDeviceWrite(path)) return "device";
  return null;
}

export function clientAddress(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = raw?.split(",")[0]?.trim();
  return ip || request.ip || "unknown";
}

export function rateLimitKey(bucket: RateBucket, request: FastifyRequest): string {
  if (bucket === "device" && request.tokenId) return `device:${request.tokenId}`;
  if ((bucket === "mcp" || bucket === "cliApprove") && request.userId) return `${bucket}:user:${request.userId}`;
  if ((bucket === "model" || bucket === "token" || bucket === "device") && request.userId) return `${bucket}:user:${request.userId}`;
  return `${bucket}:ip:${clientAddress(request)}`;
}

export type RateLimitHit = { error: string; retryAfterSeconds: number };

export function consumeRateLimit(
  limiter: MemoryRateLimiter,
  request: FastifyRequest,
  path: string,
  config: RateLimitConfig = rateLimitConfig(),
): RateLimitHit | null {
  const bucket = classifyRateLimit(request.method, path);
  if (!bucket) return null;
  const rule = config[bucket];
  const wait = limiter.take(rateLimitKey(bucket, request), rule.limit, rule.windowMs);
  if (wait === null) return null;
  return { error: rule.error, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) };
}

export const rateLimiter = new MemoryRateLimiter();

/**
 * People on a public link have no account to count against, so they are counted per address:
 * reads and writes separately. Set either to 0 to turn it off.
 */
export function linkRateLimit(limiter: MemoryRateLimiter, request: FastifyRequest, env: NodeJS.ProcessEnv = process.env): RateLimitHit | null {
  const write = request.method !== "GET" && request.method !== "HEAD";
  const limit = write ? intEnv(env, "ENSEMBLE_RATE_LINK_WRITE_LIMIT", 120) : intEnv(env, "ENSEMBLE_RATE_LINK_READ_LIMIT", 900);
  const wait = limiter.take(`link:${write ? "write" : "read"}:${clientAddress(request)}`, limit, 60_000);
  if (wait === null) return null;
  return { error: "Too many requests on this link. Wait a moment and try again.", retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) };
}
