/**
 * Readiness probes. /health stays a cheap liveness check.
 * A deep check talks to Postgres, Redis, and agent-runtime, and reports
 * when the scheduler last finished a tick. Failures use fixed words so a
 * driver error cannot leak a URL, password, or token.
 */
import type { SchedulerSnapshot } from "../jobs/scheduler-clock.js";

export const DEFAULT_HEALTH_TIMEOUT_MS = 800;
export const DEFAULT_SCHEDULER_STALE_MS = 180_000;

export type Probe = () => Promise<unknown>;

export type CheckOk = { ok: true };
export type CheckFail = { ok: false; error: "unreachable" | "timeout" };

export type SchedulerCheck =
  | { ok: true; lastTickAt: string | null; status: "ok" | "off" | "starting" }
  | { ok: false; error: "stale"; lastTickAt: string | null; status: "stale" };

export type DeepHealth = {
  ok: boolean;
  service: "hub-api";
  checks: {
    postgres: CheckOk | CheckFail;
    redis: CheckOk | CheckFail;
    agent: CheckOk | CheckFail;
    scheduler: SchedulerCheck;
  };
};

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/** The git commit a VM deploy is running. infra/deploy writes ENSEMBLE_COMMIT; elsewhere it is absent. */
export function deployedCommit(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.ENSEMBLE_COMMIT?.trim();
  return value && /^[0-9a-f]{7,40}$/.test(value) ? value : undefined;
}

export function healthTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.ENSEMBLE_HEALTH_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS, 10_000);
}

export function schedulerStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.ENSEMBLE_HEALTH_SCHEDULER_STALE_SEC, DEFAULT_SCHEDULER_STALE_MS / 1000, 86_400) * 1000;
}

class ProbeTimeout extends Error {}

async function settle(probe: Probe, timeoutMs: number): Promise<CheckOk | CheckFail> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout()), timeoutMs);
  });
  try {
    await Promise.race([probe(), timeout]);
    return { ok: true };
  } catch (error) {
    if (error instanceof ProbeTimeout) return { ok: false, error: "timeout" };
    return { ok: false, error: "unreachable" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function schedulerCheck(snapshot: SchedulerSnapshot, now: number, staleMs: number): SchedulerCheck {
  if (!snapshot.enabled) return { ok: true, lastTickAt: null, status: "off" };
  if (snapshot.lastTickAt === null) {
    if (now - snapshot.startedAt <= staleMs) return { ok: true, lastTickAt: null, status: "starting" };
    return { ok: false, error: "stale", lastTickAt: null, status: "stale" };
  }
  const lastTickAt = new Date(snapshot.lastTickAt).toISOString();
  if (now - snapshot.lastTickAt > staleMs) return { ok: false, error: "stale", lastTickAt, status: "stale" };
  return { ok: true, lastTickAt, status: "ok" };
}

export async function readDeepHealth(input: {
  postgres: Probe;
  redis: Probe;
  agent: Probe;
  scheduler: SchedulerSnapshot;
  now?: number;
  timeoutMs?: number;
  staleMs?: number;
}): Promise<DeepHealth> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const staleMs = input.staleMs ?? DEFAULT_SCHEDULER_STALE_MS;
  const now = input.now ?? Date.now();
  const [postgres, redis, agent] = await Promise.all([
    settle(input.postgres, timeoutMs),
    settle(input.redis, timeoutMs),
    settle(input.agent, timeoutMs),
  ]);
  const scheduler = schedulerCheck(input.scheduler, now, staleMs);
  const ok = postgres.ok && redis.ok && agent.ok && scheduler.ok;
  return { ok, service: "hub-api", checks: { postgres, redis, agent, scheduler } };
}

type RedisProbe = {
  status?: string;
  connect?: () => Promise<unknown>;
  ping: () => Promise<unknown>;
  once?: (event: "ready" | "end", listener: () => void) => void;
  off?: (event: "ready" | "end", listener: () => void) => void;
};

/**
 * The shared client is lazy and refuses to queue commands. A ping issued
 * while the socket is still opening throws, and /health/ready would report
 * Redis down. Connect first, or wait out a connect that is already in flight.
 */
export async function probeRedis(client: RedisProbe): Promise<void> {
  const status = client.status;
  if (status === "wait" || status === "close" || status === "end") {
    if (!client.connect) throw new Error("unreachable");
    await client.connect();
  } else if (status && status !== "ready") {
    await new Promise<void>((resolve, reject) => {
      if (!client.once || !client.off) {
        reject(new Error("unreachable"));
        return;
      }
      const ok = () => {
        cleanup();
        resolve();
      };
      const bad = () => {
        cleanup();
        reject(new Error("unreachable"));
      };
      const cleanup = () => {
        client.off?.("ready", ok);
        client.off?.("end", bad);
      };
      client.once("ready", ok);
      client.once("end", bad);
    });
  }
  await client.ping();
}

/** GET {agentUrl}/health. Throws on any failure. The message is never returned to clients. */
export async function probeAgent(url: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const base = url.replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error("unreachable");
  }
  if (!response.ok) throw new Error("unreachable");
  let body: { ok?: unknown; service?: unknown };
  try {
    body = (await response.json()) as { ok?: unknown; service?: unknown };
  } catch {
    throw new Error("unreachable");
  }
  if (body.ok !== true || body.service !== "agent-runtime") throw new Error("unreachable");
}
