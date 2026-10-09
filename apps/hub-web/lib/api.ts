import type { IdeTheme, ThemeDirectoryExtension } from "@ensemble/ide-theme";
import { emptyWorkspace, type PageDocument, type Settings } from "@ensemble/shared-types";
import type { LayoutDocument } from "@ensemble/shared-types/widgets";

import { bindClient, currentExternalSignal, isRequestCancelled, RequestCancelledError, trackRequest, isPageUnloading } from "./fetch-cancel";
import { resolveHubApi } from "./hub-origin";
import type { ApplyFailure } from "./assistant-apply";

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

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const OFFLINE = "Ensemble can't reach its server right now.";

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
export function setOpenShare(id: string | null): void {
  openShare = id;
}
export function currentShare(): string | null {
  return openShare;
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
    if (!["/login", "/signup"].includes(here)) window.location.href = `/login?next=${encodeURIComponent(here + window.location.search)}`;
  }
  if (!response.ok) {
    const text = await response.text();
    const message = serverErrorMessage(text);
    if (message) throw new ApiError(message, response.status);
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

export type PageRecord = {
  taskId: string;
  revision: number;
  content: PageDocument | null;
  notes: string;
  notesChangedExternally: boolean;
  updatedAt: string | null;
};

export type StandalonePageSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type StandalonePageRecord = {
  id: string;
  title: string;
  taskId: null;
  revision: number;
  content: PageDocument | null;
  notes: string;
  updatedAt: string | null;
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
};

export type DocumentRecord = {
  id: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  format: string;
  parseStatus: string;
  enrichmentStatus: string;
  textCharacters: number;
  summary: string | null;
  enrichmentError?: unknown;
  sha256: string;
  createdAt: string;
  parsedAt: string | null;
  projectIds: string[];
  personIds: string[];
  repoIds: string[];
  taskIds: string[];
  warnings: string[];
  modelUsage: unknown;
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
  id: string;
  taskId: string;
  title: string;
  worker: string;
  outcome: string | null;
  error: string | null;
  model: string | null;
  credits: number | null;
  startedAt: string;
  endedAt: string | null;
  stepCount: number;
};

export type RunDetail = {
  id: string;
  outcome: string | null;
  result: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
  plannerModel: string | null;
  task: { id: string; title: string };
  steps: Array<{
    id: string;
    index: number;
    title: string;
    status: string;
    output: string | null;
    error: string | null;
    model: string | null;
    credits: number | null;
    toolCalls: unknown;
  }>;
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
  accessMode?: "review" | "read-write";
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
  /** Set when the job was claimed from Ensemble on the web. */
  origin?: "local" | "web";
};

export type WorkspaceBoard = {
  root: string;
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
  strength: "strong" | "advisory" | "ask";
  osSandbox: boolean;
  mechanism: string;
  reason: string;
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
  online: boolean;
  lastHeartbeatAt: number | null;
  disconnected: { at: string; reason: string } | null;
  unreachable: string | null;
  platform: string;
};

export type AssignInput = {
  taskId: string;
  kind: "research" | "code";
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
  markDone?: boolean;
  unattended?: boolean;
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
  at: string;
};

export type MetricsSummary = {
  days: Array<{ day: string; calls: number; tokensIn: number; tokensOut: number; estimatedUsd: number | null }>;
  byModel: Array<{ model: string; provider: string; calls: number; tokensIn: number; tokensOut: number; estimatedUsd: number | null }>;
  byPurpose: Array<{ purpose: string; calls: number; tokensIn: number; tokensOut: number; estimatedUsd: number | null }>;
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
};

export type ModelCatalog = {
  providers: Array<{
    provider: string;
    available: boolean;
    models: string[];
    notes?: Record<string, { available: boolean; reason: string | null }>;
    source: "you" | "env" | "cli" | "none" | "local";
    chat: boolean;
    cheapest: string | null;
    error: string | null;
  }>;
  runtime: boolean;
  error?: string;
  updatedAt: string;
};

export type ModelKey = { provider: string; source: "you" | "env" | "none"; hint: string | null; updatedAt: string | null };

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
  };
  sessionId: string | null;
  cwd: string | null;
  status: "pending" | "decided" | "expired";
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
  createPage: () => post<{ page: StandalonePageSummary }>("/api/pages", {}),
  convertPage: (kind: "page" | "task", id: string, revision: number) =>
    post<{ kind: "page" | "task"; id: string; pageId: string }>(`/api/pages/${kind}/${id}/convert`, { revision }),
  renamePage: (id: string, title: string) => patch<{ page: StandalonePageSummary }>(`/api/pages/${id}`, { title }),
  deletePage: (id: string) => del<void>(`/api/pages/${id}`),
  standalonePage: (id: string) => get<StandalonePageRecord>(`/api/pages/${id}`),
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
  decideAgent: (id: string, data: { decision: "allow" | "deny"; scope: "once" | "session" | "always"; reason?: string }) =>
    post<{ decision: AgentDecisionRecord }>(`/api/decisions/${id}/decide`, data),
  decisionRules: () => get<{ rules: DecisionRuleRecord[] }>("/api/decision-rules"),
  deleteDecisionRule: (id: string) => del<void>(`/api/decision-rules/${id}`),
  editorSetup: () => get<{ node: string; script: string; apiUrl: string }>("/api/editors/setup"),

  // connectors
  connectorApps: () => get<{ apps: ConnectorApp[]; canEdit: boolean }>("/api/connectors/apps"),
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
  artifacts: (params: { kind?: string; q?: string } = {}) =>
    get<{
      artifacts: ArtifactRecord[];
      counts: Array<{ kind: string; count: number }>;
      sync: Array<{ connector: string; lastSyncAt: string | null; itemCount: number; lastError: string | null }>;
    }>(`/api/artifacts${qs(params)}`),
  documents: (q?: string) => get<{ documents: DocumentRecord[] }>(`/api/documents${qs({ q })}`),
  uploadDocument: (data: { filename: string; mediaType: string; dataBase64: string; summarize: boolean }) =>
    post<{ document: { id: string } }>("/api/documents", data),
  documentText: (id: string) => get<{ text: string }>(`/api/documents/${id}/text`),
  documentUrl: (id: string) => `${API}/api/documents/${id}/original`,
  deleteDocument: (id: string) => del(`/api/documents/${id}`),
  graph: (includeCompleted = false) =>
    get<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/api/context/graph${qs({ includeCompleted })}`),

  // skills
  skills: () => get<{ skills: SkillRecord[] }>("/api/skills"),
  skill: (id: string) => get<{ skill: SkillRecord }>(`/api/skills/${id}`),
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
  run: (id: string) => get<{ run: RunDetail }>(`/api/runs/${id}`),
  deleteRun: (id: string) => del(`/api/runs/${id}`),
  workspace: () => get<WorkspaceBoard>("/api/workspace"),
  assign: (data: AssignInput) => post<{ jobId: string }>("/api/agent/assign", data),
  taskJobs: (taskId: string) => get<{ jobs: AgentJob[] }>(`/api/agent/jobs${qs({ taskId })}`),
  job: (id: string) =>
    get<{ job: AgentJob & { instructions: string; networkAccess: boolean; sandbox?: SandboxCaps & { effective: boolean } }; events: JobEvent[]; log?: string }>(`/api/agent/jobs/${id}`),
  jobLogs: (id: string, after = 0) => get<{ chunks: Array<{ seqFrom: number; seqTo: number; text: string; bytes: number; at: string }> }>(`/api/agent/jobs/${id}/logs${qs({ after })}`),
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
  pairDevice: () => post<{ code: string; expiresAt: string }>("/api/devices/pair", {}),
  revokeDevice: (id: string) => del<void>(`/api/devices/${id}`),
  stopJob: (id: string) => post(`/api/agent/jobs/${id}/stop`),
  retryJob: (id: string) => post<{ jobId: string }>(`/api/agent/jobs/${id}/retry`),
  workspaceGuard: () => get<{ root: string; sandboxAvailable: boolean; sandbox: SandboxCaps }>("/api/workspace/guard"),
  checkouts: () => get<{ checkouts: Array<{ jobId: string; title: string; status: string; folder: string; branch: string; createdAt: string }> }>("/api/workspace/checkouts"),
  resolveFolder: (path: string) => post<{ path: string; git: boolean; branch: string | null }>("/api/workspace/resolve-folder", { path }),
  trustedFolders: () => get<{ folders: Array<{ id: string; path: string; createdAt: string }> }>("/api/workspace/trust"),
  pickFolder: () => post<{ path: string; git: boolean } | undefined>("/api/workspace/pick-folder"),
  branches: (path: string) => get<{ branches: string[] }>(`/api/workspace/branches${qs({ path })}`),
  agentState: () => get<AgentState>("/api/agent/state"),
  remote: () => get<RemoteMac>("/api/remote"),
  saveRemote: (body: { enabled?: boolean; runBranchPush?: boolean; apiBase?: string | null; deviceName?: string }) => put<RemoteMac>("/api/remote", body),
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
    get<{ content: string }>(`/api/code/file${qs({ ...source, path })}`),
  saveCodeFile: (source: { review?: string; repo?: string }, path: string, content: string) =>
    put("/api/code/file", { ...source, path, content }),
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
  verifyLedger: () => post<{ ok: boolean; checked: number; brokenAt?: string }>("/api/ledger/verify"),

  // settings & system
  settings: () => get<{ settings: Settings }>("/api/settings"),
  saveSettings: (data: unknown) => patch<{ settings: Settings }>("/api/settings", data),
  connections: () => get<{ connections: Connection[]; attention: number; lastFetch: string | null }>("/api/connections"),
  syncConnection: (id: string) => post<{ ok: boolean; message: string; proposed?: number }>(`/api/connections/${id}/sync`),
  fetchNow: () => post<{ results: Array<{ id: string; ok: boolean; message: string }>; message?: string }>("/api/fetch"),
  models: () => get<ModelCatalog>("/api/models"),
  prompts: () => get<{ prompts: Array<{ id: string; title: string; when: string; purpose: string; body?: string }> }>("/api/prompts"),
  deleted: () => get<{ items: Array<{ kind: string; id: string; label: string; deletedAt: string }> }>("/api/deleted"),
  restoreDeleted: (data: { kind?: string; id?: string } = {}) => post<{ restored: number }>("/api/deleted/restore", data),
  emptyDeleted: () => post<{ removed: number }>("/api/deleted/empty"),
  deleteMyData: (scope: "context" | "everything", confirm: string) => post("/api/data/delete", { scope, confirm }),
  activity: () => get<{ activities: Array<{ id: string; kind: string; label: string; detail?: string }> }>("/api/activity"),

  // assistant
  conversations: () => get<{ conversations: ConversationRecord[] }>("/api/assistant/conversations"),
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
  updateMeeting: (id: string, data: { notes: string; title: string }) => request<{ session: MeetingSessionRecord }>(`/api/meetings/sessions/${id}`, { method: "PATCH", json: data, surviveNavigation: true }),
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
  renderPlot: (id: string, body: { format: "png" | "svg" | "pdf" | "eps"; code?: string; dpi?: number }) =>
    post<{ format: string; data: string; stdout: string; stderr: string }>(`/api/plots/${id}/render`, body),
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
  openShare: (id: string) => get<OpenedShare>(`/api/sharing/open/${id}`),
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
export type SharedItem = { id: string; kind: ShareKind; title: string; role: ItemRole; owner: SharingPerson; spaceName: string; since: string; openedAt: string | null };
export type SharedWithMe = { spaces: SharedSpace[]; items: SharedItem[] };
export type SharingOverview = {
  limits: { contacts: number; members: number };
  contacts: SharingContact[];
  spaces: Array<{ id: string; name: string; icon: string | null; primary: boolean; members: SpaceMember[]; transferredAt: string | null }>;
  items: Array<{ id: string; kind: ShareKind; title: string; role: ItemRole; spaceId: string; resourceId: string; createdAt: string; person: SharingPerson }>;
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
  artifacts: Array<{ id: string; title: string; kind: string; url: string | null; ts: string; source: string }>;
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
  notes: string;
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
