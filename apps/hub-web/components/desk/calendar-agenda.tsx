"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type DeskLive } from "@/lib/api";

type Event = { id: string; title: string; start: string };

function AgendaList({ events }: { events: Event[] }) {
  return <div className="visual-timeline" data-visual="calendar-agenda">{[...events].sort((a, b) => a.start.localeCompare(b.start)).slice(0, 5).map((event) => <div key={event.id}>
    <span className="visual-date" style={{ width: 78, color: "var(--chart-blue)" }}>{new Date(event.start).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}<small style={{ display: "block", marginTop: 3 }}>{new Date(event.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</small></span>
    <span className="visual-timeline-dot" style={{ background: "var(--chart-blue)" }} /><strong>{event.title}</strong>
  </div>)}</div>;
}

function ConnectedAgenda() {
  const feed = useQuery({ queryKey: ["widget-feed"], queryFn: api.widgetFeed, staleTime: 20_000 });
  const events = (feed.data?.events ?? []).filter((e) => Date.parse(e.start) >= new Date().setHours(0, 0, 0, 0));
  if (feed.isPending) return <p className="visual-empty">Loading your calendar…</p>;
  if (feed.isError) return <div className="visual-empty">Your calendar could not load.<button className="btn" type="button" onClick={() => void feed.refetch()}>Try again</button></div>;
  return <>{events.length ? <AgendaList events={events} /> : <p className="visual-empty">No upcoming events in your synced calendar.</p>}<a className="qadd" href="/settings?tab=connections">Manage calendar connections →</a></>;
}

export function CalendarAgenda({ live, preview }: { live: DeskLive; preview: boolean }) {
  if (!preview) return <ConnectedAgenda />;
  return <AgendaList events={live.meetings.map((m, i) => ({ ...m, start: `${live.today}T${String(9 + i * 2).padStart(2, "0")}:00:00` }))} />;
}
