/**
 * Helpers for the Today calendar (components/calendar/agenda.tsx). The API merges
 * the same event from several calendars (hub-api calendar/dedupe.ts); these only
 * place events on days, find overlaps and word sources, in the person's time zone.
 */
import type { CalendarEvent, CalendarEventSource } from "./api";

const DAY = 86_400_000;
const zones = new Map<string, boolean>();

export function validZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  const known = zones.get(zone);
  if (known !== undefined) return known;
  let ok = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    ok = true;
  } catch {
    ok = false;
  }
  zones.set(zone, ok);
  return ok;
}

/** The person's zone when it is a real one, else the browser's. */
export function displayZone(zone: string | null | undefined): string {
  return validZone(zone) ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const keyFormats = new Map<string, Intl.DateTimeFormat>();

/** YYYY-MM-DD of an instant in `zone`. */
export function dateKey(at: Date, zone: string): string {
  let format = keyFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    keyFormats.set(zone, format);
  }
  return format.format(at);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** Every day (YYYY-MM-DD in `zone`) an event is on. All-day events use their own dates, never a time zone. */
export function eventDays(event: CalendarEvent, zone: string): string[] {
  let first: string;
  let last: string;
  if (event.allDay) {
    first = event.startDate ?? event.start.slice(0, 10);
    const end = event.endDate ?? (event.end ? event.end.slice(0, 10) : null);
    last = end && end > first ? addDays(end, -1) : first;
  } else {
    const start = new Date(event.start);
    first = dateKey(start, zone);
    const end = event.end ? new Date(Math.max(start.getTime(), new Date(event.end).getTime() - 1)) : start;
    last = dateKey(end, zone);
  }
  const out = [first];
  while (out[out.length - 1]! < last && out.length < 31) out.push(addDays(out[out.length - 1]!, 1));
  return out;
}

export function eventsOn(events: readonly CalendarEvent[], day: string, zone: string): CalendarEvent[] {
  return events.filter((event) => eventDays(event, zone).includes(day));
}

const span = (event: CalendarEvent): [number, number] => {
  const start = Date.parse(event.start);
  const end = event.end ? Date.parse(event.end) : Number.NaN;
  return [start, Number.isFinite(end) && end > start ? end : start + 30 * 60_000];
};

/** Ids of timed events that overlap another timed event: double bookings. */
export function conflicts(events: readonly CalendarEvent[]): Set<string> {
  const timed = events.filter((event) => !event.allDay).map((event) => ({ id: event.id, span: span(event) })).sort((a, b) => a.span[0] - b.span[0]);
  const out = new Set<string>();
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j]!.span[0] < timed[i]!.span[1]; j++) {
      out.add(timed[i]!.id);
      out.add(timed[j]!.id);
    }
  }
  return out;
}

/** "Google · Outlook" for a tooltip, in the order the API gave. */
export function sourceSummary(sources: readonly CalendarEventSource[] | undefined): string {
  return [...new Set((sources ?? []).map((source) => source.label))].join(" · ");
}

/** Which colour a source's dot takes (`.cal-dot[data-source]` in agenda.css). Never the only cue: names go with it. */
export function sourceKind(connector: string): "google" | "outlook" | "ics" | "ensemble" {
  if (connector === "google_calendar") return "google";
  if (connector === "outlook_calendar") return "outlook";
  if (connector === "ics_calendar") return "ics";
  return "ensemble";
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();

function timeFormat(zone: string): Intl.DateTimeFormat {
  let format = timeFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" });
    timeFormats.set(zone, format);
  }
  return format;
}

export function timeOf(at: string | Date, zone: string): string {
  return timeFormat(zone).format(typeof at === "string" ? new Date(at) : at);
}

/** "10:00 – 10:30 AM" (the locale's own range format), or the start alone when there is no end. */
export function timeRange(event: CalendarEvent, zone: string): string {
  const start = new Date(event.start);
  const end = event.end ? new Date(event.end) : null;
  if (!end || !(end > start)) return timeOf(start, zone);
  const format = timeFormat(zone);
  return typeof format.formatRange === "function" ? format.formatRange(start, end) : `${format.format(start)} – ${format.format(end)}`;
}

/** `count` days from `first` (YYYY-MM-DD), as dates. */
export function daysFrom(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addDays(first, index));
}

/** "Thu 6 Nov" for a YYYY-MM-DD date. */
export function shortDay(day: string, locale?: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** "Today", "Tomorrow", "Yesterday", else "Thu 6 Nov", for a YYYY-MM-DD date. */
export function dayLabel(day: string, today: string, locale?: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  if (day === addDays(today, -1)) return "Yesterday";
  return shortDay(day, locale);
}

/** Where an event is relative to now: still to come, happening, or over. */
export function eventPhase(event: CalendarEvent, now = Date.now()): "upcoming" | "now" | "past" {
  if (event.allDay) return "upcoming";
  const [start, end] = span(event);
  if (now < start) return "upcoming";
  return now < end ? "now" : "past";
}
