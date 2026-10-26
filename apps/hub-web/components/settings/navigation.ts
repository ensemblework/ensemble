import type { SettingsTab } from "./url-state";

export type SettingsDestination = { id: string; tab: SettingsTab; section: string; heading?: string; label: string; target: string; keywords: string; ownerOnly?: boolean; dialog?: "keys" | "changes" };
const groups: Array<[SettingsTab, string, string, Array<string | [string, string, string?]>]> = [
  ["account", "account", "Account", ["Profile", ["Sign out", "logout log out signout"], ["Full name", "name identity"], ["Gender", "identity optional"], ["Profession", "job role occupation"], "Organization", "How did you hear about Ensemble?", ["Change password", "add password security login", "Change password"], ["Linked login methods", "login google github microsoft oauth authentication"], "Export account data (JSON)"]],
  ["account", "about", "About Ensemble", [["About Ensemble", "version release update desktop web CLI"], "Check for updates"]],
  ["account", "avatar", "Avatar", [["Avatar", "profile picture initials face photo"], "Use initials"]],
  ["account", "you", "Scheduling and confirmations", ["Email", ["Time zone", "timezone scheduling local time"]]],
  ["appearance", "appearance", "Appearance", [["Theme", "dark light system mode"], ["Color theme", "palette petrol aubergine graphite lagoon aurora juniper blueprint ensemble background patterns doodles"], ["Accent", "colour color colors palette presets gold satin indigo tide ember rose brass orchid moss sky"], ["Custom accent", "custom colour color hex"], ["Text and font", "typography appearance"], ["Text size", "scale zoom font size"], ["App font", "typeface inter georgia monospace figtree plex"], ["Reduce motion", "disable animations accessibility"], ["Auto-collapse sidebar", "navigation hover icon rail"], ["Pages panel position", "page browser left right sidebar"], "Reset appearance"]],
  ["account", "features", "Features", [["Features", "modules enable disable code workspace runs metrics skills diagrams plots"], ["Desk extras", "optional tiles deadlines learning"]]],
  ["account", "this-mac", "This computer", [["Allow remote tasks", "mac computer device runner"], "Accept approvals from the web and phone"]],
  ["assistant", "assistant", "The assistant", [["Write policy", "preview apply changes permissions", "When it wants to change something"], ["Default model preset", "default complexity tier low medium high max"], ["What it may change", "allowed write areas permissions"]]],
  ["assistant", "models", "Models", [["Models", "model presets thinking provider tier low medium high max"], ["Your AI subscriptions", "subscription plan claude chatgpt codex cursor copilot pro max plus sign in computer app"], "Which model each tier uses"]],
  ["assistant", "watchers", "Watching for you", [["Watching for you", "watchers monitor follow up tell me when"]]],
  ["assistant", "autonomy", "Autonomy", [["Autonomy level", "ask review only unattended"], ["Daily action safety limit", "high risk write limit spending safety"], ["Network for sandboxed commands", "internet sandbox network"], ["Run commands in the Ensemble workspace without asking", "run without asking auto approval"]]],
  ["assistant", "orchestration", "Orchestration", [["Tasks that run at once", "parallel concurrency job limit"], ["Model turns per task", "turn limit agent"], ["Minutes per task", "timeout duration time limit"], ["Sandbox by default", "execution native isolation"], ["Internet for agent commands by default", "network sandbox"]]],
  ["assistant", "run-profiles", "Run profiles", [["Run profiles", "assign agent default profile quick assign star favourite favorite claude code codex cursor"], ["Default run profile", "default assign agent profile star"]]],
  ["assistant", "quiet", "Quiet hours", [["Quiet hours", "do not disturb notifications"], "Quiet hours start", "Quiet hours end"]],
  ["assistant", "prompts", "Prompts", [["Prompts", "system instructions model requests"]]],
  ["connections", "connections", "Connected apps", [["Connections", "connectors integrations apps", "Connected apps"]]],
  ["connections", "imports", "Imports", [["Imports", "import migration csv todoist notion trello asana clickup obsidian"], "Recent imports"]],
  ["connections", "fetch", "Sync people", [["Sync people", "sync contacts people refresh fetching"], ["Look back", "fetch lookback days"]]],
  ["connections", "editors", "Editors & agents", [["Editors & agents", "connect editor vscode cursor claude codex mcp"], "Connect an editor or AI app", ["Personal token", "api token hooks credentials"]]],
  ["connections", "devices", "Connected computers", [["Connected computers", "devices paired computers laptop mac windows linux cli runner"], ["Connect a computer", "pair desktop app cli device"]]],
  ["notifications", "brief", "Morning brief", ["Morning brief", "Deliver the morning brief", "Morning brief time"]],
  ["notifications", "nudges", "Quiet nudges", ["Quiet nudges", "Ask when work goes quiet", ["Days before a quiet nudge", "stale idle untouched days"]]],
  ["notifications", "reminders", "Desktop reminders", [["Desktop reminders", "push browser notifications permission"], "Show reminders as desktop notifications"]],
  ["notifications", "capture", "Quick capture", [["Quick capture", "reminders shortcut capture"]]],
  ["spaces", "spaces", "Spaces", [["Spaces", "workspace switch name icon"], "Settings across spaces", ["Copy settings into this space", "copy settings from"], ["Keep settings in sync", "synchronize spaces", "Keep every space in sync"]]],
  ["sharing", "sharing", "Sharing", [["Contacts", "friends people permissions sharing contacts"], "Spaces you share", "Items you shared", "Shared with you", ["Public links", "public sharing shareable links"]]],
  ["shortcuts", "shortcuts", "Keyboard shortcuts", [["Keyboard shortcuts", "hotkeys key bindings remap keys"]]],
  ["data", "export", "Export", [["Export space", "download export zip backup", "Download this space"]]],
  ["data", "retention", "Data retention", [["Trash retention", "purge deleted items days"], ["Completed retention", "purge finished tasks days"], ["Completed visible count", "board completed limit"], ["Context review days", "context retention review"], ["Undo depth", "history undo actions"], ["History retention", "runs retention days"]]],
  ["data", "completed", "Completed", [["Completed", "finished done tasks history"]]],
  ["data", "trash", "Trash", [["Trash", "deleted recover restore empty bin"]]],
  ["data", "terminal", "Terminal and commits", ["Terminal and commits", "Terminal on", ["Folders Code can use", "local repositories roots folders workspace"], "Terminal folder", ["Passkeys", "touch id fingerprint unlock terminal"], "Branch prefix for agent work", "Commit author", "Sign commits"]],
  ["data", "failed", "Updates needing attention", [["Updates needing attention", "failed jobs retry errors background jobs sync"]]],
  ["data", "deleted", "Deleted items", [["Deleted items", "restore trash retention"]]],
  ["data", "danger", "Delete my data", [["Delete my data", "erase account data deletion scope"]]],
  ["data", "danger", "Delete account", [["Delete account", "permanently delete hosted account revoke devices"]]],
];

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const SETTINGS_DESTINATIONS: SettingsDestination[] = groups.flatMap(([tab, section, heading, entries]) => (entries.some(entry => (typeof entry === "string" ? entry : entry[0]) === heading) ? entries : [heading, ...entries]).map((entry) => {
  const [label, keywords = "", target = label] = typeof entry === "string" ? [entry] : entry;
  return { id: `jump-${section}-${slug(label!)}`, tab, section, heading, label: label!, target: target!, keywords: `${heading} ${keywords}`, ownerOnly: tab === "connections" || tab === "data" || section === "features" || section === "this-mac" };
}));
SETTINGS_DESTINATIONS.push(
  { id: "jump-model-keys", tab:"assistant", section:"models", label:"API keys", target:"API keys", keywords:"api keys model providers credentials anthropic openai google gemini github copilot ollama provider", dialog:"keys" },
  { id: "jump-assistant-changes", tab:"assistant", section:"assistant", label:"What the assistant may change", target:"What the assistant may change", keywords:"allowed writes permissions connected apps tasks pages projects", dialog:"changes" },
);
for (const tier of ["Low model", "Medium model", "High model", "Max model"]) {
  for (const control of ["provider", "model", "thinking"]) SETTINGS_DESTINATIONS.push({ id:`jump-${slug(tier)}-${control}`, tab:"assistant", section:"models", heading:"Models", label:control === "model" ? tier : `${tier} ${control}`, target:`${tier} ${control}`, keywords:`model tier preset reasoning thinking effort ${tier} ${control}` });
}
for (const label of ["Code", "Workspace", "Runs", "Metrics", "Skills", "Diagrams", "Plots", "Deadlines", "Learning"]) SETTINGS_DESTINATIONS.push({ id:`jump-feature-${slug(label)}`, tab:"account", section:"features", heading:"Features", label:`${label} feature`, target:label, keywords:`enable disable toggle module tiles ${label}`, ownerOnly:true });
export const SETTINGS_DESTINATION_BY_ID = new Map(SETTINGS_DESTINATIONS.map((row) => [row.id, row]));
SETTINGS_DESTINATION_BY_ID.set("jump-account-delete-account", SETTINGS_DESTINATION_BY_ID.get("jump-danger-delete-account")!);

export function settingsDestinationHref(row: SettingsDestination): string {
  return `/settings?tab=${row.tab}${row.dialog ? `&dialog=${row.dialog}` : `#${row.id}`}`;
}

const textKey = (text: string) => text.replace(/\(optional\)/g, "").replace(/\s+/g, " ").trim().toLowerCase();
/** Finds a static control label after its lazy Settings tab has rendered. */
export function findSettingsTarget(root: Element, target: string): HTMLElement | null {
  const needle = textKey(target);
  const candidates = root.querySelectorAll<HTMLElement>("[data-jump-label], [data-setting-label], h2, h3, label, button, summary, [aria-label]");
  return [...candidates].find((node) => textKey(node.dataset.jumpLabel ?? node.dataset.settingLabel ?? node.getAttribute("aria-label") ?? node.textContent ?? "") === needle) ?? null;
}
