/**
 * The calendar Ensemble keeps (events synced from every connected Google and Outlook calendar,
 * the same rows as GET /api/calendar) and the weekly recap (GET /api/recap/week), for the
 * assistant. Read only; creating or moving events is the calendar app tools' job.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { addCalendarDays } from "../../cowork/dates.js";
import { participantNames } from "../../cowork/meetings.js";
import { weeklyRecap } from "../../cowork/service.js";
import { zonedDateTimeToUtc, zonedParts } from "../../lib/clock.js";
import { defineTool, toolOk } from "../types.js";

export const DateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD. Work out relative dates from today's date in the prompt.");

const CALENDAR_SOURCE: Record<string, string> = { google: "Google Calendar", outlook: "Outlook calendar" };
const CALENDAR_SYNCS = ["google_calendar", "outlook_calendar"];
const MAX_DAYS = 62;

function badInput(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/** The person's days `from`..`to` (inclusive) as UTC instants [start, end). */
export function dayRange(timeZone: string, from: string | undefined, to: string | undefined, fallbackDays: number): { from: string; to: string; start: Date; end: Date } {
  const today = zonedParts(timeZone).date;
  const first = from ?? (to ? addCalendarDays(to, -fallbackDays) : today);
  const last = to ?? addCalendarDays(first, fallbackDays);
  if (last < first) throw badInput("to is before from. Send from and to as YYYY-MM-DD with from first.");
  try {
    return { from: first, to: last, start: zonedDateTimeToUtc(first, "00:00", timeZone), end: zonedDateTimeToUtc(addCalendarDays(last, 1), "00:00", timeZone) };
  } catch {
    throw badInput("Use real dates as YYYY-MM-DD.");
  }
}

/** "Wed 14 Oct 15:00" in the person's zone; "Wed 14 Oct" for an all-day item. */
export function localWhen(at: Date, timeZone: string, dateOnly = false): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(at);
  if (dateOnly) return day;
  return `${day} ${new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at)}`;
}

function endTime(end: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(end);
}

function namesOf(participants: Prisma.JsonValue): string[] {
  const names = participantNames(participants);
  return names.length > 10 ? [...names.slice(0, 10), `and ${names.length - 10} more`] : names;
}

export const calendarTools = [
  defineTool({
    name: "hub_list_events",
    area: "tasks",
    description:
      "List calendar events already saved in Ensemble (Google Calendar, Outlook) between from and to (YYYY-MM-DD, inclusive, the person's time zone; default today to 7 days ahead): time, title, place or meeting link, attendees, which calendar, and any meeting notes linked to the event. To create or move an event use the calendar app tools.",
    input: z.object({
      from: DateField.optional(),
      to: DateField.optional(),
      query: z.string().max(200).default("").describe("Words in the event title. Empty lists every event in the range."),
      limit: z.number().int().min(1).max(100).default(40),
    }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const timeZone = ctx.settings.timezone;
      const range = dayRange(timeZone, input.from, input.to, 7);
      if (range.end.getTime() - range.start.getTime() > (MAX_DAYS + 1) * 86_400_000) throw badInput(`Ask for at most ${MAX_DAYS} days at a time.`);
      const query = input.query.trim();
      const rows = await ctx.prisma.artifact.findMany({
        where: {
          userId: ctx.userId,
          kind: "event",
          deletedAt: null,
          ts: { gte: range.start, lt: range.end },
          ...(query ? { title: { contains: query, mode: "insensitive" } } : {}),
        },
        orderBy: { ts: "asc" },
        take: input.limit + 1,
        select: { id: true, title: true, ts: true, url: true, metadata: true, participants: true },
      });
      const events = rows.slice(0, input.limit);
      const ids = events.map((row) => row.id);
      const [sessions, imported, syncs] = await Promise.all([
        ids.length
          ? ctx.prisma.meetingSession.findMany({ where: { userId: ctx.userId, deletedAt: null, artifactId: { in: ids } }, select: { id: true, title: true, artifactId: true } })
          : [],
        ids.length
          ? ctx.prisma.meetingNote.findMany({ where: { userId: ctx.userId, deletedAt: null, eventArtifactId: { in: ids }, source: { not: "live" } }, select: { id: true, title: true, eventArtifactId: true } })
          : [],
        ctx.prisma.syncState.findMany({ where: { userId: ctx.userId, connector: { in: CALENDAR_SYNCS } }, select: { connector: true, lastSyncAt: true, lastError: true } }),
      ]);
      const notesFor = (id: string) => [
        ...sessions.filter((row) => row.artifactId === id).map((row) => ({ id: row.id, title: row.title })),
        ...imported.filter((row) => row.eventArtifactId === id).map((row) => ({ id: row.id, title: row.title })),
      ];
      const list = events.map((row) => {
        const meta = (row.metadata ?? {}) as { end?: string | null; allDay?: boolean; joinUrl?: string | null; location?: string | null; source?: string; calendar?: string | null };
        const end = meta.end ? new Date(meta.end) : null;
        const allDay = Boolean(meta.allDay);
        const notes = notesFor(row.id);
        return {
          id: row.id,
          title: row.title || "(busy)",
          when: allDay ? `${localWhen(row.ts, timeZone, true)}, all day` : `${localWhen(row.ts, timeZone)}${end && !Number.isNaN(end.getTime()) ? `–${endTime(end, timeZone)}` : ""}`,
          start: row.ts.toISOString(),
          ...(end && !Number.isNaN(end.getTime()) ? { end: end.toISOString() } : {}),
          ...(meta.location ? { location: meta.location } : {}),
          ...(meta.joinUrl || row.url ? { link: meta.joinUrl ?? row.url } : {}),
          attendees: namesOf(row.participants),
          calendar: CALENDAR_SOURCE[meta.source ?? ""] ?? meta.source ?? "Calendar",
          ...(notes.length ? { meetingNotes: notes } : {}),
        };
      });
      const sync = syncs.map((row) => ({
        calendar: row.connector === "google_calendar" ? "Google Calendar" : "Outlook calendar",
        lastSync: row.lastSyncAt?.toISOString() ?? null,
        ...(row.lastError ? { error: row.lastError.slice(0, 200) } : {}),
      }));
      const note = sync.length
        ? undefined
        : "No calendar syncs to Ensemble yet. Connect Google Workspace or Microsoft 365 in Settings → Connections (/settings?tab=connections).";
      return toolOk(`${list.length} event(s) from ${range.from} to ${range.to}${rows.length > input.limit ? " (more; narrow the range)" : ""}.`, {
        timeZone,
        from: range.from,
        to: range.to,
        events: list,
        ...(rows.length > input.limit ? { more: true } : {}),
        sync,
        ...(note ? { note } : {}),
      });
    },
  }),
  defineTool({
    name: "hub_weekly_recap",
    area: "tasks",
    description:
      "The weekly recap for the week (Monday to Sunday) containing date (default this week): what was done, decided and slipped, what is due next, and the week's meeting notes. Same data as the Recap page.",
    input: z.object({ date: DateField.optional().describe("Any day in the week, YYYY-MM-DD. Last week: a date 7 days ago.") }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const recap = await weeklyRecap(ctx.prisma, ctx.userId, input.date);
      const today = zonedParts(ctx.settings.timezone).date;
      const from = today > recap.start ? today : recap.start;
      const until = addCalendarDays(recap.end, 7);
      const dueFrom = new Date(`${from}T00:00:00.000Z`);
      const dueUntil = new Date(`${until}T00:00:00.000Z`);
      const [tasks, deliverables] = from < until
        ? await Promise.all([
            ctx.prisma.task.findMany({
              where: { userId: ctx.userId, deletedAt: null, status: { notIn: ["done", "dropped"] }, due: { gte: dueFrom, lt: dueUntil } },
              orderBy: { due: "asc" },
              take: 20,
              select: { id: true, title: true, due: true },
            }),
            ctx.prisma.deliverable.findMany({
              where: { userId: ctx.userId, deletedAt: null, status: "upcoming", due: { gte: dueFrom, lt: dueUntil } },
              orderBy: { due: "asc" },
              take: 10,
              select: { title: true, due: true, projectId: true },
            }),
          ])
        : [[], []];
      const upcoming = [
        ...tasks.map((row) => ({ title: row.title, due: row.due!.toISOString().slice(0, 10), href: `/tasks/${row.id}` })),
        ...deliverables.map((row) => ({ title: row.title, due: row.due!.toISOString().slice(0, 10), href: `/projects/${row.projectId}`, detail: "Deliverable" })),
      ].sort((a, b) => a.due.localeCompare(b.due));
      const cap = <T,>(rows: T[], max: number) => ({ rows: rows.slice(0, max), more: Math.max(0, rows.length - max) });
      const done = cap(recap.done, 25);
      const slipped = cap(recap.slipped, 25);
      const decided = cap(recap.decided, 15);
      const meetings = cap(recap.meetings, 15);
      return toolOk(`Week of ${recap.label}: ${recap.done.length} done, ${recap.slipped.length} slipped, ${recap.decided.length} decided, ${upcoming.length} due next, ${recap.meetings.length} meeting(s).`, {
        week: recap.label,
        start: recap.start,
        end: addCalendarDays(recap.end, -1),
        done: done.rows,
        decided: decided.rows,
        slipped: slipped.rows,
        upcoming,
        meetings: meetings.rows,
        ...(done.more || slipped.more || decided.more || meetings.more ? { notListed: { done: done.more, slipped: slipped.more, decided: decided.more, meetings: meetings.more } } : {}),
      }, { href: "/recap" });
    },
  }),
];
