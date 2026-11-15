/** Lease, heartbeat, and online-dot timings from docs/25 §3 and §4.1. */
export const LEASE_MS = 120_000;
export const ONLINE_MS = 90_000;
export const PAIRING_MS = 10 * 60_000;
export const MAX_CHUNK_BYTES = 64 * 1024;
export const MAX_JOB_LOG_BYTES = 2 * 1024 * 1024;
export const LOG_TRUNCATED = "log truncated";
/** Reserved seq so the truncated marker is stored once per job. */
export const LOG_TRUNCATED_SEQ = 2_147_483_647;

export function trustFolder(name?: string | null): string {
  const who = name?.trim() || "your computer";
  return `Trust this folder on ${who} first.`;
}
export const DEVICE_REMOVED = "Device removed";
export const LEASE_REJECTED = "Lease rejected.";
export const INTERRUPTED_ERROR = "Interrupted: your computer went offline.";

export const LIVE_DEVICE_STATUSES = ["claimed", "running", "waiting_approval"] as const;

/** Milestones a computer may write (one list with the computer's side). `needs_me` and `interrupted` are server-only. */
export { DEVICE_EVENT_KINDS } from "../remote/contract.js";

export function serverRunnerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENSEMBLE_SERVER_RUNNER !== "off";
}

/**
 * A server whose own runner runs agents' code: `ENSEMBLE_SERVER_RUNNER` on, and not the runtime of the
 * desktop app or the CLI on the person's own computer. Its runs keep the OS sandbox by default, which is
 * in beta and off by default everywhere else (docs/24 §1).
 */
export function serverRunsOwnCode(env: NodeJS.ProcessEnv = process.env): boolean {
  return serverRunnerEnabled(env) && env.ENSEMBLE_DESKTOP !== "1";
}

export function deviceOnline(lastSeenAt: Date | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return false;
  return now - lastSeenAt.getTime() <= ONLINE_MS;
}
