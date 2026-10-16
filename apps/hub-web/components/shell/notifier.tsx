"use client";

import { canonicalTimeZone } from "@/lib/time-zones";
import { MorningBriefPrompt } from "../morning-brief";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { safeDate } from "@/lib/safe-date";
import { notify, setNotifyConfig } from "@/lib/notify";
import { accentWriteIsFresh, publishAppearance, readAppearance } from "@/lib/prefs";

/** Fires reminder notifications while an Ensemble tab is open (docs/02 §14). */
export function Notifier() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  // Reminders are the space owner's own: none to fire in a space shared with you.
  const access = useSpaceAccess();
  const reminders = useQuery({ queryKey: ["reminders"], queryFn: api.reminders, refetchInterval: 60_000, enabled: access.ready && !access.guest });
  const shown = useRef(new Set<string>());

  const detectedZone = useRef<string | null>(null);
  useEffect(() => {
    const value = settings.data?.settings;
    if (!value || value.timezoneMode !== "auto") return;
    const zone = canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (zone === canonicalTimeZone(value.timezone) || detectedZone.current === zone) return;
    detectedZone.current = zone;
    void api.saveSettings({ timezone: zone, timezoneMode: "auto" }).then(() => settings.refetch()).catch(() => { detectedZone.current = null; });
  }, [settings.data]);

  useEffect(() => {
    const value = settings.data?.settings;
    if (!value) return;
    setNotifyConfig({ enabled: value.desktopReminders, quiet: value.quietHours });
    if (accentWriteIsFresh()) return;
    const server = value.appearance;
    const local = readAppearance();
    const custom = server.accentCustom ?? null;
    const differs = (local.accent ?? "indigo") !== server.accent || (local.accentCustom ?? null) !== custom || local.colorTheme !== server.colorTheme || local.sidebarAutoCollapse !== server.sidebarAutoCollapse || local.pagesPanelSide !== server.pagesPanelSide;
    if (!differs) return;
    // The save is debounced; navigation must not restore a stale accent or color theme.
    const writtenAt = (local as { accentAt?: number }).accentAt ?? 0;
    if (writtenAt && Date.now() - writtenAt < 8000) return;
    publishAppearance({ ...local, colorTheme: server.colorTheme, accent: server.accent, accentCustom: custom, sidebarAutoCollapse: server.sidebarAutoCollapse, pagesPanelSide: server.pagesPanelSide });
  }, [settings.data]);

  useEffect(() => {
    const check = async () => {
      const now = new Date();
      for (const reminder of reminders.data?.reminders ?? []) {
        const due = safeDate(`${reminder.dueDate}T${reminder.dueTime ?? "09:00"}:00`);
        if (!due) continue;
        const key = `${reminder.id}:${reminder.dueDate}:${reminder.dueTime ?? ""}`;
        if (due <= now && now.getTime() - due.getTime() < 6 * 3_600_000 && !shown.current.has(key)) {
          if (await notify("Reminder", reminder.title, { tag: key, href: "/today" })) shown.current.add(key);
        }
      }
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => window.clearInterval(timer);
  }, [reminders.data]);

  return <MorningBriefPrompt />;
}
