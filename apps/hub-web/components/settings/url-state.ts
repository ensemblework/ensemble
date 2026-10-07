"use client";

import { useMemo, useSyncExternalStore } from "react";

export type SettingsTab = "account" | "assistant" | "connections" | "notifications" | "data";

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string; hint: string }> = [
  { id: "account", label: "Account", hint: "Profile, appearance, features" },
  { id: "assistant", label: "Assistant", hint: "Models, autonomy, what it may change" },
  { id: "connections", label: "Connections", hint: "Apps, imports, editors, devices" },
  { id: "notifications", label: "Notifications", hint: "Brief, nudges, reminders" },
  { id: "data", label: "Data", hint: "Retention, trash, deletion" },
];

/**
 * Section anchors and the tab each one lives on. The old single-page hashes
 * (#models, #connections, #devices, #fetch, #retention …) are all here, so links
 * from elsewhere in the app and from older bookmarks still land.
 */
export const SECTION_TAB: Readonly<Record<string, SettingsTab>> = {
  account: "account",
  profile: "account",
  features: "account",
  appearance: "account",
  you: "account",
  "this-mac": "account",
  assistant: "assistant",
  models: "assistant",
  keys: "assistant",
  changes: "assistant",
  watchers: "assistant",
  autonomy: "assistant",
  orchestration: "assistant",
  quiet: "assistant",
  prompts: "assistant",
  connections: "connections",
  imports: "connections",
  fetch: "connections",
  connect: "connections",
  editors: "connections",
  devices: "connections",
  brief: "notifications",
  nudges: "notifications",
  reminders: "notifications",
  capture: "notifications",
  retention: "data",
  completed: "data",
  trash: "data",
  terminal: "data",
  failed: "data",
  deleted: "data",
  danger: "data",
};

/** Dialogs that can be opened from the address: /settings?tab=assistant&dialog=keys. */
export type SettingsDialog = "keys" | "changes";
const DIALOGS: readonly SettingsDialog[] = ["keys", "changes"];

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
  const tab: SettingsTab = isSettingsTab(rawTab)
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
