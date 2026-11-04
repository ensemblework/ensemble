"use client";

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useToast } from "../toast";

/** Every query that shows the merged calendar or its links. */
export function invalidateCalendar(client: QueryClient): void {
  for (const key of ["calendar", "calendar-day", "calendar-agenda", "calendar-feeds", "widget-feed"]) void client.invalidateQueries({ queryKey: [key] });
}

/** One sync for every calendar on Today (Google, Outlook, calendar links), then the views re-read the merged list. */
export function useCalendarSync() {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.syncCalendars(),
    onSuccess: (result) => {
      const failed = result.outcomes.find((row) => !row.ok);
      if (result.message) toast(result.message, { tone: "error" });
      else if (failed) toast(`${failed.label}: ${failed.message}`, { tone: "error" });
      else toast(result.merged ? `Calendars synced. ${result.merged} duplicate${result.merged === 1 ? "" : "s"} shown once.` : "Calendars synced.", { tone: "ok" });
      invalidateCalendar(client);
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
}
