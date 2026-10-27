"use client";

import { useSyncExternalStore } from "react";
import type { PresenceEntry, ShareKind } from "./api";

/**
 * Who else is in this space right now, fed by the event stream (`presence` frames) and the
 * first GET /api/presence. One entry per browser tab; your own tabs are left out.
 */
const TTL_MS = 45_000;
let entries = new Map<string, PresenceEntry>();
let me: string | null = null;
let snapshot: PresenceEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  const cutoff = Date.now() - TTL_MS;
  snapshot = [...entries.values()].filter((entry) => entry.at >= cutoff && entry.accountId !== me);
  for (const listener of listeners) listener();
}

export const presenceStore = {
  setMe(id: string | null): void {
    if (me === id) return;
    me = id;
    emit();
  },
  reset(list: PresenceEntry[], you: string): void {
    me = you;
    entries = new Map(list.map((entry) => [`${entry.accountId}:${entry.tabId}`, entry]));
    emit();
  },
  apply(entry: PresenceEntry): void {
    const key = `${entry.accountId}:${entry.tabId}`;
    if (entry.gone) entries.delete(key);
    else entries.set(key, entry);
    emit();
  },
  clear(): void {
    entries = new Map();
    emit();
  },
  /** Drops tabs that stopped sending heartbeats. */
  sweep(): void {
    emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot(): PresenceEntry[] {
    return snapshot;
  },
};

const empty: PresenceEntry[] = [];

/** Every other tab in this space, newest first. */
export function usePresence(): PresenceEntry[] {
  return useSyncExternalStore(presenceStore.subscribe, presenceStore.snapshot, () => empty);
}

/** One row per person (their most recent tab). */
export function people(list: PresenceEntry[]): PresenceEntry[] {
  const byPerson = new Map<string, PresenceEntry>();
  for (const entry of list) {
    const seen = byPerson.get(entry.accountId);
    if (!seen || seen.at < entry.at) byPerson.set(entry.accountId, entry);
  }
  return [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The people on one item (a page, a diagram). */
export function onResource(list: PresenceEntry[], kind: string, id: string): PresenceEntry[] {
  return people(list.filter((entry) => entry.resource?.kind === kind && entry.resource.id === id));
}

const PLACES: Array<[RegExp, string]> = [
  [/^\/board/, "the board"],
  [/^\/pages\//, "a page"],
  [/^\/tasks\//, "a task"],
  [/^\/diagrams\/./, "a diagram"],
  [/^\/diagrams/, "diagrams"],
  [/^\/plots\/./, "a plot space"],
  [/^\/plots/, "plots"],
  [/^\/context/, "Context"],
  [/^\/needs-me/, "Needs me"],
  [/^\/runs/, "runs"],
  [/^\/workspace/, "runs"],
  [/^\/code/, "code"],
  [/^\/skills/, "skills"],
  [/^\/meetings/, "meetings"],
  [/^\/recap/, "the weekly recap"],
  [/^\/projects/, "projects"],
];

/** Where someone is, in words: "a page", "the board", or "the shared page" for someone who opened one shared item. */
export function placeOf(entry: Pick<PresenceEntry, "route" | "resource">): string {
  if (!entry.route) return entry.resource ? `the shared ${entry.resource.kind.replace("_", " ")}` : "this space";
  const path = entry.route.split("?")[0] ?? "";
  if (entry.route.includes("peek=task:")) return "a task";
  return PLACES.find(([pattern]) => pattern.test(path))?.[1] ?? "this space";
}

const ITEM_ROUTES: Partial<Record<ShareKind, (id: string) => string>> = {
  page: (id) => `/pages/${id}`,
  task: (id) => `/tasks/${id}`,
  diagram: (id) => `/diagrams/${id}`,
  plot_space: (id) => `/plots/${id}`,
  board: () => "/board",
  meeting: () => "/meetings",
  skill: (id) => `/skills?skill=${id}`,
  workspace: () => "/runs",
  code: () => "/code",
};

/**
 * Where "Go to" takes you. Someone on one shared item or a public link never sends a route,
 * only the item, so for them it is that item's address in this space.
 */
export function hrefOf(entry: Pick<PresenceEntry, "route" | "resource">): string | null {
  if (entry.route) return entry.route;
  const to = entry.resource ? ITEM_ROUTES[entry.resource.kind] : undefined;
  return to && entry.resource ? to(encodeURIComponent(entry.resource.id)) : null;
}

/** "Mira Chen is editing…", "Mira Chen and Ben Ito are editing…", "Mira Chen and 2 others are editing…". */
export function editingLine(names: string[]): string {
  if (names.length === 1) return `${names[0]} is editing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are editing…`;
  return `${names[0]} and ${names.length - 1} others are editing…`;
}

let tab: string | null = null;
/** A stable id for this browser tab, so two tabs of one person are two entries. */
export function tabId(): string {
  if (tab) return tab;
  try {
    tab = sessionStorage.getItem("ensemble.tab") ?? null;
    if (!tab) {
      tab = crypto.randomUUID();
      sessionStorage.setItem("ensemble.tab", tab);
    }
  } catch {
    tab = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  return tab;
}

/** The same colour the server gives a person (sharing/presence.ts), for avatars before they are live. */
const COLORS = ["#E8590C", "#7048E8", "#0C8599", "#2F9E44", "#D6336C", "#E67700", "#1971C2", "#C2255C"];
export function colorFor(accountId: string): string {
  let hash = 0;
  for (const char of accountId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

let typingSent = 0;
let typingIdle: number | undefined;
/**
 * Marks you as typing on the item you are on (others see a pulse on your avatar). Throttled,
 * and cleared after a few quiet seconds.
 */
export function announceTyping(send: (typing: boolean) => Promise<unknown>): void {
  const now = Date.now();
  if (now - typingSent > 2000) {
    typingSent = now;
    void send(true).catch(() => undefined);
  }
  window.clearTimeout(typingIdle);
  typingIdle = window.setTimeout(() => {
    typingSent = 0;
    void send(false).catch(() => undefined);
  }, 4000);
}
