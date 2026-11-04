/**
 * Which calendars feed the Today calendar (docs/03 §2.4): Google Calendar and
 * Outlook when switched on and connected, and every calendar link (ICS feed).
 */
import type { PrismaClient } from "@prisma/client";
import { connectionState, getConnector } from "../connectors/base.js";
import { loadSettings } from "../lib/settings.js";

export const ICS_SOURCE = "ics_calendar";
export const CALENDAR_SOURCES = ["google_calendar", "outlook_calendar", ICS_SOURCE] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];

/** sync_state key for a calendar's event sync, apart from its Sync people row. */
export const syncKey = (source: CalendarSource) => `calendar:${source}`;

export const SOURCE_NAME: Readonly<Record<string, string>> = {
  google_calendar: "Google Calendar",
  outlook_calendar: "Outlook calendar",
  ics_calendar: "Calendar link",
};

/** Short names for the source badges on an event. */
export const SOURCE_SHORT: Readonly<Record<string, string>> = {
  google_calendar: "Google",
  outlook_calendar: "Outlook",
  ics_calendar: "ICS",
};

const BY_METADATA: Readonly<Record<string, string>> = { google: "google_calendar", outlook: "outlook_calendar", ics: ICS_SOURCE };

/** The connector a stored event came from, from its metadata.source. */
export function connectorOf(source: unknown): string {
  return typeof source === "string" ? (BY_METADATA[source] ?? source) : "ensemble";
}

export interface FeedRow {
  id: string;
  name: string;
  host: string;
  secret: string;
  lastSyncAt: Date | null;
  lastError: string | null;
  itemCount: number;
  createdAt: Date;
}

export interface ActiveSources {
  google: boolean;
  outlook: boolean;
  feeds: FeedRow[];
  timeZone: string;
}

export async function activeSources(db: PrismaClient, userId: string): Promise<ActiveSources> {
  const settings = await loadSettings(db, userId);
  const on = async (id: string) => {
    const connector = getConnector(id);
    if (!connector || !settings.connections[connector.id]?.enabled) return false;
    return (await connectionState(userId, connector)).configured;
  };
  const [google, outlook, feeds] = await Promise.all([
    on("google_calendar"),
    on("outlook_calendar"),
    db.calendarFeed.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  ]);
  return { google, outlook, feeds, timeZone: settings.timezone };
}

export function anyActive(active: ActiveSources): boolean {
  return active.google || active.outlook || active.feeds.length > 0;
}

/** Whether a stored event's source still feeds the calendar. Events saved by hand or by the assistant always count. */
export function sourceActive(metadata: Record<string, unknown>, active: ActiveSources, feedIds: ReadonlySet<string>): boolean {
  if (metadata.calendarSync !== true) return true;
  const connector = connectorOf(metadata.source);
  if (connector === "google_calendar") return active.google;
  if (connector === "outlook_calendar") return active.outlook;
  if (connector === ICS_SOURCE) return typeof metadata.feedId === "string" && feedIds.has(metadata.feedId);
  return true;
}
