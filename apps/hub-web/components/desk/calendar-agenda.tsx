"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, type CalendarEvent, type DeskLive } from "@/lib/api";
import { dateKey, daysFrom, dayLabel, displayZone, eventsOn } from "@/lib/calendar";
import { AgendaSkeleton, CALENDAR_SETTINGS, CalendarStatus, ConnectCalendar, DayAgenda } from "../calendar/agenda";

const DAYS = 7;
const MAX_DAYS_SHOWN = 3;

function Days({ events, zone, today }: { events: readonly CalendarEvent[]; zone: string; today: string }) {
  const days = daysFrom(today, DAYS)
    .map((day) => ({ day, events: eventsOn(events, day, zone).filter((event) => event.allDay || day !== today || Date.parse(event.end ?? event.start) > Date.now()) }))
    .filter((row) => row.events.length)
    .slice(0, MAX_DAYS_SHOWN);
  if (!days.length) return <p className="visual-empty">Nothing on your calendar this week.</p>;
  return (
    <div className="cal-days" data-visual="calendar-agenda">
      {days.map((row) => (
        <section key={row.day} className="cal-day-group" aria-label={dayLabel(row.day, today)}>
          <h4 className="cal-day-heading">{dayLabel(row.day, today)}</h4>
          <DayAgenda events={row.events} day={row.day} zone={zone} limit={4} />
        </section>
      ))}
    </div>
  );
}

/** The merged calendar (Google, Outlook, calendar links) for the next seven days, each event once. */
function ConnectedAgenda() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + DAYS * 86_400_000);
  const calendar = useQuery({
    queryKey: ["calendar-agenda", start.toISOString()],
    queryFn: () => api.calendar(start.toISOString(), end.toISOString()),
    staleTime: 60_000,
  });
  const zone = displayZone(calendar.data?.timeZone);
  const today = useMemo(() => dateKey(new Date(), zone), [zone]);
  if (calendar.isPending) return <AgendaSkeleton rows={4} />;
  if (calendar.isError) {
    return (
      <div className="visual-empty">
        Your calendar could not load.
        <button className="btn" type="button" onClick={() => void calendar.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  const sources = calendar.data.sources ?? [];
  if (!sources.length && !calendar.data.events.length) return <ConnectCalendar compact />;
  return (
    <>
      <Days events={calendar.data.events} zone={zone} today={today} />
      <div className="cal-tile-foot">
        <CalendarStatus sources={sources} />
        <a className="qadd" href={CALENDAR_SETTINGS}>
          Manage calendars →
        </a>
      </div>
    </>
  );
}

function sampleEvents(live: DeskLive): CalendarEvent[] {
  return live.meetings.map((meeting, index) => {
    const start = new Date(`${live.today}T${String(9 + index * 2).padStart(2, "0")}:00:00`);
    return {
      id: meeting.id,
      title: meeting.title,
      start: start.toISOString(),
      end: new Date(start.getTime() + 30 * 60_000).toISOString(),
      allDay: false,
      joinUrl: null,
      location: null,
      sources: index % 2 ? [{ connector: "outlook_calendar", label: "Outlook", calendar: null, url: null }] : [{ connector: "google_calendar", label: "Google", calendar: null, url: null }, { connector: "outlook_calendar", label: "Outlook", calendar: null, url: null }],
    };
  });
}

export function CalendarAgenda({ live, preview }: { live: DeskLive; preview: boolean }) {
  if (!preview) return <ConnectedAgenda />;
  const zone = displayZone(null);
  return <DayAgenda events={sampleEvents(live)} day={live.today} zone={zone} limit={4} now={0} />;
}
