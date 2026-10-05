/** Lease, heartbeat, and online-dot timings from docs/25 §4.3 and §3.3. */
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

/** Milestones a computer may write. `needs_me` and `interrupted` are server-only. */
export const DEVICE_EVENT_KINDS = ["prepared", "tool", "command"] as const;

export function serverRunnerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENSEMBLE_SERVER_RUNNER !== "off";
}

export function deviceOnline(lastSeenAt: Date | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return false;
  return now - lastSeenAt.getTime() <= ONLINE_MS;
}
