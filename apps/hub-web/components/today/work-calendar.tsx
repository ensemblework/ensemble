"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, type CalendarEvent } from "@/lib/api";
import { clock, isoDate, relative, shortDate } from "@/lib/format";
import { useTodayData, workWeek } from "@/lib/home";
import { useToast } from "../toast";
import { FetchGlyph } from "@/components/motion/slot";
import { cx } from "../ui";
import type { Size } from "@ensemble/shared-types/widgets";

const LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

export function WorkCalendar({ timezone, size = "l" }: { timezone: string; size?: Size }) {
  const client = useQueryClient();
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const start = useMemo(() => workWeek(offset).start, [offset]);
  const days = useMemo(
    () =>
      Array.from({ length: 5 }, (_, index) => {
        const day = new Date(start);
        day.setDate(start.getDate() + index);
        return day;
      }),
    [start],
  );
  const end = new Date(start);
  end.setDate(start.getDate() + 5);

  const { ready } = useTodayData();
  const dayKey = isoDate(start);
  const calendar = useQuery({
    queryKey: ["calendar", dayKey],
    queryFn: () => api.calendar(start.toISOString(), end.toISOString()),
    enabled: offset !== 0 || ready || client.getQueryData(["calendar", dayKey]) !== undefined,
  });

  const sync = useMutation({
    mutationFn: async () => {
      const connections = await api.connections();
      const calendars = connections.connections.filter((row) => row.group === "calendar" && row.enabled);
      if (!calendars.length) throw new Error("No calendar is switched on. Turn one on in Settings → Connections.");
      return Promise.all(calendars.map((row) => api.syncConnection(row.id)));
    },
    onSuccess: (results) => {
      const failed = results.find((row) => !row.ok);
      toast(failed ? failed.message : "Calendar synced.", { tone: failed ? "error" : "ok" });
      void client.invalidateQueries({ queryKey: ["calendar"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  const eventsFor = (day: Date): CalendarEvent[] =>
    (calendar.data?.events ?? []).filter((event) => isoDate(new Date(event.start)) === isoDate(day));

  const syncState = calendar.data?.sync ?? [];
  const status = syncState.find((row) => row.lastError)?.lastError
    ? `Calendar needs attention: ${syncState.find((row) => row.lastError)!.lastError}`
    : syncState.length
      ? `Synced ${relative(syncState[0]!.lastSyncAt)}`
      : "No calendar connected yet";
  const today = isoDate(new Date());
  const anyEvents = days.some((day) => eventsFor(day).length > 0);

  const compact = size === "s";
  const roomy = size === "l" || size === "xl";

  return (
    <section className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1">
        <button type="button" className="icon-btn h-6 w-6 shrink-0" onClick={() => setOffset(offset - 1)} aria-label="Previous week">
          <ArrowLeft size={13} />
        </button>
        <button type="button" className="icon-btn h-6 w-6 shrink-0" onClick={() => setOffset(offset + 1)} aria-label="Next week">
          <ArrowRight size={13} />
        </button>
        {offset !== 0 ? (
          <button type="button" className="btn-ghost shrink-0 px-1.5 py-0.5" onClick={() => setOffset(0)}>
            Today
          </button>
        ) : null}
        {!compact ? (
          <span className="min-w-0 truncate text-[12px] text-muted">
            {shortDate(days[0]!)} – {shortDate(days[4]!)}
          </span>
        ) : null}
        <button
          type="button"
          className="icon-btn ml-auto h-6 w-6 shrink-0"
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          aria-label="Sync calendar"
          title="Sync calendar"
        >
          <FetchGlyph active={sync.isPending} slot="connector.sync" size={12} />
        </button>
        {roomy ? (
          <Link href="/board" className="shrink-0 text-[12px] text-muted hover:text-ink">
            Board
          </Link>
        ) : null}
      </div>
      <div className="grid min-w-0 grid-cols-5">
        {days.map((day) => {
          const events = eventsFor(day);
          const isToday = isoDate(day) === today;
          const shown = events.slice(0, compact ? 1 : roomy ? 4 : 2);
          return (
            <div key={day.toISOString()} className="min-w-0 px-0.5 text-center">
              <div className={cx("text-[11px] uppercase tracking-wide", isToday ? "text-ink" : "text-muted")}>
                {compact ? LETTERS[day.getDay()] : day.toLocaleDateString(undefined, { weekday: "short" })}
              </div>
              <div
                className={cx(
                  "mx-auto mt-0.5 flex h-5 w-5 items-center justify-center rounded-full text-[11.5px]",
                  isToday ? "on-accent font-semibold" : "text-muted",
                )}
              >
                {day.getDate()}
              </div>
              {shown.map((event) => (
                <div key={event.id} className="mt-1 truncate text-left text-[11px] leading-4 text-ink" title={event.title}>
                  {compact ? null : <span className="text-muted">{event.allDay ? "All day" : clock(event.start)} </span>}
                  {event.title}
                </div>
              ))}
              {events.length > shown.length ? <div className="text-[10px] text-faint">+{events.length - shown.length}</div> : null}
            </div>
          );
        })}
      </div>
      {roomy && anyEvents ? (
        <ul className="mt-2 space-y-1">
          {days.flatMap((day) =>
            eventsFor(day).slice(0, 3).map((event) => (
              <li key={event.id} className="truncate text-[12.5px]">
                <span className="text-muted">{event.allDay ? "All day" : clock(event.start)} · </span>
                {event.title}
              </li>
            )),
          )}
        </ul>
      ) : null}
      {!compact ? <div className="mt-1 truncate text-[11.5px] text-muted">{status}</div> : null}
      <span className="sr-only">{timezone}</span>
    </section>
  );
}
