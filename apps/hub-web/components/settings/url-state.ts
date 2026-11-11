"use client";

import { SETTINGS_DESTINATION_BY_ID } from "./navigation";
import { useMemo, useSyncExternalStore } from "react";

export type SettingsTab = "account" | "appearance" | "notifications" | "shortcuts" | "assistant" | "agents" | "connections" | "spaces" | "sharing" | "data";

export type SettingsTabGroup = "personal" | "ai" | "workspace";

/** The groups the Settings nav shows, in order. */
export const SETTINGS_TAB_GROUPS: ReadonlyArray<{ id: SettingsTabGroup; label: string }> = [
  { id: "personal", label: "Personal" },
  { id: "ai", label: "AI" },
  { id: "workspace", label: "Workspace" },
];

/** The tabs in nav order: what most people open first leads each group. `hint` is search words and the tab's tooltip. */
export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string; hint: string; group: SettingsTabGroup }> = [
  { id: "account", label: "Account", hint: "Profile, sign-in, time zone, features", group: "personal" },
  { id: "appearance", label: "Appearance", hint: "Theme, colors, text, layout", group: "personal" },
  { id: "notifications", label: "Notifications", hint: "Desktop, quiet hours, brief, nudges, reminders", group: "personal" },
  { id: "shortcuts", label: "Shortcuts", hint: "See and change key bindings", group: "personal" },
  { id: "assistant", label: "Assistant", hint: "Models, keys, what it may change, automations", group: "ai" },
  { id: "agents", label: "Agents", hint: "Autonomy, run profiles, limits, sandbox, code", group: "ai" },
  { id: "connections", label: "Connections", hint: "Apps, calendars, editors, computers, imports", group: "workspace" },
  { id: "spaces", label: "Spaces", hint: "Your spaces, and shared settings", group: "workspace" },
  { id: "sharing", label: "Sharing", hint: "Contacts, what you share, shared with you", group: "workspace" },
  { id: "data", label: "Data", hint: "Export, retention, trash, deletion", group: "workspace" },
];

/**
 * Section anchors and the tab each one lives on. The old single-page hashes
 * (#models, #connections, #devices, #fetch, #retention …) are all here, so links
 * from elsewhere in the app and from older bookmarks still land.
 */
export const SECTION_TAB: Readonly<Record<string, SettingsTab>> = {
  ...Object.fromEntries([...SETTINGS_DESTINATION_BY_ID].map(([id, row]) => [id, row.tab])),
  export: "data",
  account: "account",
  profile: "account",
  avatar: "account",
  features: "account",
  about: "account",
  appearance: "appearance",
  you: "account",
  "this-mac": "account",
  assistant: "assistant",
  models: "assistant",
  keys: "assistant",
  changes: "assistant",
  watchers: "assistant",
  automations: "assistant",
  prompts: "assistant",
  autonomy: "agents",
  orchestration: "agents",
  "run-profiles": "agents",
  terminal: "agents",
  connections: "connections",
  calendars: "connections",
  imports: "connections",
  fetch: "connections",
  failed: "connections",
  connect: "connections",
  editors: "connections",
  devices: "connections",
  reminders: "notifications",
  quiet: "notifications",
  "quiet-hours": "notifications",
  brief: "notifications",
  routines: "notifications",
  nudges: "notifications",
  capture: "notifications",
  shortcuts: "shortcuts",
  keyboard: "shortcuts",
  spaces: "spaces",
  sharing: "sharing",
  contacts: "sharing",
  retention: "data",
  completed: "data",
  trash: "data",
  deleted: "data",
  danger: "data",
  "jump-account-delete-account": "data",
};

/**
 * Sections that moved to another tab, by the tab that used to hold them. A link written then
 * (`?tab=assistant#quiet`) opens where the section is now.
 */
const MOVED_FROM: Readonly<Record<string, SettingsTab>> = {
  appearance: "account",
  quiet: "assistant",
  autonomy: "assistant",
  orchestration: "assistant",
  "run-profiles": "assistant",
  terminal: "data",
  failed: "data",
};

/** Dialogs that can be opened from the address: /settings?tab=assistant&dialog=keys. */
export type SettingsDialog = "keys" | "subscriptions" | "changes";
const DIALOGS: readonly SettingsDialog[] = ["keys", "subscriptions", "changes"];

export type SettingsLocation = {
  tab: SettingsTab;
  /** The #hash, if it names a section. */
  anchor: string | null;
  /** Store detail for this connector id. */
  connector: string | null;
  /** Store open on this category ("all", "connected", …). */
  store: string | null;
  dialog: SettingsDialog | null;
};

export function isSettingsTab(value: string | null | undefined): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.id === value);
}

export function parseSettingsLocation(search: string, hash: string): SettingsLocation {
  const params = new URLSearchParams(search);
  const anchor = decodeURIComponent(hash.replace(/^#/, "")) || null;
  const connector = params.get("connector") || null;
  const store = params.get("store") || null;
  const rawDialog = params.get("dialog");
  const dialog = DIALOGS.includes(rawDialog as SettingsDialog) ? (rawDialog as SettingsDialog) : null;
  const rawTab = params.get("tab");
  // A control's jump anchor names exactly one place, so it wins over a ?tab= written before that control moved.
  const jump = anchor ? SETTINGS_DESTINATION_BY_ID.get(anchor) : undefined;
  const moved = anchor && rawTab && (jump ? jump.tab !== rawTab : MOVED_FROM[anchor] === rawTab) ? SECTION_TAB[anchor] : undefined;
  const tab: SettingsTab = moved
    ? moved
    : isSettingsTab(rawTab)
    ? rawTab
    : anchor && SECTION_TAB[anchor]
      ? SECTION_TAB[anchor]!
      : connector || store
        ? "connections"
        : dialog
          ? "assistant"
          : "account";
  return { tab, anchor, connector, store, dialog };
}

/** The address for a location. Unknown query parameters are kept. */
export function settingsUrl(location: SettingsLocation, current: { pathname: string; search: string } = { pathname: "/settings", search: "" }): string {
  const params = new URLSearchParams(current.search);
  params.set("tab", location.tab);
  const set = (key: string, value: string | null) => (value ? params.set(key, value) : params.delete(key));
  set("store", location.store);
  set("connector", location.connector);
  set("dialog", location.dialog);
  const query = params.toString();
  return `${current.pathname}${query ? `?${query}` : ""}${location.anchor ? `#${location.anchor}` : ""}`;
}

const EVENT = "ensemble:settings-location";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  window.addEventListener(EVENT, onChange);
  // Next's <Link> and router.push to /settings#… change the address without either event.
  const timer = window.setInterval(onChange, 300);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener(EVENT, onChange);
    window.clearInterval(timer);
  };
}

const snapshot = () => `${window.location.search}${window.location.hash}`;
const serverSnapshot = () => "";

export function readSettingsLocation(): SettingsLocation {
  return parseSettingsLocation(window.location.search, window.location.hash);
}

/** The Settings address, live. Before hydration it is the default tab. */
export function useSettingsLocation(): SettingsLocation {
  const key = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return useMemo(() => {
    const cut = key.indexOf("#");
    return cut === -1 ? parseSettingsLocation(key, "") : parseSettingsLocation(key.slice(0, cut), key.slice(cut));
  }, [key]);
}

/**
 * Change the Settings address. Tabs push a history entry so Back returns to the
 * previous tab; dialogs replace, so Back never reopens a dialog you closed.
 */
export function navigateSettings(update: Partial<SettingsLocation>, mode: "push" | "replace" = "replace"): void {
  const current = readSettingsLocation();
  const next = { ...current, ...update };
  const url = settingsUrl(next, { pathname: window.location.pathname, search: window.location.search });
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (url === here) return;
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(EVENT));
}
