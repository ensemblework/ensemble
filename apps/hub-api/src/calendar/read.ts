/**
 * The Today calendar as one list (docs/03 §2.4): every stored event from the
 * calendars that still feed it, copies of the same event merged by
 * calendar/dedupe.ts at read time. GET /api/calendar, /api/today/home, the
 * assistant's hub_list_events and the other event readers use this.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { zonedDateTimeToUtc, zonedParts } from "../lib/clock.js";
import { dedupeEvents, type CalendarAttendee, type CalendarRecord, type MergedEvent } from "./dedupe.js";
import { isTimeZone } from "./ics.js";
import { activeSources, CALENDAR_SOURCES, connectorOf, ICS_SOURCE, sourceActive, SOURCE_SHORT, syncKey, type ActiveSources } from "./sources.js";

const DAY = 86_400_000;
/** Multi-day events that began before the range still show; this is how far back they are looked for. */
const LOOKBACK_DAYS = 14;
const MAX_ROWS = 5000;
const MAX_ATTENDEES = 50;

export const EVENT_ROW_SELECT = { id: true, externalId: true, title: true, ts: true, url: true, metadata: true, participants: true, createdAt: true } as const;

export interface EventRow {
  id: string;
  externalId?: string;
  title: string;
  ts: Date;
  url?: string | null;
  metadata: Prisma.JsonValue;
  participants?: Prisma.JsonValue;
  createdAt?: Date;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const instant = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** A stored all-day day: UTC midnight is the date itself; anything else was saved as local midnight. */
function floatingDate(at: Date, timeZone: string): string {
  const utcMidnight = at.getUTCHours() === 0 && at.getUTCMinutes() === 0 && at.getUTCSeconds() === 0;
  return utcMidnight ? at.toISOString().slice(0, 10) : zonedParts(timeZone, at).date;
}

function attendees(value: Prisma.JsonValue | undefined): CalendarAttendee[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const item = record(row);
    return { email: text(item.email)?.toLowerCase() ?? null, name: text(item.name) };
  });
}

export function recordFromRow(row: EventRow, timeZone: string): CalendarRecord {
  const meta = record(row.metadata);
  const connector = connectorOf(meta.source);
  const allDay = meta.allDay === true;
  const end = instant(meta.end);
  let startDate = allDay ? text(meta.startDate) : null;
  let endDate = allDay ? text(meta.endDate) : null;
  if (allDay && !startDate) {
    startDate = floatingDate(row.ts, timeZone);
    endDate = end ? floatingDate(end, timeZone) : null;
  }
  return {
    id: row.id,
    connector,
    calendarId: text(meta.calendarId) ?? text(meta.feedId) ?? (connector === "outlook_calendar" ? "default" : null),
    calendarName: text(meta.calendar),
    eventId: text(meta.eventId) ?? row.externalId ?? null,
    url: row.url ?? null,
    uid: text(meta.uid),
    instanceStart: instant(meta.originalStart),
    title: row.title,
    start: row.ts,
    end,
    allDay,
    startDate,
    endDate,
    cancelled: meta.cancelled === true,
    joinUrl: text(meta.joinUrl),
    location: text(meta.location),
    hasDescription: meta.hasDescription === true,
    attendees: attendees(row.participants),
    organizer: text(meta.organizer),
    createdAt: row.createdAt ?? null,
  };
}

/**
 * Collapses copies of the same event among rows a reader already loaded, keeping the
 * earliest-created copy's row with the merged title and every copy's id. Sorted by start.
 */
export function collapseEventRows<T extends EventRow>(rows: readonly T[], timeZone = "UTC"): Array<T & { memberIds: string[] }> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return dedupeEvents(rows.map((row) => recordFromRow(row, timeZone)))
    .filter((event) => !event.cancelled)
    .map((event) => ({ ...byId.get(event.id)!, title: event.title, memberIds: event.memberIds }))
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

export interface CalendarEventSource {
  connector: string;
  /** "Google", "Outlook", or the calendar link's name. */
  label: string;
  calendar: string | null;
  url: string | null;
}

export interface CalendarEventView {
  id: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  /** The online meeting link, else the event's own page. */
  joinUrl: string | null;
  location: string | null;
  /** All-day span as calendar dates, end exclusive. */
  startDate: string | null;
  endDate: string | null;
  /** The online meeting link only. */
  meetingUrl: string | null;
  url: string | null;
  organizer: string | null;
  attendees: CalendarAttendee[];
  hasDescription: boolean;
  /** Ids of every stored copy (one per source calendar). */
  memberIds: string[];
  sources: CalendarEventSource[];
}

export interface CalendarSourceView {
  connector: string;
  /** The calendar link's id, for ICS. */
  id: string | null;
  label: string;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface CalendarRead {
  timeZone: string;
  events: CalendarEventView[];
  sync: Array<{ connector: string; lastSyncAt: string | null; lastError: string | null }>;
  sources: CalendarSourceView[];
}

function eventView(event: MergedEvent, feedNames: ReadonlyMap<string, string>): CalendarEventView {
  return {
    id: event.id,
    title: event.title || "(busy)",
    start: event.start.toISOString(),
    end: event.end?.toISOString() ?? null,
    allDay: event.allDay,
    joinUrl: event.joinUrl ?? event.sources[0]?.url ?? null,
    location: event.location,
    startDate: event.startDate,
    endDate: event.endDate,
    meetingUrl: event.joinUrl,
    url: event.sources[0]?.url ?? null,
    organizer: event.organizer,
    attendees: event.attendees.slice(0, MAX_ATTENDEES),
    hasDescription: event.hasDescription,
    memberIds: event.memberIds,
    sources: event.sources.map((source) => ({
      connector: source.connector,
      label: source.connector === ICS_SOURCE ? (feedNames.get(source.calendarId ?? "") ?? source.calendarName ?? "ICS") : (SOURCE_SHORT[source.connector] ?? "Ensemble"),
      calendar: source.calendarName,
      url: source.url,
    })),
  };
}

function sortKey(event: MergedEvent, timeZone: string): number {
  if (!event.allDay || !event.startDate) return event.start.getTime();
  try {
    return zonedDateTimeToUtc(event.startDate, "00:00", timeZone).getTime();
  } catch {
    return event.start.getTime();
  }
}

/** Merged events that overlap [from, to): timed by instant, all-day by the person's dates. */
export function inRange(events: readonly MergedEvent[], from: Date, to: Date, timeZone: string): MergedEvent[] {
  const firstDate = zonedParts(timeZone, from).date;
  const lastDate = zonedParts(timeZone, new Date(to.getTime() - 1)).date;
  return events
    .filter((event) =>
      event.allDay && event.startDate && event.endDate
        ? event.startDate <= lastDate && event.endDate > firstDate
        : event.start < to && (event.start >= from || (event.end !== null && event.end > from)),
    )
    .sort((a, b) => sortKey(a, timeZone) - sortKey(b, timeZone) || Number(b.allDay) - Number(a.allDay) || a.title.localeCompare(b.title));
}

export async function mergedEvents(
  db: PrismaClient,
  userId: string,
  window: { from: Date; to: Date },
  timeZone: string,
  active: ActiveSources,
): Promise<MergedEvent[]> {
  const rows = await db.artifact.findMany({
    where: { userId, kind: "event", deletedAt: null, ts: { gte: new Date(window.from.getTime() - LOOKBACK_DAYS * DAY), lt: new Date(window.to.getTime() + DAY) } },
    orderBy: { ts: "asc" },
    take: MAX_ROWS,
    select: EVENT_ROW_SELECT,
  });
  const feedIds = new Set(active.feeds.map((feed) => feed.id));
  const visible = rows.filter((row) => sourceActive(record(row.metadata), active, feedIds));
  return dedupeEvents(visible.map((row) => recordFromRow(row, timeZone))).filter((event) => !event.cancelled);
}

/** The person's merged calendar in [from, to), with each source's last sync. */
export async function readCalendar(db: PrismaClient, userId: string, input: { from: Date; to: Date; timeZone?: string | null }): Promise<CalendarRead> {
  const active = await activeSources(db, userId);
  const timeZone = input.timeZone && isTimeZone(input.timeZone) ? input.timeZone : isTimeZone(active.timeZone) ? active.timeZone : "UTC";
  const legacy: string[] = CALENDAR_SOURCES.filter((id) => id !== ICS_SOURCE);
  const [merged, states] = await Promise.all([
    mergedEvents(db, userId, input, timeZone, active),
    db.syncState.findMany({ where: { userId, connector: { in: [...CALENDAR_SOURCES.map(syncKey), ...legacy] } } }),
  ]);
  const feedNames = new Map(active.feeds.map((feed) => [feed.id, feed.name]));
  const state = (source: (typeof CALENDAR_SOURCES)[number]) => states.find((row) => row.connector === syncKey(source)) ?? states.find((row) => row.connector === source);
  const sync = CALENDAR_SOURCES.flatMap((source) => {
    const row = state(source);
    return row ? [{ connector: source, lastSyncAt: row.lastSyncAt?.toISOString() ?? null, lastError: row.lastError }] : [];
  });
  const sources: CalendarSourceView[] = [
    ...(["google_calendar", "outlook_calendar"] as const)
      .filter((source) => (source === "google_calendar" ? active.google : active.outlook))
      .map((source) => {
        const row = states.find((item) => item.connector === syncKey(source));
        return { connector: source, id: null, label: SOURCE_SHORT[source]!, lastSyncAt: row?.lastSyncAt?.toISOString() ?? null, lastError: row?.lastError ?? null };
      }),
    ...active.feeds.map((feed) => ({ connector: ICS_SOURCE, id: feed.id, label: feed.name, lastSyncAt: feed.lastSyncAt?.toISOString() ?? null, lastError: feed.lastError })),
  ];
  return { timeZone, events: inRange(merged, input.from, input.to, timeZone).map((event) => eventView(event, feedNames)), sync, sources };
}
