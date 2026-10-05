/**
 * The device side of doc 25 §4.3, matched to ensemble-app's remote-tasks-api
 * (PR #47). Routes stay the §4 list. Shapes the server defines are enforced
 * here: claim is a bare job (a `{job}` wrapper is still accepted), leaseToken
 * is a JSON field, ask uses `tier`, progress status is only `running`, complete
 * outcomes are succeeded|failed|cancelled|blocked, and the pairing body is
 * `{code, name, platform, appVersion, capabilities}` with no Authorization header.
 *
 * The decision long-poll is `?timeout=` seconds (1–55) and a flat row whose
 * status is pending|decided|expired. A missing actionHash is allowed. A missing
 * scope is treated as once. There is no device unpair route.
 */
import { z } from "zod";

export const ROUTES = {
  register: "/api/devices/register",
  heartbeat: "/api/devices/self/heartbeat",
  claim: "/api/devices/self/claim",
  progress: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/progress`,
  ask: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/ask`,
  decision: (decisionId: string) => `/api/devices/self/decisions/${encodeURIComponent(decisionId)}`,
  complete: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/complete`,
  events: "/api/devices/self/events",
} as const;

const ms = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** §4.3 and §8. Tests shorten them through the environment; the shipped values are these defaults. */
export const timing = () => ({
  heartbeatMs: ms("ENSEMBLE_REMOTE_HEARTBEAT_MS", 30_000),
  leaseMs: ms("ENSEMBLE_REMOTE_LEASE_MS", 120_000),
  /** Claim polling when the event stream is down (the fallback in §3.1). */
  pollMs: ms("ENSEMBLE_REMOTE_POLL_MS", 15_000),
  /** §3.3: logs batched about every 2 s or 64 KB. */
  syncMs: ms("ENSEMBLE_REMOTE_SYNC_MS", 2_000),
  /** The decision long poll; `waitFor()` allows up to 55 s. */
  waitSeconds: Math.min(55, Math.max(1, Math.round(ms("ENSEMBLE_REMOTE_WAIT_MS", 25_000) / 1000))),
});

export const LOG_CHUNK_BYTES = 64 * 1024;
export const LOG_JOB_BYTES = 2 * 1024 * 1024;
/** §4.3 `GET /api/devices`: online means a heartbeat in the last 90 s. */
export const ONLINE_WINDOW_MS = 90_000;

const text = (max: number) => z.string().max(max);

/** The job spec claim returns: instructions, repo URL, folder label, delivery, model id. No argv. */
export const JobSpec = z
  .object({
    id: text(100).min(1),
    leaseToken: text(500).min(1),
    kind: z.enum(["code", "research"]).default("code"),
    title: text(500).nullish(),
    task: z.object({ title: text(500).nullish(), description: text(20_000).nullish() }).partial().nullish(),
    instructions: text(8000).nullish(),
    repoUrl: text(500).nullish(),
    folder: text(200).nullish(),
    folderLabel: text(200).nullish(),
    delivery: z.enum(["local", "commit", "push"]).default("local"),
    provider: text(100).nullish(),
    model: text(200).nullish(),
    reasoningEffort: text(200).nullish(),
    unattended: z.boolean().default(false),
    /**
     * The server's own sandbox-network setting, copied onto the claim.
     * The Mac does not read it. The local job uses this computer's
     * `orchestration.sandboxNetwork` instead.
     */
    networkAccess: z.boolean().optional(),
    accessMode: z.enum(["review", "read-write"]).nullish(),
    useCredentials: z.boolean().default(false),
    branchMode: text(20).nullish(),
    branch: text(200).nullish(),
    continueFromJobId: text(100).nullish(),
    leaseUntil: text(64).nullish(),
  })
  .passthrough();
export type JobSpec = z.infer<typeof JobSpec>;

/** Claim answers 204 when there is nothing, or the spec, bare or under `job`. */
export function parseClaim(body: unknown): JobSpec {
  const raw = typeof body === "object" && body !== null && "job" in body && typeof (body as { job: unknown }).job === "object" ? (body as { job: unknown }).job : body;
  return JobSpec.parse(raw);
}

export interface HostedAnswer {
  id: string | null;
  status: "pending" | "answered" | "expired";
  decision: "allow" | "deny" | null;
  scope: string | null;
  reason: string | null;
  actionHash: string | null;
}

/** `GET /api/devices/self/decisions/:id`: answered, expired, or still pending. The row may be bare or under `decision`. */
export function parseAnswer(body: unknown): HostedAnswer {
  const outer = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const row = (typeof outer.decision === "object" && outer.decision !== null ? outer.decision : outer) as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" ? value : null);
  const status = str(row.status);
  const verdict = str(row.decision);
  return {
    id: str(row.id),
    status: status === "pending" ? "pending" : status === "expired" ? "expired" : status === "decided" || status === "answered" ? "answered" : "pending",
    decision: verdict === "allow" || verdict === "deny" ? verdict : null,
    scope: str(row.scope),
    reason: str(row.reason),
    actionHash: str(row.actionHash) ?? str((row.detail as Record<string, unknown> | undefined)?.actionHash),
  };
}

export function parseRegistered(body: unknown): { token: string; deviceId: string | null; name: string | null } {
  const row = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const device = (typeof row.device === "object" && row.device !== null ? row.device : {}) as Record<string, unknown>;
  const token = typeof row.token === "string" ? row.token : "";
  if (!token) throw new Error("Ensemble on the web did not return a device token.");
  const id = typeof device.id === "string" ? device.id : typeof row.deviceId === "string" ? row.deviceId : null;
  const name = typeof device.name === "string" ? device.name : null;
  return { token, deviceId: id, name };
}

/**
 * Kinds a device may post on progress. The server writes `needs_me`,
 * `interrupted`, and every other kind itself, and rejects them from a computer.
 */
export const DEVICE_EVENT_KINDS = ["prepared", "tool", "command"] as const;
const DEVICE_EVENT_KIND = new Set<string>(DEVICE_EVENT_KINDS);

export function deviceOwnedEvents<T extends { kind: string }>(rows: T[]): T[] {
  return rows.filter((row) => DEVICE_EVENT_KIND.has(row.kind)).slice(0, 50);
}

/** Outcomes the device complete route accepts. Interrupted is the lease sweep, not a complete body. */
export type Outcome = "succeeded" | "failed" | "cancelled" | "blocked";
export type ResultLink = { kind: "pr" | "commit" | "branch"; url: string; sha?: string };
