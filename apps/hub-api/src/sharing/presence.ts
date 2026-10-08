/**
 * Who is here right now, in a shared space: where each person is (route, item), their cursor
 * on a diagram, and their colour. In memory, like the event stream: production runs one API
 * process. Entries expire when a tab stops sending heartbeats.
 */
import type { PrismaClient } from "@prisma/client";
import { sseHub } from "../lib/sse.js";
import { displayName, initialsOf } from "./store.js";

export const PRESENCE_TTL_MS = 45_000;
const MIN_GAP_MS = 40;

/** Soft, readable on light and dark. Picked by account so a person keeps their colour. */
const COLORS = ["#E8590C", "#7048E8", "#0C8599", "#2F9E44", "#D6336C", "#E67700", "#1971C2", "#C2255C"];

export type PresenceResource = { kind: string; id: string };
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
  route: string | null;
  resource: PresenceResource | null;
  /** Diagram coordinates, so everyone sees it at the same place whatever their zoom. */
  cursor: { x: number; y: number } | null;
  /** Where the person is looking on a diagram: the centre of their view (diagram coordinates) and zoom. */
  viewport: { x: number; y: number; zoom: number } | null;
  typing: boolean;
  at: number;
};

const rooms = new Map<string, Map<string, PresenceEntry>>();
type Person = { name: string; initials: string; avatar: string | null; emoji: string | null; color?: string; signedIn: boolean };
const names = new Map<string, Person>();
const lastPost = new Map<string, number>();

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

function sweep(spaceId: string): Map<string, PresenceEntry> {
  const room = rooms.get(spaceId) ?? new Map<string, PresenceEntry>();
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [key, entry] of room) if (entry.at < cutoff) room.delete(key);
  if (room.size) rooms.set(spaceId, room);
  else rooms.delete(spaceId);
  return room;
}

/** Everyone in a space now. A single shared item sees only the people on that item. */
export function presenceIn(spaceId: string, only?: PresenceResource): PresenceEntry[] {
  const entries = [...sweep(spaceId).values()];
  return only ? entries.filter((entry) => entry.resource?.kind === only.kind && entry.resource.id === only.id) : entries;
}

export type PresenceUpdate = {
  tabId: string;
  route?: string | null;
  resource?: PresenceResource | null;
  cursor?: { x: number; y: number } | null;
  viewport?: { x: number; y: number; zoom: number } | null;
  typing?: boolean;
  leave?: boolean;
};

/** Records one tab's state and tells the space. Returns false when throttled. */
/** Forget a cached name and avatar after a change, so the next heartbeat shows the new one. */
export function forgetPerson(accountId: string): void {
  names.delete(accountId);
}

export async function updatePresence(db: PrismaClient, spaceId: string, accountId: string, update: PresenceUpdate, known?: Person): Promise<boolean> {
  const key = `${accountId}:${update.tabId}`;
  const now = Date.now();
  if (!update.leave && now - (lastPost.get(key) ?? 0) < MIN_GAP_MS) return false;
  lastPost.set(key, now);
  if (lastPost.size > 5000) lastPost.clear();
  const room = sweep(spaceId);
  if (update.leave) {
    const gone = room.get(key);
    room.delete(key);
    if (!room.size) rooms.delete(spaceId);
    if (gone) sseHub.publish(spaceId, { event: "presence", data: { ...gone, gone: true }, ...(gone.resource ? { about: gone.resource } : {}) });
    return true;
  }
  const previous = room.get(key);
  const person = known ?? (await who(db, accountId));
  const entry: PresenceEntry = {
    accountId,
    tabId: update.tabId,
    name: person.name,
    initials: person.initials,
    color: person.color ?? colorFor(accountId),
    avatar: person.avatar,
    emoji: person.emoji,
    signedIn: person.signedIn,
    route: update.route === undefined ? (previous?.route ?? null) : update.route,
    resource: update.resource === undefined ? (previous?.resource ?? null) : update.resource,
    cursor: update.cursor === undefined ? (previous?.cursor ?? null) : update.cursor,
    viewport: update.viewport === undefined ? (previous?.viewport ?? null) : update.viewport,
    typing: update.typing ?? false,
    at: now,
  };
  room.set(key, entry);
  rooms.set(spaceId, room);
  // Moving to another item: the people on the old one see you leave it.
  if (previous?.resource && (previous.resource.kind !== entry.resource?.kind || previous.resource.id !== entry.resource?.id)) {
    sseHub.publish(spaceId, { event: "presence", data: { ...previous, gone: true }, about: previous.resource });
  }
  sseHub.publish(spaceId, { event: "presence", data: entry, ...(entry.resource ? { about: entry.resource } : {}) });
  return true;
}

/** Someone lost access: they leave the room at once, and the others see them go. */
export function dropPresence(spaceId: string, accountId: string): void {
  const room = rooms.get(spaceId);
  if (!room) return;
  for (const [key, entry] of room) {
    if (entry.accountId !== accountId) continue;
    room.delete(key);
    sseHub.publish(spaceId, { event: "presence", data: { ...entry, gone: true }, ...(entry.resource ? { about: entry.resource } : {}) });
  }
  if (!room.size) rooms.delete(spaceId);
}

/** Test hook. */
export function resetPresence(): void {
  rooms.clear();
  names.clear();
  lastPost.clear();
}
