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
import { SealedShape } from "../credentials/seal.js";

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
  /** A file of the owner's Ensemble Files a node puts on this computer (files `save`, `capabilities.nodeFiles`), by its download id. */
  nodeFile: (downloadId: string) => `/api/devices/self/node-files/${encodeURIComponent(downloadId)}`,
  /** The latest small picture of a run's browser tab, for its live view (protocol 7). */
  liveFrame: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/live`,
  /** A run's agent needs the owner to sign in (protocol 8, B11): the server raises the card where the run is followed. */
  runLogin: (jobId: string) => `/api/devices/self/jobs/${encodeURIComponent(jobId)}/logins`,
  /** One encrypted frame of a tab the owner controls from the web (protocol 8, B21): the server keeps only the latest, for seconds. */
  takeoverFrame: (takeoverId: string) => `/api/devices/self/takeovers/${encodeURIComponent(takeoverId)}/frames`,
  /** The computer ended a takeover itself (its time ran out, the tab closed, nobody watched, the sign-in in it finished). */
  takeoverState: (takeoverId: string) => `/api/devices/self/takeovers/${encodeURIComponent(takeoverId)}/state`,
  /** A sign-in ended on this computer by itself (`logins: 2`): seen done, its tab closed, its time ran out (`LoginStatePost`). */
  loginState: (loginId: string) => `/api/devices/self/logins/${encodeURIComponent(loginId)}/state`,
  /** A node's terminal session or watched tab ended on this computer (`capabilities.live`, `LiveEndedPost`): its live card ends. */
  liveEnded: (liveId: string) => `/api/devices/self/live/${encodeURIComponent(liveId)}/ended`,
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
 * 8 (17 Nov 2026): a browser tool's answer may say its tab waits for the owner to sign in (`login`,
 * B11, `capabilities.logins`); the server sends the owner's answer as `login.resolve`; a run's agent
 * that needs a sign-in tells the server at `ROUTES.runLogin`, which raises the card where the run is
 * followed. The owner may control a tab from the web (B21, `capabilities.takeover`): the server sends
 * `takeover.start`, `takeover.input` and `takeover.end`; the computer sends encrypted frames to
 * `ROUTES.takeoverFrame` and says when it ended a takeover itself at `ROUTES.takeoverState`.
 * Sign-ins 2 and takeovers 2 (`capabilities.logins`, `capabilities.takeover`, same protocol): a sign-in
 * has a `purpose` (a human check too), is seen done by the computer itself (`ROUTES.loginState`), may ask
 * for a one-time code (`needs_code`, answered with `code`), and a sign-in's takeover runs in a clean
 * browser whose frames say which site they show.
 */
export const PROTOCOL = 8;
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

/**
 * `capabilities.nodeTools`: this computer answers `node.tool.request` (a node's own tool calls).
 * 1: run, git, files (write, move, delete), http, secret_http, browser and capture.
 * 2: also `terminal` (a command's screen as an image), `sudo` (one command as the administrator, with the
 * owner's password sealed for this computer), files `share` (a file as evidence), and calls without a
 * folder, which run in the node's own folder on this computer.
 */
export const NODE_TOOLS_API = 2;
/** The first `nodeTools` version with terminal screenshots, sudo, file sharing and the node's own folder. */
export const NODE_TOOLS_OWN_FOLDER = 2;
/** A `sudo` answer's `error` when sudo did not take the owner's password: the card waits for another try. */
export const SUDO_PASSWORD_REFUSED = "The password was not accepted.";
/** A `sudo` answer's `error` when the command needs a password and none came. */
export const SUDO_PASSWORD_NEEDED = "This command needs your owner's password.";
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
/**
 * `capabilities.nodeFiles`: 1: files `share` takes a folder (zipped here into one `.zip`) and any file up
 * to `NODE_FILE_MAX_BYTES`, and files `save` puts a file of the owner's Ensemble Files (a chat attachment)
 * into a folder, fetched from `ROUTES.nodeFile`.
 */
export const NODE_FILES_API = 1;
/** The largest file a node shares from this computer (a zipped folder too) or saves on it. */
export const NODE_FILE_MAX_BYTES = 100 * 1024 * 1024;

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
  /** nodeTools 2: the node's handle, which names its own folder on this computer (a call without a folder works there). */
  nodeSlug: text(64).regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  /** nodeTools 2: the owner chose, on the web, to be asked before a node opens a new website (public pages ask too). */
  askBeforeBrowsing: z.boolean().optional(),
});

const Folder = text(4096).min(1);
/** nodeTools 2: absent means the node's own folder on this computer (created on first use; never asks). */
const OptionalFolder = Folder.optional();

/** A node's browser or capture tool call (protocol 7). */
const CaptureCall = {
  /** The tool's name (`browser_open`, `capture_screenshot`, …) and its input, validated on the computer by the tool layer. */
  name: text(60).regex(/^(browser|capture)_[a-z_]+$/),
  input: z.record(z.string().max(100), z.unknown()).default({}),
  /** The node's tool operation on this computer (`node:<nodeId>:<scope>`): its tabs, apps and files. */
  operation: text(300).regex(/^node:[A-Za-z0-9-]{1,64}:[A-Za-z0-9:_-]{1,200}$/),
  /** Where the files it writes go (`ROUTES.evidenceUpload`). */
  uploadId: text(100).min(1),
  /** Whether it may use the internet (the node's run profile): without, only this computer's own addresses. */
  network: z.boolean().default(true),
};

/**
 * `capabilities.live`: this computer keeps a node's terminals open between calls (`node.tool.request`
 * with `tool: "live"`, device-tools/terminal-sessions.ts) and shows them, and a node's own browser tabs,
 * to the owner live through the takeover channel (`TakeoverStart.kind`, `view`; `takeover.control`).
 */
export const LIVE_API = 1;
/** A terminal session nobody typed in or watched for this long ends. */
export const LIVE_IDLE_MS = 30 * 60_000;
/** A terminal session ends this long after it started, whatever happens. */
export const LIVE_MAX_MS = 4 * 3600_000;
/** Terminal sessions one node keeps open on one computer. */
export const LIVE_MAX_PER_NODE = 3;
/** A terminal session's id on its computer. */
export const LiveSessionId = z.string().regex(/^ts[0-9a-f]{12}$/);
/** A live card's id: a terminal session's id, or `lv` and 16 hex digits for a watched tab. */
export const LiveId = z.string().regex(/^(?:ts[0-9a-f]{12}|lv[0-9a-f]{16})$/);

/**
 * A node's live terminal session (`capabilities.live`): `terminal_open` starts a shell in a pseudo-terminal
 * in the folder (judged and sandboxed like `run`), kept until `terminal_close`, its shell ending, 30
 * minutes without use or 4 hours; `terminal_send` types `text` then `keys` (named: Enter, Up, Ctrl+C) and
 * answers the screen after `waitMs` or when the shell's prompt is back, each line the node submits judged
 * by the hard floor first; `terminal_read` answers the screen (with `lines`: the last lines, scrollback
 * too). `browser_tab`: the node's tab `tab`, checked to be its own, watched for a live card (`liveId`):
 * its closing is posted to `ROUTES.liveEnded`. Answered with a `LiveAnswer`.
 */
const LiveCall = {
  tool: z.literal("live"),
  action: z.enum(["terminal_open", "terminal_send", "terminal_read", "terminal_close", "browser_tab"]),
  folder: OptionalFolder,
  session: LiveSessionId.optional(),
  title: text(200).optional(),
  text: z.string().max(8000).optional(),
  keys: z.array(text(40)).max(40).default([]),
  waitMs: z.number().int().min(0).max(60_000).optional(),
  lines: z.number().int().min(1).max(500).optional(),
  columns: z.number().int().min(20).max(300).default(120),
  rows: z.number().int().min(5).max(100).default(32),
  tab: text(20).regex(/^t\d{1,9}$/).optional(),
  liveId: LiveId.optional(),
  /** The node's tool operation (`node:<nodeId>:own`): its sessions and tabs. */
  operation: CaptureCall.operation,
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
    folder: OptionalFolder,
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
    folder: OptionalFolder,
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
    /**
     * share (nodeTools 2): the file becomes evidence the node can show its owner (answered as a `NodeCaptureAnswer`);
     * with nodeFiles 1 a folder too, zipped. save (nodeFiles 1): a file of the owner's Files written at `path`.
     */
    action: z.enum(["write", "move", "delete", "share", "save"]),
    folder: OptionalFolder,
    path: text(1000).min(1),
    /** move: the new path, inside the same folder. */
    to: text(1000).optional(),
    /** write: the file's whole new text. */
    content: z.string().max(NODE_TOOL_WRITE_BYTES).optional(),
    /** share: the node's tool operation (its evidence folder) and where the file goes (`ROUTES.evidenceUpload`). */
    operation: CaptureCall.operation.optional(),
    uploadId: text(100).min(1).optional(),
    /** share: one line for the owner, what the file is. */
    caption: text(300).optional(),
    /** save: where its bytes come from (`ROUTES.nodeFile`), how many there are and their SHA-256. */
    downloadId: text(100).min(1).optional(),
    size: z.number().int().min(0).max(NODE_FILE_MAX_BYTES).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** save: replace a file already at `path` (never a link or a file with a second name). */
    overwrite: z.boolean().optional(),
  }),
  /**
   * nodeTools 2: a command in a pseudo-terminal of `columns` × `rows`; after `seconds` (or when it ends,
   * if sooner) its screen is captured as a PNG in the operation's evidence folder, with secrets hidden.
   * Works for full-screen programs (htop, top, vim) and plain output alike. Judged and sandboxed like `run`
   * (it may see this computer's processes); answered as a `NodeCaptureAnswer` whose result is
   * `{ screen: string, exitCode: number | null, ended: boolean }`.
   */
  NodeToolBase.extend({
    tool: z.literal("terminal"),
    folder: OptionalFolder,
    command: text(4000).min(1),
    seconds: z.number().min(0.5).max(60).default(3),
    columns: z.number().int().min(40).max(300).default(120),
    rows: z.number().int().min(10).max(100).default(32),
    /** Keys to type once it started, in order: text, or a key name in braces ({Enter}, {Escape}, {F10}, {Down}). */
    keys: z.array(text(200)).max(20).default([]),
    title: text(200).optional(),
    operation: CaptureCall.operation,
    uploadId: text(100).min(1),
    network: z.boolean().default(true),
  }),
  /**
   * nodeTools 2: one command as the administrator (`sudo`), which the owner approved on a card in the chat.
   * Never in the sandbox. The hard floor's dangerous commands (device-tools/dangerous.ts) are refused here
   * whatever the owner answered. The password, when the owner gave one, is sealed in their browser for
   * this computer (purpose "sudo", decisionId `cardId`, name `commandHash`): only this computer opens it,
   * only for this exact command, once. Answered like `run` (200 with the output, or 202 running on).
   */
  NodeToolBase.extend({
    tool: z.literal("sudo"),
    /** Where it runs (its working folder); absent: the node's own folder. */
    folder: OptionalFolder,
    command: text(4000).min(1),
    /** sha256 (hex) of `command`: the sealed password is bound to it. */
    commandHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** The approval card's id: the sealed box is bound to it. */
    cardId: text(100).min(1),
    /** The owner's password, sealed for this computer. Absent: sudo without a password (`sudo -n`). */
    sealed: SealedShape.optional(),
    timeoutSec: z.number().int().min(1).max(1800).default(600),
    /** Where its output goes when it does not fit the answer, or runs on. */
    runId: text(100).min(1),
  }),
  /** A request with a saved secret put in where {{ref}} appears (B12, `capabilities.secretHttp`; credentials/secret-http.ts). */
  NodeToolBase.extend({
    tool: z.literal("secret_http"),
    ref: text(80).min(2),
    url: text(2000).min(1),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    headers: z.record(text(100), text(8000)).optional(),
    body: z.string().max(NODE_TOOL_INLINE_BYTES).optional(),
  }),
  NodeToolBase.extend({ tool: z.literal("browser"), ...CaptureCall }),
  NodeToolBase.extend({ tool: z.literal("capture"), ...CaptureCall }),
  NodeToolBase.extend(LiveCall),
]);
export type NodeToolRequest = z.infer<typeof NodeToolRequest>;

/**
 * `capabilities.browser`: this computer answers a node's browser and capture tools (`node.tool.request`,
 * protocol 7). 2: the web tools too (`WEB_TOOLS`), focused screenshots, interactive snapshots and page hygiene.
 */
export const BROWSER_API = 2;

/** The browser tools a computer has from `capabilities.browser` 2 on. */
export const WEB_TOOLS: readonly string[] = ["browser_view", "browser_fetch", "browser_extract", "browser_set_location", "browser_shop"];

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
  /** The tab now waits for the owner to sign in (protocol 8, B11): the server raises the card. */
  login: z.lazy(() => LoginRequired).optional(),
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
  paused: z.enum(["sensitive", "controlled", "private_site", "secret_on_screen"]).optional(),
});
export type LiveFramePost = z.infer<typeof LiveFramePost>;

/**
 * `capabilities.logins`: this computer hands sign-ins to its owner (B11, protocol 8): `login.resolve`, `ROUTES.runLogin`, saved logins.
 * 2: a sign-in's `purpose` (`sign_in` or `human_check`); `login.resolve` actions `code` and `check`; statuses
 * `needs_code` and `passed`; the computer sees a sign-in done by itself and says so at `ROUTES.loginState`;
 * "Use the window on this computer" opens a clean browser there.
 */
export const LOGINS_API = 2;
/** `capabilities.logins` from which a computer takes `code` and `check` answers and may answer `needs_code` or `passed` (sign-in v2). */
export const LOGIN_CHECKS_API = 2;

const LoginId = z.string().regex(/^lg_[0-9a-f]{32}$/);

/** What a waiting tab needs from its owner: their account, or a person to pass a human check (a captcha, "Robot or human?"). */
export const LoginPurpose = z.enum(["sign_in", "human_check"]);
export type LoginPurpose = z.infer<typeof LoginPurpose>;

/**
 * A tab waiting for its owner to sign in (B11), as a browser tool's answer carries it (`login`) and a
 * run reports it (`ROUTES.runLogin`): which site and tab, why, and how the owner can answer. Never a
 * value; `saved` says only whether a login is saved here for this one site. `purpose`: a sign-in, or a
 * human check (a captcha, "Robot or human?") the owner passes.
 */
export const LoginRequired = z.object({
  loginId: LoginId,
  origin: text(300).min(1),
  tab: text(20),
  profile: text(60).nullable(),
  /** `human_check`: a person must pass a check on the page; typed and saved logins are refused for it (logins 2). */
  purpose: LoginPurpose.default("sign_in"),
  reasons: z.array(text(200)).max(6).default([]),
  saved: z.boolean(),
  display: z.boolean(),
  takeover: z.boolean().default(false),
  expiresAt: text(40),
});
export type LoginRequired = z.infer<typeof LoginRequired>;

/** What a run's computer posts when its agent waits for a sign-in (`ROUTES.runLogin`). The answer: `{decisionId}` of the card, or null when the web raises none. */
export const RunLoginPost = LoginRequired.extend({ leaseToken: text(200).min(1) });
export type RunLoginPost = z.infer<typeof RunLoginPost>;

/**
 * `login.resolve` on the event stream (protocol 8): the owner's answer to a sign-in card. `saved`: fill
 * the login saved here; `local`: open the page in a window on this computer's screen; `done` and `check`
 * (logins 2: asked from the chat): check they signed in; `typed`: fill what they typed, sealed in their
 * browser for this computer (purpose `login`, the card as `decisionId`, the sign-in's id as `name`,
 * `{origin, username?, password?, code?, save?}` inside); `code` (logins 2): the one-time code the site
 * asks for after `needs_code`, sealed the same way (`{origin, code}`); `decline` (not now) and `expire`
 * end it. `v`: the server's sign-in version; 2 reads `needs_code` and `passed` (an older server hears
 * `failed` and `signed_in` instead). The answer is a `CodeAnswer` whose body is a `LoginResolution`.
 */
export const LoginResolve = z.object({
  id: text(100).min(1),
  loginId: LoginId,
  decisionId: text(100).min(1),
  action: z.enum(["saved", "local", "typed", "code", "done", "check", "decline", "expire"]),
  sealed: SealedShape.optional(),
  v: z.number().int().min(1).max(100).optional(),
});
export type LoginResolve = z.infer<typeof LoginResolve>;

export const LoginResolution = z.object({
  /**
   * `signed_in`; `passed` (a human check); `needs_code` (the site asks for a one-time code: `message` says
   * which, the card asks for it); `waiting` (not yet, `message` says why); `shown` (open in a window on the
   * computer); the rest end it or say why not.
   */
  status: z.enum(["signed_in", "passed", "needs_code", "waiting", "failed", "shown", "no_window", "declined", "expired", "gone", "busy"]),
  message: text(500).optional(),
  /** The typed login was saved on this computer, as the owner asked. */
  savedNow: z.boolean().optional(),
  code: text(40).optional(),
});
export type LoginResolution = z.infer<typeof LoginResolution>;

/**
 * What a computer posts at `ROUTES.loginState` (logins 2) when a sign-in changed on its own, not as the
 * answer to a `login.resolve`: seen done (`signed_in`, `passed`), its tab or work gone (`ended`), its time
 * run out (`expired`), or a problem the card should show while it still waits (`waiting` with `message`).
 * `via`: `computer` (seen in the node's tab), `window` (the window on this computer), `takeover` (the
 * owner's remote view), `check` (the node's own `browser_login_check`). A server without the route
 * answers 404, which the computer ignores.
 */
export const LoginStatePost = z.object({
  status: z.enum(["signed_in", "passed", "waiting", "declined", "expired", "ended"]),
  message: text(500).optional(),
  via: z.enum(["computer", "window", "takeover", "check"]).optional(),
});
export type LoginStatePost = z.infer<typeof LoginStatePost>;

/**
 * `capabilities.takeover`: the owner can control a tab of this computer's browser from the web, end to end (B21, protocol 8).
 * 2: a sign-in's takeover runs in a clean browser (C0, `browser/clean.ts`) at the tab's page and moves the
 * session into the tab when done; its frames' headers say which site they show (`site`, `title`, `popup`,
 * `mode`); the computer ends it itself when the sign-in is done (reason `signed_in` or `passed`).
 * 3: kinds and views: a live view of a node's own tab or terminal session (`TakeoverStart.kind`,
 * `operation`, `view`), switched between watching and control with `takeover.control`.
 */
export const TAKEOVER_API = 3;
/** The oldest takeover a server can use. */
export const TAKEOVER_MIN_API = 1;
/** `capabilities.takeover` from which a sign-in's takeover can run in a clean browser (`TakeoverStart.mode` "clean", browser/clean.ts). */
export const TAKEOVER_CLEAN_API = 2;

/** One message of a takeover's channel as the relay carries it: a sequence number, an IV and ciphertext, base64url (takeover/channel.ts). */
export const ChannelMessage = z.object({
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ct: z.string().regex(/^[A-Za-z0-9_-]+$/).min(22).max(700_000),
});
export type ChannelMessage = z.infer<typeof ChannelMessage>;

/**
 * `takeover.start` on the event stream: the owner opens a tab of this computer from the web. `sealed`
 * holds the channel's secret, sealed in their browser for this computer (purpose `takeover`, the
 * takeover's id as `decisionId`, the tab as `name`). The tab is a sign-in's (`loginId`) or a run's
 * (`jobId`, the hosted job). The answer is a `CodeAnswer`: `{started, width, height, endsAt}`, and with
 * takeover 2 `mode` (`clean`: a sign-in in the clean browser; `tab`: the tab itself) and `note` (why a
 * sign-in fell back to the tab). Each frame is `packMessage({t: "frame", w, h, url, site, title, popup,
 * mode}, jpeg)`: `url` without its query, `site` its host, `popup` a window the page opened (a "Sign in
 * with Google" popup), all inside the encrypted message.
 * The server may ask for `mode` "clean" (a sign-in, on a computer with `TAKEOVER_CLEAN_API`) or "tab".
 * A live view (`capabilities.live`) names `kind` ("browser": the node's own tab; "terminal": its
 * terminal session, whose id is `tab`), the node's `operation` that must own it, and `view` ("watch":
 * the owner sees it while the node works, browser input ignored until `takeover.control` turns control
 * on; "control"). A terminal's frames are `packMessage(TerminalFrameHeader, utf8 JSON TerminalScreen)`,
 * and its input `TerminalInputEvent`s.
 */
export const TakeoverStart = z.object({
  id: text(100).min(1),
  takeoverId: z.string().uuid(),
  tab: text(20).regex(/^(?:t\d{1,9}|ts[0-9a-f]{12})$/),
  loginId: z.string().regex(/^lg_[0-9a-f]{32}$/).optional(),
  jobId: z.string().uuid().optional(),
  sealed: SealedShape,
  endsAt: text(40),
  mode: z.enum(["tab", "clean"]).optional(),
  kind: z.enum(["browser", "terminal"]).optional(),
  operation: CaptureCall.operation.optional(),
  view: z.enum(["watch", "control"]).optional(),
});
export type TakeoverStart = z.infer<typeof TakeoverStart>;

/** `takeover.input`: input from the owner's browser, encrypted for this computer; relayed as it came, without an answer. */
export const TakeoverInput = ChannelMessage.extend({ takeoverId: z.string().uuid() });
export type TakeoverInput = z.infer<typeof TakeoverInput>;

/** `takeover.end`: the owner pressed I'm done (`done`: check the sign-in and give the tab back) or Stop, or the server ended it. */
export const TakeoverEnd = z.object({ id: text(100).optional(), takeoverId: z.string().uuid(), done: z.boolean().default(false), reason: text(40).optional() });
export type TakeoverEnd = z.infer<typeof TakeoverEnd>;

/**
 * `takeover.control` (takeover 3): the owner of a live view takes control (`on`) or hands it back. A
 * tab under control is paused for the node, as in a sign-in's takeover; a terminal under control refuses
 * the node's typing. The answer is a `CodeAnswer` whose body is `{view: "watch" | "control"}`.
 */
export const TakeoverControl = z.object({ id: text(100).min(1), takeoverId: z.string().uuid(), on: z.boolean() });
export type TakeoverControl = z.infer<typeof TakeoverControl>;

/** One run of terminal cells that look the same: its text, colours as `#rrggbb` (absent: the default), bold, italic, underline, dim. */
export type TerminalRun = { t: string; fg?: string; bg?: string; b?: 1; i?: 1; u?: 1; dim?: 1 };
/** A terminal frame's payload, as UTF-8 JSON: each row of the screen as runs (secrets hidden, drawn plain). */
export type TerminalScreen = { rows: TerminalRun[][] };
/** A terminal frame's header: its size, where the cursor is (0-based) and its title. */
export type TerminalFrameHeader = { t: "frame"; kind: "terminal"; cols: number; rows: number; cursor: { x: number; y: number }; title: string };

/** The owner's input to a live terminal: characters as typed, a named key (Enter, Up, Ctrl+C, F5), the size it is shown at, or a ping. */
export const TerminalInputEvent = z.discriminatedUnion("t", [
  z.object({ t: z.literal("tty"), text: z.string().min(1).max(4000) }),
  z.object({ t: z.literal("tty-key"), key: z.string().min(1).max(24) }),
  z.object({ t: z.literal("tty-size"), cols: z.number().int().min(20).max(300), rows: z.number().int().min(5).max(100) }),
  z.object({ t: z.literal("ping") }),
]);
export type TerminalInputEvent = z.infer<typeof TerminalInputEvent>;

/** What a `live` tool call answers: the terminal session and its screen as text (secrets hidden), or the tab checked for a live card. */
export const LiveAnswer = z.object({
  session: LiveSessionId.optional(),
  title: text(300).optional(),
  folder: text(300).optional(),
  screen: z.string().max(200_000).optional(),
  cursor: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
  columns: z.number().int().optional(),
  rows: z.number().int().optional(),
  /** The shell waits at its prompt (nothing runs in the foreground). */
  atPrompt: z.boolean().optional(),
  /** A secret was on the screen and is hidden in `screen`. */
  hidden: z.boolean().optional(),
  ended: z.boolean().optional(),
  exitCode: z.number().int().nullable().optional(),
  /** The owner controls the terminal from the web: the node's typing waits. */
  controlled: z.boolean().optional(),
  tab: text(20).optional(),
  url: text(4000).optional(),
});
export type LiveAnswer = z.infer<typeof LiveAnswer>;

/** What a computer posts at `ROUTES.liveEnded` when a terminal session or a watched tab ends: `closed`, `exited`, `idle`, `max`, `tab_closed`, `stopped`. */
export const LiveEndedPost = z.object({ reason: text(40), exitCode: z.number().int().nullable().optional() });
export type LiveEndedPost = z.infer<typeof LiveEndedPost>;

/**
 * What a computer posts when it ends a takeover itself. `reason`: `expired`, `idle`, `tab_closed`, `stopped`,
 * `relay_gone`; with takeover 2 also `signed_in` and `passed` (the sign-in in it was seen done and its session
 * moved into the tab), `not_carried` (signed in, but the site did not take the session in the tab) and
 * `closed` (the clean browser closed).
 */
export const TakeoverStatePost = z.object({ state: z.literal("ended"), reason: text(200) });

/** What a computer asks the owner before a node's first use of a folder or address (the answer's body on 428). */
export const NodeToolAsk = z.object({
  /** `browse`: a page opened in the browser, or captured (protocol 7). `read`: a file shared into the chat (nodeTools 2). */
  capability: z.enum(["run", "git", "http", "files", "browse", "read"]),
  /** What the answer covers: the folder's real path, or the address's origin. */
  target: text(4096).min(1),
  /** How the card names it: the folder's label or path, or the origin. */
  label: text(300).min(1),
  scope: z.enum(["folder", "origin"]),
  /** The sandbox here is weak: "Always" is not offered for commands, and asks once per mission instead. */
  weak: z.boolean().default(false),
});
export type NodeToolAsk = z.infer<typeof NodeToolAsk>;
