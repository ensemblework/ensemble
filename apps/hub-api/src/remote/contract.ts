/**
 * The device side of doc 25 §4.1, matched to ensemble-app's remote-tasks-api
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
  self: "/api/devices/self",
  heartbeat: "/api/devices/self/heartbeat",
  claim: "/api/devices/self/claim",
  progress: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/progress`,
  ask: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/ask`,
  decision: (decisionId: string) => `/api/devices/self/decisions/${encodeURIComponent(decisionId)}`,
  /** Answered on this computer: closes the card on the web too. */
  closeDecision: (decisionId: string) => `/api/devices/self/decisions/${encodeURIComponent(decisionId)}/close`,
  complete: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/complete`,
  /** A run this computer still has (running, or finished while it was cut off) after its lease ran out: a new lease (protocol 5). */
  reattach: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/reattach`,
  /** A run this computer lost when it restarted: carried on in a new run in the same folder and session (protocol 5). */
  resume: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/resume`,
  events: "/api/devices/self/events",
  attachment: (jobId: string, fileId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/attachments/${encodeURIComponent(fileId)}`,
  /** The account's model keys, for this computer's own model calls. */
  modelKeys: "/api/devices/self/model-keys",
  /** The text of the files a run changed, sent before complete (protocol 3). */
  files: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/files`,
  /** This computer's answer to a `files.request` from the web: a folder's entries or a file's text. */
  fileAnswer: (requestId: string) => `/api/devices/self/file-requests/${encodeURIComponent(requestId)}`,
  /** This computer's answer to a `code.request` or `terminal.request` from the web (protocol 4). */
  codeAnswer: (requestId: string) => `/api/devices/self/code-requests/${encodeURIComponent(requestId)}`,
  /** Output of a terminal command the web started here, in order (protocol 4). */
  terminalOutput: (runId: string) => `/api/devices/self/terminal-runs/${encodeURIComponent(runId)}/output`,
  /** A file the run's worker attached, as raw bytes with `EVIDENCE_HEADERS` (protocol 6). */
  evidence: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/evidence`,
  /** Output of a node tool command, in order, past what its answer carried (protocol 6, `node.tool.request`). */
  toolOutput: (runId: string) => `/api/devices/self/tool-runs/${encodeURIComponent(runId)}/output`,
  /** A file the web asked for by an upload id (protocol 7): a node's capture, or a held file released or previewed. */
  evidenceUpload: (uploadId: string) => `/api/devices/self/evidence-uploads/${encodeURIComponent(uploadId)}`,
  /** The latest small picture of a run's browser tab, for its live view (protocol 7). */
  liveFrame: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/live`,
  /** An assistant turn the web handed this computer's agent (capabilities `assistantTurns`): read it, call its tools, stream, finish. */
  assistantTurn: (turnId: string) => `/api/devices/self/assistant-turns/${encodeURIComponent(turnId)}`,
  /** A file attached to the turn's message (`assistantTurns` 2). */
  assistantFile: (turnId: string, fileId: string) => `/api/devices/self/assistant-turns/${encodeURIComponent(turnId)}/files/${encodeURIComponent(fileId)}`,
  assistantTool: (turnId: string) => `/api/devices/self/assistant-turns/${encodeURIComponent(turnId)}/tool`,
  assistantStream: (turnId: string) => `/api/devices/self/assistant-turns/${encodeURIComponent(turnId)}/stream`,
  assistantDone: (turnId: string) => `/api/devices/self/assistant-turns/${encodeURIComponent(turnId)}/done`,
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

/**
 * The device protocol this server speaks, sent on every claim. 2 (14 Oct 2026): progress may carry
 * `steps` and the `engine` and `sandbox` events, and complete `totals` and a 20,000-character summary.
 * 3 (14 Oct 2026): the text of the files a run changed goes to `ROUTES.files` before complete, and the
 * server may ask for a folder's entries or a file's text (`files.request` on the event stream).
 * 4 (14 Oct 2026): the web's Code tab works on this computer: the server sends `code.request` (one call
 * to this computer's own `/api/code/*`) and `terminal.request` (the web terminal, after a passkey unlock
 * on the web); answers go to `ROUTES.codeAnswer`, terminal output to `ROUTES.terminalOutput`. A computer
 * says it takes them with `capabilities.code`.
 * 5 (25 Oct 2026): after an outage a computer reattaches a run whose lease ran out while it kept
 * going (`ROUTES.reattach`), and asks to carry on a run it lost by restarting (`ROUTES.resume`); a
 * claim may carry `resume`, which the computer runs in the earlier run's folder and agent session.
 * A computer sends each only to a server that says so: an older one answers them with a 400 or 404.
 * 6 (3 Nov 2026): a claim may carry `secrets` (the saved secrets the run may have; absent: all of them);
 * complete may carry the worker's `report` (node/report.ts StepReport); the files a worker attached go to
 * `ROUTES.evidence` before complete; the server may send `node.tool.request` (a node's own tool call on
 * this computer, `capabilities.nodeTools`), whose long output goes to `ROUTES.toolOutput`.
 * 7 (16 Nov 2026): an evidence file's description may say it is held for the owner's preview (`held`,
 * `holdReason`; its bytes stay here), that it is a video's poster or preview (`variantOf`, `variant`)
 * and what capture measured (`details`); `node.tool.request` may carry a browser or capture tool
 * (`capabilities.browser`), whose files go to `ROUTES.evidenceUpload`; the server may send
 * `evidence.request` (preview, release or discard a file kept here); a run's live view goes to
 * `ROUTES.liveFrame`.
 */
export const PROTOCOL = 7;
/** Carry-ons after a computer restarted, per task chain; the next interruption stays for Run again. */
export const MAX_AUTO_RESUMES = 2;
/** A run interrupted longer ago than this is not carried on by itself. */
export const RESUME_WINDOW_MS = 24 * 3600_000;
/** What a protocol 1 server takes. */
export const LEGACY_EVENT_KINDS = ["prepared", "tool", "command"] as const;
export const LEGACY_SUMMARY_CHARS = 8000;

/** The heading the task page goes under inside `task.description`, for computers that do not read `task.page`. */
export const PAGE_HEADING = "## The task page (what the person wrote; the task itself)";

/** A description with the page section the server added taken out, for a computer that reads `task.page` itself. */
export function withoutPageSection(description: string, page: string): string {
  const section = `${PAGE_HEADING}\n${page}`;
  const at = description.indexOf(section);
  if (at < 0) return description;
  return `${description.slice(0, at)}${description.slice(at + section.length)}`.replace(/\n{3,}/g, "\n\n").trim();
}

export const LOG_JOB_BYTES = 2 * 1024 * 1024;
/** §4.3 `GET /api/devices`: online means a heartbeat in the last 90 s. */
export const ONLINE_WINDOW_MS = 90_000;

const text = (max: number) => z.string().max(max);

/** Worktree and branch names Ensemble makes: letters, digits and . _ - / only, never starting with - or . */
const RefName = z.string().max(200).regex(/^(?![-.])[A-Za-z0-9._/-]+$/).refine((value) => !value.includes("..") && !value.endsWith(".lock") && !value.endsWith("/"));

export const MissionSpec = z.object({
  id: text(100).min(1),
  step: text(100).min(1),
  /** Work in this git worktree of the shared folder: on `branch` (made from the folder's last commit when new), or detached; `reuse`: a check of a build, in that build's worktree. */
  worktree: z.object({ name: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/), branch: RefName.nullish(), detached: z.boolean().optional(), reuse: z.boolean().optional() }).nullish(),
  port: z.number().int().min(1024).max(65535).nullish(),
  /** An integration step's worktrees (names): removed after it succeeds, when clean and nothing would be lost. */
  integrates: z.array(z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)).max(20).nullish(),
});
export type MissionSpec = z.infer<typeof MissionSpec>;

/** The job spec claim returns: instructions, repo URL, folder label, delivery, model id. No argv. */
export const JobSpec = z
  .object({
    id: text(100).min(1),
    leaseToken: text(500).min(1),
    kind: z.enum(["code", "research"]).default("code"),
    title: text(500).nullish(),
    /**
     * `page` is the task page as Markdown (what the person wrote there, the main content of the
     * task). Servers since 14 Oct 2026 send it, and also inside `description` under
     * `PAGE_HEADING` for computers that predate the field.
     */
    task: z.object({ title: text(500).nullish(), description: text(40_000).nullish(), page: text(20_000).nullish() }).partial().nullish(),
    attachments: z.array(z.object({ id: z.string().uuid(), filename: text(500), kind: z.enum(["file", "diagram"]).optional(), byteSize: z.number().int().min(0).max(100 * 1024 * 1024) })).max(100).default([]),
    instructions: text(8000).nullish(),
    repoUrl: text(500).nullish(),
    folder: text(200).nullish(),
    folderLabel: text(200).nullish(),
    delivery: z.enum(["local", "commit", "push"]).default("push"),
    provider: text(100).nullish(),
    model: text(200).nullish(),
    reasoningEffort: text(200).nullish(),
    /** The model's context window where it offers more than one (GitHub Copilot's long_context). */
    contextTier: z.enum(["default", "long_context"]).nullish(),
    /** The model's fast mode (Claude Code, Codex). Older servers omit it. */
    fast: z.boolean().nullish(),
    /** The run ends in a pull request into `base`, merged as `merge` says (docs/24 §5.1). Older servers omit it. */
    pullRequest: z.object({ base: text(200).default(""), merge: z.enum(["ask", "auto", "never"]).default("ask") }).nullish(),
    unattended: z.boolean().default(false),
    /** Ask, Review only or Run unattended. Older servers send only `unattended`. */
    mode: z.enum(["ask", "review", "unattended"]).nullish(),
    /**
     * Internet access chosen when it was assigned. Applied when this computer
     * accepts web settings (`acceptWebApprovals`); otherwise this computer's
     * `orchestration.sandboxNetwork` decides.
     */
    networkAccess: z.boolean().optional(),
    askBeforePublish: z.boolean().optional(),
    /** The sandbox toggle from the Assign dialog. Older servers omit it (sandbox on). */
    sandbox: z.boolean().optional(),
    /** Outside the work folder in a sandboxed run: read only, read and write, or nothing. */
    outsideAccess: z.enum(["none", "read", "read-write"]).nullish(),
    markDone: z.boolean().optional(),
    maxMinutes: z.number().int().min(1).max(480).nullish(),
    maxTurns: z.number().int().min(3).max(200).nullish(),
    maxToolCalls: z.number().int().min(5).max(500).nullish(),
    accessMode: z.enum(["review", "read-write"]).nullish(),
    useCredentials: z.boolean().default(false),
    branchMode: text(20).nullish(),
    branch: text(200).nullish(),
    continueFromJobId: text(100).nullish(),
    leaseUntil: text(64).nullish(),
    /** The server's device protocol (`PROTOCOL`); servers before 14 Oct 2026 omit it (1). */
    protocol: z.number().int().min(1).max(1000).optional(),
    /** False when the server keeps no text of the files a run changed (Ensemble on the web): skip sending it. */
    keepsFileText: z.boolean().optional(),
    /** This run carries on `continueFromJobId`, cut off when this computer restarted (protocol 5). */
    resume: z.object({ reason: text(300), attempt: z.number().int().min(1).max(10) }).nullish(),
    /** This run changes the one it continues, which was interrupted for it (Ensemble Node's steer). Older servers omit it. */
    steer: z.object({ update: text(8000) }).nullish(),
    /**
     * The saved secrets this run may have in its environment, by name (protocol 6): an Ensemble Node run
     * lists the ones its step or mission names, possibly none. Absent: every saved secret, as before.
     */
    secrets: z.array(text(64)).max(100).nullish(),
    /**
     * An Ensemble Node plan step's run (B13): its mission and step, the git worktree of the shared folder it
     * works in, its development-server port, and the worktrees an integration step brings in. Older servers
     * omit it; an older computer ignores it and works in the folder itself. Read with `parseMission`, so a
     * value this computer does not understand never refuses the whole job.
     */
    mission: z.unknown().optional(),
  })
  .passthrough();
export type JobSpec = z.infer<typeof JobSpec>;

/** A claim's (or a job context's) `mission`, when it is a valid one. */
export function parseMission(value: unknown): MissionSpec | null {
  const parsed = MissionSpec.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A job's `context.mission`, when it is a valid one. */
export function missionOf(context: unknown): MissionSpec | null {
  return parseMission(typeof context === "object" && context !== null ? (context as { mission?: unknown }).mission : undefined);
}

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
export const DEVICE_EVENT_KINDS = ["prepared", "tool", "command", "engine", "sandbox", "engine_retry", "resumed"] as const;
const DEVICE_EVENT_KIND = new Set<string>(DEVICE_EVENT_KINDS);
/** What servers on protocols 2 to 4 take; they refuse a post with any other kind. */
const V2_EVENT_KINDS = new Set<string>(["prepared", "tool", "command", "engine", "sandbox"]);

export function deviceOwnedEvents<T extends { kind: string }>(rows: T[], protocol = PROTOCOL): T[] {
  const kinds: ReadonlySet<string> = protocol >= 5 ? DEVICE_EVENT_KIND : protocol >= 2 ? V2_EVENT_KINDS : new Set<string>(LEGACY_EVENT_KINDS);
  return rows.filter((row) => kinds.has(row.kind)).slice(0, 50);
}

/** A run step as a computer sends it: previews only, already scrubbed there (docs/25 §4.5). */
export const UploadedStep = z.object({
  index: z.number().int().min(0).max(5000),
  title: text(300),
  status: z.enum(["pending", "running", "done", "failed", "needs_approval", "skipped"]),
  output: text(4000).nullish(),
  reasoning: text(4000).nullish(),
  error: text(1000).nullish(),
  model: text(200).nullish(),
  tokensIn: z.number().int().min(0).max(1_000_000_000).nullish(),
  tokensOut: z.number().int().min(0).max(1_000_000_000).nullish(),
  toolCalls: z
    .array(
      z.object({
        id: text(200).optional(),
        name: text(120),
        args: text(2000).optional(),
        output: text(4000).optional(),
        ok: z.boolean().optional(),
        ms: z.number().min(0).max(864_000_000).optional(),
        engine: text(40).optional(),
        summary: text(300).optional(),
      }),
    )
    .max(10)
    .default([]),
  startedAt: z.string().datetime().nullish(),
  endedAt: z.string().datetime().nullish(),
});
export type UploadedStep = z.infer<typeof UploadedStep>;

/** Steps a run keeps on the server. */
export const MAX_UPLOADED_STEPS = 800;
/** About how much step text one progress post carries; the rest goes on the next post. */
export const STEP_POST_BYTES = 1_000_000;

/**
 * What the engine reported the run went with (workspace/engines/observed.ts): the model it started on,
 * the thinking level and context window it said it used (the window in tokens too), and fast mode. A
 * field the engine did not report is left out; the server shows it as "not reported". Sent on progress
 * when it changes and on complete (`RunTotals.observed`); servers before 2 November 2026 ignore it.
 */
export const ObservedSettings = z.object({
  model: text(200).nullish(),
  effort: text(40).nullish(),
  context: z.enum(["default", "long_context"]).nullish(),
  contextTokens: z.number().int().positive().max(100_000_000).nullish(),
  fast: z.boolean().nullish(),
});
export type ObservedSettings = z.infer<typeof ObservedSettings>;

/** What a computer reports when a run ends: the model that answered, counts, its cost estimate, files changed (names and line counts only). */
export const RunTotals = z.object({
  model: text(200).nullish(),
  turns: z.number().int().min(0).max(1_000_000).optional(),
  toolCalls: z.number().int().min(0).max(1_000_000).optional(),
  tokensIn: z.number().int().min(0).max(1_000_000_000).optional(),
  tokensOut: z.number().int().min(0).max(1_000_000_000).optional(),
  costUsd: z.number().min(0).max(100_000).nullish(),
  /** The run's review on this computer (protocol 4): the web opens it in the Code tab through this computer. */
  reviewId: z.string().uuid().nullish(),
  files: z
    .array(z.object({ path: text(500), added: z.number().int().min(0), removed: z.number().int().min(0), status: z.enum(["added", "modified", "deleted"]).optional(), binary: z.boolean().optional() }))
    .max(200)
    .default([]),
  /** What the engine reported it ran with. */
  observed: ObservedSettings.optional(),
});
export type RunTotals = z.infer<typeof RunTotals>;

/** Changed files a computer sends with their text: at most this many, each and in all. */
export const UPLOAD_FILES_MAX = 100;
export const UPLOAD_FILE_BYTES = 256 * 1024;
export const UPLOAD_TOTAL_BYTES = 3 * 1024 * 1024;

/** One changed file as a computer sends it: its text when it is text and not a secrets file, cut to `UPLOAD_FILE_BYTES`. */
export const UploadedFile = z.object({
  path: text(500).min(1),
  status: z.enum(["added", "modified", "deleted"]),
  size: z.number().int().min(0).max(2_147_483_647),
  content: z.string().max(UPLOAD_FILE_BYTES).nullish(),
  binary: z.boolean().default(false),
  truncated: z.boolean().default(false),
  /** Why the text was not sent (a secrets file, too large, unreadable). */
  skipped: text(200).nullish(),
});
export type UploadedFile = z.infer<typeof UploadedFile>;

/** `files.request` on the event stream: the web asks for one folder's entries or one file's text in a job's folder. */
export const FileRequest = z.object({
  id: text(100).min(1),
  jobId: text(100).min(1),
  kind: z.enum(["tree", "file"]),
  path: text(1000).default(""),
});
export type FileRequest = z.infer<typeof FileRequest>;

/** The computer's answer: entries, a file, or why not. */
export const FileAnswer = z.object({
  listing: z
    .object({
      path: text(1000),
      entries: z.array(z.object({ name: text(500), kind: z.enum(["dir", "file", "link"]), size: z.number().int().min(0).nullable() })).max(1000),
      truncated: z.boolean(),
      hidden: z.number().int().min(0),
    })
    .optional(),
  file: z
    .object({ path: text(1000), size: z.number().int().min(0).max(2_147_483_647), content: z.string().max(600 * 1024).nullable(), binary: z.boolean(), truncated: z.boolean() })
    .optional(),
  error: text(500).optional(),
});
export type FileAnswer = z.infer<typeof FileAnswer>;

/** Outcomes the device complete route accepts. Interrupted is the lease sweep, not a complete body. */
export type Outcome = "succeeded" | "failed" | "cancelled" | "blocked";
export type ResultLink = { kind: "pr" | "commit" | "branch"; url: string; sha?: string };

/**
 * The calls the web may make to a computer's own Code API (`routes/code.ts`), method and path. Both the
 * server and the computer check a request against this list; anything else is refused. Settings (the
 * folders Code can use) stay on the computer.
 */
export const CODE_CALLS: ReadonlyArray<{ method: "GET" | "POST" | "PUT"; path: RegExp; write: boolean; slow?: boolean; since?: number }> = [
  { method: "GET", path: /^\/api\/code\/(repos|reviews|source|diff|file|scm)$/, write: false },
  { method: "GET", path: /^\/api\/code\/(versions|tree|files|progress|commit-plan)$/, write: false, since: 2 },
  { method: "GET", path: /^\/api\/code\/actions$/, write: false, slow: true },
  { method: "GET", path: /^\/api\/code\/search$/, write: false, slow: true, since: 2 },
  { method: "POST", path: /^\/api\/code\/decide$/, write: true },
  { method: "POST", path: /^\/api\/code\/(accept-content|restore)$/, write: true, since: 2 },
  { method: "POST", path: /^\/api\/code\/reviews\/[0-9a-f-]{36}\/complete$/, write: true },
  { method: "POST", path: /^\/api\/code\/reviews\/[0-9a-f-]{36}\/(accept|discard)$/, write: true, slow: true },
  { method: "POST", path: /^\/api\/code\/reviews\/[0-9a-f-]{36}\/push$/, write: true, slow: true },
  { method: "POST", path: /^\/api\/code\/scm\/(stage|unstage|discard)$/, write: true },
  { method: "POST", path: /^\/api\/code\/scm\/(commit|push|pull)$/, write: true, slow: true },
  { method: "POST", path: /^\/api\/code\/(commit-paths|pull-request)$/, write: true, slow: true, since: 2 },
  { method: "PUT", path: /^\/api\/code\/file$/, write: true },
];

/**
 * The Code calls a computer answers (`capabilities.codeApi`): 1 is the first relay (0.3.8); 2 adds the
 * IDE's calls (`since: 2`: versions, tree, files, search, progress, accept, restore, commit, pull request).
 */
export const CODE_API = 2;

/** The entry for this call, or null when the web may not make it. */
export function codeCall(method: string, path: string): (typeof CODE_CALLS)[number] | null {
  return CODE_CALLS.find((call) => call.method === method && call.path.test(path)) ?? null;
}

/** What one Code answer may carry. Larger answers are refused on the computer with a 413. */
export const CODE_ANSWER_BYTES = 3 * 1024 * 1024;
/** A file the web may edit; larger ones open read-only. */
export const CODE_EDIT_BYTES = 1024 * 1024;

/** `code.request` on the event stream: one call to this computer's Code API, from the web. */
export const CodeRequest = z.object({
  id: text(100).min(1),
  method: z.enum(["GET", "POST", "PUT"]),
  path: text(300).min(1),
  query: z.record(z.string().max(100), z.string().max(4096)).default({}),
  body: z.unknown().optional(),
});
export type CodeRequest = z.infer<typeof CodeRequest>;

/** The computer's answer to a `code.request` or `terminal.request`: the status and JSON body its own API gave. */
export const CodeAnswer = z.object({
  status: z.number().int().min(100).max(599),
  body: z.unknown().optional(),
});
export type CodeAnswer = z.infer<typeof CodeAnswer>;

/**
 * `terminal.request` on the event stream: the web terminal, unlocked with a passkey on the web. `status`
 * gives the folders it may use, `cd` resolves a folder, `run` starts one allow-listed command (its output
 * goes to `ROUTES.terminalOutput` under the request id), `kill` stops a run.
 */
export const TerminalRequest = z.object({
  id: text(100).min(1),
  op: z.enum(["status", "cd", "run", "kill"]),
  cwd: text(4096).optional(),
  path: text(4096).optional(),
  line: text(4000).optional(),
  confirmed: z.boolean().default(false),
  runId: text(100).optional(),
});
export type TerminalRequest = z.infer<typeof TerminalRequest>;

/** Terminal output a computer sends, in order. The last chunk says `done` with the exit code. */
export const TERMINAL_CHUNK_BYTES = 64 * 1024;
/** What one web terminal command may print; past this the computer stops sending and says so. */
export const TERMINAL_OUTPUT_BYTES = 1024 * 1024;
export const TerminalChunk = z.object({
  seq: z.number().int().min(0).max(100_000),
  text: z.string().max(TERMINAL_CHUNK_BYTES),
  done: z.boolean().default(false),
  exitCode: z.number().int().min(-1).max(1_000_000).nullish(),
});
export type TerminalChunk = z.infer<typeof TerminalChunk>;

// ── evidence (protocol 6) ───────────────────────────────────────────────────

/** What a worker may attach (evidence/limits.ts holds the size limits and the content checks). */
export const EVIDENCE_KINDS = ["screenshot", "image", "video", "trace", "report", "log", "file"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** What capture measured about a file: its size in pixels, a video's length, rate, frames and codec. */
export const EvidenceDetails = z
  .object({
    width: z.number().int().min(0).max(100_000).optional(),
    height: z.number().int().min(0).max(100_000).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    fps: z.number().int().min(0).max(1000).optional(),
    frames: z.number().int().min(0).max(10_000_000).optional(),
    codec: text(40).optional(),
  })
  .strict();
export type EvidenceDetails = z.infer<typeof EvidenceDetails>;

/** Headers of an evidence upload: the job's lease, and `EvidenceMeta` as base64url JSON. The body is the file's bytes. */
export const EVIDENCE_HEADERS = { lease: "x-ensemble-job-lease", meta: "x-ensemble-evidence" } as const;

/**
 * One attached file, as the computer describes it. `local`: evidence upload is off on that computer
 * (`ensemble evidence off`), so only this goes up and the body is empty; the web shows the file as on
 * the computer, not uploaded.
 */
export const EvidenceMeta = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(EVIDENCE_KINDS),
    name: text(200).min(1),
    size: z.number().int().min(0).max(200 * 1024 * 1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** The type the computer sniffed; the server sniffs uploaded bytes itself and uses this only for `local`. */
    mime: text(100).nullish(),
    caption: text(300).nullish(),
    requirementId: text(80).nullish(),
    local: z.boolean().default(false),
    /** Protocol 7: kept here for the owner to preview first; like `local`, no bytes come with it. */
    held: z.boolean().optional(),
    holdReason: text(300).nullish(),
    /** Protocol 7: a video's poster or small preview image, and the video's id. */
    variantOf: z.string().uuid().nullish(),
    variant: z.enum(["poster", "preview"]).nullish(),
    /** Protocol 7: what capture measured. */
    details: EvidenceDetails.nullish(),
  })
  .strict();
export type EvidenceMeta = z.infer<typeof EvidenceMeta>;

// ── node tools (protocol 6) ─────────────────────────────────────────────────

/** `capabilities.nodeTools`: this computer answers `node.tool.request` (a node's own tool calls). */
export const NODE_TOOLS_API = 1;
/** What one node tool answer carries inline; a command's longer output goes to `ROUTES.toolOutput`. */
export const NODE_TOOL_INLINE_BYTES = 64 * 1024;
/** A command still going after this becomes a background tool run that wakes the node when it ends. */
export const NODE_TOOL_FOREGROUND_MS = 60_000;
/** The longest a node's command may run; longer work is an agent session. */
export const NODE_TOOL_MAX_SECONDS = 900;
/** What one tool run may print in all; past this the computer stops sending and says so. */
export const NODE_TOOL_OUTPUT_BYTES = 1024 * 1024;
/** A file a node may write in one call. */
export const NODE_TOOL_WRITE_BYTES = 1024 * 1024;

/** An answer the owner gave in Needs me for a node's tools: once, for this mission, or always for the folder or address. */
export const NodeToolGrant = z.object({ id: text(100).min(1), scope: z.enum(["once", "mission", "always"]), target: text(4096).min(1) }).strict();
export type NodeToolGrant = z.infer<typeof NodeToolGrant>;

const NodeToolBase = z.object({
  id: text(100).min(1),
  nodeId: text(100).min(1),
  /** The mission (plan) or conversation the call is for: an answer for "This mission" covers it. */
  mission: text(200).min(1),
  /** Attended: the first use per folder or address asks the owner once. Unattended: allowed inside the sandbox. */
  attended: z.boolean(),
  /** Answers from Needs me this computer has not used yet; it applies the one for the call's folder or address. */
  grants: z.array(NodeToolGrant).max(20).default([]),
  /** The call's operation id: the ledger entry names it. */
  operationId: text(200).optional(),
});

const Folder = text(4096).min(1);

/** A node's browser or capture tool call (protocol 7). */
const CaptureCall = {
  /** The tool's name (`browser_open`, `capture_screenshot`, …) and its input, validated on the computer by the tool layer. */
  name: text(60).regex(/^(browser|capture)_[a-z_]+$/),
  input: z.record(z.string().max(100), z.unknown()).default({}),
  /** The node's tool operation on this computer (`node:<nodeId>:<mission>`): its tabs, apps and files. */
  operation: text(300).regex(/^node:[A-Za-z0-9-]{1,64}:[A-Za-z0-9:_-]{1,200}$/),
  /** Where the files it writes go (`ROUTES.evidenceUpload`). */
  uploadId: text(100).min(1),
  /** Whether it may use the internet (the node's run profile): without, only this computer's own addresses. */
  network: z.boolean().default(true),
};

/**
 * `node.tool.request` on the event stream: one tool call of a node, run and judged here (docs/25 §4.10).
 * The answer is a `CodeAnswer`: 200 with the result, 202 for a command still running (its output follows
 * on `ROUTES.toolOutput` and its end wakes the node), 428 when the owner must answer once in Needs me
 * (`body.ask`), 403 for the hard floor, 409 when it is switched off or cannot run here.
 */
export const NodeToolRequest = z.discriminatedUnion("tool", [
  NodeToolBase.extend({
    tool: z.literal("run"),
    folder: Folder,
    /** A subfolder to run in, inside the folder. */
    cwd: text(1000).optional(),
    command: text(4000).min(1),
    timeoutSec: z.number().int().min(1).max(NODE_TOOL_MAX_SECONDS).default(120),
    /** Answer at once and run in the background; its end wakes the node. */
    background: z.boolean().default(false),
    /** Saved secrets for this command's environment only, by name. */
    secrets: z.array(text(64)).max(20).default([]),
    /** Where its output goes when it does not fit the answer, or runs on. */
    runId: text(100).min(1),
    /** The git ceiling of the node's run profile, for git commands. */
    delivery: z.enum(["local", "commit", "push"]).default("local"),
    network: z.boolean().default(true),
  }),
  NodeToolBase.extend({
    tool: z.literal("git"),
    folder: Folder,
    op: z.enum(["status", "diff", "log", "show", "branch"]),
    args: z.array(text(500)).max(20).default([]),
  }),
  NodeToolBase.extend({
    tool: z.literal("http"),
    url: text(2000).min(1),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).default("GET"),
    body: z.string().max(NODE_TOOL_INLINE_BYTES).optional(),
    contentType: text(200).optional(),
  }),
  NodeToolBase.extend({
    tool: z.literal("files"),
    action: z.enum(["write", "move", "delete"]),
    folder: Folder,
    path: text(1000).min(1),
    /** move: the new path, inside the same folder. */
    to: text(1000).optional(),
    /** write: the file's whole new text. */
    content: z.string().max(NODE_TOOL_WRITE_BYTES).optional(),
  }),
  NodeToolBase.extend({ tool: z.literal("browser"), ...CaptureCall }),
  NodeToolBase.extend({ tool: z.literal("capture"), ...CaptureCall }),
]);
export type NodeToolRequest = z.infer<typeof NodeToolRequest>;

/** `capabilities.browser`: this computer answers a node's browser and capture tools (`node.tool.request`, protocol 7). */
export const BROWSER_API = 1;

/** What a node's browser or capture tool call answers: the tool's summary and result, and the files it kept as evidence. */
export const NodeCaptureAnswer = z.object({
  ok: z.boolean(),
  summary: z.string().max(200_000).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: text(40), message: text(2000) }).optional(),
  evidence: z
    .array(z.object({ id: z.string().uuid(), name: text(200), kind: text(20), held: z.boolean(), holdReason: text(300).nullish(), local: z.boolean(), variantOf: z.string().uuid().nullish() }))
    .max(40)
    .default([]),
  /** Files the computer did not keep (a saved secret's value in it, too large), with why. */
  refused: z.array(z.object({ name: text(200), reason: text(300) })).max(40).default([]),
});
export type NodeCaptureAnswer = z.infer<typeof NodeCaptureAnswer>;

/**
 * `evidence.request` on the event stream (protocol 7): the owner previews, releases or discards a file
 * this computer keeps (held, or upload off). Preview and release send the file to `ROUTES.evidenceUpload`
 * under `uploadId`; discard deletes it here. The answer is a `CodeAnswer`.
 */
export const EvidenceRequest = z.object({
  id: text(100).min(1),
  evidenceId: z.string().uuid(),
  action: z.enum(["preview", "release", "discard"]),
  uploadId: text(100).optional(),
});
export type EvidenceRequest = z.infer<typeof EvidenceRequest>;

/** One live view frame of a run's browser tab (`ROUTES.liveFrame`): a small JPEG, or why it paused. */
export const LiveFramePost = z.object({
  leaseToken: text(200).min(1),
  tab: text(20),
  url: text(4000).default(""),
  title: text(500).default(""),
  at: text(40),
  /** base64 JPEG, at most about 200 KB; absent while paused. */
  jpeg: z.string().max(300_000).optional(),
  width: z.number().int().min(0).max(10_000).optional(),
  height: z.number().int().min(0).max(10_000).optional(),
  paused: z.enum(["sensitive", "private_site", "secret_on_screen"]).optional(),
});
export type LiveFramePost = z.infer<typeof LiveFramePost>;

/** What a computer asks the owner before a node's first use of a folder or address (the answer's body on 428). */
export const NodeToolAsk = z.object({
  /** `browse`: a page opened in the browser, or captured (protocol 7). */
  capability: z.enum(["run", "git", "http", "files", "browse"]),
  /** What the answer covers: the folder's real path, or the address's origin. */
  target: text(4096).min(1),
  /** How the card names it: the folder's label or path, or the origin. */
  label: text(300).min(1),
  scope: z.enum(["folder", "origin"]),
  /** The sandbox here is weak: "Always" is not offered for commands, and asks once per mission instead. */
  weak: z.boolean().default(false),
});
export type NodeToolAsk = z.infer<typeof NodeToolAsk>;
