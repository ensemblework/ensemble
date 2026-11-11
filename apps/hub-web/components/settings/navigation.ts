import type { SettingsTab } from "./url-state";

export type SettingsDestination = { id: string; tab: SettingsTab; section: string; heading?: string; label: string; target: string; keywords: string; ownerOnly?: boolean; dialog?: "keys" | "changes" };
const groups: Array<[SettingsTab, string, string, Array<string | [string, string, string?]>]> = [
  ["account", "account", "Account", ["Profile", ["Sign out", "logout log out signout"], ["Full name", "name identity"], ["Gender", "identity optional"], ["Profession", "job role occupation"], "Organization", "How did you hear about Ensemble?", ["Change password", "add password security login", "Change password"], ["Linked login methods", "login google github microsoft oauth authentication"], ["Export account data (JSON)", "download export backup gdpr json", "Export account data"]]],
  ["account", "avatar", "Avatar", [["Avatar", "profile picture initials face photo"], "Use initials"]],
  ["account", "you", "Time zone and email", [["Time zone", "timezone scheduling local time"], ["Email", "confirm confirmations sensitive changes address"]]],
  ["account", "features", "Features", [["Features", "modules enable disable code workspace runs metrics skills diagrams plots"], ["Desk extras", "optional tiles deadlines learning"]]],
  ["account", "this-mac", "This computer", [["Allow remote tasks", "mac computer device runner"], "Accept approvals from the web and phone"]],
  ["account", "about", "About Ensemble", [["About Ensemble", "version release update desktop web CLI"], "Check for updates"]],
  ["appearance", "appearance", "Theme", [["Theme", "dark light system mode", "Mode"], ["Color theme", "palette petrol aubergine graphite lagoon aurora juniper blueprint ensemble"], ["Doodle", "doodles background pattern wallpaper constellation orbits galaxy stardust ripples network contours waves weave dots circuits graph plain"], ["Accent", "colour color colors palette presets gold satin indigo tide ember rose brass orchid moss sky"], ["Custom accent", "custom colour color hex"]]],
  ["appearance", "appearance", "Text", [["Text", "typography font"], ["Text size", "scale zoom font size"], ["App font", "typeface inter georgia monospace figtree plex"]]],
  ["appearance", "appearance", "Layout and motion", [["Layout and motion", "navigation sidebar"], ["Auto-collapse sidebar", "navigation hover icon rail"], ["Pages panel position", "page browser left right sidebar"], ["Ensemble's right-click menu", "context menu right click browser menu"], ["Reduce motion", "disable animations accessibility"], ["Reset appearance", "defaults restore"]]],
  ["notifications", "reminders", "Notifications on this device", [["Notifications on this device", "desktop reminders push browser app notifications permission"], "Show reminders as desktop notifications"]],
  ["notifications", "quiet", "Quiet hours", [["Quiet hours", "do not disturb notifications night"], "Quiet hours start", "Quiet hours end"]],
  ["notifications", "brief", "Morning brief", ["Morning brief", "Deliver the morning brief", "Morning brief time"]],
  ["notifications", "nudges", "Nudges", [["Nudges", "nudge bell waiting reminders"], ["Tell me when agent work waits for review", "review notification agent finished done"], ["Ask when work goes quiet", "quiet nudges stale idle"], ["Days before a quiet nudge", "stale idle untouched days"]]],
  ["notifications", "routines", "Routines", [["Routines", "schedule scheduled work assistant recurring"], "Run my routines"]],
  ["notifications", "capture", "Quick capture", [["Quick capture", "reminders shortcut capture"]]],
  ["shortcuts", "shortcuts", "Keyboard shortcuts", [["Keyboard shortcuts", "hotkeys key bindings remap keys"]]],
  ["assistant", "assistant", "The assistant", [["Write policy", "preview apply changes permissions", "When it wants to change something"], ["Default model preset", "default complexity tier low medium high max"], ["What it may change", "allowed write areas permissions"]]],
  ["assistant", "models", "Models", [["Models", "model presets thinking provider tier low medium high max"], ["Your AI subscriptions", "subscription plan claude chatgpt codex cursor copilot pro max plus sign in computer app"], "Which model each tier uses"]],
  ["assistant", "automations", "Automations", [["Automations", "ai automation background model calls switches on off"], ["Meeting automations", "meeting transcript notes action items tasks proposals prep brief recap series model tier"], ["Brief before a meeting", "meeting prep minutes before"], ["Summarize uploaded files", "file summary document upload tier model"], ["Learn skills from finished work", "skills learning completed work"]]],
  ["assistant", "watchers", "Watching for you", [["Watching for you", "watchers monitor follow up tell me when"]]],
  ["assistant", "prompts", "Prompts", [["Prompts", "system instructions model requests"]]],
  ["agents", "autonomy", "Autonomy", [["Default autonomy", "autonomy level assist supervised autonomous ask review unattended"], ["Daily action safety limit", "high risk write limit spending safety"], ["Run commands in the Ensemble workspace without asking", "run without asking auto approval"], ["Trust folders in your other AI tools too", "trust share folders claude code codex cursor"]]],
  ["agents", "run-profiles", "Run profiles", [["Run profiles", "assign agent default profile quick assign star favourite favorite claude code codex cursor"], ["Default run profile", "default assign agent profile star"]]],
  ["agents", "orchestration", "Task limits", [["Task limits", "orchestration run limits queue"], ["Tasks that run at once", "parallel concurrency job limit"], ["Model turns per task", "turn limit agent"], ["Minutes per task", "timeout duration time limit"]]],
  ["agents", "orchestration", "Sandbox and access", [["Sandbox and access", "isolation security permissions"], ["Sandbox by default", "execution native isolation"], ["Internet for agent commands", "network sandbox internet"], ["Outside the Ensemble workspace", "outside access folders read write"]]],
  ["agents", "orchestration", "Agent sessions", [["Agent sessions", "sessions conversations"], ["One folder per project", "project folder agents claude codex cursor"], ["Continue a fitting agent session", "session reuse continue"], ["Clean up agent sessions", "delete sessions conversations"]]],
  ["agents", "terminal", "Terminal and commits", [["Terminal and commits", "terminal commits git code tab folders"], ["Folders Code can use", "local repositories roots folders workspace"], "Terminal on", "Terminal folder", ["Passkeys", "touch id fingerprint unlock terminal"], "Branch prefix for agent work", "Sign commits"]],
  ["connections", "connections", "Connections", [["Connections", "connectors integrations apps connected apps"]]],
  ["connections", "calendars", "Calendars on Today", [["Calendars on Today", "calendar union merged duplicates ics ical webcal icloud proton fastmail notion holidays subscription feed"], ["Add calendar by URL (ICS)", "ics ical webcal subscribe calendar link url feed"], ["Sync calendars", "refresh calendar events"]]],
  ["connections", "editors", "Editors & agents", [["Editors & agents", "connect editor vscode cursor claude codex mcp"], "Connect an editor or AI app", ["Personal token", "api token hooks credentials"]]],
  ["connections", "devices", "Connected computers", [["Connected computers", "devices paired computers laptop mac windows linux cli runner"], ["Connect a computer", "pair desktop app cli device"]]],
  ["connections", "fetch", "Sync people", [["Sync people", "sync contacts people refresh fetching"], ["Look back", "fetch lookback days"]]],
  ["connections", "failed", "Updates needing attention", [["Updates needing attention", "failed jobs retry errors background jobs sync"]]],
  ["connections", "imports", "Imports", [["Imports", "import migration csv todoist notion trello asana clickup obsidian"], "Recent imports"]],
  ["spaces", "spaces", "Spaces", [["Spaces", "workspace switch name icon"], "Settings across spaces", ["Copy settings into this space", "copy settings from"], ["Keep settings in sync", "synchronize spaces", "Keep every space in sync"]]],
  ["sharing", "sharing", "Sharing", [["Contacts", "friends people permissions sharing contacts"], "Spaces you share", "Items you shared", "Shared with you", ["Public links", "public sharing shareable links"], ["Limits", "sharing limits contacts people per space node room"]]],
  ["data", "export", "Download this space", [["Download this space", "download export zip backup space"]]],
  ["data", "retention", "Data retention", [["Trash retention", "purge deleted items days"], ["Completed retention", "purge finished tasks days"], ["Completed visible count", "board completed limit"], ["Context review days", "context retention review"], ["Undo depth", "history undo actions"], ["History retention", "runs retention days"]]],
  ["data", "completed", "Completed and Trash", [["Completed", "finished done tasks history"], ["Trash", "deleted recover restore empty bin"]]],
  ["data", "danger", "Danger zone", [["Danger zone", "delete erase"], ["Delete my data", "erase account data deletion scope"], ["Delete account", "permanently delete hosted account revoke devices"]]],
];

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const SETTINGS_DESTINATIONS: SettingsDestination[] = groups.flatMap(([tab, section, heading, entries]) => (entries.some(entry => (typeof entry === "string" ? entry : entry[0]) === heading) ? entries : [heading, ...entries]).map((entry) => {
  const [label, keywords = "", target = label] = typeof entry === "string" ? [entry] : entry;
  return { id: `jump-${section}-${slug(label!)}`, tab, section, heading, label: label!, target: target!, keywords: `${heading} ${keywords}`, ownerOnly: tab === "connections" || tab === "data" || section === "features" || section === "this-mac" || section === "terminal" };
}));
SETTINGS_DESTINATIONS.push(
  { id: "jump-model-keys", tab:"assistant", section:"models", label:"API keys", target:"API keys", keywords:"api keys model providers credentials anthropic openai google gemini github copilot ollama provider", dialog:"keys" },
  { id: "jump-assistant-changes", tab:"assistant", section:"assistant", label:"What the assistant may change", target:"What the assistant may change", keywords:"allowed writes permissions connected apps tasks pages projects", dialog:"changes" },
);
for (const tier of ["Low model", "Medium model", "High model", "Max model"]) {
  for (const control of ["provider", "model", "thinking"]) SETTINGS_DESTINATIONS.push({ id:`jump-${slug(tier)}-${control}`, tab:"assistant", section:"models", heading:"Models", label:control === "model" ? tier : `${tier} ${control}`, target:`${tier} ${control}`, keywords:`model tier preset reasoning thinking effort ${tier} ${control}` });
}
for (const label of ["Code", "Agent queue", "Runs", "Metrics", "Skills", "Diagrams", "Plots", "Deadlines", "Learning"]) SETTINGS_DESTINATIONS.push({ id:`jump-feature-${slug(label)}`, tab:"account", section:"features", heading:"Features", label:`${label} feature`, target:label, keywords:`enable disable toggle module tiles ${label}`, ownerOnly:true });
export const SETTINGS_DESTINATION_BY_ID = new Map(SETTINGS_DESTINATIONS.map((row) => [row.id, row]));
/** Ids that links already carry, for controls that were renamed or moved: each still lands. */
const ALIASES: Record<string, string> = {
  "jump-feature-workspace": "jump-feature-agent-queue",
  "jump-account-delete-account": "jump-danger-delete-account",
  "jump-you-scheduling-and-confirmations": "jump-you-time-zone-and-email",
  "jump-appearance-appearance": "jump-appearance-theme",
  "jump-appearance-text-and-font": "jump-appearance-text",
  "jump-reminders-desktop-reminders": "jump-reminders-notifications-on-this-device",
  "jump-nudges-quiet-nudges": "jump-nudges-nudges",
  "jump-automations-tell-me-when-agent-work-waits-for-review": "jump-nudges-tell-me-when-agent-work-waits-for-review",
  "jump-orchestration-orchestration": "jump-orchestration-task-limits",
  "jump-connections-connected-apps": "jump-connections-connections",
  "jump-export-export": "jump-export-download-this-space",
  "jump-export-export-space": "jump-export-download-this-space",
  "jump-trash-trash": "jump-completed-trash",
  "jump-deleted-deleted-items": "jump-completed-trash",
};
for (const [old, now] of Object.entries(ALIASES)) SETTINGS_DESTINATION_BY_ID.set(old, SETTINGS_DESTINATION_BY_ID.get(now)!);

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

/**
 * A short glow on the row a jump landed on, so the eye finds it. The row is the setting's own
 * row when there is one, else the labelled control or card. Colour only, no movement.
 */
export function flashSetting(node: HTMLElement): void {
  const row = node.closest<HTMLElement>("div[data-setting-label]") ?? node.closest<HTMLElement>("[data-jump-label]") ?? node;
  if (typeof row.animate !== "function") return;
  const accent = getComputedStyle(row).getPropertyValue("--accent-rgb").trim() || "200 160 70";
  const radius = row.style.borderRadius;
  if (row.tagName !== "SECTION") row.style.borderRadius = "10px";
  // A whole card keeps its own surface and only gets the ring; a row gets a soft fill too.
  const card = row.tagName === "SECTION";
  const glow = (alpha: number) =>
    card
      ? { boxShadow: `0 0 0 2px rgb(${accent} / ${alpha * 0.55})` }
      : { backgroundColor: `rgb(${accent} / ${alpha * 0.14})`, boxShadow: `0 0 0 6px rgb(${accent} / ${alpha * 0.14}), 0 0 0 7px rgb(${accent} / ${alpha * 0.5})` };
  const animation = row.animate([glow(1), glow(1), glow(0)], { duration: 1800, easing: "cubic-bezier(0.2, 0, 0, 1)" });
  animation.onfinish = animation.oncancel = () => {
    row.style.borderRadius = radius;
  };
}
