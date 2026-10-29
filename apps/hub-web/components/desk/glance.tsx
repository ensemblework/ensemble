"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Bot, CalendarClock, CalendarDays, CircleDot, Hand, TriangleAlert, type LucideIcon } from "lucide-react";
import { hasModule } from "@ensemble/shared-types/modules";
import { api, type DeskLive } from "@/lib/api";
import { isoDate } from "@/lib/format";
import { dayGlance } from "./tile-data";

/** "Good morning" until noon, "Good afternoon" until six, then "Good evening". */
export function greeting(now = new Date(), name?: string | null): string {
  const hour = now.getHours();
  const part = hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = name?.trim().split(/\s+/)[0] ?? "";
  return /^[\p{L}][\p{L}'’-]*$/u.test(first) ? `${part}, ${first}` : part;
}

export function longDate(now = new Date()): string {
  return now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

type Pill = { key: string; icon: LucideIcon; n: number; one: string; many: string; href: string; tone?: "danger" | "warn" | "live" };

function GlancePill({ pill, interactive }: { pill: Pill; interactive: boolean }) {
  const Icon = pill.icon;
  const body = <><Icon size={13} strokeWidth={2.1} aria-hidden="true" /><b>{pill.n}</b><span>{pill.n === 1 ? pill.one : pill.many}</span></>;
  const tone = pill.n > 0 ? pill.tone : undefined;
  return interactive ? (
    <Link href={pill.href} className="gpill" data-glance={pill.key} data-tone={tone} data-zero={pill.n === 0 ? "1" : undefined}>{body}</Link>
  ) : (
    <span className="gpill" data-glance={pill.key} data-tone={tone} data-zero={pill.n === 0 ? "1" : undefined}>{body}</span>
  );
}

/**
 * The day at a glance: open work, what is due, what is late, what waits on you, agents at work and
 * today's meetings. Every number comes from data Today already holds or a one-day calendar read.
 */
export function GlancePills({ live, sample = false }: { live: DeskLive; sample?: boolean }) {
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const agentsOn = hasModule(shell.data?.modules, "workspace");
  const agents = useQuery({ queryKey: ["agent-state"], queryFn: api.agentState, enabled: agentsOn && !sample, staleTime: 15_000 });
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  const day = isoDate(start);
  const calendar = useQuery({ queryKey: ["calendar-day", day], queryFn: () => api.calendar(start.toISOString(), end.toISOString()), enabled: !sample, staleTime: 60_000 });
  const counts = dayGlance(live);
  const needs = sample ? 1 : (shell.data?.approvals ?? 0) + (shell.data?.decisions ?? 0) + (shell.data?.nodeApprovals ?? 0);
  const meetings = (calendar.data?.events ?? []).filter((event) => !event.allDay).length;
  const pills: Pill[] = [
    { key: "open", icon: CircleDot, n: counts.open, one: "open", many: "open", href: "/board" },
    { key: "due", icon: CalendarClock, n: counts.dueToday, one: "due today", many: "due today", href: "/board" },
    { key: "overdue", icon: TriangleAlert, n: counts.overdue, one: "overdue", many: "overdue", href: "/board", tone: "danger" },
    ...(sample || shell.isSuccess ? [{ key: "needs", icon: Hand, n: needs, one: "needs you", many: "need you", href: "/needs-me", tone: "warn" as const }] : []),
    ...(agentsOn && agents.data ? [{ key: "agents", icon: Bot, n: agents.data.running.length, one: "agent working", many: "agents working", href: "/runs", tone: "live" as const }] : []),
    ...(calendar.data && (calendar.data.sync.length || meetings) ? [{ key: "meetings", icon: CalendarDays, n: meetings, one: "meeting today", many: "meetings today", href: "/meetings" }] : []),
  ];
  return (
    <nav className="glance" aria-label="Your day at a glance" data-today-glance>
      {pills.map((pill) => <GlancePill key={pill.key} pill={pill} interactive={!sample} />)}
    </nav>
  );
}
