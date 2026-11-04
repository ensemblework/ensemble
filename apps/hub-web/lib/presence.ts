"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { api, presenceJoined, type PresenceEntry, type PresenceUpdate, type ShareKind } from "./api";
import { LIVE_OPENED_EVENT } from "./events";
import { followStore } from "./follow";

/**
 * Who else is in this space right now, fed by the event stream (`presence` frames) and
 * GET /api/presence whenever the stream opens. One entry per browser tab; your own tabs are
 * left out. The timings match hub-api's sharing/presence.ts.
 */
export const HEARTBEAT_MS = 10_000;
const TTL_MS = 30_000;
const AWAY_TTL_MS = 150_000;
const SWEEP_MS = 5_000;

/** When this browser last heard each tab, by its own clock: the server's `at` may be off by minutes. */
type Held = { entry: PresenceEntry; seen: number };
let entries = new Map<string, Held>();
/** Tabs that left, and when: an answer to GET /api/presence asked before then must not bring them back. */
let left = new Map<string, number>();
/** When each person first appeared, so avatars keep their place as others come and go. */
const joined = new Map<string, number>();
let me: string | null = null;
let snapshot: PresenceEntry[] = [];
const listeners = new Set<() => void>();

const keyOf = (entry: Pick<PresenceEntry, "accountId" | "tabId">) => `${entry.accountId}:${entry.tabId}`;
const fresh = (held: Held, now: number) => held.seen >= now - (held.entry.away ? AWAY_TTL_MS : TTL_MS);

function emit(force = false): void {
  const now = Date.now();
  for (const [key, held] of entries) if (!fresh(held, now)) entries.delete(key);
  const accounts = new Set<string>();
  for (const { entry } of entries.values()) {
    accounts.add(entry.accountId);
    if (!joined.has(entry.accountId)) joined.set(entry.accountId, now);
  }
  for (const account of joined.keys()) if (!accounts.has(account)) joined.delete(account);
  const next = [...entries.values()].map((held) => held.entry).filter((entry) => entry.accountId !== me);
  // Same people, same frames: keep the snapshot, so nothing re-renders on a quiet sweep.
  if (!force && next.length === snapshot.length && next.every((entry, index) => entry === snapshot[index])) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export const presenceStore = {
  setMe(id: string | null): void {
    if (me === id) return;
    me = id;
    emit(true);
  },
  /**
   * Everyone the server lists. `now` is the server's clock when it answered and `asked` this
   * browser's when the request went out: frames that arrived since are newer than the list.
   */
  reset(list: PresenceEntry[], you: string, now?: number, asked = 0): void {
    me = you;
    const local = Date.now();
    const next = new Map<string, Held>();
    for (const entry of list) {
      const key = keyOf(entry);
      if ((left.get(key) ?? -1) >= asked) continue;
      const held = entries.get(key);
      next.set(key, held && held.seen >= asked ? held : { entry, seen: local - Math.max(0, now === undefined ? 0 : now - entry.at) });
    }
    for (const [key, held] of entries) if (!next.has(key) && held.seen >= asked && asked > 0) next.set(key, held);
    entries = next;
    emit(true);
  },
  apply(entry: PresenceEntry): void {
    const key = keyOf(entry);
    if (entry.gone) {
      entries.delete(key);
      left.set(key, Date.now());
      if (left.size > 500) left = new Map([...left].slice(-200));
    } else {
      entries.set(key, { entry, seen: Date.now() });
      left.delete(key);
    }
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
  /** Your account id (a `visitor:…` id on a public link). */
  me(): string | null {
    return me;
  },
  /** Whether someone has any tab open here now. */
  isHere(accountId: string): boolean {
    return snapshot.some((entry) => entry.accountId === accountId);
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

/** Every other tab in this space. */
export function usePresence(): PresenceEntry[] {
  return useSyncExternalStore(presenceStore.subscribe, presenceStore.snapshot, () => empty);
}

/** One row per person: their tab in front, else their most recent one. In the order they arrived, so avatars keep their place. */
export function people(list: PresenceEntry[]): PresenceEntry[] {
  const byPerson = new Map<string, PresenceEntry>();
  for (const entry of list) {
    const seen = byPerson.get(entry.accountId);
    if (!seen || (seen.away && !entry.away) || (Boolean(seen.away) === Boolean(entry.away) && seen.at < entry.at)) byPerson.set(entry.accountId, entry);
  }
  const order = (entry: PresenceEntry) => joined.get(entry.accountId) ?? Number.MAX_SAFE_INTEGER;
  return [...byPerson.values()].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

export type PresenceStatus = "editing" | "viewing" | "away";
/** Typing now, looking, or with the tab in the background. */
export function statusOf(entry: Pick<PresenceEntry, "typing" | "away">): PresenceStatus {
  return entry.away ? "away" : entry.typing ? "editing" : "viewing";
}

/** "Owner", "Can edit", "Can view". */
export function roleLabel(role: PresenceEntry["role"]): string {
  return role === "owner" ? "Owner" : role === "edit" ? "Can edit" : "Can view";
}

/** An anonymous visitor on a public link. */
export function isGuest(entry: Pick<PresenceEntry, "signedIn" | "accountId">): boolean {
  return entry.signedIn === false || entry.accountId.startsWith("visitor:");
}

/** "Mira Chen · editing", "Curious Otter (guest) · viewing": the tooltip on an avatar. */
export function presenceLine(entry: PresenceEntry): string {
  return `${entry.name}${isGuest(entry) ? " (guest)" : ""} · ${statusOf(entry)}`;
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

async function resync(): Promise<void> {
  const asked = Date.now();
  try {
    const data = await api.presence();
    presenceStore.reset(data.people, data.you, data.now, asked);
  } catch {
    // The next stream open or heartbeat tries again.
  }
}

/**
 * Keeps this tab in the room while `active`: says where you are when it changes and every
 * `HEARTBEAT_MS` (marked away while the tab is hidden), reads who is here whenever the stream
 * opens or the tab comes back (from the background, sleep or offline), and leaves on `pagehide`
 * and when it stops. `room` names the space or item, and `where` what a post says about you.
 * `scope` runs the leave under the share or link header the view opened with.
 */
export function usePresenceSession({
  active,
  room,
  place,
  where,
  scope,
}: {
  active: boolean;
  room: string | null;
  place: string;
  where: () => Pick<PresenceUpdate, "route" | "resource">;
  scope: (fn: () => void) => void;
}): void {
  const whereRef = useRef(where);
  whereRef.current = where;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    if (!active || !room) return;
    presenceJoined();
    const send = () => void api.sendPresence({ tabId: tabId(), ...whereRef.current(), away: document.visibilityState === "hidden", follows: followStore.get()?.accountId ?? null }).catch(() => undefined);
    let tick = Date.now();
    void resync();
    const beat = window.setInterval(() => {
      const now = Date.now();
      // Timers stop while a laptop sleeps: what we know is stale.
      if (now - tick > HEARTBEAT_MS * 2.5) void resync();
      tick = now;
      send();
    }, HEARTBEAT_MS);
    const sweep = window.setInterval(() => presenceStore.sweep(), SWEEP_MS);
    const back = () => {
      send();
      void resync();
    };
    const onVisibility = () => (document.visibilityState === "visible" ? back() : send());
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      presenceJoined();
      back();
    };
    const leave = () => scopeRef.current(() => api.leavePresence(tabId()));
    const unfollow = followStore.subscribe(send);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(LIVE_OPENED_EVENT, back);
    window.addEventListener("online", back);
    window.addEventListener("pageshow", onShow);
    window.addEventListener("pagehide", leave);
    return () => {
      window.clearInterval(beat);
      window.clearInterval(sweep);
      unfollow();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(LIVE_OPENED_EVENT, back);
      window.removeEventListener("online", back);
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("pagehide", leave);
      leave();
      presenceStore.clear();
    };
  }, [active, room]);

  useEffect(() => {
    if (!active || !room) return;
    void api.sendPresence({ tabId: tabId(), ...whereRef.current(), away: document.visibilityState === "hidden", follows: followStore.get()?.accountId ?? null }).catch(() => undefined);
  }, [active, room, place]);
}
