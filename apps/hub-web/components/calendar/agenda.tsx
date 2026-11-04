"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * One day of the merged calendar (hub-api calendar/read.ts): all-day events in
 * a slim strip, then one row per event with its sources, a Join link for
 * online meetings and a quiet mark on double bookings. Used by the Today
 * calendar widget (components/today/work-calendar.tsx) and the desk's Calendar
 * agenda tile (components/desk/calendar-agenda.tsx). Styles: agenda.css,
 * loaded by app/(hub)/layout.tsx.
 */
import { AlertTriangle, CalendarCheck2, CalendarPlus, Link2, MapPin, Video } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { CalendarEvent, CalendarEventSource, CalendarSourceState } from "@/lib/api";
import { conflicts, eventDays, eventPhase, sourceKind, sourceSummary, timeOf, timeRange } from "@/lib/calendar";
import { relative } from "@/lib/format";
import { cx, Skeleton } from "../ui";

/** Where calendars are connected and calendar links are added. */
export const CALENDAR_SETTINGS = "/settings?tab=connections#calendars";

/** One dot per calendar the event came from; the names are in the tooltip and for screen readers. */
export function SourceDots({ sources, className }: { sources: readonly Pick<CalendarEventSource, "connector" | "label">[] | undefined; className?: string }) {
  const list = sources ?? [];
  if (!list.length) return null;
  const summary = sourceSummary(list as CalendarEventSource[]);
  return (
    <span className={cx("cal-dots", className)} role="img" aria-label={`From ${summary}`} title={summary} data-sources={list.length}>
      {list.slice(0, 4).map((source, index) => (
        <span key={`${source.connector}-${index}`} className="cal-dot" data-source={sourceKind(source.connector)} />
      ))}
    </span>
  );
}

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });

export function AllDayStrip({ events, day }: { events: readonly CalendarEvent[]; day: string }) {
  if (!events.length) return null;
  return (
    <ul className="cal-allday" aria-label="All day">
      {events.map((event) => {
        const days = eventDays(event, "UTC");
        const last = days[days.length - 1]!;
        return (
          <li key={event.id} className="cal-allday-chip" title={`${event.title}${event.sources?.length ? ` · ${sourceSummary(event.sources)}` : ""}`} data-event={event.id}>
            <SourceDots sources={event.sources} />
            <span className="min-w-0 truncate">{event.title}</span>
            {days.length > 1 && last > day ? <span className="shrink-0 text-faint">until {weekday(last)}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** A place worth showing: not a meeting link, and not the "Microsoft Teams Meeting" Outlook writes beside one. */
function placeOf(event: CalendarEvent): string | null {
  const place = event.location?.trim();
  if (!place || /^https?:\/\//i.test(place)) return null;
  if (event.meetingUrl && /^(microsoft teams meeting|google meet|zoom( meeting)?|webex)$/i.test(place)) return null;
  return place;
}

function AgendaRow({ event, zone, conflict, compact, now }: { event: CalendarEvent; zone: string; conflict: boolean; compact: boolean; now: number }) {
  const phase = eventPhase(event, now);
  const join = event.meetingUrl ?? null;
  const when = compact ? timeOf(event.start, zone) : timeRange(event, zone);
  const place = compact ? null : placeOf(event);
  const label = `${event.title}, ${timeRange(event, zone)}${conflict ? ", overlaps another event" : ""}`;
  return (
    <li className={cx("cal-row", conflict && "cal-row-conflict", phase === "past" && "cal-row-past")} data-event={event.id} data-phase={phase} aria-label={label}>
      <span className="cal-time">
        {when}
        {phase === "now" ? <span className="cal-now">Now</span> : null}
      </span>
      <span className="cal-main">
        {event.url ? (
          <a href={event.url} target="_blank" rel="noreferrer" className="cal-title" title={event.title}>
            {event.title}
          </a>
        ) : (
          <span className="cal-title" title={event.title}>
            {event.title}
          </span>
        )}
        {place ? (
          <span className="cal-place" title={place}>
            <MapPin size={10} aria-hidden />
            <span className="truncate">{place}</span>
          </span>
        ) : null}
      </span>
      {conflict ? (
        <span className="cal-conflict" title="Overlaps another event">
          <AlertTriangle size={11} aria-hidden />
        </span>
      ) : null}
      <SourceDots sources={event.sources} />
      {join && phase !== "past" ? (
        <a href={join} target="_blank" rel="noreferrer" className="cal-join" aria-label={`Join ${event.title}`} title="Join the online meeting">
          <Video size={12} aria-hidden />
          {compact ? null : <span>Join</span>}
        </a>
      ) : null}
    </li>
  );
}

/** The events on `day` (YYYY-MM-DD in `zone`). Pass only that day's events. `foldPast` tucks finished events behind "N earlier". */
export function DayAgenda({
  events,
  day,
  zone,
  limit,
  compact = false,
  foldPast = false,
  now = Date.now(),
  empty = "Nothing scheduled",
}: {
  events: readonly CalendarEvent[];
  day: string;
  zone: string;
  limit?: number;
  compact?: boolean;
  foldPast?: boolean;
  now?: number;
  empty?: string | null;
}) {
  const [all, setAll] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const allDay = events.filter((event) => event.allDay);
  const timed = events.filter((event) => !event.allDay).sort((a, b) => a.start.localeCompare(b.start));
  const overlapping = conflicts(timed);
  const folded = foldPast && !earlier ? new Set(timed.filter((event) => eventPhase(event, now) === "past").map((event) => event.id)) : new Set<string>();
  const past = folded.size;
  const rest = timed.filter((event) => !folded.has(event.id));
  const shown = all || !limit ? rest : rest.slice(0, limit);
  if (!allDay.length && !timed.length) {
    if (empty === null) return null;
    return (
      <p className="cal-empty">
        <CalendarCheck2 size={13} aria-hidden /> {empty}
      </p>
    );
  }
  return (
    <div className="cal-agenda">
      <AllDayStrip events={allDay} day={day} />
      {past ? (
        <button type="button" className="cal-more" onClick={() => setEarlier(true)} aria-label={`Show ${past} earlier event${past === 1 ? "" : "s"}`}>
          {past} earlier
        </button>
      ) : null}
      {past && !rest.length ? (
        <p className="cal-empty">
          <CalendarCheck2 size={13} aria-hidden /> Nothing else today
        </p>
      ) : null}
      {shown.length ? (
        <ul className="cal-rows" aria-label="Events">
          {shown.map((event) => (
            <AgendaRow key={event.id} event={event} zone={zone} conflict={overlapping.has(event.id)} compact={compact} now={now} />
          ))}
        </ul>
      ) : null}
      {rest.length > shown.length ? (
        <button type="button" className="cal-more" onClick={() => setAll(true)}>
          {rest.length - shown.length} more
        </button>
      ) : null}
    </div>
  );
}

export function AgendaSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="cal-agenda" aria-busy="true" aria-label="Loading your calendar">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} index={index} className="h-7 w-full rounded-md" />
      ))}
    </div>
  );
}

/** Shown when no calendar feeds Today yet. */
export function ConnectCalendar({ compact = false }: { compact?: boolean }) {
  return (
    <div className="cal-connect">
      <p className="cal-connect-line">
        <CalendarPlus size={14} aria-hidden className="shrink-0 text-muted" /> Connect a calendar to see your day here.
      </p>
      {compact ? null : <p className="text-[11.5px] text-muted">Google, Outlook and calendar links (iCloud, Proton, holidays) show as one calendar, each event once.</p>}
      <div className="flex flex-wrap gap-1.5">
        <Link className="btn-primary" href="/settings?tab=connections&store=suites">
          Connect a calendar
        </Link>
        <Link className="btn-ghost" href={CALENDAR_SETTINGS}>
          <Link2 size={12} aria-hidden /> Add by link
        </Link>
      </div>
    </div>
  );
}

/** Which calendars feed Today and when each was last read: "Google · Outlook · Holidays, synced 4 min ago". */
export function CalendarStatus({ sources, className }: { sources: readonly CalendarSourceState[]; className?: string }) {
  if (!sources.length) return null;
  const failed = sources.find((source) => source.lastError);
  const synced = sources.map((source) => source.lastSyncAt).filter((at): at is string => Boolean(at)).sort().at(-1) ?? null;
  return (
    <p className={cx("cal-status", className)} aria-live="polite">
      <SourceDots sources={sources} />
      <span className="min-w-0 truncate">
        {sources.map((source) => source.label).join(" · ")}
        {failed ? null : <span className="text-faint">{synced ? `, synced ${relative(synced)}` : ", not synced yet"}</span>}
      </span>
      {failed ? (
        <Link href={CALENDAR_SETTINGS} className="cal-status-error" title={failed.lastError ?? undefined}>
          <AlertTriangle size={11} aria-hidden /> {failed.label} needs attention
        </Link>
      ) : null}
    </p>
  );
}
