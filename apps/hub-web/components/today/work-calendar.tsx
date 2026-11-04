"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type CalendarEvent, type CalendarPayload } from "@/lib/api";
import { conflicts, dateKey, daysFrom, dayLabel, displayZone, eventsOn, shortDay } from "@/lib/calendar";
import { isoDate, shortDate } from "@/lib/format";
import { useTodayData, workWeek } from "@/lib/home";
import { AgendaSkeleton, CalendarStatus, ConnectCalendar, DayAgenda } from "../calendar/agenda";
import { useCalendarSync } from "../calendar/sync";
import { FetchGlyph } from "@/components/motion/slot";
import { cx } from "../ui";
import type { Size } from "@ensemble/shared-types/widgets";

const LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

function DayButton({ day, events, selected, today, compact, onSelect }: { day: string; events: readonly CalendarEvent[]; selected: boolean; today: boolean; compact: boolean; onSelect: () => void }) {
  const date = new Date(`${day}T12:00:00Z`);
  const clash = conflicts(events).size > 0;
  const allDay = events.filter((event) => event.allDay).length;
  const marks = Math.min(3, events.length);
  const label = `${date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}: ${events.length ? `${events.length} event${events.length === 1 ? "" : "s"}` : "nothing scheduled"}${clash ? ", with overlaps" : ""}`;
  return (
    <button type="button" className={cx("cal-day", today && "cal-day-today")} aria-pressed={selected} aria-label={label} title={label} onClick={onSelect} data-day={day}>
      <span className="cal-day-date">
        <span className="cal-day-name">{compact ? LETTERS[date.getUTCDay()] : date.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}</span>
        <span className="cal-day-num">{date.getUTCDate()}</span>
      </span>
      <span className="cal-day-marks" aria-hidden>
        {Array.from({ length: marks }, (_, index) => (
          <span key={index} className={cx("cal-day-mark", clash && index === marks - 1 ? "cal-day-mark-conflict" : index < allDay && "cal-day-mark-allday")} />
        ))}
      </span>
    </button>
  );
}

/** The Today calendar widget: a work week of the merged calendar (Google, Outlook, calendar links) and the chosen day's agenda. */
export function WorkCalendar({ timezone, size = "m" }: { timezone: string; size?: Size }) {
  const client = useQueryClient();
  const [offset, setOffset] = useState(0);
  const week = useMemo(() => workWeek(offset), [offset]);
  const first = isoDate(week.start);
  const days = useMemo(() => daysFrom(first, 5), [first]);

  const { ready } = useTodayData();
  const calendar = useQuery<CalendarPayload>({
    queryKey: ["calendar", first],
    queryFn: () => api.calendar(week.start.toISOString(), week.end.toISOString(), displayZone(timezone)),
    enabled: offset !== 0 || ready || client.getQueryData(["calendar", first]) !== undefined,
  });
  const sync = useCalendarSync();

  const zone = displayZone(calendar.data?.timeZone ?? timezone);
  const today = dateKey(new Date(), zone);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [first]);
  const selected = picked && days.includes(picked) ? picked : days.includes(today) ? today : days[0]!;

  const events = calendar.data?.events ?? [];
  const byDay = useMemo(() => new Map(days.map((day) => [day, eventsOn(events, day, zone)])), [days, events, zone]);
  const sources = calendar.data?.sources ?? [];
  const nothingConnected = calendar.isSuccess && !sources.length && !events.length;

  const compact = size === "s";
  const limit = compact ? 2 : size === "m" ? 5 : 10;

  const heading = dayLabel(selected, today);
  const range = `${shortDate(week.start)} – ${shortDate(new Date(week.end.getTime() - 86_400_000))}`;
  return (
    <section className="cal-widget min-w-0" aria-label="Calendar" data-calendar-widget data-size={size}>
      <div className="cal-head">
        <button type="button" className="icon-btn h-7 w-6 shrink-0" onClick={() => setOffset(offset - 1)} aria-label="Previous week" title="Previous week">
          <ChevronLeft size={14} aria-hidden />
        </button>
        <div className="cal-week" role="group" aria-label={`Week of ${range}`}>
          {days.map((day) => (
            <DayButton key={day} day={day} events={byDay.get(day) ?? []} selected={day === selected} today={day === today} compact={compact} onSelect={() => setPicked(day)} />
          ))}
        </div>
        <button type="button" className="icon-btn h-7 w-6 shrink-0" onClick={() => setOffset(offset + 1)} aria-label="Next week" title="Next week">
          <ChevronRight size={14} aria-hidden />
        </button>
      </div>
      <div className="cal-subhead">
        <p className="cal-day-heading">
          {heading}
          {heading !== shortDay(selected) && !compact ? <span className="cal-day-heading-date"> · {shortDay(selected)}</span> : null}
        </p>
        {offset !== 0 ? (
          <button type="button" className="cal-more" onClick={() => setOffset(0)}>
            This week
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn ml-auto h-6 w-6 shrink-0"
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          aria-label="Sync calendars"
          title="Sync Google, Outlook and calendar links"
        >
          <FetchGlyph active={sync.isPending} slot="connector.sync" size={12} />
        </button>
      </div>
      <div className="cal-day-body">
        {calendar.isPending ? (
          <AgendaSkeleton rows={compact ? 2 : 3} />
        ) : calendar.isError ? (
          <p className="cal-empty">
            Your calendar could not load.{" "}
            <button type="button" className="cal-more" onClick={() => void calendar.refetch()}>
              Try again
            </button>
          </p>
        ) : nothingConnected ? (
          <ConnectCalendar compact={compact || size === "m"} />
        ) : (
          <DayAgenda key={selected} events={byDay.get(selected) ?? []} day={selected} zone={zone} limit={limit} compact={compact} foldPast={selected === today} />
        )}
      </div>
      {!compact ? <CalendarStatus sources={sources} /> : null}
    </section>
  );
}
