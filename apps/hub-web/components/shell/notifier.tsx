"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { safeDate } from "@/lib/safe-date";
import { notify, setNotifyConfig } from "@/lib/notify";
import { accentWriteIsFresh, publishAppearance, readAppearance } from "@/lib/prefs";

/** Fires reminder notifications while a Ensemble tab is open (docs/02 §14). */
export function Notifier() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const reminders = useQuery({ queryKey: ["reminders"], queryFn: api.reminders, refetchInterval: 60_000 });
  const shown = useRef(new Set<string>());

  useEffect(() => {
    const value = settings.data?.settings;
    if (!value) return;
    setNotifyConfig({ enabled: value.desktopReminders, quiet: value.quietHours });
    if (accentWriteIsFresh()) return;
    const server = value.appearance;
    const local = readAppearance();
    const custom = server.accentCustom ?? null;
    const differs = (local.accent ?? "indigo") !== server.accent || (local.accentCustom ?? null) !== custom;
    if (!differs) return;
    // The settings save is debounced. A navigation before it lands must not paint the old accent back.
    const writtenAt = (local as { accentAt?: number }).accentAt ?? 0;
    if (writtenAt && Date.now() - writtenAt < 8000) return;
    publishAppearance({ ...local, accent: server.accent, accentCustom: custom });
  }, [settings.data]);

  useEffect(() => {
    const check = () => {
      const now = new Date();
      for (const reminder of reminders.data?.reminders ?? []) {
        const due = safeDate(`${reminder.dueDate}T${reminder.dueTime ?? "09:00"}:00`);
        if (!due) continue;
        const key = `${reminder.id}:${reminder.dueDate}:${reminder.dueTime ?? ""}`;
        if (due <= now && now.getTime() - due.getTime() < 6 * 3_600_000 && !shown.current.has(key)) {
          if (notify("Reminder", reminder.title, { tag: key, href: "/today" })) shown.current.add(key);
        }
      }
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => window.clearInterval(timer);
  }, [reminders.data]);

  return null;
}
