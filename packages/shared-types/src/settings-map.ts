/**
 * Every setting a person can change, by Settings tab: a plain label, search words, one line
 * on what it does, and a link that opens it (`/settings?tab=…#jump-…`, resolved by
 * `apps/hub-web/components/settings/navigation.ts`).
 *
 * Entries with a `key` are the only settings the assistant may change (hub_update_settings,
 * always held for Apply). Everything else is the person's to change in Settings: secrets and
 * keys, sign-in, sharing and space membership, connections, the assistant's own permissions,
 * sandbox and run limits, folders, retention and deletion. Light/dark mode, font, text size and motion
 * have no key because they are kept per browser; a server change would not reach the screen.
 */
import { AppColorTheme, AccentPreset, ReasoningEffort } from "./assistant.js";
import { OPTIONAL_MODULES, type OptionalModule } from "./modules.js";
import { FEATURES } from "./features.js";
import { timeZoneName } from "./account.js";

export type SettingsMapTab = "account" | "appearance" | "spaces" | "sharing" | "assistant" | "connections" | "notifications" | "shortcuts" | "data";

export const SETTINGS_MAP_TABS: Readonly<Record<SettingsMapTab, string>> = {
  account: "Account",
  appearance: "Appearance",
  spaces: "Spaces",
  sharing: "Sharing",
  assistant: "Assistant",
  connections: "Connections",
  notifications: "Notifications",
  shortcuts: "Shortcuts",
  data: "Data",
};

/** What a changeable setting accepts. */
export type SettingRule =
  | { type: "enum"; values: readonly string[] }
  | { type: "boolean" }
  | { type: "int"; min: number; max: number; values?: readonly number[] }
  /** 24-hour HH:MM. */
  | { type: "time" }
  /** An IANA name such as Europe/London. */
  | { type: "timezone" }
  /** #rrggbb, or "none" to go back to the preset accent. */
  | { type: "color" };

export interface SettingsMapEntry {
  id: string;
  tab: SettingsMapTab;
  /** The card it sits in, as the page shows it. */
  section: string;
  label: string;
  keywords: string;
  about: string;
  href: string;
  /** Settings path the assistant may change (`features.<module>` is the Features switch). */
  key?: string;
  rule?: SettingRule;
  /** Only the space owner can change it; hidden from people a space is shared with. */
  ownerOnly?: boolean;
}

const at = (tab: SettingsMapTab, anchor?: string) => `/settings?tab=${tab}${anchor ? `#${anchor}` : ""}`;
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const bool: SettingRule = { type: "boolean" };
const TIERS = [
  ["easy", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["max", "Max"],
] as const;

type Row = Omit<SettingsMapEntry, "tab" | "section"> & { tab?: SettingsMapTab; section?: string };
const group = (tab: SettingsMapTab, section: string, rows: Row[]): SettingsMapEntry[] => rows.map((row) => ({ tab, section, ...row }));

export const SETTINGS_MAP: readonly SettingsMapEntry[] = [
  // ── Account ───────────────────────────────────────────────────────────────
  ...group("account", "Account", [
    { id: "account.profile", label: "Name and profile", keywords: "name full name profession organization role gender identity", about: "Your name, profession and organization.", href: at("account", "jump-account-full-name") },
    { id: "account.password", label: "Change password", keywords: "password security login sign in", about: "Set or change the password you sign in with.", href: at("account", "jump-account-change-password") },
    { id: "account.logins", label: "Linked login methods", keywords: "google github microsoft oauth sign in login", about: "Sign in with Google, GitHub or Microsoft; link or unlink them.", href: at("account", "jump-account-linked-login-methods") },
    { id: "account.sign-out", label: "Sign out", keywords: "logout log out signout", about: "Sign out of Ensemble on this browser.", href: at("account", "jump-account-sign-out") },
    { id: "account.export", label: "Export account data (JSON)", keywords: "download export backup gdpr", about: "Download everything in your account as JSON.", href: at("account", "jump-account-export-account-data-json") },
    { id: "account.delete", label: "Delete account", keywords: "close remove account erase", about: "Deletes your account and every space. It cannot be undone.", href: at("account", "jump-account-delete-account") },
  ]),
  ...group("account", "Avatar", [
    { id: "account.avatar", label: "Avatar", keywords: "profile picture photo initials face", about: "The picture or initials shown for you.", href: at("account", "jump-avatar-avatar") },
  ]),
  ...group("account", "You", [
    { id: "account.email", label: "Email", keywords: "email address identity confirm", about: "Your address: recognises your own mail and confirms destructive actions.", href: at("account", "jump-you-email") },
    { id: "account.timezone", label: "Time zone", keywords: "timezone time zone local time scheduling clock", about: "Used for due times, reminders, quiet hours and the morning brief.", href: at("account", "jump-you-time-zone"), key: "timezone", rule: { type: "timezone" } },
  ]),
  ...group("appearance", "Appearance", [
    { id: "appearance.theme", label: "Theme (dark, light, system)", keywords: "theme dark light mode system night", about: "Kept in each browser: change it here or with the light/dark switch in the account menu.", href: at("appearance", "jump-appearance-theme") },
    { id: "appearance.color-theme", label: "Color theme", keywords: "theme palette atmosphere petrol aubergine graphite lagoon aurora juniper blueprint ensemble background patterns doodles", about: "A coordinated light and dark palette. Keeps your accent, font and mode choices.", href: at("appearance", "jump-appearance-color-theme"), key: "appearance.colorTheme", rule: { type: "enum", values: AppColorTheme.options } },
    { id: "appearance.accent", label: "Accent colour", keywords: "accent colour color palette gold satin indigo tide ember rose brass orchid moss sky", about: "The highlight colour, from nine presets, with Satin Gold as the default.", href: at("appearance", "jump-appearance-accent"), key: "appearance.accent", rule: { type: "enum", values: AccentPreset.options } },
    { id: "appearance.accent-custom", label: "Custom accent colour", keywords: "custom accent colour color hex", about: "Your own accent as #rrggbb; none goes back to the preset.", href: at("appearance", "jump-appearance-custom-accent"), key: "appearance.accentCustom", rule: { type: "color" } },
    { id: "appearance.text-size", label: "Text size", keywords: "text size font size zoom scale bigger smaller", about: "Kept in each browser: change it in Appearance.", href: at("appearance", "jump-appearance-text-size") },
    { id: "appearance.font", label: "App font", keywords: "font typeface inter plex georgia monospace", about: "Kept in each browser: change it in Appearance.", href: at("appearance", "jump-appearance-app-font") },
    { id: "appearance.reduce-motion", label: "Reduce motion", keywords: "reduce motion animations accessibility", about: "Kept in each browser: change it in Appearance.", href: at("appearance", "jump-appearance-reduce-motion") },
  ]),
  ...group(
    "account",
    "Features",
    OPTIONAL_MODULES.map((id: OptionalModule) => ({
      id: `features.${id}`,
      label: `${FEATURES[id].label} feature`,
      keywords: `feature module enable disable ${id} ${FEATURES[id].label.toLowerCase()}`,
      about: `${FEATURES[id].line} Off hides it; nothing is deleted.`,
      href: at("account", `jump-feature-${slug(FEATURES[id].label)}`),
      key: `features.${id}`,
      rule: bool,
      ownerOnly: true,
    })),
  ),
  ...group("account", "Features", [
    { id: "features.desk-extras", label: "Desk extras", keywords: "desk tiles deadlines learning today", about: "Optional Today tiles for your profile, such as Deadlines and Learning.", href: at("account", "jump-features-desk-extras"), ownerOnly: true },
  ]),
  ...group("account", "This computer", [
    { id: "account.remote-tasks", label: "Allow remote tasks on this computer", keywords: "remote tasks mac computer device runner desktop", about: "Desktop app only: lets tasks assigned from the web run here.", href: at("account", "jump-this-mac-allow-remote-tasks"), ownerOnly: true },
  ]),

  // ── Spaces ────────────────────────────────────────────────────────────────
  ...group("spaces", "Spaces", [
    { id: "spaces.manage", label: "Your spaces", keywords: "space spaces rename icon open delete switch workspace", about: "Rename, change the icon of, open or delete a space.", href: at("spaces", "jump-spaces-spaces") },
    { id: "spaces.sync", label: "Keep every space in sync", keywords: "sync settings spaces same", about: "Settings saved in one space are saved in all of them.", href: at("spaces", "jump-spaces-keep-settings-in-sync") },
    { id: "spaces.copy", label: "Copy settings into this space", keywords: "copy settings from another space", about: "A one-time copy of another space's settings.", href: at("spaces", "jump-spaces-copy-settings-into-this-space") },
  ]),

  // ── Sharing ───────────────────────────────────────────────────────────────
  ...group("sharing", "Sharing", [
    { id: "sharing.contacts", label: "Contacts", keywords: "contacts people friends invite share with", about: "The people you can share spaces and items with.", href: at("sharing", "jump-sharing-contacts") },
    { id: "sharing.spaces", label: "Spaces you share", keywords: "share space members viewer editor hand over owner", about: "Who can open your spaces, as viewer or editor.", href: at("sharing", "jump-sharing-spaces-you-share") },
    { id: "sharing.items", label: "Items you shared", keywords: "shared pages tasks diagrams stop sharing", about: "Single pages, tasks and diagrams you shared, with Stop sharing.", href: at("sharing", "jump-sharing-items-you-shared") },
    { id: "sharing.with-you", label: "Shared with you", keywords: "shared with me leave space", about: "Spaces and items others shared with you.", href: at("sharing", "jump-sharing-shared-with-you") },
    { id: "sharing.links", label: "Public links", keywords: "public link anyone with the link share url", about: "Links anyone can open; turn them off here.", href: at("sharing", "jump-sharing-public-links") },
  ]),

  // ── Assistant ─────────────────────────────────────────────────────────────
  ...group("assistant", "The assistant", [
    { id: "assistant.write-policy", label: "When the assistant wants to change something", keywords: "write policy preview apply immediate needs me approve", about: "Whether its changes wait for Apply. Only you can change this.", href: at("assistant", "jump-assistant-write-policy") },
    { id: "assistant.default-tier", label: "Default model preset", keywords: "default preset tier low medium high max complexity chat model", about: "The tier the chat starts on: easy (Low), medium, high or max.", href: at("assistant", "jump-assistant-default-model-preset"), key: "assistant.defaultTier", rule: { type: "enum", values: ["easy", "medium", "high", "max"] } },
    { id: "assistant.changes", label: "What the assistant may change", keywords: "permissions allowed writes areas connected apps", about: "The areas it may change and whether it may propose changes in connected apps.", href: "/settings?tab=assistant&dialog=changes" },
  ]),
  ...group("assistant", "Models", [
    { id: "models.subscriptions", label: "Your AI subscriptions", keywords: "subscription plan claude chatgpt codex cursor copilot pro max plus sign in computer app", about: "Use your Claude, ChatGPT, Cursor or Copilot plan, on your own computer, for Ensemble's AI.", href: at("assistant", "jump-models-your-ai-subscriptions") },
    { id: "models.keys", label: "API keys", keywords: "api key keys credentials model providers anthropic openai google gemini copilot ollama openrouter provider", about: "API keys per provider, the Ollama address and the GitHub token for private clones.", href: "/settings?tab=assistant&dialog=keys" },
    { id: "models.tiers", label: "Which model each tier uses", keywords: "model provider tier low medium high max choose model", about: "Pick the provider and model for each tier from the list of models your keys reach.", href: at("assistant", "jump-models-models") },
    ...TIERS.map(([tier, name]) => ({
      id: `models.${tier}.effort`,
      label: `${name} model thinking`,
      keywords: `thinking reasoning effort ${name.toLowerCase()} tier model`,
      about: `How hard the ${name} tier's model thinks, in the levels that model takes (Off to Max).`,
      href: at("assistant", `jump-${slug(`${name} model`)}-thinking`),
      key: `models.${tier}.effort`,
      rule: { type: "enum", values: ReasoningEffort.options } as SettingRule,
    })),
  ]),
  ...group("assistant", "Watching for you", [
    { id: "assistant.watchers", label: "Watching for you", keywords: "watchers tell me when watch monitor cancel", about: "What the assistant watches after “tell me when …”, with Cancel.", href: at("assistant", "jump-watchers-watching-for-you") },
  ]),
  ...group("assistant", "Autonomy", [
    { id: "autonomy.level", label: "Autonomy level", keywords: "autonomy ask review only unattended delegate", about: "The default for newly delegated tasks.", href: at("assistant", "jump-autonomy-autonomy-level") },
    { id: "autonomy.high-risk-limit", label: "Daily high-risk write limit", keywords: "high risk limit brake sends", about: "Beyond this, unattended sends ask you first.", href: at("assistant", "jump-autonomy-daily-high-risk-write-limit") },
    { id: "autonomy.run-without-asking", label: "Run commands in the Ensemble workspace without asking", keywords: "run without asking trusted folder commands approval", about: "Commands in the trusted workspace folder run without an Allow prompt.", href: at("assistant", "jump-autonomy-run-commands-in-the-ensemble-workspace-without-asking") },
    { id: "autonomy.trust-sharing", label: "Trust folders in your other AI tools too", keywords: "trust folders claude code codex cursor share trust", about: "Desktop app and CLI: folders you trust here are trusted in those tools.", href: at("assistant", "autonomy") },
  ]),
  ...group("assistant", "Orchestration", [
    { id: "orchestration.concurrency", label: "Tasks that run at once", keywords: "parallel concurrency jobs at once queue", about: "How many agent tasks run at the same time.", href: at("assistant", "jump-orchestration-tasks-that-run-at-once") },
    { id: "orchestration.turns", label: "Model turns per task", keywords: "turn limit agent turns", about: "A task stops at this many turns and keeps its progress.", href: at("assistant", "jump-orchestration-model-turns-per-task") },
    { id: "orchestration.minutes", label: "Minutes per task", keywords: "timeout minutes duration time limit", about: "A task that takes longer is stopped; its work is kept.", href: at("assistant", "jump-orchestration-minutes-per-task") },
    { id: "orchestration.sandbox", label: "Sandbox by default", keywords: "sandbox native isolation execution", about: "New code tasks start inside this computer's sandbox.", href: at("assistant", "jump-orchestration-sandbox-by-default") },
    { id: "orchestration.network", label: "Internet for agent commands by default", keywords: "network internet sandbox commands", about: "Whether agent commands can reach the internet.", href: at("assistant", "jump-orchestration-internet-for-agent-commands-by-default") },
    { id: "orchestration.outside", label: "Outside the work folder, in sandboxed tasks", keywords: "outside access other folders read write", about: "Whether sandboxed tasks may read or write your other folders.", href: at("assistant", "orchestration") },
  ]),
  ...group("assistant", "Quiet hours", [
    { id: "quiet.enabled", label: "Quiet hours", keywords: "quiet hours do not disturb notifications night", about: "Notifications wait until morning during these hours.", href: at("assistant", "jump-quiet-quiet-hours"), key: "quietHours.enabled", rule: bool },
    { id: "quiet.from", label: "Quiet hours start", keywords: "quiet hours start from evening", about: "When quiet hours begin (HH:MM).", href: at("assistant", "jump-quiet-quiet-hours-start"), key: "quietHours.from", rule: { type: "time" } },
    { id: "quiet.until", label: "Quiet hours end", keywords: "quiet hours end until morning", about: "When quiet hours end (HH:MM).", href: at("assistant", "jump-quiet-quiet-hours-end"), key: "quietHours.until", rule: { type: "time" } },
  ]),
  ...group("assistant", "Prompts", [
    { id: "assistant.prompts", label: "Prompts", keywords: "prompts system instructions what is sent to models", about: "Every instruction Ensemble sends to a model, to read.", href: at("assistant", "jump-prompts-prompts") },
  ]),

  // ── Connections ───────────────────────────────────────────────────────────
  ...group("connections", "Connected apps", [
    { id: "connections.apps", label: "Connected apps", keywords: "connect connector integration google microsoft notion linear github slack jira disconnect", about: "Connect, disconnect and switch products of the apps Ensemble reads.", href: at("connections", "jump-connections-connections"), ownerOnly: true },
    { id: "connections.imports", label: "Imports from other apps", keywords: "import notion trello asana todoist clickup csv migration", about: "Bring tasks and pages over from other apps; recent imports.", href: at("connections", "jump-imports-imports"), ownerOnly: true },
  ]),
  ...group("connections", "Fetching", [
    { id: "fetch.sync", label: "Fetching and Sync now", keywords: "sync now fetch refresh scheduled", about: "Read your connected apps now. Scheduled fetching is paused.", href: at("connections", "jump-fetch-fetching"), ownerOnly: true },
    { id: "fetch.lookback", label: "Look back", keywords: "look back days sync gap fetch", about: "How far back a sync reads after a gap: 1, 2, 3, 7, 14 or 30 days.", href: at("connections", "jump-fetch-look-back"), key: "fetch.lookbackDays", rule: { type: "int", min: 1, max: 30, values: [1, 2, 3, 7, 14, 30] }, ownerOnly: true },
    { id: "fetch.propose", label: "Propose todos from what was read", keywords: "propose todos tasks from email sync proposals", about: "New items that need you become proposed todos on Today.", href: at("connections", "jump-fetch-propose-todos-from-what-was-read"), key: "fetch.proposeTodos", rule: bool, ownerOnly: true },
  ]),
  ...group("connections", "Editors & agents", [
    { id: "editors.connect", label: "Editors & agents", keywords: "editor vscode cursor claude code codex copilot mcp hooks connect", about: "Connect an editor or AI app to Ensemble (MCP and hooks).", href: at("connections", "jump-editors-editors-agents"), ownerOnly: true },
    { id: "editors.token", label: "Personal token", keywords: "api token personal token hooks credentials", about: "Tokens for hooks and scripts.", href: at("connections", "jump-editors-personal-token"), ownerOnly: true },
    { id: "editors.requests", label: "Which sessions come to Needs me", keywords: "needs me editor sessions prompts hooks", about: "Only tasks Ensemble opened; their connections are set up automatically.", href: at("connections", "editors"), ownerOnly: true },
  ]),
  ...group("connections", "Devices", [
    { id: "devices.list", label: "Devices", keywords: "devices paired computers laptop remove", about: "Computers paired to run tasks, with Remove.", href: at("connections", "jump-devices-devices"), ownerOnly: true },
    { id: "devices.pair", label: "Pair a computer", keywords: "pair computer desktop app cli device", about: "Pair the desktop app or the CLI.", href: at("connections", "jump-devices-pair-a-computer"), ownerOnly: true },
  ]),

  // ── Notifications ─────────────────────────────────────────────────────────
  ...group("notifications", "Morning brief", [
    { id: "brief.enabled", label: "Morning brief", keywords: "morning brief daily summary digest", about: "A note inside Ensemble each morning; it never sends email.", href: at("notifications", "jump-brief-deliver-the-morning-brief"), key: "morningBrief.enabled", rule: bool },
    { id: "brief.time", label: "Morning brief time", keywords: "morning brief time when", about: "When the brief arrives (HH:MM).", href: at("notifications", "jump-brief-morning-brief-time"), key: "morningBrief.time", rule: { type: "time" } },
  ]),
  ...group("notifications", "Quiet nudges", [
    { id: "nudges.enabled", label: "Quiet nudges", keywords: "nudges stale idle untouched reminders still relevant", about: "Items left alone ask whether they still matter.", href: at("notifications", "jump-nudges-ask-when-work-goes-quiet"), key: "staleNudge.enabled", rule: bool },
    { id: "nudges.days", label: "Days before a quiet nudge", keywords: "nudge days untouched stale", about: "How long an item sits untouched first (1–180 days).", href: at("notifications", "jump-nudges-days-before-a-quiet-nudge"), key: "staleNudge.untouchedDays", rule: { type: "int", min: 1, max: 180 } },
  ]),
  ...group("notifications", "Desktop reminders", [
    { id: "reminders.desktop", label: "Notifications on this device", keywords: "desktop notifications push browser reminders pop up native app", about: "Reminders use browser notifications on the web and native notifications in the desktop app.", href: at("notifications", "jump-reminders-show-reminders-as-desktop-notifications"), key: "desktopReminders", rule: bool },
  ]),
  ...group("notifications", "Quick capture", [
    { id: "capture.shortcut", label: "Quick capture", keywords: "quick capture shortcut reminder anywhere", about: "The shortcut that captures a reminder from anywhere.", href: at("notifications", "jump-capture-quick-capture") },
  ]),

  // ── Shortcuts ─────────────────────────────────────────────────────────────
  ...group("shortcuts", "Keyboard shortcuts", [
    { id: "shortcuts.keys", label: "Keyboard shortcuts", keywords: "keyboard shortcuts hotkeys key bindings remap chord", about: "See every key binding and change one.", href: at("shortcuts", "jump-shortcuts-keyboard-shortcuts") },
  ]),

  // ── Data ──────────────────────────────────────────────────────────────────
  ...group("data", "Export", [
    { id: "data.export", label: "Download this space", keywords: "export download zip backup space", about: "A zip of this space's pages, tasks and files.", href: at("data", "jump-export-export-space"), ownerOnly: true },
  ]),
  ...group("data", "Data retention", [
    { id: "retention.trash", label: "Trash retention", keywords: "trash purge deleted days", about: "Days deleted items stay in Trash before they are purged.", href: at("data", "jump-retention-trash-retention"), ownerOnly: true },
    { id: "retention.completed", label: "Completed retention", keywords: "completed tasks purge days finished", about: "Days finished work is kept unless pinned.", href: at("data", "jump-retention-completed-retention"), ownerOnly: true },
    { id: "retention.visible", label: "Completed visible count", keywords: "board completed shown recently finished how many", about: "How many recently completed rows the board shows: 3, 5, 8, 10, 15 or 20.", href: at("data", "jump-retention-completed-visible-count"), key: "completedVisible", rule: { type: "int", min: 3, max: 20, values: [3, 5, 8, 10, 15, 20] }, ownerOnly: true },
    { id: "retention.context", label: "Context review days", keywords: "context graph finished tasks days", about: "Days finished tasks stay on the Context graph (0 hides them).", href: at("data", "jump-retention-context-review-days"), key: "contextReviewDays", rule: { type: "int", min: 0, max: 365 }, ownerOnly: true },
    { id: "retention.undo", label: "Undo depth", keywords: "undo history steps how many", about: "How many changes Undo remembers (3–20).", href: at("data", "jump-retention-undo-depth"), ownerOnly: true },
    { id: "retention.history", label: "History retention", keywords: "history audit ledger runs retention days", about: "Days the audit ledger and task history are kept.", href: at("data", "jump-retention-history-retention"), ownerOnly: true },
  ]),
  ...group("data", "Completed and Trash", [
    { id: "data.completed", label: "Completed", keywords: "completed finished done list history", about: "Everything finished, with pin and restore.", href: at("data", "jump-completed-completed"), ownerOnly: true },
    { id: "data.trash", label: "Trash", keywords: "trash deleted recover restore empty bin", about: "Restore or empty deleted items.", href: at("data", "jump-trash-trash"), ownerOnly: true },
  ]),
  ...group("data", "Terminal and commits", [
    { id: "terminal.enabled", label: "Terminal on", keywords: "terminal shell on off code tab", about: "The guarded terminal in the Code tab.", href: at("data", "jump-terminal-terminal-on"), ownerOnly: true },
    { id: "code.folders", label: "Folders Code can use", keywords: "code folders repositories roots local repos add folder", about: "The folders the Code tab may list and review.", href: at("data", "jump-terminal-folders-code-can-use"), ownerOnly: true },
    { id: "terminal.folders", label: "Terminal folder", keywords: "terminal folder roots", about: "Folders the terminal may open.", href: at("data", "jump-terminal-terminal-folder"), ownerOnly: true },
    { id: "terminal.passkeys", label: "Passkeys", keywords: "passkey touch id fingerprint unlock terminal", about: "The passkeys that unlock the terminal.", href: at("data", "jump-terminal-passkeys"), ownerOnly: true },
    { id: "terminal.branch-prefix", label: "Branch prefix for agent work", keywords: "branch prefix git agent", about: "The prefix of branches agents create.", href: at("data", "jump-terminal-branch-prefix-for-agent-work"), ownerOnly: true },
    { id: "terminal.author", label: "Commit author", keywords: "commit author git name email", about: "The author on commits made here.", href: at("data", "jump-terminal-commit-author"), ownerOnly: true },
    { id: "terminal.sign", label: "Sign commits", keywords: "sign commits gpg signing", about: "Passes -S to git commit.", href: at("data", "jump-terminal-sign-commits"), ownerOnly: true },
  ]),
  ...group("data", "Delete my data", [
    { id: "data.failed", label: "Failed jobs", keywords: "failed jobs errors retry sync background", about: "Syncs and background jobs that gave up, with Retry.", href: at("data", "jump-failed-failed-jobs"), ownerOnly: true },
    { id: "data.deleted", label: "Deleted items", keywords: "deleted items restore", about: "Items deleted from connected sources.", href: at("data", "jump-deleted-deleted-items"), ownerOnly: true },
    { id: "data.delete", label: "Delete my data", keywords: "delete erase data wipe context", about: "Removes what Ensemble read from your apps, or everything.", href: at("data", "jump-danger-delete-my-data"), ownerOnly: true },
  ]),
];

/** The settings the assistant may change, by key. */
export const ASSISTANT_SETTING_KEYS: ReadonlyMap<string, SettingsMapEntry & { key: string; rule: SettingRule }> = new Map(
  SETTINGS_MAP.filter((entry): entry is SettingsMapEntry & { key: string; rule: SettingRule } => Boolean(entry.key && entry.rule)).map((entry) => [entry.key, entry]),
);

/** "Settings → Account → Appearance". */
export function settingsPlace(entry: Pick<SettingsMapEntry, "tab" | "section">): string {
  return `Settings → ${SETTINGS_MAP_TABS[entry.tab]} → ${entry.section}`;
}

/** What `rule` accepts, in a few words for a model or a person. */
export function describeRule(rule: SettingRule): string {
  switch (rule.type) {
    case "enum":
      return rule.values.join(" | ");
    case "boolean":
      return "true | false";
    case "int":
      return rule.values ? rule.values.join(" | ") : `a whole number ${rule.min}–${rule.max}`;
    case "time":
      return "HH:MM (24-hour)";
    case "timezone":
      return "an IANA time zone such as Europe/London";
    case "color":
      return "#rrggbb, or none";
  }
}

/**
 * Parses a value given as text, a number or a boolean into what the setting stores, or
 * returns the reason it is refused. `null` is stored for a custom accent of "none".
 */
export function parseSettingValue(rule: SettingRule, raw: unknown): { ok: true; value: string | number | boolean | null } | { ok: false; error: string } {
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : raw === null ? "" : undefined;
  if (text === undefined) return { ok: false, error: `Give ${describeRule(rule)}.` };
  switch (rule.type) {
    case "enum": {
      const found = rule.values.find((value) => value.toLowerCase() === text.toLowerCase());
      return found ? { ok: true, value: found } : { ok: false, error: `Use one of: ${describeRule(rule)}.` };
    }
    case "boolean": {
      const lower = text.toLowerCase();
      if (["true", "on", "yes"].includes(lower)) return { ok: true, value: true };
      if (["false", "off", "no"].includes(lower)) return { ok: true, value: false };
      return { ok: false, error: "Use true or false." };
    }
    case "int": {
      const value = Number(text);
      if (!Number.isInteger(value) || value < rule.min || value > rule.max) return { ok: false, error: `Use ${describeRule(rule)}.` };
      if (rule.values && !rule.values.includes(value)) return { ok: false, error: `Use one of: ${describeRule(rule)}.` };
      return { ok: true, value };
    }
    case "time": {
      const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
      return match ? { ok: true, value: `${match[1]!.padStart(2, "0")}:${match[2]}` } : { ok: false, error: "Use HH:MM, 24-hour, such as 07:30." };
    }
    case "timezone": {
      const zone = timeZoneName(text);
      return zone ? { ok: true, value: zone } : { ok: false, error: "Use an IANA time zone such as Europe/London or America/New_York." };
    }
    case "color":
      if (!text || text.toLowerCase() === "none") return { ok: true, value: null };
      return /^#[0-9a-fA-F]{6}$/.test(text) ? { ok: true, value: text.toLowerCase() } : { ok: false, error: "Use #rrggbb, or none." };
  }
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1)
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

const STOP = new Set(["the", "my", "to", "of", "and", "or", "in", "on", "for", "how", "do", "can", "where", "is", "it", "change", "set", "turn", "make", "want", "setting", "settings", "me", "an", "what", "which", "with", "off", "please", "switch", "where's"]);

/** The best entries for a few words ("dark mode", "api key", "quiet hours"), best first. */
export function findSettings(query: string, options: { limit?: number; guest?: boolean } = {}): SettingsMapEntry[] {
  const asked = words(query).filter((word) => !STOP.has(word));
  if (!asked.length) return [];
  const phrase = query.trim().toLowerCase();
  const scored = SETTINGS_MAP.filter((entry) => !(options.guest && entry.ownerOnly)).map((entry) => {
    const label = new Set(words(entry.label));
    const keywords = new Set(words(entry.keywords));
    const about = new Set(words(entry.about));
    let score = 0;
    for (const word of asked) {
      if (label.has(word)) score += 3;
      else if (keywords.has(word)) score += 2;
      else if (about.has(word)) score += 1;
      else if ([...label, ...keywords].some((known) => known.length > 3 && word.length > 3 && (known.startsWith(word) || word.startsWith(known)))) score += 1;
    }
    if (phrase.length > 3 && (entry.label.toLowerCase().includes(phrase) || entry.keywords.includes(phrase))) score += 4;
    return { entry, score };
  });
  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 5)
    .map((row) => row.entry);
}
