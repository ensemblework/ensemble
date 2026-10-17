import type { IdeTheme, ThemeDirectoryExtension } from "@ensemble/ide-theme";
import { emptyWorkspace, type IncludedUsage, type ModelMeta, type PageDocument, type Settings, type SubscriptionAgent, type SubscriptionProvider, type TaskPageContent } from "@ensemble/shared-types";
import type { LayoutDocument } from "@ensemble/shared-types/widgets";

import { bindClient, currentExternalSignal, isRequestCancelled, RequestCancelledError, trackRequest, isPageUnloading } from "./fetch-cancel";
import { resolveHubApi } from "./hub-origin";
import type { ApplyFailure } from "./assistant-apply";
import type { CollabBatch, CollabJoin, CollabSend } from "@/components/editor/collab";
import { MODULE_DENIED } from "@ensemble/shared-types/modules";

/** Direct hub-api origin. SSE uses this so the stream is not buffered by the Next rewrite. */
export const HUB_API = resolveHubApi({
  NEXT_PUBLIC_HUB_API: process.env.NEXT_PUBLIC_HUB_API,
  NODE_ENV: process.env.NODE_ENV,
});
/**
 * Browser calls are same-origin (`/api/...`). next.config rewrites them to hub-api,
 * which drops the CORS preflight on mutations. The server (there is almost no SSR
 * fetching) still talks to hub-api directly.
 */
export const API = typeof window === "undefined" ? HUB_API : "";

/** Shown instead of the API's bare refusal for a feature the space's template leaves out. */
export const MODULE_OFF_MESSAGE = "That feature is off in this space. Turn it on in Settings → Account → Features.";

export class ApiError extends Error {
  /** The request reached a feature that is off in this space (the API's 404 `MODULE_DENIED`). */
  readonly moduleOff: boolean;

  constructor(
    message: string,
    public readonly status: number,
    /** The API's machine-readable reason, when it gave one (`HOST_ACCESS_DENIED`, `EMAIL_UNVERIFIED`…). */
    public readonly code: string | null = null,
    /** The refusal's JSON body, for answers that carry more than a message (a live page's missed steps). */
    public readonly data: unknown = null,
  ) {
    const off = status === 404 && message === MODULE_DENIED;
    super(off ? MODULE_OFF_MESSAGE : message);
    this.moduleOff = off;
  }
}

/** True when the API refused because the route needs this server's own folders (Ensemble on the web, not the operator). */
export const hostOnly = (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === "HOST_ACCESS_DENIED";

function errorCode(text: string): string | null {
  try {
    const body = JSON.parse(text) as { code?: unknown };
    return typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

function errorBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const OFFLINE = "Ensemble can't reach its server right now.";

/** The request never got an answer from hub-api (no network, or the proxy could not connect). A 500 is not this. */
export function isUnreachable(error: unknown): boolean {
  return error instanceof ApiError && error.message === OFFLINE;
}

/** A JSON error body the server meant the person to read. */
function serverErrorMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const body = JSON.parse(trimmed) as { error?: unknown; message?: unknown; detail?: unknown };
    for (const candidate of [body.error, body.message, body.detail]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The rewrite proxy answers `500 Internal Server Error` when hub-api refuses
 * the connection. That is offline, same as a thrown fetch or a bare 502–504.
 */
function unreachable(status: number, text: string): boolean {
  if (status === 502 || status === 503 || status === 504) return true;
  const trimmed = text.trim();
  return trimmed === "Internal Server Error" || /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(trimmed);
}

/**
 * While a single shared item is open (/shared/[id]), every request names that share. The
 * server then answers as if you were in the owner's space, limited to that item.
 */
let openShare: string | null = null;
export const SHARE_HEADER = "x-ensemble-share";
/** A public link (/p/[token]): every request names it, with this tab's visitor id. */
let openLink: string | null = null;
export const LINK_HEADER = "x-ensemble-link";
export const VISITOR_HEADER = "x-ensemble-visitor";
export function setOpenLink(token: string | null): void {
  openLink = token;
}
export function currentLink(): string | null {
  return openLink;
}
/** On one shared item or a public link: nothing else of the owner's space is reachable. */
export function inItemView(): boolean {
  return Boolean(openShare || openLink);
}
/** Like withShare, for a public link. */
export function withLink<T>(token: string | null, fn: () => T): T {
  const before = openLink;
  openLink = token;
  try {
    return fn();
  } finally {
    openLink = before;
  }
}
let visitor: string | null = null;
/** A random id this browser keeps, so a visitor keeps the same creature name across reloads. */
function visitorId(): string {
  if (visitor) return visitor;
  try {
    visitor = localStorage.getItem("ensemble.visitor");
    if (!visitor || !/^[A-Za-z0-9-]{8,64}$/.test(visitor)) {
      visitor = crypto.randomUUID();
      localStorage.setItem("ensemble.visitor", visitor);
    }
  } catch {
    visitor = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  return visitor;
}
/** Dispatched on `window` when the open share or public link turns out to be gone (a save or a ticket refused). */
export const SHARE_GONE_EVENT = "ensemble:share-gone";
/** Dispatched on `window` just before a refused session sends the tab to sign in, so open pages can keep unsent typing. */
export const SIGNED_OUT_EVENT = "ensemble:signed-out";
export function setOpenShare(id: string | null): void {
  openShare = id;
}
export function currentShare(): string | null {
  return openShare;
}

/** The share or public-link headers for requests made outside `request`, such as raw byte downloads. */
export function itemViewHeaders(): Record<string, string> {
  return {
    ...(openShare ? { [SHARE_HEADER]: openShare } : {}),
    ...(openLink ? { [LINK_HEADER]: openLink, [VISITOR_HEADER]: visitorId() } : {}),
  };
}

/**
 * Runs `fn` with the share header fixed to `share`. Requests read the header synchronously,
 * so a save made while a page unmounts goes where the page was opened, whichever page is
 * mounting at the same moment.
 */
export function withShare<T>(share: string | null, fn: () => T): T {
  const before = openShare;
  openShare = share;
  try {
    return fn();
  } finally {
    openShare = before;
  }
}

export async function request<T>(path: string, init?: RequestInit & { json?: unknown; surviveNavigation?: boolean }): Promise<T> {
  const { json, signal: explicit, surviveNavigation, ...rest } = init ?? {};
  const external = explicit ?? currentExternalSignal();
  const tracked = trackRequest(external, path, surviveNavigation);
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...rest,
      signal: tracked.signal,
      body: json === undefined ? rest.body : JSON.stringify(json),
      headers: {
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(openShare ? { [SHARE_HEADER]: openShare } : {}),
        ...(openLink ? { [LINK_HEADER]: openLink, [VISITOR_HEADER]: visitorId() } : {}),
        ...(rest.headers ?? {}),
      },
      credentials: "include",
      cache: "no-store",
    });
  } catch (error) {
    if (isRequestCancelled(error, { signal: tracked.signal, unloading: isPageUnloading() })) {
      throw new RequestCancelledError();
    }
    throw new ApiError(OFFLINE, 0);
  } finally {
    tracked.close();
  }
  // On a public link there is no account to sign in to: a 401 means the link stopped working.
  if (response.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth/") && !openLink) {
    const here = window.location.pathname;
    if (!["/login", "/signup"].includes(here)) {
      window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT));
      window.location.href = `/login?next=${encodeURIComponent(here + window.location.search)}`;
    }
  }
  if (!response.ok) {
    const text = await response.text();
    const message = serverErrorMessage(text);
    if (message) throw new ApiError(message, response.status, errorCode(text), errorBody(text));
    if (unreachable(response.status, text)) throw new ApiError(OFFLINE, response.status);
    throw new ApiError(text.trim() || response.statusText, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const get = <T>(path: string) => request<T>(path);
export const post = <T>(path: string, json?: unknown) => request<T>(path, { method: "POST", json: json ?? {} });
export const patch = <T>(path: string, json: unknown) => request<T>(path, { method: "PATCH", json });
export const put = <T>(path: string, json: unknown) => request<T>(path, { method: "PUT", json });
export const del = <T>(path: string, json?: unknown) => request<T>(path, json === undefined ? { method: "DELETE" } : { method: "DELETE", json });

const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

// ── records ─────────────────────────────────────────────────────────────────

export type Priority = "critical" | "p0" | "p1" | "p2";
export type TaskStatus = "proposed" | "todo" | "in_progress" | "waiting_approval" | "blocked" | "done" | "dropped";
export type Owner = "me" | "agent" | "unassigned";
export type Complexity = "easy" | "medium" | "high" | "max";

export type TaskRecord = {
  id: string;
  title: string;
  description: string;
  notes: string;
  owner: Owner;
  status: TaskStatus;
  priority: Priority;
  complexity: Complexity;
  due: string | null;
  boardOrder: number;
  todayFocus: "auto" | "keep" | "hidden";
  sourceKind: string;
  sourceRef: string;
  sourceUrl: string | null;
  excerpt: string | null;
  projectId: string | null;
  repoId: string | null;
  deliverableId: string | null;
  people: string[];
  /** In a shared space: which person a "me" task is with. Null: the space's owner. */
  assigneeAccountId?: string | null;
  /** Free-form tags; imports bring labels, tags and multi-selects here. */
  labels?: string[];
  /** Set on action items a meeting-notes connector proposed. */
  meetingNoteId?: string | null;
  skillIds: string[];
  snoozedUntil: string | null;
  rationale: string | null;
  taskType: string | null;
  measure?: number | null;
  createdBy: "agent" | "me" | "system";
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The file a page was converted from. */
export type PageSourceFile = NonNullable<TaskPageContent["sourceFile"]>;

const collabPath = (kind: "page" | "task", id: string) => (kind === "page" ? `/api/pages/${id}/collab` : `/api/tasks/${id}/page/collab`);

export type PageRecord = {
  taskId: string;
  revision: number;
  content: PageDocument | null;
  notes: string;
  notesChangedExternally: boolean;
  updatedAt: string | null;
  sourceFile?: PageSourceFile | null;
};

export type StandalonePageSummary = {
  parentId?: string | null;
  id: string;
  title: string;
  updatedAt: string;
  createdAt?: string;
  /** Set on search results: the page's words around the match. */
  snippet?: string;
};

export type StandalonePageRecord = {
  parentId?: string | null;
  parentTaskId?: string | null;
  id: string;
  title: string;
  taskId: null;
  revision: number;
  content: PageDocument | null;
  notes: string;
  updatedAt: string | null;
  sourceFile?: PageSourceFile | null;
};

export type ApprovalRecord = {
  id: string;
  runId: string;
  taskId: string | null;
  kind: string;
  title: string;
  preview: unknown;
  requestedAt: string;
};

export type DeliverableRecord = {
  id: string;
  title: string;
  status: "upcoming" | "completed";
  due: string | null;
  projectId: string;
  project: { id: string; name: string };
};

export type ReminderRecord = { id: string; title: string; dueDate: string; dueTime: string | null };

export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  joinUrl: string | null;
  location: string | null;
};

export type PersonRecord = {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  team: string | null;
  lastInteraction: string | null;
  confidence: number;
  projects: Array<{ id: string; name: string }>;
  openTasks: number;
  recentTitle: string | null;
  recentAt: string | null;
  derived: boolean;
};

export type ProjectRecord = {
  id: string;
  name: string;
  summary: string;
  status: "active" | "done";
  aliases: string[];
  repos: Array<{ id: string; fullName: string }>;
  people: Array<{ id: string; name: string }>;
  deliverableCount: number;
  taskCount: number;
};

export type RepoRecord = {
  id: string;
  fullName: string;
  provider: string;
  url: string | null;
  description: string | null;
  defaultBranch: string | null;
  tracked: boolean;
  myRole: string;
  languages: string[];
  lastSyncedAt: string | null;
  projects: Array<{ id: string; name: string }>;
};

export type PreferenceRecord = { id: string; key: string; value: unknown; source: string; confidence: number; evidence: string[] };

export type BoardCard = {
  id: string;
  lane: "people" | "projects" | "repos" | "meetings" | "artifacts";
  kind: "people" | "project" | "repo" | "meeting" | "artifact";
  title: string;
  subtitle: string | null;
  meta: string | null;
  initials: string;
  chips: string[];
  projectIds: string[];
  personIds: string[];
  repoIds: string[];
  artifactKind: string | null;
  progress: { done: number; total: number } | null;
  members: string[];
  language: string | null;
  day: string | null;
  month: string | null;
  activity: Array<{ id: string; title: string; when: string }>;
  href?: string | null;
};

export type BoardPayload = {
  view: "board" | "grid" | "list" | "graph";
  group: "kind" | "project";
  groups: Record<string, string[]>;
  kinds?: Array<BoardCard["lane"]> | null;
  lanes: Array<{ id: BoardCard["lane"]; label: string; cards: BoardCard[] }>;
};

/** Which app an item came from. `app` is a BrandLogo key; null when only a label is known. */
export type ArtifactOrigin = { app: string | null; label: string };

export type ArtifactRecord = {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  ts: string;
  projectId: string | null;
  repoId: string | null;
  taskId: string | null;
  metadata: Record<string, unknown>;
  origin?: ArtifactOrigin | null;
};

export type Entity = { kind: string; id: string; label: string; detail: string; parentId?: string; parentLabel?: string; tileId?: string; isSpace?: boolean };

export type GraphNode = { id: string; kind: string; label: string; sub: string };
export type GraphEdge = { source: string; target: string; kind: string };

export type SkillRecord = {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: number;
  body: string;
  enabled: boolean;
  provenance: string;
  confidence: number;
  acceptanceRate: number | null;
  minedFrom: number;
  evidence: string[];
  versions: Array<{ id: string; version: number; note: string | null; createdAt: string; body: string }>;
};

export type RunSummary = {
  sourceRunId?: string | null;
  id: string;
  taskId: string;
  title: string;
  worker: string;
  outcome: string | null;
  error: string | null;
  /** The model that answered when the run reported it, else the one asked for. */
  model: string | null;
  credits: number | null;
  /** The harness's own cost estimate (agent runs). */
  costUsd?: number | null;
  /** Ensemble agent, Claude Code, Codex or Cursor, for agent runs. */
  engineName?: string | null;
  where?: RunJob["where"] | null;
  deviceName?: string | null;
  jobStatus?: AgentJob["status"] | null;
  toolCalls?: number | null;
  tokens?: number | null;
  startedAt: string;
  endedAt: string | null;
  stepCount: number;
};

/** One tool call inside a run step, as harnesses record them (older rows may carry args as an object). */
export type RunToolCall = {
  id?: string;
  name?: string;
  args?: unknown;
  output?: unknown;
  ok?: boolean;
  ms?: number;
  engine?: string;
  summary?: string;
};

export type RunStep = {
  id: string;
  index: number;
  title: string;
  status: string;
  output: string | null;
  error: string | null;
  reasoning?: string | null;
  reasoningSource?: string | null;
  model: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  credits: number | null;
  startedAt?: string | null;
  endedAt?: string | null;
  toolCalls: unknown;
};

export type RunDetail = {
  sourceRunId?: string | null;
  feedback?: Array<{ id: string; text: string; at: string; authorId: string; jobId: string | null }>;
  id: string;
  taskId?: string;
  worker?: string;
  outcome: string | null;
  result: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
  plannerModel: string | null;
  requestedModel?: string | null;
  assignmentInstructions?: string | null;
  task: { id: string; title: string };
  steps: RunStep[];
  approvals?: Array<{ id: string; title: string; kind: string; decision: string | null; requestedAt: string; decidedAt: string | null; stepIndex: number | null }>;
};

/** The agent job behind a run: harness, models, where it ran, its limits and what it cost. */
export type RunJob = {
  id: string;
  kind: "research" | "code";
  status: AgentJob["status"];
  engine: "ensemble" | "claude-code" | "codex" | "cursor-agent";
  engineName: string;
  provider: string | null;
  model: string;
  modelUsed: string | null;
  reasoningEffort: string | null;
  where: "device" | "server" | "local";
  deviceName: string | null;
  runnerAccountId: string | null;
  sandbox: boolean;
  networkAccess: boolean;
  delivery: AgentJob["delivery"];
  accessMode: string;
  unattended: boolean;
  folder: string | null;
  repoUrl: string | null;
  branch: string | null;
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  limits: { turns: number; toolCalls: number; minutes: number };
  costUsd: number | null;
  files: Array<{ path: string; added: number; removed: number }>;
  results: Array<{ kind: "pr" | "commit" | "branch"; url: string; sha?: string }>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type AgentJob = {
  id: string;
  taskId: string;
  title: string;
  priority: Priority;
  kind: "research" | "code";
  status: "queued" | "claimed" | "running" | "stopping" | "waiting_approval" | "blocked" | "succeeded" | "failed" | "cancelled" | "interrupted";
  position: number | null;
  executionMode: "sandbox" | "native";
  delivery: "local" | "commit" | "push";
  useCredentials: boolean;
  askBeforePublish: boolean;
  unattended?: boolean;
  accessMode?: "review" | "read-write" | "auto";
  markDone?: boolean;
  instructions?: string;
  branchMode?: "as-is" | "existing" | "new";
  reasoningEffort?: string | null;
  networkAccess?: boolean;
  maxTurns?: number;
  folder: string;
  repoUrl: string | null;
  branch: string;
  provider: string | null;
  model: string;
  progress: string | null;
  summary: string | null;
  error: string | null;
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  maxToolCalls: number;
  maxMinutes: number;
  continueFromJobId: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
  /** In a shared space: whose computer runs it (null: the space's owner). */
  runnerAccountId?: string | null;
  /** True when it runs on your own computer (only then is the computer named). */
  yours?: boolean;
  deviceOnline?: boolean | null;
  deviceRevoked?: boolean;
  folderLabel?: string | null;
  results?: Array<{ kind: "pr" | "commit" | "branch"; url: string; sha?: string }>;
  cancelRequestedAt?: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  reviewId?: string | null;
  /** The run's review on the paired computer that ran it: the Code tab opens it through that computer (protocol 4). */
  deviceReviewId?: string | null;
  /** The run this job recorded (its trace on the Runs page). */
  runId?: string | null;
  /** When it finished: the model that answered, the harness's cost estimate, files changed (names and line counts). */
  modelUsed?: string | null;
  costUsd?: number | null;
  files?: Array<{ path: string; added: number; removed: number }>;
  /** Set when the job was claimed from Ensemble on the web. */
  origin?: "local" | "web";
};

/** A file a job's run changed (`GET /api/agent/jobs/:id/files`); `stored`: its text was sent when the run ended. */
export type JobFileEntry = {
  path: string;
  status: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  binary: boolean;
  stored: boolean;
  truncated: boolean;
  skipped: string | null;
};
export type JobFiles = {
  files: JobFileEntry[];
  /** Whether you may see the files' text (a device job's runner, with sharing on there). */
  text?: { available: boolean; reason: string | null };
  live: { available: boolean; reason: string | null };
  where: "device" | "server";
};
export type FolderEntry = { name: string; kind: "dir" | "file" | "link"; size: number | null };
export type FolderListing = { path: string; entries: FolderEntry[]; truncated: boolean; hidden: number };
export type FolderFile = { path: string; size: number; content: string | null; binary: boolean; truncated: boolean };

export type WorkspaceBoard = {
  /** This server's own workspace folder; null on Ensemble on the web, where the work runs on your computers. */
  root: string | null;
  maxConcurrent: number;
  paused: boolean;
  sandboxAvailable: boolean;
  serverRunner?: boolean;
  queued: AgentJob[];
  running: AgentJob[];
  waiting: AgentJob[];
  stopped: AgentJob[];
  completed: AgentJob[];
};

/** What the agent's commands run inside on this computer. */
export type SandboxCaps = {
  os: string;
  strength: "strong" | "reduced" | "advisory" | "ask";
  osSandbox: boolean;
  /** seatbelt (macOS), bubblewrap or landlock (Linux), windows (sandbox account), none. */
  mechanism: string;
  reason: string;
  /** What this computer's sandbox cannot enforce. */
  limits?: string[];
  networkOff?: boolean;
  /** Windows: one admin prompt turns it on. */
  setup?: { needed: boolean; how: string };
};

export type AgentCall = { id: string; kind: string; label: string; detail?: string; model?: string; startedAt: string };
export type AgentState = { paused: boolean; calls: AgentCall[]; running: AgentJob[]; waiting: AgentJob[]; queued: AgentJob[] };

export type RemoteMac = {
  apiBase: string | null;
  deviceName: string;
  deviceId: string | null;
  paired: boolean;
  enabled: boolean;
  runBranchPush: boolean;
  /** Approvals and run settings from the web and phone apply on this computer. */
  acceptWebApprovals: boolean;
  /** Ensemble on the web may show the files of tasks run here (on by default). */
  browseFiles?: boolean;
  /** The web's Code tab may change code here: accept/reject, edit, commit, push (on by default). */
  webEdit?: boolean;
  /** The terminal may open from the web, after a passkey unlock there (on by default). */
  webTerminal?: boolean;
  online: boolean;
  lastHeartbeatAt: number | null;
  disconnected: { at: string; reason: string } | null;
  unreachable: string | null;
  platform: string;
};

/** An agent's app or command line found on this computer. */
export type AgentPresence = { id: "claude" | "codex" | "cursor" | "vscode" | "copilot"; name: string; app: boolean; cli: string | null };
export type HandoffApp = "claude" | "codex" | "cursor" | "vscode" | "claude-cli" | "codex-cli" | "cursor-cli" | "copilot-cli";
/** Where a task can be opened on this computer: an app, or a command-line tool in a terminal. */
export type HandoffTarget = { id: HandoffApp; name: string; terminal: boolean };
export type HandoffInput = { taskId: string; app: HandoffApp; folder?: string; continueFromJobId?: string; instructions?: string };
/** A task Ensemble opened in an agent's own app; its prompts reach Needs me. */
export type HandoffRecord = {
  id: string;
  taskId: string;
  taskTitle: string;
  app: HandoffApp;
  appName: string;
  folder: string;
  status: "open" | "finished" | "closed";
  linked: boolean;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Folder trust shared with the person's other AI tools on this computer (desktop and CLI only). */
export type TrustSharing = { available: boolean; enabled: boolean; tools: Array<{ id: string; name: string; found: boolean; marked: number }> };

export type AssignInput = {
  taskId: string;
  kind: "research" | "code";
  /** Ensemble's own agent, or the person's own Claude Code on their computer. */
  engine?: "ensemble" | "claude-code" | "codex" | "cursor-agent";
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  instructions?: string;
  repoUrl?: string;
  folder?: string;
  continueFromJobId?: string;
  branchMode?: "as-is" | "existing" | "new";
  branch?: string;
  delivery?: "local" | "commit" | "push";
  askBeforePublish?: boolean;
  useCredentials?: boolean;
  sandbox?: boolean;
  network?: boolean;
  /** In a sandboxed run, outside the work folder. Default: Settings. */
  outsideAccess?: "none" | "read" | "read-write";
  markDone?: boolean;
  unattended?: boolean;
  /** Ask, Review only or Run unattended. Wins over `unattended`. */
  mode?: "ask" | "review" | "unattended";
  /** `review` is the read-only grant, for a folder shared read-only. */
  accessMode?: "review" | "read-write";
  trust?: "always" | "task" | "none";
  maxMinutes?: number;
  maxToolCalls?: number;
  maxTurns?: number;
  deviceId?: string;
  folderLabel?: string;
};

export type JobEvent = { id: string; kind: string; data: Record<string, unknown>; at: string };

export type TerminalStatus = {
  enabled: boolean;
  unlocked: boolean;
  expiresAt: string | null;
  passkeys: Array<{ id: string; label: string; createdAt: string; lastUsedAt: string | null }>;
  roots: string[];
  home: string;
};

/** The web terminal's lock on Ensemble on the web (`/api/web-terminal/status`). */
export type WebTerminalStatus = {
  unlocked: boolean;
  expiresAt: string | null;
  passkeys: Array<{ id: string; label: string; createdAt: string; lastUsedAt: string | null }>;
  /** The account has a password to confirm a new passkey with; otherwise a mailed code. */
  password: boolean;
  emailCode: boolean;
};

/** The versions of one file the Code tab's editor works from (`/api/code/versions`, docs/16 §1). LF text. */
export type CodeVersions = {
  path: string;
  kind: "review" | "repo";
  /** Before the run (for a checkout: the index). */
  start: string | null;
  /** As the run left it. */
  agent: string | null;
  /** What the file is compared against: before the run plus the changes accepted so far. */
  original: string | null;
  /** On disk now. */
  current: string | null;
  exists: { start: boolean; agent: boolean; current: boolean };
  binary: boolean;
  tooLarge: boolean;
  eol: "lf" | "crlf";
  bom: boolean;
  hash: string | null;
  /** From a paired computer: why it cannot be edited from the web. */
  readOnly?: string;
};
/** What a commit from the Code tab would hold, and what a pull request starts from (`/api/code/commit-plan`). */
export type CommitPlan = {
  branch: string;
  defaultBranch: string | null;
  github: { owner: string; repo: string } | null;
  /** Files this run changed: ticked. */
  run: string[];
  /** Your own changes (from before the run, or a checkout's): not ticked. */
  before: string[];
  model: string | null;
  template: string | null;
  proposal: string | null;
};
export type CodeProgress = { files: Array<{ path: string; total: number; pending: number; yours: number }>; total: number; pending: number; filesLeft: number };
export type CodeTreeEntry = { name: string; kind: "dir" | "file" | "link"; size: number | null; secret?: boolean };
export type CodeTree = { path: string; entries: CodeTreeEntry[]; truncated: boolean; hidden?: number };
export type CodeSearch = { results: Array<{ path: string; line: number; text: string }>; truncated: boolean };

/** A file as the Code tab opens it. From a paired computer: `readOnly` says why it cannot be edited from the web. */
export type CodeFile = { path: string; content: string; readOnly?: string; binary?: boolean; truncated?: boolean };

export type ReviewSummary = {
  id: string;
  title: string;
  taskId: string;
  repoPath: string;
  branch: string;
  delivery: string;
  model: string;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string;
  decisions: number;
  files: number;
  added: number;
  removed: number;
  reachable: boolean;
};

export type ChangedFile = { path: string; status: "A" | "M" | "D" | "R" | "U"; added: number; removed: number; binary: boolean };

export type CodeSource = {
  kind: "review" | "repo";
  review?: { id: string; completedAt: string | null; outside: boolean; runBranch: boolean; canPush: boolean } | null;
  repo: string;
  branch: string;
  title: string;
  taskId: string | null;
  model: string | null;
  createdAt: string | null;
  files: ChangedFile[];
  unreviewable: ChangedFile[];
  planted?: Array<{ path: string; kind: string; reason: string }>;
  decisions: Array<{ path: string; chunkKey: string; decision: string }>;
};

export type DiffLine = { type: "context" | "add" | "del"; text: string; oldNo: number | null; newNo: number | null };
export type Hunk = { key: string; header: string; added: number; removed: number; lines: DiffLine[] };
export type FileDiff = { path: string; hunks: Hunk[]; isNew: boolean; binary: boolean };

export type ScmStatus = {
  repo: string;
  name: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: Array<{ path: string; index: string; worktree: string }>;
  unstaged: Array<{ path: string; index: string; worktree: string }>;
  untracked: Array<{ path: string; index: string; worktree: string }>;
  log: Array<{ sha: string; author: string; when: string; subject: string }>;
  remote: string;
  github: string | null;
  /** origin's default branch; pushing straight to it asks first. */
  defaultBranch?: string | null;
};

export type ActionsResult =
  | { available: false; reason: string }
  | {
      available: true;
      runs: Array<{
        id: number;
        workflow: string;
        title: string;
        status: string;
        conclusion: string | null;
        branch: string;
        url: string;
        createdAt: string;
        event: string;
      }>;
    };

export type Connection = {
  id: string;
  label: string;
  group: string;
  description: string;
  setupHint: string;
  provider: "google" | "github" | "slack" | "linear" | "microsoft" | null;
  connect: "oauth" | "token" | "oauth_or_token" | "builtin" | "later";
  account: string | null;
  accountSource: "you" | "env" | "cli" | null;
  appReady: boolean;
  scope: string;
  configured: boolean;
  enabled: boolean;
  itemCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
  needsAttention: boolean;
};

export type UsageCall = {
  title: string;
  purpose: string;
  provider: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  estimatedUsd: number | null;
  /** Ensemble credits, for included models only (their estimatedUsd is null). */
  credits: number | null;
  at: string;
};

export type MetricsSummary = {
  days: Array<{ day: string; calls: number; tokensIn: number; tokensOut: number; estimatedUsd: number | null; credits: number | null }>;
  byModel: Array<{ model: string; provider: string; calls: number; tokensIn: number; tokensOut: number; estimatedUsd: number | null; credits: number | null }>;
  byPurpose: Array<{ purpose: string; calls: number; tokensIn: number; tokensOut: number; estimatedUsd: number | null; credits: number | null }>;
  recent: UsageCall[];
  providers: string[];
  baselines: Array<{
    kind: string;
    baselineSeconds: number;
    sampleSize: number;
    note: string | null;
    currentSeconds: number | null;
    observations: number;
  }>;
  events: Array<{ kind: string; count: number; avgSeconds: number | null }>;
  throughput: { completed: number; failed: number; medianMinutes: number | null; waitingOnYou: number };
  trust: { approved: number; edited: number; rejected: number };
  governance: { ledgerEntries: number };
};

export type ConversationRecord = { id: string; title: string; updatedAt: string; createdAt: string };

export type AssistantToolCallRecord = {
  id: string;
  name: string;
  area?: string;
  summary?: string;
  state?: "ok" | "failed" | "awaiting_approval" | "undone";
  isWrite?: boolean;
  href?: string;
  error?: string;
  input?: Record<string, unknown>;
  undoEntryId?: string | null;
};

export type AssistantMessageRecord = {
  id: string;
  role: "user" | "assistant" | string;
  content: string;
  toolCalls: AssistantToolCallRecord[];
  model: string | null;
  createdAt: string;
  credentialSource?: string | null;
};

/** A computer the person's AI subscriptions run on, and the agents it found. */
export type SubscriptionComputer = {
  id: string;
  name: string;
  platform: string | null;
  local: boolean;
  online: boolean;
  lastSeenAt: string | null;
  appVersion: string | null;
  /** New enough to run assistant turns. */
  ready: boolean;
  agents: SubscriptionAgent[];
};

export type SubscriptionsView = { computers: SubscriptionComputer[]; preferred: string | null };

export type ModelCatalog = {
  providers: Array<{
    provider: string;
    available: boolean;
    models: string[];
    notes?: Record<string, { available: boolean; reason: string | null }>;
    /** What the provider's own model list said about each model: its thinking levels. */
    meta?: Record<string, ModelMeta>;
    /** included: the operator's own models, metered in Ensemble credits (provider "ensemble"). */
    source: "you" | "account" | "env" | "cli" | "none" | "local" | "included";
    chat: boolean;
    cheapest: string | null;
    error: string | null;
    /** When this provider's list was fetched; lists are kept a week. */
    fetchedAt?: string | null;
  }>;
  runtime: boolean;
  error?: string;
  updatedAt: string;
  /** The oldest list among the providers with a key. */
  fetchedAt?: string | null;
};

/** you: saved here. account: on a paired computer, a key saved on the Ensemble account. */
export type ModelKey = { provider: string; source: "you" | "account" | "env" | "none"; hint: string | null; updatedAt: string | null };

export type Profile = { gender: string | null; profession: string | null; organization: string | null; heardFrom: string | null };

export type ProfileInput = {
  name: string;
  gender?: string | null;
  profession?: string | null;
  organization?: string | null;
  heardFrom?: string | null;
};

export type Me = {
  user: { id: string; email: string; name: string; avatar?: string | null; emailVerified?: boolean; hasPassword?: boolean; profile: Profile };
  via: "session" | "token" | "internal" | "bypass" | "desktop";
  modules?: string | null;
  verificationRequired?: boolean;
  onboardingComplete?: boolean;
  profileComplete?: boolean;
};

export type ApiTokenRecord = {
  id: string;
  name: string;
  prefix: string;
  scope?: "full" | "bridge" | "device";
  lastUsedAt: string | null;
  createdAt: string;
};

export type ConnectBridge = {
  repoRoot: string;
  bridgeScript: string;
  node: string;
  hubApiUrl: string;
  publicApiUrl: string;
  httpUrl: string;
  platform: string;
  built: boolean;
  httpUp: boolean;
  state: "connected" | "running" | "not_running";
  tokens: Array<{ id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string }>;
};

export type CliAuthScope = "mcp" | "runner";

export type CliAuthRequest = {
  clientName: string;
  platform: string;
  version: string;
  scopes: CliAuthScope[];
  createdAt: string;
  expiresAt: string;
  status: string;
  requestedFrom?: string | null;
  sameNetwork?: boolean | null;
};

export type CliAuthDecision = "approve" | "deny";

export type ConnectorApp = {
  provider: "google" | "github";
  configured: boolean;
  source: "env" | "settings" | null;
  clientIdHint: string | null;
  redirectUri: string;
  console: string | null;
  steps: string[];
};

export type AgentDecisionRecord = {
  id: string;
  source: "cursor" | "claude" | "copilot" | "codex" | "ensemble" | "other";
  event: string;
  toolName: string;
  title: string;
  detail: {
    command?: string | null;
    input?: Record<string, unknown>;
    server?: string | null;
    model?: string | null;
    options?: string[];
    allowCustom?: boolean;
    taskId?: string;
    taskTitle?: string;
    jobId?: string;
    deviceId?: string;
    deviceName?: string;
    tier?: "ordinary" | "run_branch_push" | "high_risk";
    /** A risky allow (push, outside path, trust): the person confirms first. */
    confirm?: boolean;
    /** The option the agent recommends, one of `options`. */
    recommended?: string | null;
    /** A question from another tool (Claude Code's AskUserQuestion): each option's description. */
    optionDetails?: Array<{ label: string; description: string }>;
    /** More than one option may be picked. */
    multiSelect?: boolean;
    /** Short label the tool gave the question. */
    header?: string | null;
  };
  sessionId: string | null;
  cwd: string | null;
  /** settled: answered in the tool's own window before anyone answered here. */
  status: "pending" | "decided" | "expired" | "settled";
  decision: "allow" | "deny" | null;
  scope: "once" | "session" | "always" | null;
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  expiresAt: string;
  /** In a shared space: false when only someone else (the runner, or the owner) may answer. */
  canAnswer?: boolean;
  runnerAccountId?: string | null;
};

export type DecisionRuleRecord = {
  id: string;
  source: string;
  toolName: string;
  pattern: string;
  decision: "allow" | "deny";
  sessionId: string | null;
  createdAt: string;
};

// ── client ─────────────────────────────────────────────────────────────────

export const api = bindClient({
  version: (updates = false) => get<{ version: string; commit: string | null; mode: "local" | "web"; checked: boolean; releases: { desktop: { version: string; assets: Array<{ name: string; url: string }> } | null; cli: { version: string; assets: Array<{ name: string; url: string }> } | null } | null }>(`/api/version${updates ? "?updates=1" : ""}`),
  health: () => get<{ ok: boolean }>("/health"),
  shell: () =>
    get<{
      user: Me["user"];
      via: Me["via"];
      approvals: number;
      decisions: number;
      attention: number;
      canUndo: boolean;
      canRedo: boolean;
      /** The action the top bar's Undo would reverse: the latest from the last few minutes. */
      undoLabel?: string | null;
      redoLabel?: string | null;
      onboardingComplete: boolean;
      verificationRequired?: boolean;
      highlights: string[];
      modules?: string | null;
      labels?: Record<string, string>;
      activeTemplateId?: string | null;
      onboardingTemplateId?: string | null;
      /** The Ensemble space this request ran in. */
      space?: {
        id: string;
        name: string;
        icon: string | null;
        primary: boolean;
        members?: number;
        /** Members and people with a shared item. Above zero, presence is sent. */
        collaborators?: number;
        /** Set when this is someone else's space, shared with you. */
        shared?: { owner: SharingPerson; role: "viewer" | "editor" } | null;
      };
      templateName?: string | null;
      seasonEnded?: { id: string; name: string } | null;
      devTools?: boolean;
      pageWidth?: number;
    }>("/api/shell"),
  todayHome: (from: string, to: string) =>
    get<{
      tasks: TaskRecord[];
      deliverables: DeliverableRecord[];
      reminders: ReminderRecord[];
      events: CalendarEvent[];
      sync: Array<{ connector: string; lastSyncAt: string | null; lastError: string | null }>;
      timezone: string;
    }>(`/api/today/home${qs({ from, to })}`),

  // tasks & board
  tasks: () => get<{ tasks: TaskRecord[] }>("/api/tasks"),
  task: (id: string) => get<{ task: TaskRecord }>(`/api/tasks/${id}`),
  createTask: (data: Partial<TaskRecord> & { title: string }) =>
    post<{ task: TaskRecord; undoEntryId?: string | null }>("/api/tasks", { sourceKind: "manual", ...data }),
  patchTask: (id: string, data: Record<string, unknown>) => patch<{ task: TaskRecord; undoEntryId?: string | null }>(`/api/tasks/${id}`, data),
  moveTask: (id: string, data: { status: TaskStatus; beforeId?: string | null; afterId?: string | null }) =>
    post<{ task: { id: string }; undoEntryId?: string | null }>(`/api/tasks/${id}/move`, data),
  deleteTask: (id: string) => del<{ undoEntryId?: string | null }>(`/api/tasks/${id}`),
  taskRuns: (id: string) =>
    get<{ runs: Array<{ id: string; outcome: string | null; result: string | null; requestedModel: string | null; startedAt: string }> }>(
      `/api/tasks/${id}/runs`,
    ),
  page: (id: string) => get<PageRecord>(`/api/tasks/${id}/page`),
  savePage: (id: string, data: { revision: number; content: unknown; notes?: string }) =>
    put<PageRecord>(`/api/tasks/${id}/page`, data),
  pages: () => get<{ pages: StandalonePageSummary[] }>("/api/pages"),
  /** Pages whose title or text contains `query`, each with a snippet. */
  searchPages: (query: string) => get<{ pages: StandalonePageSummary[] }>(`/api/pages${qs({ q: query })}`),
  deletePages: (pageIds: string[]) => post<{ deleted: number; undoEntryId: string | null }>("/api/pages/delete-many", { pageIds }),
  createPage: () => post<{ page: StandalonePageSummary }>("/api/pages", {}),
  convertPage: (kind: "page" | "task", id: string, revision: number) =>
    post<{ kind: "page" | "task"; id: string; pageId: string }>(`/api/pages/${kind}/${id}/convert`, { revision }),
  renamePage: (id: string, title: string) => patch<{ page: StandalonePageSummary }>(`/api/pages/${id}`, { title }),
  deletePage: (id: string) => del<void>(`/api/pages/${id}`),
  standalonePage: (id: string) => get<StandalonePageRecord>(`/api/pages/${id}`),
  /** A page in Trash, to read before restoring it. The owner only. */
  trashedPage: (id: string) => get<StandalonePageRecord & { deletedAt: string }>(`/api/pages/${id}?trashed=1`),
  /** Live co-editing (`components/editor/collab.ts`): join, the steps since a version, and sending steps. */
  collabJoin: (kind: "page" | "task", id: string, options: { stored?: boolean; start?: boolean } = {}) => get<CollabJoin>(`${collabPath(kind, id)}${qs({ stored: options.stored ? 1 : undefined, start: options.start ? 1 : undefined })}`),
  collabSince: (kind: "page" | "task", id: string, epoch: string, version: number) => get<CollabBatch>(`${collabPath(kind, id)}${qs({ epoch, version })}`),
  collabSend: (kind: "page" | "task", id: string, body: CollabSend) => request<CollabBatch>(collabPath(kind, id), { method: "POST", json: body, surviveNavigation: true }),
  saveStandalonePage: (id: string, data: { revision: number; content: unknown; notes?: string }) =>
    put<StandalonePageRecord>(`/api/pages/${id}`, data),
  undo: (entryId?: string) => post<{ label: string; entryId: string } | undefined>("/api/undo", entryId ? { entryId } : {}),
  redo: (entryId?: string) => post<{ label: string; entryId: string } | undefined>("/api/redo", entryId ? { entryId } : {}),

  // today
  deliverables: (includeCompleted = false) =>
    get<{ deliverables: DeliverableRecord[] }>(`/api/deliverables${qs({ includeCompleted })}`),
  createDeliverable: (data: { title: string; projectId: string; due?: string | null }) =>
    post<{ deliverable: DeliverableRecord }>("/api/deliverables", data),
  patchDeliverable: (id: string, data: Record<string, unknown>) => patch(`/api/deliverables/${id}`, data),
  reminders: () => get<{ reminders: ReminderRecord[] }>("/api/reminders"),
  createReminder: (data: { title: string; dueDate: string; dueTime?: string | null; timeZone?: string }) =>
    post("/api/reminders", data),
  dismissReminder: (id: string) => post(`/api/reminders/${id}/dismiss`),
  calendar: (from: string, to: string) =>
    get<{ events: CalendarEvent[]; sync: Array<{ connector: string; lastSyncAt: string | null; lastError: string | null }> }>(
      `/api/calendar${qs({ from, to })}`,
    ),

  // account
  authStatus: () => get<{
    hasAccounts: boolean; bypass: boolean; signup: "open" | "closed" | "allowlist";
    providers: Array<"google" | "github" | "microsoft">; emailConfigured: boolean; emailSignupAvailable?: boolean; turnstileSiteKey: string | null;
  }>("/api/auth/status"),
  me: () => get<Me>("/api/auth/me"),
  signup: (data: { email: string; password: string; name: string; turnstileToken?: string }) =>
    post<{ user: Me["user"]; firstAccount: boolean; verificationSent: boolean; verificationRequired: boolean }>("/api/auth/signup", data),
  login: (data: { email: string; password: string }) => post<{ user: Me["user"] }>("/api/auth/login", data),
  logout: () => post<void>("/api/auth/logout"),
  updateMe: (data: { name?: string; password?: string; current?: string; avatar?: string | null }) => patch<{ user: Me["user"] }>("/api/auth/me", data),
  updateProfile: (data: ProfileInput) => put<{ user: Me["user"]; profile: Profile }>("/api/auth/profile", data),
  verifyEmail: (code: string) => post<{ verified: boolean }>("/api/auth/verify-email", { code }),
  resendVerification: () => post<{ sent: boolean }>("/api/auth/resend-verification"),
  forgotPassword: (email: string) => post<{ message: string }>("/api/auth/forgot", { email }),
  resetPassword: (token: string, password: string) => post<{ reset: boolean }>("/api/auth/reset", { token, password }),
  identities: () => get<{
    identities: Array<{ provider: "google" | "github" | "microsoft"; email: string | null; createdAt: string }>;
    providers: Array<"google" | "github" | "microsoft">;
  }>("/api/auth/identities"),
  unlinkIdentity: (provider: string, current?: string) => request<void>(`/api/auth/identities/${encodeURIComponent(provider)}`, { method: "DELETE", json: { current } }),
  exportAccount: () => get<Record<string, unknown>>("/api/auth/export"),
  deleteAccount: (current?: string) => request<void>("/api/auth/account", { method: "DELETE", json: { confirmation: "DELETE", current } }),
  eventsTicket: () => post<{ ticket: string }>("/api/events/ticket"),
  tokens: () => get<{ tokens: ApiTokenRecord[] }>("/api/tokens"),
  createToken: (name: string) => post<{ id: string; token: string }>("/api/tokens", { name }),
  revokeToken: (id: string) => del<void>(`/api/tokens/${id}`),
  connectBridge: () => get<ConnectBridge>("/api/connect/bridge"),
  createBridgeToken: (name?: string) => post<{ id: string; token: string; prefix: string }>("/api/connect/token", name ? { name } : {}),
  cliAuthRequest: (code: string) => get<CliAuthRequest>(`/api/cli/auth/request${qs({ code })}`),
  approveCliAuth: (body: { userCode: string; scopes: CliAuthScope[]; decision: CliAuthDecision }) =>
    post<{ ok: true; scopes: CliAuthScope[] }>("/api/cli/auth/approve", body),

  // editor decisions (Needs me router)
  decisions: (status: "pending" | "recent" = "pending") =>
    get<{ decisions: AgentDecisionRecord[] }>(`/api/decisions${qs({ status })}`),
  decideAgent: (id: string, data: { decision: "allow" | "deny"; scope: "once" | "session" | "always"; reason?: string; confirmed?: boolean }) =>
    post<{ decision: AgentDecisionRecord }>(`/api/decisions/${id}/decide`, data),
  decisionRules: () => get<{ rules: DecisionRuleRecord[] }>("/api/decision-rules"),
  deleteDecisionRule: (id: string) => del<void>(`/api/decision-rules/${id}`),
  editorSetup: () => get<{ node: string; script: string; apiUrl: string; local?: boolean; connected?: string[] }>("/api/editors/setup"),
  connectEditor: (target: string, remove = false) => post<{ ok: boolean; message: string; connected: string[] }>("/api/editors/connect", { target, remove }),
  agentApps: () => get<{ available: boolean; agents: AgentPresence[]; targets: HandoffTarget[] }>("/api/agent/apps"),
  handoff: (data: HandoffInput) => post<{ id: string; marker: string; folder: string; opened: boolean; url: string | null; prompt: string }>("/api/agent/handoff", data),
  handoffs: (taskId?: string) => get<{ handoffs: HandoffRecord[] }>(`/api/agent/handoffs${taskId ? qs({ taskId }) : ""}`),
  closeHandoff: (id: string) => post<void>(`/api/agent/handoffs/${id}/close`, {}),

  // connectors
  connectorApps: () => get<{ apps: ConnectorApp[]; canEdit: boolean; mcpRedirectUri?: string }>("/api/connectors/apps"),
  saveConnectorApp: (provider: string, data: { clientId: string; clientSecret: string }) =>
    put(`/api/connectors/apps/${provider}`, data),
  startConnect: (provider: string, returnTo?: string) =>
    get<{ url: string }>(`/api/connectors/${provider}/start${qs({ returnTo })}`),
  connectToken: (provider: string, token: string) => post<{ ok: boolean; account: string }>(`/api/connectors/${provider}/token`, { token }),
  disconnect: (provider: string) => del<void>(`/api/connectors/${provider}`),

  // model keys
  modelKeys: () => get<{ credentials: ModelKey[] }>("/api/model-keys"),
  saveModelKey: (provider: string, apiKey: string) => put<{ ok: boolean; models: number }>(`/api/model-keys/${provider}`, { apiKey }),
  removeModelKey: (provider: string) => del<void>(`/api/model-keys/${provider}`),
  testModel: (tier: Complexity) =>
    post<{ ok: boolean; model: string; text: string; tokensIn: number | null; tokensOut: number | null; ms: number }>("/api/models/test", { tier }),

  // needs me
  approvals: () => get<{ approvals: ApprovalRecord[] }>("/api/approvals"),
  decide: (id: string, data: { decision: "approved" | "edited" | "rejected"; editedPayload?: unknown; reason?: string }) =>
    post(`/api/approvals/${id}/decide`, data),

  // context
  entities: () => get<{ entities: Entity[] }>("/api/entities"),
  contextBoard: () => get<BoardPayload>("/api/context/board"),
  saveContextOrder: (body: Pick<BoardPayload, "view" | "group" | "groups"> & { lanes: Record<string, string[]> }) =>
    put<{ ok: boolean }>("/api/context/order", body),
  people: () => get<{ people: PersonRecord[] }>("/api/people"),
  createPerson: (data: { name: string; email?: string; role?: string }) => post("/api/people", data),
  patchPerson: (id: string, data: Record<string, unknown>) => patch(`/api/people/${id}`, data),
  deletePerson: (id: string) => del(`/api/people/${id}`),
  projects: () => get<{ projects: ProjectRecord[] }>("/api/projects"),
  createProject: (data: { name: string; summary?: string }) => post<{ project: { id: string } }>("/api/projects", data),
  patchProject: (id: string, data: Record<string, unknown>) => patch(`/api/projects/${id}`, data),
  deleteProject: (id: string) => del(`/api/projects/${id}`),
  repos: () => get<{ repos: RepoRecord[] }>("/api/repos"),
  addRepo: (fullName: string) => post("/api/repos", { fullName }),
  patchRepo: (id: string, data: Record<string, unknown>) => patch(`/api/repos/${id}`, data),
  deleteRepo: (id: string) => del<void>(`/api/repos/${id}`),
  preferences: () => get<{ preferences: PreferenceRecord[] }>("/api/preferences"),
  putPreference: (key: string, value: unknown) =>
    put<{ preference: PreferenceRecord }>(`/api/preferences/${encodeURIComponent(key)}`, { value }),
  setModules: (id: string, on: boolean) => put<{ modules: string }>("/api/settings/modules", { id, on }),
  deletePreference: (key: string) => del(`/api/preferences/${encodeURIComponent(key)}`),
  /** `exclude: "uploads"` leaves out uploaded files; `before` is the previous page's `nextCursor`. */
  artifacts: (params: { kind?: string; q?: string; take?: number; exclude?: "uploads"; before?: string } = {}) =>
    get<{
      artifacts: ArtifactRecord[];
      counts: Array<{ kind: string; count: number }>;
      sync: Array<{ connector: string; lastSyncAt: string | null; itemCount: number; lastError: string | null }>;
      nextCursor: string | null;
    }>(`/api/artifacts${qs(params)}`),
  graph: (includeCompleted = false) =>
    get<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/api/context/graph${qs({ includeCompleted })}`),

  // skills
  skills: () => get<{ skills: SkillRecord[] }>("/api/skills"),
  skill: (id: string) => get<{ skill: SkillRecord }>(`/api/skills/${id}`),
  morningBriefSkill: () => get<{ skill: { id: string; body: string }; notification: HubNotification | null; customize: boolean }>("/api/brief/skill"),
  saveMorningBriefSkill: (instructions: string) => patch("/api/brief/skill", { instructions }),
  morningBriefPrompt: (action: "show" | "dismiss") => post<{ show: boolean }>("/api/brief/prompt", { action }),
  testSkill: (id: string, prompt?: string) => post<{ title: string; body: string }>(`/api/skills/${id}/test`, { prompt }),
  createSkill: (name: string) => post<{ skill: SkillRecord }>("/api/skills", { name }),
  patchSkill: (id: string, data: Record<string, unknown>) => patch<{ skill: SkillRecord }>(`/api/skills/${id}`, data),
  deleteSkill: (id: string) => del<void>(`/api/skills/${id}`),
  restoreSkill: (id: string, version: number) => post(`/api/skills/${id}/restore`, { version }),
  scoreSkill: (id: string, draft: string) =>
    post<{ words: number; score: number | null; results: Array<{ rule: string; pass: boolean }>; note?: string }>(
      `/api/skills/${id}/score`,
      { draft },
    ),

  // runs & workspace
  runs: (take = 20) => get<{ runs: RunSummary[]; total: number }>(`/api/runs${qs({ take })}`),
  run: (id: string) => get<{ run: RunDetail; job: RunJob | null }>(`/api/runs/${id}`),
  runFeedback: (id: string, text: string, start: boolean) => post<{ jobId: string | null }>(`/api/runs/${id}/feedback`, { id: crypto.randomUUID(), text, start }),
  deleteRun: (id: string) => del(`/api/runs/${id}`),
  workspace: () => get<WorkspaceBoard>("/api/workspace"),
  assign: (data: AssignInput) => post<{ jobId: string }>("/api/agent/assign", data),
  taskJobs: (taskId: string) => get<{ jobs: AgentJob[] }>(`/api/agent/jobs${qs({ taskId })}`),
  job: (id: string) =>
    get<{ job: AgentJob & { instructions: string; networkAccess: boolean; sandbox?: Partial<SandboxCaps> & { effective: boolean; where?: "device" | "server" } }; events: JobEvent[]; log?: string }>(`/api/agent/jobs/${id}`),
  jobFiles: (id: string) => get<JobFiles>(`/api/agent/jobs/${id}/files`),
  /** A changed file's copy from when the run ended, or (live) read now from the task's folder. */
  jobFile: (id: string, path: string, live = false) =>
    get<{ source: "stored" | "live"; file: FolderFile; status?: string; at?: string }>(`/api/agent/jobs/${id}/file${qs({ path, live: live ? 1 : undefined })}`),
  /** One folder of the task's folder, read now (from the computer that ran it). */
  jobTree: (id: string, path = "") => get<{ listing: FolderListing }>(`/api/agent/jobs/${id}/tree${qs({ path })}`),
  jobLogs: (id: string, after?: number) => get<{ chunks: Array<{ seqFrom: number; seqTo: number; text: string; bytes: number; at: string }> }>(`/api/agent/jobs/${id}/logs${qs({ after })}`),
  devices: () =>
    get<{
      serverRunner: boolean;
      devices: Array<{
        id: string;
        name: string;
        platform: string;
        appVersion: string | null;
        capabilities: unknown;
        folders: string[];
        runBranchPush: boolean;
        lastSeenAt: string | null;
        createdAt: string;
        online: boolean;
      }>;
    }>("/api/devices"),
  /** The person's AI subscriptions on their computers (docs/30 §8). */
  subscriptions: () => get<SubscriptionsView>("/api/subscriptions"),
  checkSubscriptions: (deviceId: string) => post<{ sent?: boolean; agents?: SubscriptionAgent[] }>("/api/subscriptions/check", { deviceId }),
  signInSubscription: (deviceId: string, agent: SubscriptionProvider) => post<{ message: string }>("/api/subscriptions/sign-in", { deviceId, agent }),
  pairDevice: () => post<{ code: string; expiresAt: string }>("/api/devices/pair", {}),
  renameDevice: (id: string, name: string) => patch(`/api/devices/${id}`, { name }),
  revokeDevice: (id: string) => del<void>(`/api/devices/${id}`),
  stopJob: (id: string) => post(`/api/agent/jobs/${id}/stop`),
  retryJob: (id: string) => post<{ jobId: string }>(`/api/agent/jobs/${id}/retry`),
  workspaceGuard: () => get<{ root: string; sandboxAvailable: boolean; sandbox: SandboxCaps }>("/api/workspace/guard"),
  sandboxStatus: (refresh = false) => get<{ sandbox: SandboxCaps }>(`/api/sandbox${refresh ? "?refresh=1" : ""}`),
  /** Windows asks for permission once; elsewhere it re-checks. Only the computer itself can do this. */
  setupSandbox: () => post<{ ok: boolean; message: string; sandbox: SandboxCaps }>("/api/sandbox/setup", {}),
  checkouts: () => get<{ checkouts: Array<{ jobId: string; title: string; status: string; folder: string; branch: string; createdAt: string }> }>("/api/workspace/checkouts"),
  resolveFolder: (path: string) => post<{ path: string; git: boolean; branch: string | null }>("/api/workspace/resolve-folder", { path }),
  trustedFolders: () => get<{ folders: Array<{ id: string; path: string; createdAt: string }> }>("/api/workspace/trust"),
  trustSharing: () => get<TrustSharing>("/api/workspace/trust/sharing"),
  setTrustSharing: (enabled: boolean) => put<TrustSharing>("/api/workspace/trust/sharing", { enabled }),
  pickFolder: () => post<{ path: string; git: boolean } | undefined>("/api/workspace/pick-folder"),
  branches: (path: string) => get<{ branches: string[] }>(`/api/workspace/branches${qs({ path })}`),
  agentState: () => get<AgentState>("/api/agent/state"),
  remote: () => get<RemoteMac>("/api/remote"),
  saveRemote: (body: { enabled?: boolean; runBranchPush?: boolean; acceptWebApprovals?: boolean; browseFiles?: boolean; webEdit?: boolean; webTerminal?: boolean; apiBase?: string | null; deviceName?: string }) => put<RemoteMac>("/api/remote", body),
  pairRemote: (body: { apiBase: string; code: string; name?: string }) => post<RemoteMac>("/api/remote/pair", body),
  unpairRemote: () => post<RemoteMac>("/api/remote/unpair"),
  pauseAgent: () => post<{ stopped: number; cancelled: number }>("/api/agent/pause"),
  resumeAgent: () => post("/api/agent/resume"),
  stopAll: () => post<{ stopped: number; cancelled: number }>("/api/agent/stop-all"),
  stopActivity: (id: string) => post(`/api/activity/${encodeURIComponent(id)}/stop`),

  // terminal
  terminalStatus: () => get<TerminalStatus>("/api/terminal/status"),
  terminalPasskeyOptions: (password: string) => post<Record<string, unknown>>("/api/terminal/passkeys/options", { password }),
  terminalPasskeyVerify: (response: unknown, label: string) => post("/api/terminal/passkeys/verify", { response, label }),
  terminalRemovePasskey: (id: string) => del(`/api/terminal/passkeys/${id}`),
  terminalUnlockOptions: () => post<Record<string, unknown>>("/api/terminal/unlock/options"),
  terminalUnlockVerify: (response: unknown) => post<{ unlocked: boolean; expiresAt: string | null }>("/api/terminal/unlock/verify", { response }),
  terminalLock: () => post("/api/terminal/lock"),
  terminalKill: () => post("/api/terminal/kill"),
  terminalCd: (cwd: string, path: string) => post<{ cwd: string; scope: string }>("/api/terminal/cd", { cwd, path }),

  // the web terminal's passkey lock (Ensemble on the web)
  webTerminalStatus: () => get<WebTerminalStatus>("/api/web-terminal/status"),
  webTerminalSendCode: () => post<{ sent: boolean; to: string }>("/api/web-terminal/passkeys/code", {}),
  webTerminalPasskeyOptions: (proof: { password?: string; code?: string }) => post<Record<string, unknown>>("/api/web-terminal/passkeys/options", proof),
  webTerminalPasskeyVerify: (response: unknown, label: string) => post("/api/web-terminal/passkeys/verify", { response, label }),
  webTerminalRemovePasskey: (id: string) => del(`/api/web-terminal/passkeys/${id}`),
  webTerminalUnlockOptions: () => post<Record<string, unknown>>("/api/web-terminal/unlock/options", {}),
  webTerminalUnlockVerify: (response: unknown) => post<{ unlocked: boolean; expiresAt: string | null }>("/api/web-terminal/unlock/verify", { response }),
  webTerminalLock: () => post("/api/web-terminal/lock", {}),
  /** One call to a paired computer's own Code API, passed through Ensemble on the web (protocol 4). */
  deviceCode: <T>(deviceId: string, method: "GET" | "POST" | "PUT", path: string, query: Record<string, string> = {}, body?: unknown) =>
    post<T>(`/api/devices/${encodeURIComponent(deviceId)}/code`, { method, path, query, ...(body === undefined ? {} : { body }) }),
  deviceTerminal: <T>(deviceId: string, body: { op: "status" | "cd" | "kill"; cwd?: string; path?: string; runId?: string }) =>
    post<T>(`/api/devices/${encodeURIComponent(deviceId)}/terminal`, body),
  deviceTerminalOutput: (deviceId: string, run: string, after: number) =>
    get<{ chunks: Array<{ seq: number; text: string }>; done: boolean; exitCode: number | null }>(`/api/devices/${encodeURIComponent(deviceId)}/terminal/output${qs({ run, after })}`),

  // code
  codeRepos: () => get<{ repos: string[]; roots: string[] }>("/api/code/repos"),
  /** Checks a folder for "Folders Code can use" and returns its real path. Saving goes through saveSettings. */
  resolveCodeFolder: (path: string) => post<{ path: string }>("/api/code/folders/resolve", { path }),
  reviews: (filter: "needs" | "reviewed" | "all", expired: boolean) =>
    get<{ reviews: ReviewSummary[]; ttlDays: number }>(`/api/code/reviews${qs({ filter, expired })}`),
  codeSource: (source: { review?: string; repo?: string }) => get<CodeSource>(`/api/code/source${qs(source)}`),
  codeDiff: (source: { review?: string; repo?: string }, path: string, untracked: boolean) =>
    get<{ diff: FileDiff; decisions: Array<{ chunkKey: string; decision: string }> }>(
      `/api/code/diff${qs({ ...source, path, untracked })}`,
    ),
  decideHunk: (data: {
    review?: string;
    repo?: string;
    path: string;
    key: string;
    untracked: boolean;
    decision: "accepted" | "rejected";
  }) => post("/api/code/decide", data),
  completeReview: (id: string) => post(`/api/code/reviews/${id}/complete`),
  acceptReview: (id: string) => post<{ commit: string | null; branch: string; pushable: boolean }>(`/api/code/reviews/${id}/accept`),
  discardReview: (id: string) => post<{ restored: number; keptCommits: boolean }>(`/api/code/reviews/${id}/discard`),
  pushReview: (id: string) => post<{ branch: string; remote: string }>(`/api/code/reviews/${id}/push`),
  codeFile: (source: { review?: string; repo?: string }, path: string) =>
    get<CodeFile>(`/api/code/file${qs({ ...source, path })}`),
  saveCodeFile: (source: { review?: string; repo?: string }, path: string, content: string, expectedHash?: string | null) =>
    put<{ ok: boolean; hash?: string | null }>("/api/code/file", { ...source, path, content, ...(expectedHash === undefined ? {} : { expectedHash }) }),
  codeVersions: (source: { review?: string; repo?: string }, path: string) => get<CodeVersions>(`/api/code/versions${qs({ ...source, path })}`),
  codeAcceptContent: (source: { review?: string; repo?: string }, path: string, content: string) => post("/api/code/accept-content", { ...source, path, content }),
  codeRestore: (review: string, path: string) => post("/api/code/restore", { review, path }),
  codeProgress: (source: { review?: string; repo?: string }) => get<CodeProgress>(`/api/code/progress${qs(source)}`),
  codeTree: (source: { review?: string; repo?: string }, path: string) => get<CodeTree>(`/api/code/tree${qs({ ...source, path })}`),
  codeFiles: (source: { review?: string; repo?: string }) => get<{ files: string[]; truncated: boolean }>(`/api/code/files${qs(source)}`),
  codeCommitPlan: (source: { review?: string; repo?: string }) => get<CommitPlan>(`/api/code/commit-plan${qs(source)}`),
  codeCommitPaths: (source: { review?: string; repo?: string }, paths: string[], message: string) => post<{ ok: boolean; commit: string; branch: string }>("/api/code/commit-paths", { ...source, paths, message }),
  codePullRequest: (source: { review?: string; repo?: string }, pr: { title: string; body: string; base: string; draft: boolean }) => post<{ ok: boolean; url: string; number: number }>("/api/code/pull-request", { ...source, ...pr }),
  codeSearch: (source: { review?: string; repo?: string }, q: string, matchCase: boolean) => get<CodeSearch>(`/api/code/search${qs({ ...source, q, case: matchCase ? "1" : "0" })}`),
  searchThemes: (q: string) => get<{ extensions: ThemeDirectoryExtension[] }>(`/api/themes/search${qs({ q })}`),
  loadOpenVsxTheme: (query: { namespace: string; name: string; version: string; label: string }) =>
    get<{ theme: IdeTheme | null; reason?: string }>(`/api/themes/openvsx${qs(query)}`),
  scm: (repo: string) => get<ScmStatus>(`/api/code/scm${qs({ repo })}`),
  stage: (repo: string, paths: string[]) => post("/api/code/scm/stage", { repo, paths }),
  unstage: (repo: string, paths: string[]) => post("/api/code/scm/unstage", { repo, paths }),
  discard: (repo: string, paths: string[]) => post("/api/code/scm/discard", { repo, paths }),
  commit: (repo: string, message: string, all = false) => post("/api/code/scm/commit", { repo, message, all }),
  push: (repo: string) => post<{ output: string }>("/api/code/scm/push", { repo }),
  pull: (repo: string) => post<{ output: string }>("/api/code/scm/pull", { repo }),
  actions: (repo: string) => get<ActionsResult>(`/api/code/actions${qs({ repo })}`),

  // metrics
  metrics: () => get<MetricsSummary>("/api/metrics/summary"),
  /** This account's included credits this month. `available` is false when the server has no included models. */
  includedUsage: () => get<IncludedUsage>("/api/metrics/credits"),
  verifyLedger: () => post<{ ok: boolean; checked: number; brokenAt?: string }>("/api/ledger/verify"),

  // settings & system
  settings: () => get<{ settings: Settings }>("/api/settings"),
  saveSettings: (data: unknown) => patch<{ settings: Settings }>("/api/settings", data),
  connections: () => get<{ connections: Connection[]; attention: number; lastFetch: string | null }>("/api/connections"),
  syncConnection: (id: string) => post<{ ok: boolean; message: string; proposed?: number }>(`/api/connections/${id}/sync`),
  fetchNow: () => post<{ results: Array<{ id: string; ok: boolean; message: string }>; message?: string }>("/api/fetch"),
  models: () => get<ModelCatalog>("/api/models"),
  /** Asks each provider with a key (or only those named) for its model list now. */
  refreshModels: (providers?: string[]) => post<ModelCatalog>("/api/models/refresh", providers?.length ? { providers } : {}),
  prompts: () => get<{ prompts: Array<{ id: string; title: string; when: string; purpose: string; body?: string }> }>("/api/prompts"),
  deleted: () =>
    get<{
      /** `detail`: for a comment, the page it was on. `href`: where the item opens once restored. */
      items: Array<{ kind: string; id: string; label: string; detail?: string | null; href?: string | null; deletedAt: string }>;
    }>("/api/deleted"),
  restoreDeleted: (data: { kind?: string; id?: string } = {}) => post<{ restored: number }>("/api/deleted/restore", data),
  emptyDeleted: () => post<{ removed: number }>("/api/deleted/empty"),
  deleteMyData: (scope: "context" | "everything", confirm: string) => post("/api/data/delete", { scope, confirm }),
  activity: () => get<{ activities: Array<{ id: string; kind: string; label: string; detail?: string }> }>("/api/activity"),

  // assistant
  conversations: () => get<{ conversations: ConversationRecord[] }>("/api/assistant/conversations"),
  /** The assistant dock's own chats, newest first: conversations that have messages. */
  assistantChats: () => get<{ conversations: ConversationRecord[] }>("/api/assistant/conversations?chats=1"),
  conversationMessages: (id: string) => get<{ messages: AssistantMessageRecord[] }>(`/api/assistant/conversations/${id}/messages`),
  assistantTurn: (body: {
    conversationId?: string;
    message: string;
    tier?: Complexity;
    page?: { path: string; label?: string; taskId?: string };
  }) =>
    post<{ conversationId: string; content: string; toolCalls: AssistantToolCallRecord[]; model: string }>(
      "/api/assistant/turn",
      body,
    ),
  applyAssistant: (data: {
    name?: string;
    input?: Record<string, unknown>;
    conversationId?: string;
    callId?: string;
    calls?: Array<{ name: string; input: Record<string, unknown>; callId?: string }>;
  }) =>
    post<{
      summary: string;
      href: string | null;
      undoEntryId?: string | null;
      already?: boolean;
      replies?: Array<{ id: string; content: string; toolCalls: AssistantToolCallRecord[] }>;
      /** Some of a batch landed and some did not; `failed` names the rest. Landed calls are never re-run. */
      partial?: boolean;
      failed?: ApplyFailure[];
    }>("/api/assistant/apply", data),
  stopAssistant: (id: string) => post<void>(`/api/assistant/conversations/${id}/stop`),
  ensembleReplies: (surface: string, anchorKey: string) =>
    get<{
      replies: Array<{
        id: string;
        content: string;
        prompt: string;
        toolCalls: AssistantToolCallRecord[];
        citations: Array<{ kind: string; id?: string; url?: string; label: string }>;
      }>;
    }>(`/api/ensemble/replies${qs({ surface, anchorKey })}`),
  markEnsembleApplied: (id: string, callId: string, undoEntryId?: string | null) =>
    post(`/api/ensemble/replies/${id}/applied`, { callId, ...(undoEntryId ? { undoEntryId } : {}) }),
  watchers: () =>
    get<{
      watchers: Array<{
        id: string;
        message: string;
        status: string;
        condition: string;
        scopeKind: string;
        daysBefore: number | null;
        createdAt: string;
      }>;
    }>("/api/watchers"),
  cancelWatcher: (id: string) => post(`/api/watchers/${id}/cancel`),

  comments: (kind: string, id: string) =>
    get<{ comments: PageComment[] }>(`/api/pages/${kind}/${id}/comments`),
  createComment: (kind: string, id: string, body: { markId?: string; quote?: string; body: { text: string }; mentions?: unknown[] }) =>
    post<{ comment: PageComment }>(`/api/pages/${kind}/${id}/comments`, body),
  patchComment: (id: string, body: { body?: { text: string }; status?: "open" | "resolved" }) =>
    patch<{ comment: PageComment }>(`/api/comments/${id}`, body),
  deleteComment: (id: string) => del<void>(`/api/comments/${id}`),

  completed: (query: { q?: string; kind?: string; projectId?: string } = {}) =>
    get<{ items: CompletedItem[] }>(`/api/completed${qs(query)}`),
  reopenTask: (id: string) => post(`/api/tasks/${id}/reopen`),
  reopenDeliverable: (id: string) => post(`/api/deliverables/${id}/reopen`),
  pinTask: (id: string, pinned: boolean) => post(`/api/tasks/${id}/pin`, { pinned }),
  pinDeliverable: (id: string, pinned: boolean) => post(`/api/deliverables/${id}/pin`, { pinned }),
  deleteDeliverable: (id: string) => del<void>(`/api/deliverables/${id}`),
  deleteReminder: (id: string) => del<void>(`/api/reminders/${id}`),
  githubGit: () => get<{ hint: string | null }>(`/api/secrets/github`),
  saveGithubGit: (token: string) => put<{ hint: string }>(`/api/secrets/github`, { token }),
  deleteGithubGit: () => del<void>(`/api/secrets/github`),

  notifications: () => get<{ notifications: HubNotification[] }>("/api/notifications"),
  readNotification: (id: string) => post<{ updated: number }>(`/api/notifications/${id}/read`),
  readNotifications: () => post<{ updated: number }>("/api/notifications/read"),
  capture: (text: string) =>
    post<{
      task: TaskRecord;
      undoEntryId: string | null;
      parsed: { title: string; due: string | null; dueLabel: string | null; matched: Array<{ id: string; name: string }>; unmatched: string[] };
    }>("/api/capture", { text }),
  searchWorkspace: (query: string, signal?: AbortSignal) => request<{ query: string; results: WorkspaceSearchHit[] }>(`/api/context/search?q=${encodeURIComponent(query)}`, { signal }),
  ask: (question: string) =>
    post<{ question: string; answer: string; sources: AskSource[]; undoEntryId?: string | null }>("/api/ask", { question }),
  meetingCues: () => get<{ cues: MeetingCue[]; voice: string }>("/api/meetings/cues"),
  meetingSessions: () => get<{ sessions: MeetingSessionRecord[]; voice: string }>("/api/meetings/sessions"),
  importedMeetings: () =>
    get<{
      notes: Array<{
        id: string;
        title: string;
        sourceLabel: string;
        occurredAt: string;
        summary: string;
        decisions: string[];
        actionItems: Array<{ text: string; owner: { name: string | null } | null; completed: boolean }>;
        people: Array<{ id: string; name: string | null }>;
      }>;
    }>("/api/meetings/imported"),
  importedMeetingNote: (id: string) =>
    get<{
      note: {
        id: string;
        title: string;
        occurredAt: string;
        summary: string;
        decisions: string[];
        actionItems: Array<{ text: string; owner: { name: string | null } | null; completed: boolean }>;
      };
    }>(`/api/meetings/notes/${id}`),
  meetingSession: (id: string) =>
    get<{ session: MeetingSessionRecord; openTasks: Array<{ id: string; title: string; href: string }>; voice: string }>(`/api/meetings/sessions/${id}`),
  startMeeting: (artifactId: string | null, title?: string) =>
    post<{ session: MeetingSessionRecord }>("/api/meetings/sessions", { artifactId, title }),
  updateMeeting: (id: string, data: { notes?: string; content?: PageDocument; title?: string }) => request<{ session: MeetingSessionRecord }>(`/api/meetings/sessions/${id}`, { method: "PATCH", json: data, surviveNavigation: true }),
  deleteMeeting: (id: string) => del<{ deleted: boolean }>(`/api/meetings/sessions/${id}`),
  saveMeetingNotes: (id: string, notes: string) => request<{ session: MeetingSessionRecord }>(`/api/meetings/sessions/${id}`, { method: "PATCH", json: { notes }, surviveNavigation: true }),
  endMeeting: (id: string) => post<{ session: MeetingSessionRecord; askAttach: boolean }>(`/api/meetings/sessions/${id}/end`),
  attachMeeting: (id: string) => post<{ session: MeetingSessionRecord; message: string; calendarWrite: boolean }>(`/api/meetings/sessions/${id}/attach`),
  declineMeeting: (id: string) => post<{ session: MeetingSessionRecord }>(`/api/meetings/sessions/${id}/decline`),
  meetingRecap: (id: string) => post<{ session: MeetingSessionRecord }>(`/api/meetings/sessions/${id}/recap`),
  summarizeMeetings: (question: string) =>
    post<{ answer: string; quotes: Array<{ text: string; title: string; href: string }> }>("/api/meetings/summarize", { question }),
  weeklyRecap: (date?: string) =>
    get<{
      label: string;
      start: string;
      end: string;
      markdown: string;
      done: Array<{ title: string; href: string; detail?: string }>;
      decided: Array<{ title: string; href: string; detail?: string }>;
      slipped: Array<{ title: string; href: string; detail?: string }>;
      meetings: Array<{ title: string; when: string; summary: string; href: string }>;
    }>(`/api/recap/week${qs({ date })}`),
  nudges: () => get<{ days: number; nudges: Array<{ id: string; title: string; question: string; reasons: string[] }> }>("/api/nudges"),
  nudge: (taskId: string, action: "keep" | "snooze" | "done" | "trash") =>
    post<{ action: string; undoEntryId?: string | null }>(`/api/nudges/${taskId}`, { action }),

  diagramLinks: (query?: { targetKind?: string; targetId?: string }) =>
    get<{
      links: Array<{
        id: string;
        targetKind: string;
        targetId: string;
        diagram: { id: string; title: string; updatedAt: string; source: string; model: unknown };
      }>;
    }>(`/api/diagrams/links${qs(query ?? {})}`),
  syncDiagramLinks: (body: { targetKind: string; targetId: string; diagramIds: string[] }) =>
    put<{ ok: boolean }>("/api/diagrams/links", body),
  diagrams: () => get<{ diagrams: DiagramSummary[] }>("/api/diagrams"),
  diagram: (id: string) => get<{ diagram: DiagramDetail }>(`/api/diagrams/${id}`),
  createDiagram: (source?: string) => post<{ diagram: DiagramDetail }>("/api/diagrams", source ? { source } : {}),
  updateDiagram: (id: string, body: { source?: string; title?: string; version: number }) =>
    patch<{ diagram: DiagramDetail }>(`/api/diagrams/${id}`, body),
  deleteDiagram: (id: string) => del<void>(`/api/diagrams/${id}`),
  pageVersions: (kind: "page" | "task", id: string) => get<{ revision: number; updatedAt: string | null; versions: Array<{ id: string; revision: number; title: string; createdAt: string; author: string }> }>(`/api/page-versions?kind=${kind}&id=${encodeURIComponent(id)}`),
  pageVersion: (id: string) => get<{ version: { id: string; title: string; content: PageDocument; markdown: string } }>(`/api/page-versions/${id}`),
  restorePageVersion: (id: string, revision: number, updatedAt: string) => post<{ restored: { id: string } }>(`/api/page-versions/${id}/restore`, { revision, updatedAt }),
  duplicatePage: (id: string) => post<{ page: { id: string; title: string } }>(`/api/pages/${id}/duplicate`, {}),
  savePageTemplate: (id: string, title: string) => post<{ template: { id: string; title: string } }>(`/api/pages/${id}/template`, { title }),
  pageTemplates: () => get<{ profile: string; templates: Array<{ id: string; title: string; createdAt: string }> }>("/api/page-templates"),
  pageFromTemplate: (id: string) => post<{ page: { id: string; title: string } }>(`/api/page-templates/${id}/create`, {}),
  deletePageTemplate: (id: string) => del<void>(`/api/page-templates/${id}`),
  diagramRevisions: (id: string) =>
    get<{ current: { version: number; title: string; updatedAt: string }; revisions: Array<{ version: number; title: string; createdAt: string }> }>(
      `/api/diagrams/${id}/revisions`,
    ),
  restoreDiagram: (id: string, version: number) => post<{ diagram: DiagramDetail }>(`/api/diagrams/${id}/restore`, { version }),
  duplicateDiagram: (id: string) => post<{ diagram: DiagramDetail }>(`/api/diagrams/${id}/duplicate`),
  plots: () => get<{ plots: Array<{ id: string; title: string; datasetId: string | null; datasetName: string | null; config: unknown; updatedAt: string }> }>("/api/plots"),
  plot: (id: string) => get<{ plot: { id: string; title: string; datasetId: string | null; config: unknown; code: string }; spark: number[] }>(`/api/plots/${id}`),
  createPlot: (body?: { title?: string; datasetId?: string }) => post<{ plot: { id: string; title: string } }>("/api/plots", body ?? {}),
  createPlotSpace: () => post<{ plot: { id: string; title: string } }>("/api/plots", { title: "Untitled space", config: emptyWorkspace() }),
  updatePlot: (id: string, body: { title?: string; datasetId?: string | null; config?: unknown; code?: string }) => patch<{ plot: { id: string } }>(`/api/plots/${id}`, body),
  duplicatePlot: (id: string) => post<{ plot: { id: string; title: string } }>(`/api/plots/${id}/duplicate`),
  deletePlot: (id: string) => del<void>(`/api/plots/${id}`),
  createPlotDataset: (body: Record<string, unknown>) =>
    post<{ dataset: { id: string; name: string; columns: Array<{ name: string; type: "number" | "date" | "category" | "text" }>; rowCount: number; warnings: string[]; sheets: string[]; sheet: string } }>("/api/plots/datasets", body),
  plotDataset: (id: string, rows = false) =>
    get<{ dataset: { id: string; name: string; format: string; columns: Array<{ name: string; type: "number" | "date" | "category" | "text" }>; rowCount: number; sheet: string; sheets: string[]; rows: Array<Array<string | number | null>> } }>(`/api/plots/datasets/${id}?rows=${rows ? "1" : "0"}`),
  updatePlotDataset: (id: string, body: { columns: Array<{ name: string; type: string }> }) => patch(`/api/plots/datasets/${id}`, body),
  plotSheet: (id: string, sheet: string) => post(`/api/plots/datasets/${id}/sheet`, { sheet }),
  /** Use `renderPlot` from lib/plots/render.ts: it runs the script in the browser where the server does not. */
  renderPlotOnServer: (id: string, body: { format: "png" | "svg" | "pdf" | "eps"; code?: string; dpi?: number }) =>
    post<{ format: string; data: string; stdout: string; stderr: string }>(`/api/plots/${id}/render`, body),
  /** Whether this server runs plot Python for this account. */
  plotRuntime: () => get<{ serverPython: boolean }>("/api/plots/runtime"),
  /** The datasets and code a render runs, for running it in the browser. */
  plotRenderInput: (id: string, accent?: string) =>
    get<{ code: string; datasets: Array<{ name: string; columns: string[]; rows: Array<Array<string | number | null>> }> }>(`/api/plots/${id}/render-input${qs({ accent })}`),
  plotWorkspace: (id?: string) =>
    get<{ workspace: { id: string; title: string; config: unknown; code: string; updatedAt: string } }>(`/api/plots/workspace${qs({ id })}`),
  savePlotWorkspace: (body: { id?: string; config: unknown; code?: string; title?: string }) =>
    put<{ workspace: { id: string; config: unknown; code: string } }>("/api/plots/workspace", body),
  deletePlotDataset: (id: string) => del<void>(`/api/plots/datasets/${id}`),
  diagramFreshness: (id: string) => get<{ stale: boolean; reasons: string[] }>(`/api/diagrams/${id}/freshness`),
  layout: (surface: "today" | "context" | "board") =>
    get<{
      surface: string;
      document: LayoutDocument;
      templateId: string | null;
      source: string;
      ignored: string[];
    }>(`/api/layouts/${surface}`),
  saveLayout: (surface: "today" | "context" | "board", document: LayoutDocument) =>
    put<{ surface: string; document: LayoutDocument }>(`/api/layouts/${surface}`, document),
  resetLayout: (surface: "today" | "context" | "board") =>
    post<{ surface: string; document: LayoutDocument }>(`/api/layouts/${surface}/reset`),
  onboardingTemplates: (role: string) =>
    get<{ templates: OnboardingTemplateCard[] }>(
      `/api/onboarding/templates${qs({ role })}`,
    ),
  spaces: () => get<SpacesPayload>("/api/spaces"),
  createSpace: (data: { name: string; icon: string | null; templateId: string; settings: { mode: SpaceSettingsMode; from?: string } }) =>
    post<{ space: SpaceSummary; activeId: string }>("/api/spaces", data),
  switchSpace: (id: string) => post<{ activeId: string }>(`/api/spaces/${id}/switch`, {}),
  updateSpace: (id: string, data: { name?: string; icon?: string | null }) => patch<{ space: SpaceSummary }>(`/api/spaces/${id}`, data),
  deleteSpace: (id: string, confirmation: string) => del<void>(`/api/spaces/${id}`, { confirmation }),
  copySpaceSettings: (from: string) => post<{ copied: boolean }>("/api/spaces/settings/copy", { from }),
  syncSpaceSettings: (on: boolean, from?: string) => put<{ sync: boolean }>("/api/spaces/settings/sync", { on, from }),

  // sharing
  searchPeople: (q: string) => get<{ people: SharingPerson[] }>(`/api/sharing/people${qs({ q })}`),
  sharingOverview: () => get<SharingOverview>("/api/sharing/overview"),
  contacts: () => get<{ limit: number; contacts: SharingContact[] }>("/api/sharing/contacts"),
  addContact: (personId: string) => post<{ limit: number; contacts: SharingContact[] }>("/api/sharing/contacts", { personId }),
  removeContact: (personId: string) =>
    del<{ removed: { spaces: number; items: number }; limit: number; contacts: SharingContact[] }>(`/api/sharing/contacts/${personId}`),
  sharedWithMe: () => get<SharedWithMe>("/api/sharing/with-me"),
  spaceMembers: (spaceId: string) => get<SpaceMembers>(`/api/sharing/spaces/${spaceId}/members`),
  addMember: (spaceId: string, personId: string, role: MemberRole) =>
    post<{ limit: number; members: SpaceMember[] }>(`/api/sharing/spaces/${spaceId}/members`, { personId, role }),
  setMemberRole: (spaceId: string, personId: string, role: MemberRole) =>
    patch<{ limit: number; members: SpaceMember[] }>(`/api/sharing/spaces/${spaceId}/members/${personId}`, { role }),
  removeMember: (spaceId: string, personId: string) => del<void>(`/api/sharing/spaces/${spaceId}/members/${personId}`),
  transferSpace: (spaceId: string, toId: string, confirmation: string) =>
    post<{ transferred: boolean }>(`/api/sharing/spaces/${spaceId}/transfer`, { toId, confirmation }),
  itemShares: (kind: ShareKind, resourceId: string) =>
    get<{ viewOnly: boolean; shares: ItemShare[] }>(`/api/sharing/items${qs({ kind, resourceId })}`),
  shareItem: (data: { kind: ShareKind; resourceId: string; personId: string; role: ItemRole }) =>
    post<{ viewOnly: boolean; shares: ItemShare[] }>("/api/sharing/items", data),
  setShareRole: (id: string, role: ItemRole) => patch<{ updated: boolean }>(`/api/sharing/items/${id}`, { role }),
  removeShare: (id: string) => del<void>(`/api/sharing/items/${id}`),
  /** Sent without the share header, so a wrong or removed share gets its own answer rather than the header's 404. */
  openShare: (id: string) => withShare(null, () => get<OpenedShare>(`/api/sharing/open/${id}`)),
  presence: () => get<{ you: string; people: PresenceEntry[] }>("/api/presence"),
  sendPresence: (data: PresenceUpdate, keepalive = false) => request<void>("/api/presence", { method: "POST", json: data, keepalive }),
  publicLinks: () => get<{ limit: number; links: PublicLink[] }>("/api/links"),
  publicLinkFor: (kind: ShareKind, resourceId: string) =>
    get<{ limit: number; used: number; allowed: boolean; link: PublicLink | null }>(`/api/links/item${qs({ kind, resourceId })}`),
  setPublicLink: (data: { kind: ShareKind; resourceId: string; role: ItemRole }) => post<{ link: PublicLink; limit: number }>("/api/links", data),
  removePublicLink: (id: string) => del<void>(`/api/links/${id}`),
  rotatePublicLink: (id: string) => post<{ link: PublicLink }>(`/api/links/${id}/rotate`, {}),
  openPublicLink: () => get<OpenedLink>("/api/links/open"),
  completeOnboarding: (role: string, templateId: string) =>
    post<{ role: string; templateId: string; onboardingComplete: boolean }>("/api/onboarding", { role, templateId }),
  widgetFeed: () =>
    get<{
      tasks: Array<{
        id: string;
        title: string;
        taskType: string | null;
        due: string | null;
        status: string;
        measure: number | null;
        projectId: string | null;
        completedAt: string | null;
        updatedAt: string;
        people: string[];
      }>;
      deliverables: Array<{ id: string; title: string; due: string | null; projectId: string; projectName: string }>;
      reminders: Array<{ id: string; title: string; dueDate: string }>;
      people: Array<{ id: string; name: string }>;
      artifacts: Array<{ id: string; title: string; projectId: string | null; ts: string }>;
      meetings: Array<{ id: string; title: string; personIds: string[]; projectId: string | null; updatedAt: string }>;
      projects: Array<{ id: string; name: string; done: number; total: number }>;
      events: Array<{ id: string; title: string; start: string }>;
      pages: Array<{ taskId: string; title: string; projectId: string | null; lines: string[] }>;
    }>("/api/widgets/feed"),
  applyTemplate: (id: string) => post<{ id: string; modules: string }>("/api/marketplace/apply", { id }),
  templateHistory: () =>
    get<{
      activeTemplateId: string;
      activeName: string;
      history: Array<{ id: string; templateId: string; name: string; at: string }>;
    }>("/api/marketplace/history"),
  clearSamples: () => post<{ cleared: number }>("/api/marketplace/samples/clear", {}),
  revertTemplate: () => post<{ id: string; modules: string }>("/api/marketplace/revert", {}),
  deskLive: () => get<DeskLive>("/api/desk/live"),
  deskAdd: (kind: string, fields: Record<string, string>) =>
    post<{ id: string; kind: string; title: string; undoEntryId: string | null }>("/api/desk/entries", { kind, fields }),
  deskRemove: (kind: string, id: string) => del<{ ok: boolean }>(`/api/desk/entries/${kind}/${id}`),
});

export type SpaceSummary = { id: string; name: string; icon: string | null; primary: boolean; role: string | null; templateId: string | null; createdAt: string };
export type SpacesPayload = { activeId: string; account: { sync: boolean; role: string | null }; spaces: SpaceSummary[]; shared?: SharedSpace[] };

// ── sharing ────────────────────────────────────────────────────────────────

export type ShareKind = "page" | "task" | "board" | "diagram" | "plot_space" | "plot" | "meeting" | "skill" | "workspace" | "code";
export type MemberRole = "viewer" | "editor";
export type ItemRole = "view" | "edit";
export type SharingPerson = { id: string; name: string; initials: string; avatar?: string | null; email?: string; exact?: boolean; contact?: boolean };
export type SharingContact = { id: string; name: string; initials: string; avatar?: string | null; email: string; spaces: number; items: number; addedAt: string };
export type SpaceMember = { id: string; name: string; initials: string; avatar?: string | null; email: string; role: MemberRole; addedAt: string };
export type SpaceMembers = {
  owner: SharingPerson;
  you: "owner" | MemberRole;
  limit: number;
  members: SpaceMember[];
  canTransfer: boolean;
  transferredAt: string | null;
};
export type ItemShare = { id: string; person: SharingPerson & { email: string }; role: ItemRole; createdAt: string };
export type SharedSpace = { id: string; name: string; icon: string | null; owner: SharingPerson; role: MemberRole; since: string };
export type SharedItem = { id: string; kind: ShareKind; title: string; excerpt?: string; role: ItemRole; owner: SharingPerson; spaceName: string; since: string; openedAt: string | null };
export type SharedWithMe = { spaces: SharedSpace[]; items: SharedItem[] };
export type SharingOverview = {
  limits: { contacts: number; members: number };
  contacts: SharingContact[];
  spaces: Array<{ id: string; name: string; icon: string | null; primary: boolean; members: SpaceMember[]; transferredAt: string | null }>;
  items: Array<{ id: string; kind: ShareKind; title: string; excerpt?: string; role: ItemRole; spaceId: string; resourceId: string; createdAt: string; person: SharingPerson }>;
  withMe: SharedWithMe;
};
export type OpenedShare = { id: string; kind: ShareKind; resourceId: string; title: string; role: ItemRole; spaceId: string; owner: SharingPerson };
export type PresenceEntry = {
  accountId: string;
  tabId: string;
  name: string;
  initials: string;
  color: string;
  avatar?: string | null;
  emoji?: string | null;
  signedIn?: boolean;
  route: string | null;
  resource: { kind: ShareKind; id: string } | null;
  cursor: { x: number; y: number } | null;
  viewport: { x: number; y: number; zoom: number } | null;
  /** Their text cursor on a page: positions in the live document at `version`. */
  caret?: { anchor: number; head: number; version?: number } | null;
  typing: boolean;
  at: number;
  gone?: boolean;
};
export type PublicLink = { id: string; token: string; kind: ShareKind; resourceId: string; title: string; role: ItemRole; spaceId: string; createdAt: string; openedAt: string | null; opens: number };
export type OpenedLink = {
  kind: "page" | "task" | "diagram" | "meeting";
  resourceId: string;
  title: string;
  role: ItemRole;
  owner: { name: string; initials: string; avatar: string | null };
  you: { id: string; name: string; emoji: string | null; color: string; signedIn: boolean };
};
/** The address someone opens: /p/<token>. */
export function publicLinkUrl(token: string): string {
  return `${typeof window === "undefined" ? "" : window.location.origin}/p/${token}`;
}

export type PresenceUpdate = {
  tabId: string;
  route?: string | null;
  resource?: { kind: ShareKind; id: string } | null;
  cursor?: { x: number; y: number } | null;
  viewport?: { x: number; y: number; zoom: number } | null;
  caret?: { anchor: number; head: number; version?: number } | null;
  typing?: boolean;
  leave?: boolean;
};
export type SpaceSettingsMode = "fresh" | "copy" | "sync";

export type OnboardingTemplateCard = {
  id: string;
  role: string;
  name: string;
  blurb: string;
  desk: "semester" | "exam" | "literature" | "chambers" | "classes" | "staff" | "branch" | "bench";
  tiles: Array<[string, number, number]>;
  features: [string, string, string];
  preview: {
    project: string;
    tasks: Array<{ title: string; people: string[] }>;
    people: Array<{ name: string; role: string | null }>;
    deliverables: Array<{ title: string; dueInDays: number | null }>;
  };
};

export type DeskLive = {
  today: string;
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    taskType: string | null;
    due: string | null;
    startsAt: string | null;
    court: string | null;
    matterStage: string | null;
    orderDate: string | null;
    subject: string | null;
    weight: number | null;
    wordCount: number | null;
    pipelineStage: string | null;
    measure: number | null;
    rule: string | null;
    projectId: string | null;
    starter?: boolean;
  }>;
  deliverables: Array<{ id: string; title: string; due: string | null; status: string }>;
  people: Array<{ id: string; name: string; role: string | null; capacityHours: number | null; oneOnOneDays: number | null; lastInteraction: string | null }>;
  meetings: Array<{ id: string; title: string }>;
  /** `format` and `fileType` say what a file is: an uploaded file's extension, or the media type or type name its app gave. */
  artifacts: Array<{ id: string; title: string; kind: string; url: string | null; ts: string; source: string; format?: string | null; fileType?: string | null }>;
  reminders: Array<{ id: string; title: string; dueDate: string }>;
  slots: Array<{ id: string; title: string; weekday: number; startMin: number; endMin: number; course: string }>;
  holidays: Array<{ id: string; day: string; name: string }>;
  attendance: { present: number; absent: number };
  objectives: Array<{ id: string; title: string; progress: number }>;
  deploys: Array<{ id: string; name: string; env: string; at: string }>;
  parts: Array<{ id: string; name: string; status: string; qty: number }>;
  tests: Array<{ id: string; name: string; build: string; status: string }>;
  citations: Array<{ id: string; fromTitle: string; toTitle: string }>;
  grading: Array<{ id: string; className: string; expected: number; marked: number }>;
  repos: Array<{ id: string; fullName: string }>;
  projects: Array<{ id: string; name: string }>;
  limitation: Array<{ id: string; title: string; court: string | null; due: string; days: number; shifted: boolean; note: string | null }>;
  countdowns: Array<{ id: string; title: string; due: string; days: number }>;
};

export type AskSource = { id: string; kind: string; label: string; excerpt: string; url: string; path: string };
export type HubNotification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  urgent?: boolean;
  readAt: string | null;
  createdAt: string;
};
export type MeetingSessionRecord = {
  id: string;
  artifactId: string | null;
  title: string;
  /** Markdown of `content`. */
  notes: string;
  /** The notes as a page. Only on one meeting (not the list); null when nothing is written yet. */
  content?: PageDocument | null;
  recap: string;
  status: string;
  attachState: string;
  personIds: string[];
  startedAt: string;
  endedAt: string | null;
  href: string;
};
export type MeetingCue = {
  kind: "prep" | "live" | "follow_up" | string;
  artifactId: string | null;
  session: MeetingSessionRecord | null;
  title: string;
  start: string;
  end: string | null;
  attendees: Array<{ id: string | null; name: string }>;
  decisions: Array<{ text: string }>;
  openTasks: Array<{ id: string; title: string; status: string; due: string | null; href: string }>;
  attachState: string;
};

export type PageComment = {
  id: string;
  parentId: string | null;
  authorKind: string;
  kind: string;
  markId: string | null;
  quote: string;
  body: { text?: string; content?: unknown[] };
  status: string;
  resolved: boolean;
  model: string | null;
  tier: string | null;
  toolCalls: AssistantToolCallRecord[];
  conversationId: string | null;
  error: string | null;
  anchor: { orphaned?: boolean; quote?: string } | null;
  createdAt: string;
};

export type DiagramSummary = {
  id: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DiagramDetail = DiagramSummary & {
  source: string;
  model: unknown;
};

export type CompletedItem = {
  kind: "task" | "deliverable";
  id: string;
  title: string;
  status: string;
  priority: string | null;
  projectId: string | null;
  projectName: string | null;
  completedAt: string | null;
  pinned: boolean;
};

export type WorkspaceSearchHit = { id: string; kind: string; label: string; excerpt: string; path: string };
