/**
 * Calendar subscriptions by link (ICS / iCal / webcal): Apple iCloud, Proton,
 * Fastmail, Notion Calendar, holiday calendars (docs/03 §2.4). The link usually
 * carries a private token, so it is stored encrypted and never returned.
 * Fetched server-side through the Files link guard (assistant/tools/save-file.ts:
 * public addresses only on every hop, at most 5 redirects), capped in size and time.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { fetchPublicFile, SaveFileError } from "../assistant/tools/save-file.js";
import { upsertArtifact } from "../connectors/ingest.js";
import { prisma } from "../lib/prisma.js";
import { decrypt, encrypt, privateIdentifier } from "../lib/secrets.js";
import { parseIcs, type IcsEvent } from "./ics.js";

export const MAX_FEEDS = 20;
export const MAX_FEED_BYTES = 5 * 1024 * 1024;
export const FEED_TIMEOUT_MS = 20_000;
const MAX_FEED_EVENTS = 2000;

export class CalendarFeedError extends Error {
  readonly expose = true;
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "CalendarFeedError";
  }
}

export interface CalendarFeedView {
  id: string;
  name: string;
  host: string;
  lastSyncAt: string | null;
  lastError: string | null;
  itemCount: number;
  createdAt: string;
}

type FeedRow = { id: string; name: string; host: string; secret: string; lastSyncAt: Date | null; lastError: string | null; itemCount: number; createdAt: Date };

export function feedView(row: Omit<FeedRow, "secret">): CalendarFeedView {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastError: row.lastError,
    itemCount: row.itemCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** webcal:// becomes https://; only https links without a user name or password are taken. */
export function feedUrl(raw: string): URL {
  const text = raw.trim();
  if (text.length > 2048) throw new CalendarFeedError("That link is too long.");
  let url: URL;
  try {
    url = new URL(text.replace(/^webcals?:\/\//i, "https://"));
  } catch {
    throw new CalendarFeedError("That is not a calendar link. Paste the ICS, iCal or webcal address your calendar app shares.");
  }
  if (url.protocol !== "https:") throw new CalendarFeedError("Use an https:// or webcal:// calendar link.");
  if (url.username || url.password) throw new CalendarFeedError("Links with a user name or password are refused.");
  url.hash = "";
  return url;
}

let fetchForTests: ((url: string) => Promise<string>) | null = null;

/** Tests serve feeds without a network. */
export function setCalendarFeedFetchForTests(fetcher: ((url: string) => Promise<string>) | null): void {
  fetchForTests = fetcher;
}

/** Downloads and checks a feed. Errors are worded for the calendar, not for Files. */
export async function fetchFeed(url: URL): Promise<string> {
  if (fetchForTests) return checkedCalendar(await fetchForTests(url.toString()));
  let bytes: Buffer;
  try {
    ({ bytes } = await fetchPublicFile(url.toString(), MAX_FEED_BYTES, undefined, FEED_TIMEOUT_MS));
  } catch (error) {
    if (error instanceof SaveFileError) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 413) throw new CalendarFeedError(`That calendar is larger than ${MAX_FEED_BYTES / (1024 * 1024)} MB.`);
      if (status === 415) throw new CalendarFeedError("That link opened a web page, not a calendar. Copy the ICS or iCal link from your calendar's sharing settings.");
      throw new CalendarFeedError(error.message.replace(/saved/g, "used"));
    }
    throw new CalendarFeedError(`That calendar could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return checkedCalendar(bytes.toString("utf8"));
}

function checkedCalendar(body: string): string {
  const text = body.replace(/^\uFEFF/, "");
  if (!/^\s*BEGIN:VCALENDAR/i.test(text)) throw new CalendarFeedError("That link did not return a calendar (no BEGIN:VCALENDAR).");
  return text;
}

const urlKey = (url: URL) => privateIdentifier("calendar-feed", url.toString());

/** Adds a feed after reading it once, so a wrong link is refused at once. */
export async function addFeed(db: PrismaClient, userId: string, input: { url: string; name?: string | null }, timeZone: string): Promise<{ feed: CalendarFeedView; events: number }> {
  const url = feedUrl(input.url);
  if ((await db.calendarFeed.count({ where: { userId } })) >= MAX_FEEDS) throw new CalendarFeedError(`You can add up to ${MAX_FEEDS} calendar links.`);
  const key = urlKey(url);
  if (await db.calendarFeed.findUnique({ where: { userId_urlKey: { userId, urlKey: key } }, select: { id: true } })) {
    throw new CalendarFeedError("That calendar is already added.", 409);
  }
  const text = await fetchFeed(url);
  const now = Date.now();
  const parsed = parseIcs(text, { from: new Date(now - 86_400_000), to: new Date(now + 86_400_000), defaultTimeZone: timeZone, maxEvents: 1 });
  const name = (input.name?.trim() || parsed.name || url.hostname).slice(0, 80);
  const row = await db.calendarFeed.create({ data: { userId, name, secret: encrypt(url.toString()), urlKey: key, host: url.hostname } });
  return { feed: feedView(row), events: 0 };
}

export async function renameFeed(db: PrismaClient, userId: string, id: string, name: string): Promise<CalendarFeedView | null> {
  const found = await db.calendarFeed.findFirst({ where: { id, userId }, select: { id: true } });
  if (!found) return null;
  return feedView(await db.calendarFeed.update({ where: { id }, data: { name: name.trim().slice(0, 80) } }));
}

/** Removes the feed and the events it brought; copies of them from other calendars stay. */
export async function removeFeed(db: PrismaClient, userId: string, id: string): Promise<boolean> {
  const found = await db.calendarFeed.findFirst({ where: { id, userId }, select: { id: true } });
  if (!found) return false;
  await db.artifact.updateMany({ where: { userId, kind: "event", externalId: { startsWith: `ics:${id}:` }, deletedAt: null }, data: { deletedAt: new Date() } });
  await db.calendarFeed.delete({ where: { id } });
  return true;
}

function externalId(feedId: string, event: IcsEvent): string {
  const instance = event.instanceStart ? event.instanceStart.toISOString() : "single";
  return `ics:${feedId}:${createHash("sha256").update(`${event.uid}\0${instance}`).digest("hex").slice(0, 32)}`;
}

/** Reads one feed into the Today calendar for the window. Records the outcome on the feed. */
export async function syncFeed(userId: string, feed: Pick<FeedRow, "id" | "name" | "secret">, window: { from: Date; to: Date }, timeZone: string): Promise<{ items: number }> {
  try {
    const text = await fetchFeed(feedUrl(decrypt(feed.secret)));
    const parsed = parseIcs(text, { from: window.from, to: window.to, defaultTimeZone: timeZone, maxEvents: MAX_FEED_EVENTS });
    const latest = new Map<string, IcsEvent>();
    for (const event of parsed.events) if (!event.cancelled) latest.set(externalId(feed.id, event), event);
    const seen: string[] = [];
    let items = 0;
    for (const [id, event] of latest) {
      const stored = await upsertArtifact(userId, {
        kind: "event",
        externalId: id,
        url: event.url,
        ts: event.start,
        title: event.title,
        text: event.description,
        participants: event.attendees,
        metadata: {
          source: "ics",
          calendarSync: true,
          feedId: feed.id,
          calendarId: feed.id,
          calendar: feed.name,
          eventId: event.uid,
          uid: event.uid,
          originalStart: event.instanceStart?.toISOString() ?? null,
          end: event.end?.toISOString() ?? null,
          allDay: event.allDay,
          startDate: event.startDate,
          endDate: event.endDate,
          joinUrl: event.joinUrl,
          location: event.location,
          organizer: event.organizer,
          hasDescription: Boolean(event.description.trim()),
        },
      });
      seen.push(id);
      if (stored) items += 1;
    }
    await prisma.artifact.updateMany({
      where: { userId, kind: "event", deletedAt: null, ts: { gte: window.from, lt: window.to }, externalId: { startsWith: `ics:${feed.id}:`, notIn: seen } },
      data: { deletedAt: new Date() },
    });
    const note = parsed.truncated ? `Only the first ${MAX_FEED_EVENTS} events in the window were read.` : null;
    await prisma.calendarFeed.update({ where: { id: feed.id }, data: { lastSyncAt: new Date(), lastError: note, itemCount: items } });
    return { items };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.calendarFeed.update({ where: { id: feed.id }, data: { lastError: message.slice(0, 300) } }).catch(() => undefined);
    throw error;
  }
}
