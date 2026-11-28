"use client";

import { Skeleton } from "@/components/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { GitBranch, Sunrise, Users, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type TaskRecord } from "@/lib/api";
import type { Size } from "@ensemble/shared-types/widgets";

function useWhenVisible() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setVisible(true);
      },
      { rootMargin: "160px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);
  return { ref, visible };
}

/** The widgets' empty state, as on the desk tiles: centred, an icon in a soft circle, one line, at most one link. */
function GlanceEmpty({ icon: Icon, line, href, action }: { icon: LucideIcon; line: string; href?: string; action?: string }) {
  return (
    <div className="flex h-full min-h-[4.5rem] flex-1 flex-col items-center justify-center gap-1.5 px-2 text-center" data-widget-empty>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line bg-hover text-muted" aria-hidden="true"><Icon size={14} /></span>
      <p className="text-[13px] leading-snug text-muted">{line}</p>
      {href && action ? <Link href={href} className="rounded px-1 text-[12.5px] font-medium text-ink-2 hover:text-ink hover:underline">{action}</Link> : null}
    </div>
  );
}

function limitFor(size: Size, small: number, medium: number): number {
  if (size === "s") return small;
  if (size === "m") return medium;
  return 12;
}

export function MorningBrief({ size }: { size: Size }) {
  const brief = useQuery({ queryKey: ["morning-brief"], queryFn: api.morningBrief, staleTime: 30_000 });
  if (brief.isPending) return <Skeleton className="h-16 w-full" />;
  if (brief.error) return <div role="alert" className="text-[13px] text-danger">{brief.error.message} <button type="button" className="text-accent underline" onClick={() => void brief.refetch()}>Retry</button></div>;
  const routine = brief.data.routine;
  const href = routine ? `/routines?routine=${routine.id}` : "/routines";
  if (!brief.data.enabled || !routine || routine.status === "paused" || !brief.data.brief) {
    const line = !brief.data.enabled ? "Routines are off." : !routine ? "Morning brief was deleted." : routine.status === "paused" ? "Morning brief is paused." : routine.lastStatus === "failed" ? "Your last brief did not finish." : "Your first brief has not run yet.";
    return <GlanceEmpty icon={Sunrise} line={line} href={href} action={routine ? "Open routine" : "Open routines"} />;
  }
  return (
    <div>
      <p className={size === "s" ? "line-clamp-2 text-[13px] leading-5 text-muted" : "text-[13px] leading-5 text-muted"}>{brief.data.brief}</p>
      <Link href={href} className="mt-2 inline-block text-[12.5px] text-accent hover:underline">Open routine</Link>
    </div>
  );
}

export function WeekRecapLink() {
  return (
    <Link href="/recap" className="text-[14px] font-medium text-accent hover:underline">
      Open the week recap
    </Link>
  );
}

export function NeedsMeCount() {
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const count = (shell.data?.approvals ?? 0) + (shell.data?.decisions ?? 0);
  return (
    <Link href="/needs-me" className="flex items-baseline gap-2">
      <span className="display text-[28px] leading-none">{shell.data ? count : "-"}</span>
      <span className="text-[12.5px] text-muted">waiting</span>
    </Link>
  );
}

export function PeopleGlance({ size }: { size: Size }) {
  const { ref, visible } = useWhenVisible();
  const people = useQuery({ queryKey: ["people"], queryFn: api.people, enabled: visible, staleTime: 30_000 });
  const rows = (people.data?.people ?? []).slice(0, limitFor(size, 3, 6));
  return (
    <div ref={ref} className="flex h-full min-h-0 flex-col">
      {rows.length ? (
        <ul className="space-y-1">
          {rows.map((person) => (
            <li key={person.id}>
              <Link href={`/context?tab=people&who=${encodeURIComponent(person.name)}`} className="flex items-center gap-2 py-0.5 text-[13.5px] hover:text-accent">
                <span className="avatar avatar-sm" data-kind="people">
                  {person.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 truncate">
                  {person.name}
                  {size !== "s" && person.role ? <span className="ml-2 text-[12px] text-muted">{person.role}</span> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : people.data ? (
        <GlanceEmpty icon={Users} line="No one here yet." href="/context?tab=people" action="Add a person" />
      ) : null}
      {rows.length ? (
        <Link href="/context?tab=people" className="mt-2 inline-block text-[12px] text-accent hover:underline">
          All people
        </Link>
      ) : null}
    </div>
  );
}

export function ReposGlance({ size }: { size: Size }) {
  const { ref, visible } = useWhenVisible();
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repos, enabled: visible, staleTime: 30_000 });
  const rows = (repos.data?.repos ?? []).slice(0, limitFor(size, 1, 5));
  return (
    <div ref={ref} className="flex h-full min-h-0 flex-col">
      {rows.length ? (
        <ul className="space-y-1">
          {rows.map((repo) => (
            <li key={repo.id} className="truncate text-[13.5px]">
              <Link href="/context?tab=repos" className="hover:text-accent">
                {repo.fullName}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        repos.data ? <GlanceEmpty icon={GitBranch} line="No repos yet." href="/context?tab=repos" action="Open repos" /> : null
      )}
    </div>
  );
}

export function taskChip(task: TaskRecord) {
  if (!task.taskType) return null;
  return <span className="text-[11px] uppercase tracking-wide text-faint">{task.taskType}</span>;
}
