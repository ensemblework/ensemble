"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, FileText, NotebookPen } from "lucide-react";
import { useMemo, useState } from "react";
import type { CalendarEvent } from "@/lib/api";
import { MEETING_QUERY, meetingsApi, PROVIDER_LABEL, PROVIDER_LOGO, providerForUrl } from "@/lib/api-meetings";
import { BrandLogo } from "../connectors/brand-logo";
import { Spinner } from "../ui";
import { meetingWhen } from "./meeting-time";

const HOUR = 3_600_000;
const SHOWN = 4;

type Linked = { sessionId: string | null; noteId: string | null };

function phase(event: CalendarEvent, now: number): "live" | "upcoming" | "past" {
  const start = new Date(event.start).getTime();
  const end = event.end ? new Date(event.end).getTime() : start + HOUR / 2;
  if (now >= start && now < end) return "live";
  return start > now ? "upcoming" : "past";
}

function soon(event: CalendarEvent, now: number): string {
  const minutes = Math.round((new Date(event.start).getTime() - now) / 60_000);
  if (minutes <= 0) return "Now";
  if (minutes < 60) return `In ${minutes} min`;
  return meetingWhen(event.start);
}

/** Calendar events from the last week to two days ahead; one cached read shared by the page and the strip. */
export function useMeetingCalendar() {
  const range = useMemo(() => {
    const now = Date.now();
    return { from: new Date(now - 7 * 24 * HOUR).toISOString(), to: new Date(now + 48 * HOUR).toISOString() };
  }, []);
  return useQuery({ queryKey: [...MEETING_QUERY.calendar, range.from.slice(0, 13)], queryFn: () => meetingsApi.calendar(range.from, range.to), staleTime: 60_000 });
}

/**
 * Meetings from the calendar, around now: the next two days and the last week, each with
 * "Take notes" (notes linked to the event and its attendees) and, for a past Teams, Meet or Zoom
 * meeting, "Get transcript".
 */
export function CalendarMeetings({
  linked,
  onTakeNotes,
  onOpenSession,
  onOpenNote,
  onTranscript,
  starting,
  fetching,
}: {
  linked: (eventId: string) => Linked;
  onTakeNotes: (event: CalendarEvent) => void;
  onOpenSession: (id: string) => void;
  onOpenNote: (id: string) => void;
  onTranscript: (event: CalendarEvent) => void;
  starting: string | null;
  fetching: string | null;
}) {
  const [all, setAll] = useState(false);
  const calendar = useMeetingCalendar();
  const now = Date.now();
  const events = useMemo(() => {
    const rows = (calendar.data?.events ?? []).filter((event) => !event.allDay);
    const ahead = rows.filter((event) => phase(event, now) !== "past").sort((a, b) => a.start.localeCompare(b.start));
    const behind = rows.filter((event) => phase(event, now) === "past").sort((a, b) => b.start.localeCompare(a.start));
    return [...ahead, ...behind];
  }, [calendar.data, now]);
  if (calendar.isPending || calendar.isError || !events.length) return null;
  const shown = all ? events : events.slice(0, SHOWN);
  return (
    <section className="calendar-meetings" aria-labelledby="calendar-meetings-title">
      <div className="calendar-meetings-head">
        <h2 id="calendar-meetings-title"><CalendarDays size={15} aria-hidden />From your calendar</h2>
        {events.length > SHOWN ? (
          <button type="button" className="btn-ghost text-[12.5px]" aria-expanded={all} onClick={() => setAll((value) => !value)}>{all ? "Show fewer" : `Show all ${events.length}`}</button>
        ) : null}
      </div>
      <ul className="calendar-meetings-grid">
        {shown.map((event) => {
          const when = phase(event, now);
          const provider = providerForUrl(event.joinUrl);
          const link = linked(event.id);
          return (
            <li key={event.id} className="calendar-meeting" data-phase={when}>
              <p className="calendar-meeting-when">
                {when === "live" ? <span className="calendar-live">Now</span> : null}
                <time dateTime={event.start}>{when === "upcoming" ? soon(event, now) : meetingWhen(event.start)}</time>
              </p>
              <p className="calendar-meeting-title" title={event.title}>{event.title || "Meeting"}</p>
              <p className="calendar-meeting-app">
                {provider ? <><BrandLogo id={PROVIDER_LOGO[provider]} size={14} decorative />{PROVIDER_LABEL[provider]}</> : <span className="truncate">{event.location || "Calendar event"}</span>}
              </p>
              <div className="calendar-meeting-actions">
                {link.sessionId ? (
                  <button type="button" className="btn" onClick={() => onOpenSession(link.sessionId!)}><NotebookPen size={13} aria-hidden />Open notes</button>
                ) : (
                  <button type="button" className={when === "live" ? "btn-primary" : "btn"} disabled={starting !== null} onClick={() => onTakeNotes(event)}>
                    {starting === event.id ? <Spinner size={12} /> : <NotebookPen size={13} aria-hidden />}Take notes
                  </button>
                )}
                {link.noteId ? (
                  <button type="button" className="btn" onClick={() => onOpenNote(link.noteId!)}><FileText size={13} aria-hidden />Transcript</button>
                ) : provider && when === "past" ? (
                  <button type="button" className="btn" disabled={fetching !== null} onClick={() => onTranscript(event)}>
                    {fetching === event.id ? <><Spinner size={12} />Fetching…</> : <><FileText size={13} aria-hidden />Get transcript</>}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
