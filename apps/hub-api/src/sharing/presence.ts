/**
 * Who is here right now, in a shared space: where each person is (route, item), their cursor
 * on a diagram, their caret and scroll position on a page, and their colour. In memory, like the
 * event stream: production runs one API process.
 *
 * Tabs post a heartbeat every `HEARTBEAT_MS`. An entry not heard from for `PRESENCE_TTL_MS`
 * (`AWAY_TTL_MS` for a hidden tab, whose timers the browser slows down) is dropped by a sweep
 * that tells the others it left, so a closed laptop or a lost network drops off on its own.
 */
import type { PrismaClient } from "@prisma/client";
import { sseHub } from "../lib/sse.js";
import { displayName, initialsOf } from "./store.js";

export const HEARTBEAT_MS = 10_000;
export const PRESENCE_TTL_MS = 30_000;
export const AWAY_TTL_MS = 150_000;
/** Posts from one tab closer together than this are merged: the latest state goes out once the gap has passed. */
const MIN_GAP_MS = 40;
const SWEEP_MS = 5_000;
/** A `seq` this far below the last one is a clock set back, not a late request. */
const SEQ_RESET = 60_000_000;

/** Soft, readable on light and dark. Picked by account so a person keeps their colour. */
const COLORS = ["#E8590C", "#7048E8", "#0C8599", "#2F9E44", "#D6336C", "#E67700", "#1971C2", "#C2255C"];
/** Where two people in a room would share a colour, the second takes the first free one of these. */
const SPARE = [...COLORS, "#5F3DC4", "#087F5B", "#9C36B5", "#364FC7", "#A61E4D", "#5C940D"];

export type PresenceResource = { kind: string; id: string };
/** What the person may do where they are: the space's owner, or edit or view access. */
export type PresenceRole = "owner" | "edit" | "view";
export type PresenceEntry = {
  accountId: string;
  tabId: string;
  name: string;
  initials: string;
  color: string;
  /** A picture avatar id, or null. */
  avatar: string | null;
  /** Anonymous visitors on a public link show a creature instead. */
  emoji: string | null;
  /** Signed in (false: anonymous on a public link). */
  signedIn: boolean;
  role: PresenceRole;
  route: string | null;
  resource: PresenceResource | null;
  /** Diagram coordinates, so everyone sees it at the same place whatever their zoom. */
  cursor: { x: number; y: number } | null;
  /** Where the person is looking on a diagram: the centre of their view (diagram coordinates) and zoom. */
  viewport: { x: number; y: number; zoom: number } | null;
  /** Their text cursor on a page or task page: ProseMirror positions in the live document at `version` (pages/collab.ts). */
  caret: { anchor: number; head: number; version?: number } | null;
  /** The first position in view on a page or task page, at `version`, so a follower sees what they see. */
  scroll: { pos: number; version?: number } | null;
  /** The account id of the person this tab follows, if any. */
  follows: string | null;
  /** The tab is in the background. */
  away: boolean;
  typing: boolean;
  at: number;
};

const rooms = new Map<string, Map<string, PresenceEntry>>();
type Person = { name: string; initials: string; avatar: string | null; emoji: string | null; color?: string; signedIn: boolean };
const names = new Map<string, Person>();
/** The last `seq` per tab, kept after it leaves, so a request that arrives late cannot undo a newer one. */
const order = new Map<string, { seq: number; at: number }>();
const lastPublish = new Map<string, number>();
const deferred = new Map<string, ReturnType<typeof setTimeout>>();
let sweeper: ReturnType<typeof setInterval> | null = null;

export function colorFor(accountId: string): string {
  let hash = 0;
  for (const char of accountId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

async function who(db: PrismaClient, accountId: string): Promise<Person> {
  const known = names.get(accountId);
  if (known) return known;
  const row = await db.user.findUnique({ where: { id: accountId }, select: { name: true, email: true, avatar: true } });
  const value: Person = { name: row ? displayName(row.name, row.email) : "Someone", initials: row ? initialsOf(row.name, row.email) : "?", avatar: row?.avatar ?? null, emoji: null, signedIn: true };
  if (names.size > 2000) names.clear();
  names.set(accountId, value);
  return value;
}

function publish(spaceId: string, entry: PresenceEntry, gone = false): void {
  sseHub.publish(spaceId, { event: "presence", data: gone ? { ...entry, gone: true } : entry, ...(entry.resource ? { about: entry.resource } : {}) });
}

function cancelDeferred(key: string): void {
  const timer = deferred.get(key);
  if (timer) clearTimeout(timer);
  deferred.delete(key);
}

function expired(entry: PresenceEntry, now: number): boolean {
  return entry.at < now - (entry.away ? AWAY_TTL_MS : PRESENCE_TTL_MS);
}

/** Drops one room's silent tabs; the others see them leave. */
function sweepRoom(spaceId: string, now = Date.now()): Map<string, PresenceEntry> {
  const room = rooms.get(spaceId) ?? new Map<string, PresenceEntry>();
  for (const [key, entry] of room) {
    if (!expired(entry, now)) continue;
    room.delete(key);
    cancelDeferred(key);
    publish(spaceId, entry, true);
  }
  if (room.size) rooms.set(spaceId, room);
  else rooms.delete(spaceId);
  return room;
}

/** Drops every tab that stopped sending heartbeats and tells its room. Runs every few seconds. */
export function sweepPresence(now = Date.now()): void {
  for (const spaceId of [...rooms.keys()]) sweepRoom(spaceId, now);
  for (const [key, mark] of order) if (mark.at < now - 10 * 60_000) order.delete(key);
  for (const [key, at] of lastPublish) if (at < now - 60_000) lastPublish.delete(key);
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => sweepPresence(), SWEEP_MS);
  sweeper.unref?.();
}

/** Everyone in a space now. A single shared item sees only the people on that item. */
export function presenceIn(spaceId: string, only?: PresenceResource): PresenceEntry[] {
  const entries = [...sweepRoom(spaceId).values()];
  return only ? entries.filter((entry) => entry.resource?.kind === only.kind && entry.resource.id === only.id) : entries;
}

export type PresenceUpdate = {
  tabId: string;
  /** Rises with every post from a tab (also across reloads); an older one arriving late is ignored. */
  seq?: number;
  /** Set by the route from the request's access, never by the body. */
  role?: PresenceRole;
  route?: string | null;
  resource?: PresenceResource | null;
  cursor?: { x: number; y: number } | null;
  viewport?: { x: number; y: number; zoom: number } | null;
  caret?: { anchor: number; head: number; version?: number } | null;
  scroll?: { pos: number; version?: number } | null;
  follows?: string | null;
  away?: boolean;
  typing?: boolean;
  leave?: boolean;
};

/** Forget a cached name and avatar after a change, so the next heartbeat shows the new one. */
export function forgetPerson(accountId: string): void {
  names.delete(accountId);
}

function inOrder(key: string, seq: number | undefined, now: number): boolean {
  if (seq === undefined) return true;
  const mark = order.get(key);
  if (mark && seq <= mark.seq && mark.seq - seq < SEQ_RESET) return false;
  order.set(key, { seq, at: now });
  return true;
}

/**
 * A person's colour in a room: their own, unless someone else here already has it (carets and
 * cursors must tell people apart). Kept while they stay, and the same for all their tabs.
 */
function colorIn(room: Map<string, PresenceEntry>, accountId: string, wanted: string): string {
  const taken = new Set<string>();
  for (const entry of room.values()) {
    if (entry.accountId === accountId) return entry.color;
    taken.add(entry.color);
  }
  if (!taken.has(wanted)) return wanted;
  return SPARE.find((color) => !taken.has(color)) ?? wanted;
}

function same(a: PresenceResource | null | undefined, b: PresenceResource | null | undefined): boolean {
  return Boolean(a && b && a.kind === b.kind && a.id === b.id);
}

/**
 * Records one tab's state and tells the space. Returns false when the post was older than one
 * already applied. Posts closer together than `MIN_GAP_MS` are merged, never dropped.
 */
export async function updatePresence(db: PrismaClient, spaceId: string, accountId: string, update: PresenceUpdate, known?: Person): Promise<boolean> {
  startSweeper();
  const key = `${accountId}:${update.tabId}`;
  if (!inOrder(key, update.seq, Date.now())) return false;
  if (update.leave) {
    cancelDeferred(key);
    const room = sweepRoom(spaceId);
    const gone = room.get(key);
    room.delete(key);
    if (!room.size) rooms.delete(spaceId);
    if (gone) publish(spaceId, gone, true);
    return true;
  }
  const person = known ?? (await who(db, accountId));
  // A newer post (a leave, say) was applied while this one looked up the name.
  if (update.seq !== undefined && order.get(key)?.seq !== update.seq) return false;
  const now = Date.now();
  const room = sweepRoom(spaceId, now);
  const previous = room.get(key);
  const resource = update.resource === undefined ? (previous?.resource ?? null) : update.resource;
  const sameItem = same(previous?.resource, resource);
  const entry: PresenceEntry = {
    accountId,
    tabId: update.tabId,
    name: person.name,
    initials: person.initials,
    color: colorIn(room, accountId, person.color ?? colorFor(accountId)),
    avatar: person.avatar,
    emoji: person.emoji,
    signedIn: person.signedIn,
    role: update.role ?? previous?.role ?? "view",
    route: update.route === undefined ? (previous?.route ?? null) : update.route,
    resource,
    cursor: update.cursor === undefined ? (previous?.cursor ?? null) : update.cursor,
    viewport: update.viewport === undefined ? (previous?.viewport ?? null) : update.viewport,
    // A caret and a scroll position belong to one document: they do not follow you to the next item.
    caret: update.caret === undefined ? (sameItem ? (previous?.caret ?? null) : null) : update.caret,
    scroll: update.scroll === undefined ? (sameItem ? (previous?.scroll ?? null) : null) : update.scroll,
    follows: update.follows === undefined ? (previous?.follows ?? null) : update.follows,
    away: update.away ?? previous?.away ?? false,
    // A caret or scroll move between typing pulses must not end the "is editing" pulse.
    typing: update.typing ?? ((update.caret !== undefined || update.scroll !== undefined) && sameItem ? (previous?.typing ?? false) : false),
    at: now,
  };
  room.set(key, entry);
  rooms.set(spaceId, room);
  // Moving to another item: the people on the old one see you leave it.
  const moved = Boolean(previous?.resource && !same(previous.resource, entry.resource));
  if (moved) publish(spaceId, previous!, true);
  const wait = MIN_GAP_MS - (now - (lastPublish.get(key) ?? 0));
  if (wait > 0 && !moved) {
    if (!deferred.has(key)) {
      const timer = setTimeout(() => {
        deferred.delete(key);
        const latest = rooms.get(spaceId)?.get(key);
        if (!latest) return;
        lastPublish.set(key, Date.now());
        publish(spaceId, latest);
      }, wait);
      timer.unref?.();
      deferred.set(key, timer);
    }
    return true;
  }
  cancelDeferred(key);
  lastPublish.set(key, now);
  publish(spaceId, entry);
  return true;
}

/** Someone lost access: they leave the room at once, and the others see them go. */
export function dropPresence(spaceId: string, accountId: string): void {
  const room = rooms.get(spaceId);
  if (!room) return;
  for (const [key, entry] of room) {
    if (entry.accountId !== accountId) continue;
    room.delete(key);
    cancelDeferred(key);
    publish(spaceId, entry, true);
  }
  if (!room.size) rooms.delete(spaceId);
}

/** Test hook. */
export function resetPresence(): void {
  for (const timer of deferred.values()) clearTimeout(timer);
  deferred.clear();
  rooms.clear();
  names.clear();
  order.clear();
  lastPublish.clear();
}
