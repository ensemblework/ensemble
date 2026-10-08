"use client";

import { useSyncExternalStore } from "react";
import type { PresenceEntry } from "./api";

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
