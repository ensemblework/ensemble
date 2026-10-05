import { z } from "zod";
import { AutonomyLevel } from "./enums.js";

export const AssistantToolArea = z.enum(["tasks", "projects", "context", "skills", "reminders", "runs"]);
export type AssistantToolArea = z.infer<typeof AssistantToolArea>;

export const ASSISTANT_WRITE_AREAS: readonly AssistantToolArea[] = AssistantToolArea.options;

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

export const EntityMentionKind = z.enum(["people", "project", "repo", "task", "deliverable", "skill", "diagram", "plot"]);
export type EntityMentionKind = z.infer<typeof EntityMentionKind>;

export const MentionKind = z.enum(["people", "project", "repo", "task", "deliverable", "skill", "diagram", "plot", "date"]);
export type MentionKind = z.infer<typeof MentionKind>;

export const AssistantWritePolicy = z.enum(["immediate", "preview", "needs-me"]);
export type AssistantWritePolicy = z.infer<typeof AssistantWritePolicy>;

export const ActAs = z.enum(["general", "student", "engineer", "teacher", "lawyer", "researcher", "manager", "aspirant", "maker"]);
export type ActAs = z.infer<typeof ActAs>;

export const AssistantSettings = z.object({
  allowedWriteAreas: z.array(AssistantToolArea).default([...ASSISTANT_WRITE_AREAS]),
  writePolicy: AssistantWritePolicy.default("preview"),
  model: z.string().default("auto"),
  reasoningEffort: z.string().optional(),
  defaultTier: z.enum(["easy", "medium", "high", "max"]).default("medium"),
  /** Tone and suggested actions only. Never permissions or tools. */
  actAs: ActAs.default("general"),
});
export type AssistantSettings = z.infer<typeof AssistantSettings>;

// ── appearance ─────────────────────────────────────────────────────────────

export const AppFont = z.enum(["system", "inter", "plex", "georgia", "mono"]);
export type AppFont = z.infer<typeof AppFont>;

export const AccentPreset = z.enum(["indigo", "tide", "ember", "rose", "brass", "orchid", "moss", "sky"]);
export type AccentPreset = z.infer<typeof AccentPreset>;

export const MotionTheme = z.enum(["expressive", "minimal-quiet", "minimal-dot"]);
export type MotionTheme = z.infer<typeof MotionTheme>;

export const AppearanceSettings = z.object({
  theme: z.enum(["dark", "light", "system"]).default("dark"),
  textScale: z.number().min(80).max(130).default(100),
  font: AppFont.default("system"),
  /** Expressive is the default. Minimal suites share the same slots. */
  motion: MotionTheme.default("expressive"),
  reduceMotion: z.boolean().default(false),
  /** Curated accent. Ignored while accentCustom is set. */
  accent: AccentPreset.default("indigo"),
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
  source: z.enum(["builtin", "openvsx"]),
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
  "mock",
]);
export type ModelProvider = z.infer<typeof ModelProvider>;

export const ReasoningEffort = z.enum(["default", "minimal", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const ModelTier = z.object({
  provider: ModelProvider.default("google"),
  model: z.string().default("gemini-3.5-flash-lite"),
  effort: ReasoningEffort.default("default"),
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
});
export type ModelSettings = z.infer<typeof ModelSettings>;

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
  defaultDelivery: z.enum(["review-first", "unattended"]).default("review-first"),
});
export type OrchestrationSettings = z.infer<typeof OrchestrationSettings>;

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
]);
export type ConnectorId = z.infer<typeof ConnectorId>;

export const ConnectionSettings = z.object({
  enabled: z.boolean().default(false),
  scope: z.string().default(""),
});
export type ConnectionSettings = z.infer<typeof ConnectionSettings>;

export const FetchSettings = z.object({
  scheduled: z.boolean().default(true),
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
  timezone: z.string().default("Asia/Kolkata"),
  email: z.string().default("you@ensemble.local"),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = Settings.parse({});
