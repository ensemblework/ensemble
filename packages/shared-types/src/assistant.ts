import { z } from "zod";
import { AutonomyLevel } from "./enums.js";
import { CODE_ENGINES, ContextTier } from "./subscriptions.js";

export const AssistantToolArea = z.enum(["tasks", "projects", "context", "skills", "reminders", "runs", "apps"]);
export type AssistantToolArea = z.infer<typeof AssistantToolArea>;

/**
 * Areas inside Ensemble the assistant may change. "apps" (connected apps such as
 * Google Calendar or a remote MCP server) is not listed here: it has its own
 * switch, assistant.connectedAppWrites, and every app write waits for Apply.
 */
export const ASSISTANT_WRITE_AREAS: readonly AssistantToolArea[] = AssistantToolArea.options.filter((area) => area !== "apps");

export const AssistantToolInfo = z.object({
  name: z.string(),
  area: AssistantToolArea,
  description: z.string(),
  isWrite: z.boolean(),
  risk: z.enum(["low", "medium", "high"]),
  undoable: z.boolean(),
});
export type AssistantToolInfo = z.infer<typeof AssistantToolInfo>;

export const AssistantPageContext = z.object({
  path: z.string(),
  label: z.string().optional(),
  taskId: z.string().optional(),
  projectId: z.string().optional(),
  meetingId: z.string().max(64).optional(),
  selection: z.string().max(2000).optional(),
  surface: z.object({
    kind: z.enum(["desk", "board", "context", "widgets"]),
    tab: z.string().max(40).optional(),
    filters: z.record(z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).optional(),
    selectedIds: z.array(z.string().uuid()).max(100).optional(),
    visibleIds: z.array(z.string().uuid()).max(100).optional(),
    tiles: z.array(z.object({ key: z.string().max(100), title: z.string().max(200).optional(), c: z.number().int().min(1).max(12), r: z.number().int().min(1).max(8) })).max(100).optional(),
  }).optional(),
});
export type AssistantPageContext = z.infer<typeof AssistantPageContext>;

export const AssistantToolCallState = z.enum(["ok", "failed", "awaiting_approval", "applying"]);
export type AssistantToolCallState = z.infer<typeof AssistantToolCallState>;

export const AssistantToolCall = z.object({
  id: z.string(),
  name: z.string(),
  area: AssistantToolArea.optional(),
  arguments: z.unknown().optional(),
  input: z.record(z.unknown()).optional(),
  summary: z.string().optional(),
  state: AssistantToolCallState.optional(),
  isWrite: z.boolean().optional(),
  durationMs: z.number().optional(),
  href: z.string().optional(),
  undoEntryId: z.string().optional(),
  error: z.string().optional(),
});
export type AssistantToolCall = z.infer<typeof AssistantToolCall>;

export const AssistantStreamFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), text: z.string() }),
  z.object({ type: z.literal("tool"), call: AssistantToolCall }),
  z.object({ type: z.literal("pending"), call: AssistantToolCall, preview: z.string() }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done") }),
]);
export type AssistantStreamFrame = z.infer<typeof AssistantStreamFrame>;

export const EntityMentionKind = z.enum(["people", "project", "repo", "task", "deliverable", "skill", "diagram", "plot", "dataset", "file"]);
export type EntityMentionKind = z.infer<typeof EntityMentionKind>;

export const MentionKind = z.enum(["people", "project", "repo", "task", "deliverable", "skill", "diagram", "plot", "dataset", "file", "date"]);
export type MentionKind = z.infer<typeof MentionKind>;

export const AssistantWritePolicy = z.enum(["immediate", "preview", "needs-me"]);
export type AssistantWritePolicy = z.infer<typeof AssistantWritePolicy>;

export const ActAs = z.enum(["general", "student", "engineer", "teacher", "lawyer", "researcher", "manager", "aspirant", "maker"]);
export type ActAs = z.infer<typeof ActAs>;

export const AssistantSettings = z.object({
  allowedWriteAreas: z.array(AssistantToolArea).default([...ASSISTANT_WRITE_AREAS]),
  writePolicy: AssistantWritePolicy.default("immediate"),
  model: z.string().default("auto"),
  reasoningEffort: z.string().optional(),
  defaultTier: z.enum(["easy", "medium", "high", "max"]).default("medium"),
  /** Tone and suggested actions only. Never permissions or tools. */
  actAs: ActAs.default("general"),
  /** Lets the assistant propose changes in connected apps (calendar events, documents, MCP tools). Each one still waits for Apply. */
  connectedAppWrites: z.boolean().default(true),
});
export type AssistantSettings = z.infer<typeof AssistantSettings>;

// ── appearance ─────────────────────────────────────────────────────────────

export const AppFont = z.enum(["system", "inter", "plex", "georgia", "mono"]);
export type AppFont = z.infer<typeof AppFont>;

export const AccentPreset = z.enum(["gold", "indigo", "tide", "ember", "rose", "brass", "orchid", "moss", "sky"]);
export type AccentPreset = z.infer<typeof AccentPreset>;

export const MotionTheme = z.enum(["expressive", "minimal-quiet", "minimal-dot"]).transform(() => "expressive" as const);
export type MotionTheme = z.infer<typeof MotionTheme>;

export const AppColorTheme = z.enum(["ensemble", "aubergine", "graphite", "lagoon", "aurora", "juniper", "blueprint"]);
export type AppColorTheme = z.infer<typeof AppColorTheme>;

export const AppearanceSettings = z.object({
  theme: z.enum(["dark", "light", "system"]).default("dark"),
  colorTheme: AppColorTheme.default("ensemble"),
  textScale: z.number().min(80).max(130).default(100),
  font: AppFont.default("system"),
  /** Legacy motion choices normalize to the single Expressive system. */
  motion: MotionTheme.default("expressive"),
  reduceMotion: z.boolean().default(false),
  sidebarAutoCollapse: z.boolean().default(false),
  pagesPanelSide: z.enum(["left", "right"]).default("left"),
  /** Curated accent. Ignored while accentCustom is set. */
  accent: AccentPreset.default("gold"),
  /** User-picked #rrggbb. Null means the preset is in use. */
  accentCustom: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),
});
export type AppearanceSettings = z.infer<typeof AppearanceSettings>;

/** Code-space theme. Stored on the user, not the whole app. No database migration: settings are a JSON document. */
export const IdeThemeFavourite = z.object({
  id: z.string().min(1).max(240),
  label: z.string().min(1).max(80),
  kind: z.enum(["dark", "light", "hc"]),
  source: z.enum(["builtin", "openvsx", "import"]),
});
export type IdeThemeFavourite = z.infer<typeof IdeThemeFavourite>;

export const IdeThemeSettings = z.object({
  activeId: z.string().min(1).max(240).default("builtin:ensemble-default"),
  favourites: z.array(IdeThemeFavourite).max(3).default([]),
});
export type IdeThemeSettings = z.infer<typeof IdeThemeSettings>;

// ── models & orchestration ─────────────────────────────────────────────────

export const ModelProvider = z.enum([
  "openai",
  "anthropic",
  "google",
  "mistral",
  "kimi",
  "qwen",
  "copilot",
  "cursor",
  "ollama",
  "openrouter",
  // Models the operator hosts on Azure and pays for, metered in Ensemble credits (included.ts).
  "ensemble",
  // The person's own AI subscription, run by that vendor's agent on their paired computer (subscriptions.ts).
  "claude-code",
  "codex",
  "cursor-agent",
  "copilot-cli",
  "mock",
]);
export type ModelProvider = z.infer<typeof ModelProvider>;

/** "default" sends no level. Which of the others a model takes is in model-efforts.ts. */
export const ReasoningEffort = z.enum(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const ModelTier = z.object({
  provider: ModelProvider.default("google"),
  model: z.string().default("gemini-3.5-flash-lite"),
  effort: ReasoningEffort.default("default"),
  /** The context window, for models that offer more than one (Copilot's long_context). Unset: the model's default. */
  context: ContextTier.optional(),
});
export type ModelTier = z.infer<typeof ModelTier>;

// Cheapest first: a fresh install should not spend much until someone chooses otherwise.
export const ModelSettings = z.object({
  easy: ModelTier.default({ model: "gemini-3.5-flash-lite", effort: "minimal" }),
  medium: ModelTier.default({ model: "gemini-3.5-flash-lite", effort: "low" }),
  high: ModelTier.default({ model: "gemini-3.5-flash", effort: "medium" }),
  max: ModelTier.default({ model: "gemini-3.5-flash", effort: "high" }),
  embedding: z.string().default("text-embedding-3-large"),
  ollamaUrl: z.string().default("http://127.0.0.1:11434"),
  /** The person's own paired computers (the CLI, the desktop app) may use these keys for their model calls. */
  keysOnComputers: z.boolean().default(true),
  /**
   * The paired computer that runs tiers set to a subscription (claude-code, codex, …). Null: the
   * computer seen most recently that has that agent.
   */
  computer: z.string().max(80).nullable().default(null),
});
export type ModelSettings = z.infer<typeof ModelSettings>;

export const OutsideAccess = z.enum(["none", "read", "read-write"]);
export type OutsideAccess = z.infer<typeof OutsideAccess>;

export const OrchestrationSettings = z.object({
  dailyHighRiskLimit: z.number().int().min(0).max(500).default(20),
  sandboxNetwork: z.boolean().default(true),
  runWithoutAsking: z.boolean().default(true),
  placeByPriority: z.boolean().default(true),
  maxConcurrentJobs: z.number().int().min(1).max(8).default(3),
  maxTurns: z.number().int().min(5).max(200).default(40),
  maxMinutes: z.number().int().min(5).max(480).default(60),
  planWithTaskModel: z.boolean().default(true),
  requireTestsBeforeCommit: z.boolean().default(true),
  defaultExecution: z.enum(["sandbox", "native"]).default("sandbox"),
  /**
   * In a sandboxed run, what the agent may do with a path outside its work
   * folder without asking: read it (default), read and write it, or nothing.
   * Anything not covered asks in Ask mode and is refused in Review only and
   * Run unattended. Keys, dotfiles, Ensemble's data and code stay refused.
   * Unsandboxed runs are not affected.
   */
  outsideAccess: OutsideAccess.default("read"),
  /**
   * Only sessions Ensemble opened send prompts through its hook. Normalize older saved
   * values while keeping other editor sessions in their own app.
   */
  editorRequests: z.enum(["ensemble", "all"]).default("ensemble").transform(() => "ensemble" as const),
  defaultDelivery: z.enum(["review-first", "unattended"]).default("review-first"),
});
export type OrchestrationSettings = z.infer<typeof OrchestrationSettings>;

/** Ask, Review only (commands run without asking; only decisions reach the person), Run unattended. */
export const RunMode = z.enum(["ask", "review", "unattended"]);
export type RunMode = z.infer<typeof RunMode>;

/** A git branch name: no leading dash, no "..", no spaces or special characters. */
export const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

/**
 * A code run that ends in a pull request (docs/24 §5.1). Ensemble pushes the run's branch and opens it
 * into `base`, any branch the person names (empty: the repository's default branch); `merge`: ask the
 * person on Needs me, merge when its checks pass, or leave it open.
 */
export const PullRequestPlan = z.object({
  base: z
    .string()
    .trim()
    .max(200)
    .refine((value) => value === "" || BRANCH_NAME.test(value), "Give a branch name git accepts.")
    .default(""),
  merge: z.enum(["ask", "auto", "never"]).default("ask"),
});
export type PullRequestPlan = z.infer<typeof PullRequestPlan>;

/** Why `branch` cannot be the branch a run's pull request comes from (git's and GitHub's own rules), or null. */
export function pullRequestHeadRefusal(branch: string, base: string): string | null {
  if (!BRANCH_NAME.test(branch)) return `“${branch.slice(0, 80)}” is not a branch name git accepts.`;
  if (base && branch === base) return `A pull request cannot come from ${base} into itself. Name another branch for the run.`;
  return null;
}

/**
 * A saved set of Assign options, picked in one click from the Assign dialog,
 * the board or the CLI. At most three per person; one can be the default.
 * Task-specific choices (which folder, which earlier task, a branch name) are
 * not part of a profile.
 */
export const RunProfile = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(40),
  kind: z.enum(["research", "code"]).default("code"),
  /** A preferred paired computer. Null: this server when it runs code, else the first computer. */
  deviceId: z.string().max(100).nullable().default(null),
  /** Who does the work: Ensemble's own agent, or the person's own coding agent on their computer (CODE_ENGINES). */
  engine: z.enum(["ensemble", ...CODE_ENGINES]).default("ensemble"),
  /** `provider::model`, or empty for the task's tier. With an engine: its model name, or empty for its default. */
  model: z.string().max(240).default(""),
  effort: ReasoningEffort.default("default"),
  /** The model's context window, where it offers more than one (GitHub Copilot). Unset: the default. */
  context: ContextTier.optional(),
  branchMode: z.enum(["as-is", "new"]).default("as-is"),
  /** Git for the run: `push` lets the agent commit, push any branch and work with pull requests; `local` and `commit` are limits the person picks. */
  delivery: z.enum(["local", "commit", "push"]).default("push"),
  askBeforePublish: z.boolean().default(true),
  mode: RunMode.default("ask"),
  sandbox: z.boolean().default(true),
  useCredentials: z.boolean().default(false),
  network: z.boolean().default(true),
  markDone: z.boolean().default(true),
  maxMinutes: z.number().int().min(1).max(480).nullable().default(null),
  maxToolCalls: z.number().int().min(5).max(500).nullable().default(null),
  maxTurns: z.number().int().min(3).max(200).nullable().default(null),
  instructions: z.string().max(2000).default(""),
  /** End each run in a pull request Ensemble opens into this base (empty: the default branch), and whether to merge it. */
  pullRequest: PullRequestPlan.nullable().default(null),
});
export type RunProfile = z.infer<typeof RunProfile>;
export const MAX_RUN_PROFILES = 3;
export const QUICK_PROFILE_ID = "quick";

/** The built-in profile while none is saved: code in its own checkout, git without limits, Ask. */
export function quickRunProfile(orchestration?: { defaultExecution?: string; sandboxNetwork?: boolean } | null): RunProfile {
  return {
    id: QUICK_PROFILE_ID,
    name: "Quick",
    kind: "code",
    deviceId: null,
    engine: "ensemble",
    model: "",
    effort: "default",
    branchMode: "as-is",
    delivery: "push",
    askBeforePublish: true,
    mode: "ask",
    sandbox: orchestration?.defaultExecution !== "native",
    useCredentials: false,
    network: orchestration?.sandboxNetwork ?? true,
    markDone: true,
    maxMinutes: null,
    maxToolCalls: null,
    maxTurns: null,
    instructions: "",
    pullRequest: null,
  };
}

/** The profile a run uses: the one named (by id or name), else the default, else the first saved, else Quick. */
export function pickRunProfile(
  settings: { runProfiles: RunProfile[]; defaultRunProfileId: string | null; orchestration?: { defaultExecution?: string; sandboxNetwork?: boolean } | null },
  wanted?: string | null,
): RunProfile {
  const key = wanted?.trim().toLowerCase();
  const named = key ? settings.runProfiles.find((profile) => profile.id.toLowerCase() === key || profile.name.toLowerCase() === key) : undefined;
  return named ?? settings.runProfiles.find((profile) => profile.id === settings.defaultRunProfileId) ?? settings.runProfiles[0] ?? quickRunProfile(settings.orchestration);
}

// ── sources & schedule ─────────────────────────────────────────────────────

export const ConnectorId = z.enum([
  "gmail",
  "google_calendar",
  "outlook",
  "outlook_calendar",
  "github",
  "teams",
  "slack",
  "linear",
  "meeting_notes",
  // Meeting-notes sources with a pasted API key (hub-api connectors/meetings).
  "fireflies",
  "fathom",
  "granola",
  "tldv",
  "krisp",
  "jamie",
  "otter",
]);
export type ConnectorId = z.infer<typeof ConnectorId>;

export const ConnectionSettings = z.object({
  enabled: z.boolean().default(false),
  scope: z.string().default(""),
});
export type ConnectionSettings = z.infer<typeof ConnectionSettings>;

export const FetchSettings = z.object({
  /** Scheduled fetching is paused product-wide until routines replace it; Sync now still works. */
  scheduled: z.boolean().default(false),
  times: z.array(z.string().regex(/^\d{2}:\d{2}$/)).default(["09:00", "16:00"]),
  proposeTodos: z.boolean().default(true),
  lookbackDays: z.number().int().min(1).max(30).default(3),
});
export type FetchSettings = z.infer<typeof FetchSettings>;

export const QuietHours = z.object({
  enabled: z.boolean().default(true),
  from: z.string().default("19:00"),
  until: z.string().default("08:00"),
});
export type QuietHours = z.infer<typeof QuietHours>;

/** In-app only. Nothing here sends mail. */
export const MorningBriefSettings = z.object({
  enabled: z.boolean().default(true),
  time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).default("08:00"),
});
export type MorningBriefSettings = z.infer<typeof MorningBriefSettings>;

/** How long an open item can sit untouched before Ensemble asks if it still matters. */
export const StaleNudgeSettings = z.object({
  enabled: z.boolean().default(true),
  untouchedDays: z.number().int().min(1).max(180).default(14),
});
export type StaleNudgeSettings = z.infer<typeof StaleNudgeSettings>;

export const TerminalSettingsShape = z.object({
  enabled: z.boolean().default(true),
  roots: z.array(z.string()).default([]),
  keepReviewCache: z.boolean().default(false),
  branchPrefix: z.string().default("ensemble/"),
  commitAuthor: z.string().default(""),
  signCommits: z.boolean().default(false),
});
export type TerminalSettingsShape = z.infer<typeof TerminalSettingsShape>;

/**
 * Folders the Code tab may list and review. Separate from `terminal.roots`:
 * the terminal never reads this list and Code never reads the terminal's.
 */
export const CodeSettingsShape = z.object({
  roots: z.array(z.string()).default([]),
});
export type CodeSettingsShape = z.infer<typeof CodeSettingsShape>;

export const Settings = z.object({
  assistant: AssistantSettings.default({}),
  autonomy: AutonomyLevel.default("assist"),
  appearance: AppearanceSettings.default({}),
  ideTheme: IdeThemeSettings.default({}),
  models: ModelSettings.default({}),
  orchestration: OrchestrationSettings.default({}),
  /** Up to three saved Assign settings (`RunProfile`). */
  runProfiles: z
    .array(RunProfile)
    .max(MAX_RUN_PROFILES, "Keep at most three run profiles.")
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, "Run profile ids must be unique.")
    .default([]),
  /** The profile Quick assign uses. Null: the first profile, or the built-in Quick settings. */
  defaultRunProfileId: z.string().max(40).nullable().default(null),
  retentionDays: z.number().int().min(1).max(365).default(30),
  /** Undo stack depth. Never unlimited. */
  undoDepth: z.number().int().min(3).max(20).default(5),
  /** audit_ledger and task_transitions. Separate from Trash retention. */
  historyRetentionDays: z.number().int().min(30).max(365).default(90),
  /** How many recently completed rows a board or list shows before the Completed view. */
  completedVisible: z.number().int().min(3).max(20).default(5),
  /** Side-peek width as a percent of the page. One value for every page, task, deliverable, and project. */
  pageWidth: z.number().int().min(28).max(80).default(50),
  /** Completed tasks and deliverables are soft-deleted after this many days unless pinned. */
  completedRetentionDays: z.number().int().min(1).max(365).default(60),
  /** Done tasks newer than this stay on the Context graph. 0 hides them until "Completed" is ticked. */
  contextReviewDays: z.number().int().min(0).max(365).default(14),
  desktopReminders: z.boolean().default(false),
  terminal: TerminalSettingsShape.default({}),
  code: CodeSettingsShape.default({}),
  fetch: FetchSettings.default({}),
  quietHours: QuietHours.default({}),
  morningBrief: MorningBriefSettings.default({}),
  staleNudge: StaleNudgeSettings.default({}),
  connections: z.record(ConnectorId, ConnectionSettings).default({}),
  /** Per connector-store entry (e.g. google_workspace), which products are switched on. Missing keys use the catalog default. */
  connectorProducts: z.record(z.string(), z.record(z.string(), z.boolean())).default({}),
  timezone: z.string().default("Asia/Kolkata"),
  timezoneMode: z.enum(["auto", "manual"]).default("auto"),
  email: z.string().default("you@ensemble.local"),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = Settings.parse({});

export const ASSISTANT_UNAVAILABLE = "The assistant is unavailable right now. Try again in a minute.";

/** Network diagnostics are for operator logs, never a substitute for a model reply. */
export function assistantErrorText(message: string): string {
  return /model runtime|fetch failed|ECONNREFUSED|ENOTFOUND|failed to fetch|networkerror/i.test(message) ? ASSISTANT_UNAVAILABLE : message;
}
