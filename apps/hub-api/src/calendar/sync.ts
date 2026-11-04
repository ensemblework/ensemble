/**
 * Keeps the Today calendar's events (docs/03 §2.4). Calendar sources are the one
 * place Ensemble keeps a rolling copy of provider content: while Google Calendar
 * or Outlook is switched on, or a calendar link is added, the events in a window
 * (14 days back, 42 ahead) are read when the person presses Sync on Today, when
 * a link is added, and every 30 minutes by the scheduler (ENSEMBLE_CALENDAR_REFRESH=off
 * stops that). Each source keeps its own rows; after every read, copies of one event
 * are grouped (metadata.dedupeKey = the group's earliest-created id) by the same
 * rules the read path applies.
 */
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { syncCalendar } from "../connectors/google.js";
import { syncOutlookCalendar } from "../connectors/microsoft.js";
import { ConnectorError } from "../connectors/types.js";
import { claimSlot } from "../jobs/claim.js";
import { requireVerifiedUser } from "../lib/hosted-access.js";
import { appendLedger } from "../lib/ledger.js";
import { prisma } from "../lib/prisma.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { dedupeEvents } from "./dedupe.js";
import { syncFeed } from "./feeds.js";
import { recordFromRow, EVENT_ROW_SELECT } from "./read.js";
import { activeSources, anyActive, ICS_SOURCE, syncKey, type ActiveSources, type CalendarSource } from "./sources.js";

const DAY = 86_400_000;
export const WINDOW_BACK_DAYS = 14;
export const WINDOW_AHEAD_DAYS = 42;
export const REFRESH_MS = 30 * 60_000;

export function calendarWindow(now = Date.now()): { from: Date; to: Date } {
  return { from: new Date(now - WINDOW_BACK_DAYS * DAY), to: new Date(now + WINDOW_AHEAD_DAYS * DAY) };
}

export function calendarRefreshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENSEMBLE_CALENDAR_REFRESH?.trim().toLowerCase() !== "off";
}

export interface CalendarSyncOutcome {
  connector: CalendarSource;
  /** The calendar link, for ICS. */
  id?: string;
  label: string;
  ok: boolean;
  items: number;
  message: string;
}

export interface CalendarSyncResult {
  outcomes: CalendarSyncOutcome[];
  merged: number;
  message?: string;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Hides synced events of calendars that no longer feed Today (switched off, disconnected, link removed). */
export async function hideInactive(db: PrismaClient, userId: string, active: ActiveSources): Promise<number> {
  const off = [...(active.google ? [] : ["google"]), ...(active.outlook ? [] : ["outlook"])];
  let hidden = 0;
  for (const source of off) {
    hidden += (
      await db.artifact.updateMany({
        where: { userId, kind: "event", deletedAt: null, AND: [{ metadata: { path: ["calendarSync"], equals: true } }, { metadata: { path: ["source"], equals: source } }] },
        data: { deletedAt: new Date() },
      })
    ).count;
  }
  return hidden;
}

/** Stores each event's group (metadata.dedupeKey) for the window. Only rows whose group changed are written. */
export async function regroupCalendar(db: PrismaClient, userId: string, window: { from: Date; to: Date }, timeZone: string): Promise<{ rows: number; events: number }> {
  const rows = await db.artifact.findMany({
    where: { userId, kind: "event", deletedAt: null, ts: { gte: new Date(window.from.getTime() - DAY), lt: new Date(window.to.getTime() + DAY) } },
    select: EVENT_ROW_SELECT,
    take: 5000,
  });
  const merged = dedupeEvents(rows.map((row) => recordFromRow(row, timeZone)));
  const stored = new Map(rows.map((row) => [row.id, record(row.metadata).dedupeKey]));
  const ids: string[] = [];
  const keys: string[] = [];
  for (const event of merged) {
    for (const id of event.memberIds) {
      if (stored.get(id) === event.id) continue;
      ids.push(id);
      keys.push(event.id);
    }
  }
  if (ids.length) {
    await db.$executeRaw`
      UPDATE artifacts AS a SET metadata = jsonb_set(a.metadata, '{dedupeKey}', to_jsonb(v.key))
      FROM unnest(${ids}::text[], ${keys}::text[]) AS v(id, key)
      WHERE a.id = v.id AND a.user_id = ${userId}`;
  }
  return { rows: rows.length, events: merged.length };
}

async function saveState(userId: string, source: CalendarSource, outcome: { ok: boolean; message: string; items: number }) {
  const connector = syncKey(source);
  await prisma.syncState.upsert({
    where: { userId_connector: { userId, connector } },
    create: { userId, connector, lastSyncAt: outcome.ok ? new Date() : null, lastError: outcome.ok ? null : outcome.message, itemCount: outcome.items },
    update: { ...(outcome.ok ? { lastSyncAt: new Date(), itemCount: outcome.items } : {}), lastError: outcome.ok ? null : outcome.message },
  });
}

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function run(app: Pick<FastifyInstance, "log">, userId: string, reason: "button" | "schedule" | "feed", only?: { feedId?: string }): Promise<CalendarSyncResult> {
  await requireVerifiedUser(userId);
  const settings = await loadSettings(prisma, userId);
  const active = await activeSources(prisma, userId);
  const window = calendarWindow();
  const outcomes: CalendarSyncOutcome[] = [];
  const ctx = { userId, settings, since: window.from, cursor: null };
  const providers: Array<{ source: CalendarSource; on: boolean; label: string; sync: typeof syncCalendar }> = [
    { source: "google_calendar", on: active.google && !only?.feedId, label: "Google Calendar", sync: syncCalendar },
    { source: "outlook_calendar", on: active.outlook && !only?.feedId, label: "Outlook calendar", sync: syncOutlookCalendar },
  ];
  for (const provider of providers) {
    if (!provider.on) continue;
    try {
      const result = await provider.sync(ctx, window);
      const outcome = { connector: provider.source, label: provider.label, ok: true, items: result.items, message: `${result.items} event${result.items === 1 ? "" : "s"}` };
      outcomes.push(outcome);
      await saveState(userId, provider.source, outcome);
    } catch (error) {
      const message = error instanceof ConnectorError ? error.message : `Calendar sync failed: ${failure(error)}`;
      app.log.warn({ connector: provider.source, err: failure(error) }, "calendar sync failed");
      const outcome = { connector: provider.source, label: provider.label, ok: false, items: 0, message };
      outcomes.push(outcome);
      await saveState(userId, provider.source, outcome);
    }
  }
  const feeds = active.feeds.filter((feed) => !only?.feedId || feed.id === only.feedId);
  for (const feed of feeds) {
    try {
      const { items } = await syncFeed(userId, feed, window, settings.timezone);
      outcomes.push({ connector: ICS_SOURCE, id: feed.id, label: feed.name, ok: true, items, message: `${items} event${items === 1 ? "" : "s"}` });
    } catch (error) {
      app.log.warn({ connector: ICS_SOURCE, err: failure(error) }, "calendar link sync failed");
      outcomes.push({ connector: ICS_SOURCE, id: feed.id, label: feed.name, ok: false, items: 0, message: failure(error) });
    }
  }
  const icsOutcomes = outcomes.filter((row) => row.connector === ICS_SOURCE);
  if (icsOutcomes.length) {
    const failed = icsOutcomes.find((row) => !row.ok);
    await saveState(userId, ICS_SOURCE, { ok: !failed, message: failed ? `${failed.label}: ${failed.message}` : "", items: icsOutcomes.reduce((sum, row) => sum + row.items, 0) });
  }
  await hideInactive(prisma, userId, active);
  const grouped = await regroupCalendar(prisma, userId, window, settings.timezone);
  if (reason !== "schedule") {
    await appendLedger({ userId, actor: "me", action: "calendar.sync", payload: { reason, results: outcomes.map(({ connector, ok, items }) => ({ connector, ok, items })) } });
  }
  sseHub.publish(userId, { event: "sync", data: { calendar: outcomes.map(({ connector, ok }) => ({ connector, ok })) } });
  return {
    outcomes,
    merged: grouped.rows - grouped.events,
    ...(anyActive(active) ? {} : { message: "No calendar is connected. Connect Google or Microsoft 365, or add a calendar link, in Settings → Connections." }),
  };
}

const running = new Map<string, Promise<CalendarSyncResult>>();

/** Reads every calendar that feeds Today (or one calendar link). One run per person at a time. */
export function syncCalendars(app: Pick<FastifyInstance, "log">, userId: string, reason: "button" | "schedule" | "feed", only?: { feedId?: string }): Promise<CalendarSyncResult> {
  const key = `${userId}:${only?.feedId ?? "all"}`;
  const existing = running.get(key) ?? running.get(`${userId}:all`);
  if (existing) return existing;
  const job = run(app, userId, reason, only).finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

const lastSlot = new Map<string, number>();

/** Scheduler tick: once per 30-minute slot per person with a calendar on, claimed across API processes. */
export async function refreshCalendarsIfDue(app: Pick<FastifyInstance, "log" | "prisma">, userId: string, now = Date.now()): Promise<boolean> {
  if (!calendarRefreshEnabled()) return false;
  const slot = Math.floor(now / REFRESH_MS);
  if (lastSlot.get(userId) === slot) return false;
  lastSlot.set(userId, slot);
  if (lastSlot.size > 50_000) lastSlot.clear();
  const active = await activeSources(app.prisma, userId);
  if (!anyActive(active)) {
    await hideInactive(app.prisma, userId, active);
    return false;
  }
  if (!(await claimSlot(app.prisma, userId, "schedule:calendar", `calendar@${slot}`))) return false;
  await syncCalendars(app, userId, "schedule");
  return true;
}
