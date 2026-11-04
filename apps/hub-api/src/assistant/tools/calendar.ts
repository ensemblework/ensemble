import { isGuestIn } from "../../sharing/context.js";
/**
 * The calendar Ensemble keeps (every connected Google and Outlook calendar and calendar link,
 * copies of one event merged: the same list as GET /api/calendar, calendar/read.ts) and the
 * weekly recap (GET /api/recap/week), for the assistant. Read only; creating or moving events
 * is the calendar app tools' job.
 */
import { z } from "zod";
import { addCalendarDays } from "../../cowork/dates.js";
import { participantNames } from "../../cowork/meetings.js";
import { weeklyRecap } from "../../cowork/service.js";
import { zonedDateTimeToUtc, zonedParts } from "../../lib/clock.js";
import { readCalendar } from "../../calendar/read.js";
import { defineTool, toolOk } from "../types.js";

export const DateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD. Work out relative dates from today's date in the prompt.");

const CALENDAR_SOURCE: Record<string, string> = { google_calendar: "Google Calendar", outlook_calendar: "Outlook calendar" };
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

function namesOf(participants: unknown): string[] {
  const names = participantNames(participants);
  return names.length > 10 ? [...names.slice(0, 10), `and ${names.length - 10} more`] : names;
}

export const calendarTools = [
  defineTool({
    name: "hub_list_events",
    area: "tasks",
    description:
      "List the person's calendar as Ensemble keeps it (Google Calendar, Outlook and calendar links, the same event from several calendars listed once) between from and to (YYYY-MM-DD, inclusive, the person's time zone; default today to 7 days ahead): time, title, place or meeting link, attendees, which calendars, and any meeting notes linked to the event. To create or move an event use the calendar app tools.",
    input: z.object({
      from: DateField.optional(),
      to: DateField.optional(),
      query: z.string().max(200).default("").describe("Words in the event title. Empty lists every event in the range."),
      limit: z.number().int().min(1).max(100).default(40),
    }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      if (isGuestIn(ctx.userId)) throw new Error("The space owner’s calendar is private. Open a space you own to use your calendar.");
      const timeZone = ctx.settings.timezone;
      const range = dayRange(timeZone, input.from, input.to, 7);
      if (range.end.getTime() - range.start.getTime() > (MAX_DAYS + 1) * 86_400_000) throw badInput(`Ask for at most ${MAX_DAYS} days at a time.`);
      const query = input.query.trim().toLowerCase();
      const calendar = await readCalendar(ctx.prisma, ctx.userId, { from: range.start, to: range.end, timeZone });
      const matching = query ? calendar.events.filter((row) => row.title.toLowerCase().includes(query)) : calendar.events;
      const events = matching.slice(0, input.limit);
      const ids = events.flatMap((row) => row.memberIds);
      const [sessions, imported] = await Promise.all([
        ids.length
          ? ctx.prisma.meetingSession.findMany({ where: { userId: ctx.userId, deletedAt: null, artifactId: { in: ids } }, select: { id: true, title: true, artifactId: true } })
          : [],
        ids.length
          ? ctx.prisma.meetingNote.findMany({ where: { userId: ctx.userId, deletedAt: null, eventArtifactId: { in: ids }, source: { not: "live" } }, select: { id: true, title: true, eventArtifactId: true } })
          : [],
      ]);
      const notesFor = (members: string[]) => [
        ...sessions.filter((row) => row.artifactId && members.includes(row.artifactId)).map((row) => ({ id: row.id, title: row.title })),
        ...imported.filter((row) => row.eventArtifactId && members.includes(row.eventArtifactId)).map((row) => ({ id: row.id, title: row.title })),
      ];
      const list = events.map((row) => {
        const start = new Date(row.start);
        const end = row.end ? new Date(row.end) : null;
        const notes = notesFor(row.memberIds);
        const lastDay = row.allDay && row.startDate && row.endDate ? addCalendarDays(row.endDate, -1) : null;
        const dateOnly = (date: string) => localWhen(new Date(`${date}T12:00:00Z`), "UTC", true);
        const calendars = [...new Set(row.sources.map((source) => CALENDAR_SOURCE[source.connector] ?? source.label))];
        return {
          id: row.id,
          title: row.title || "(busy)",
          when: row.allDay && row.startDate
            ? `${dateOnly(row.startDate)}${lastDay && lastDay !== row.startDate ? `–${dateOnly(lastDay)}` : ""}, all day`
            : `${localWhen(start, timeZone)}${end && !Number.isNaN(end.getTime()) ? `–${endTime(end, timeZone)}` : ""}`,
          start: row.start,
          ...(end && !Number.isNaN(end.getTime()) ? { end: row.end } : {}),
          ...(row.location ? { location: row.location } : {}),
          ...(row.joinUrl ? { link: row.joinUrl } : {}),
          attendees: namesOf(row.attendees),
          calendar: calendars.join(" · ") || "Calendar",
          ...(row.sources.length > 1 ? { mergedFrom: row.sources.length } : {}),
          ...(notes.length ? { meetingNotes: notes } : {}),
        };
      });
      const sync = calendar.sync.map((row) => ({
        calendar: CALENDAR_SOURCE[row.connector] ?? "Calendar links",
        lastSync: row.lastSyncAt,
        ...(row.lastError ? { error: row.lastError.slice(0, 200) } : {}),
      }));
      const note = sync.length || calendar.sources.length
        ? undefined
        : "No calendar syncs to Ensemble yet. Connect Google Workspace or Microsoft 365, or add a calendar link (ICS), in Settings → Connections (/settings?tab=connections).";
      const more = matching.length > input.limit;
      return toolOk(`${list.length} event(s) from ${range.from} to ${range.to}${more ? " (more; narrow the range)" : ""}.`, {
        timeZone,
        from: range.from,
        to: range.to,
        events: list,
        ...(more ? { more: true } : {}),
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
