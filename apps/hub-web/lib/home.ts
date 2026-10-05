"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, type CalendarEvent, type DeliverableRecord, type ReminderRecord, type TaskRecord } from "./api";
import { isoDate, startOfDay } from "./format";

export type HomePayload = {
  tasks: TaskRecord[];
  deliverables: DeliverableRecord[];
  reminders: ReminderRecord[];
  events: CalendarEvent[];
  sync: Array<{ connector: string; lastSyncAt: string | null; lastError: string | null }>;
  timezone: string;
};

/** Monday of the work week, or next Monday on a weekend. Matches the Today calendar. */
export function workWeek(offsetWeeks = 0, anchor = new Date()): { start: Date; end: Date } {
  const copy = startOfDay(anchor);
  const day = copy.getDay();
  if (day === 6 || day === 0) copy.setDate(copy.getDate() + (day === 6 ? 2 : 1));
  else copy.setDate(copy.getDate() - (day - 1));
  copy.setDate(copy.getDate() + offsetWeeks * 7);
  const end = new Date(copy);
  end.setDate(copy.getDate() + 5);
  return { start: copy, end };
}

let flight: Promise<HomePayload> | null = null;
let flightKey = "";

/** One network call shared by every Today query that mounts in the same turn. */
export function loadToday(from: string, to: string): Promise<HomePayload> {
  const key = `${from}|${to}`;
  if (flight && flightKey === key) return flight;
  flightKey = key;
  const pending = api.todayHome(from, to).then(
    (data) => data,
    (error: unknown) => {
      if (flight === pending) {
        flight = null;
        flightKey = "";
      }
      throw error;
    },
  );
  flight = pending;
  return pending;
}

/** Fill the slice caches from one home payload. Never overwrites a slice that already has data. */
export function seedToday(client: QueryClient, data: HomePayload, day: string): void {
  const put = (key: unknown[], value: unknown) => {
    if (client.getQueryData(key) === undefined) client.setQueryData(key, value);
  };
  put(["tasks"], { tasks: data.tasks });
  put(["deliverables", false], { deliverables: data.deliverables });
  put(["reminders"], { reminders: data.reminders });
  put(["calendar", day], { events: data.events, sync: data.sync });
}

/**
 * One boot request for Today. Later invalidations refetch the slice
 * (`/api/tasks`, `/api/deliverables`, …), not this bundle.
 */
export function useTodayData() {
  const client = useQueryClient();
  const week = workWeek(0);
  const from = week.start.toISOString();
  const to = week.end.toISOString();
  const day = isoDate(week.start);
  const home = useQuery({
    queryKey: ["home", from],
    queryFn: async () => {
      const data = await loadToday(from, to);
      seedToday(client, data, day);
      return data;
    },
    staleTime: Infinity,
  });
  return { home, from, to, day, ready: home.isSuccess, timezone: home.data?.timezone ?? "local time" };
}
