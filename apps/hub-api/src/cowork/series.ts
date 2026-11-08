/**
 * Meetings of one series (a weekly sync, a recurring 1:1) share a key, so a meeting can find the
 * one before it: its notes, decisions and open action items (docs/03 §7).
 *
 * The calendar decides when it can: Google names an occurrence's series (`recurringEventId`), Outlook
 * its series master, and an ICS feed repeats one UID across occurrences. A meeting with no recurring
 * event falls back to its title with dates and numbers taken out ("Atlas sync — 4 Nov" and "Atlas sync
 * 11/11" are one series); a generic title ("Meeting", "Call") has no key.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

const PREFIXES = /^(?:(?:re|fw|fwd|invitation|updated invitation|accepted|declined|tentative|canceled|cancelled)\s*:\s*)+/i;
const MONTHS = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;
const DAYS = /\b(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi;
/** Words that alone say nothing about which meeting this is. */
const GENERIC = new Set([
  "meeting", "meetings", "call", "calls", "sync", "chat", "catch", "catchup", "up", "the", "a", "an", "and", "with", "for", "of", "on", "at", "to",
  "notes", "note", "transcript", "recording", "session", "teams", "zoom", "google", "meet", "microsoft", "untitled", "new", "busy", "invite", "quick",
]);

/** A title as a series key: lower case, no dates, numbers, prefixes or punctuation; null when nothing specific is left. */
export function titleSeriesKey(title: string | null | undefined): string | null {
  if (!title) return null;
  const words = title
    .normalize("NFKC")
    .replace(PREFIXES, "")
    .toLowerCase()
    .replace(MONTHS, " ")
    .replace(DAYS, " ")
    .replace(/\d+(?:st|nd|rd|th)?\b/g, " ")
    .replace(/[^\p{L}\s]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
  if (!words.some((word) => !GENERIC.has(word))) return null;
  return `t:${words.join(" ").slice(0, 160)}`;
}

/** The calendar's own series for an event row's metadata, or null for a one-off event. */
export function eventSeriesKey(metadata: unknown): string | null {
  const meta = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  const series = typeof meta.seriesId === "string" && meta.seriesId ? meta.seriesId : null;
  if (series) return `s:${String(meta.source ?? "cal")}:${series}`.slice(0, 300);
  const uid = typeof meta.uid === "string" && meta.uid ? meta.uid : null;
  // A UID names the series only for a recurring occurrence; a one-off event's UID is its own.
  if (uid && typeof meta.originalStart === "string" && meta.originalStart) return `u:${uid}`.slice(0, 300);
  return null;
}

/** A meeting's series key: its calendar event's series, else its title. */
export function seriesKeyFor(input: { eventMetadata?: unknown; title?: string | null; eventTitle?: string | null }): string | null {
  return eventSeriesKey(input.eventMetadata) ?? titleSeriesKey(input.title) ?? titleSeriesKey(input.eventTitle);
}

/** The series key for a note or notes session from its stored event (by artifact id) and title. */
export async function seriesKeyOf(db: Db, userId: string, input: { artifactId?: string | null; title?: string | null }): Promise<string | null> {
  const event = input.artifactId
    ? await db.artifact.findFirst({ where: { id: input.artifactId, userId, kind: "event" }, select: { metadata: true, title: true } })
    : null;
  return seriesKeyFor({ eventMetadata: event?.metadata, title: input.title, eventTitle: event?.title });
}

export interface SeriesMeeting {
  /** The MeetingNote id when there is one, else the notes session's. */
  id: string;
  kind: "note" | "session";
  noteId: string | null;
  sessionId: string | null;
  title: string;
  at: Date;
  projectId: string | null;
  personIds: string[];
}

/**
 * Earlier meetings of a series, newest first. A title key alone also needs a shared person, or the
 * same project, when both sides have them: two teams' "Weekly sync" are not one series.
 */
export async function meetingsInSeries(
  db: Db,
  userId: string,
  input: { seriesKey: string; before?: Date; after?: Date; excludeIds?: string[]; personIds?: string[]; projectId?: string | null; limit?: number },
): Promise<SeriesMeeting[]> {
  const limit = input.limit ?? 3;
  const when = (field: "occurredAt" | "startedAt") => ({
    ...(input.before ? { lt: input.before } : {}),
    ...(input.after ? { gt: input.after } : {}),
  }) as Prisma.DateTimeFilter;
  const exclude = input.excludeIds?.filter(Boolean) ?? [];
  const [notes, sessions] = await Promise.all([
    db.meetingNote.findMany({
      where: { userId, deletedAt: null, seriesKey: input.seriesKey, ...(exclude.length ? { id: { notIn: exclude } } : {}), ...(input.before || input.after ? { occurredAt: when("occurredAt") } : {}) },
      orderBy: { occurredAt: input.after ? "asc" : "desc" },
      take: limit * 3,
      select: { id: true, title: true, occurredAt: true, askedAt: true, projectId: true, personIds: true },
    }),
    db.meetingSession.findMany({
      where: { userId, deletedAt: null, seriesKey: input.seriesKey, meetingNoteId: null, ...(exclude.length ? { id: { notIn: exclude } } : {}), ...(input.before || input.after ? { startedAt: when("startedAt") } : {}) },
      orderBy: { startedAt: input.after ? "asc" : "desc" },
      take: limit * 3,
      select: { id: true, title: true, startedAt: true, projectId: true, personIds: true },
    }),
  ]);
  const rows: SeriesMeeting[] = [
    ...notes.map((row) => ({ id: row.id, kind: "note" as const, noteId: row.id, sessionId: null, title: row.title, at: row.occurredAt ?? row.askedAt, projectId: row.projectId, personIds: row.personIds })),
    ...sessions.map((row) => ({ id: row.id, kind: "session" as const, noteId: null, sessionId: row.id, title: row.title, at: row.startedAt, projectId: row.projectId, personIds: row.personIds })),
  ];
  const byTitle = input.seriesKey.startsWith("t:");
  const people = new Set(input.personIds ?? []);
  const fits = (row: SeriesMeeting) => {
    if (!byTitle) return true;
    if (input.projectId && row.projectId) return input.projectId === row.projectId;
    if (people.size && row.personIds.length) return row.personIds.some((id) => people.has(id));
    return true;
  };
  return rows
    .filter(fits)
    .sort((a, b) => (input.after ? a.at.getTime() - b.at.getTime() : b.at.getTime() - a.at.getTime()))
    .slice(0, limit);
}
