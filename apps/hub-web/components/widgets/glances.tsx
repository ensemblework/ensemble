"use client";

import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, type TaskRecord } from "@/lib/api";
import type { Size } from "@ensemble/shared-types/widgets";

const GraphTab = dynamic(() => import("@/components/context/graph").then((mod) => mod.GraphTab), {
  ssr: false,
  loading: () => <div className="skeleton h-full min-h-[96px] w-full flex-1" />,
});

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

function limitFor(size: Size, small: number, medium: number): number {
  if (size === "s") return small;
  if (size === "m") return medium;
  return 12;
}

export function MorningBrief({ size }: { size: Size }) {
  const notes = useQuery({ queryKey: ["notifications"], queryFn: api.notifications, staleTime: 60_000 });
  const brief = notes.data?.notifications.find((row) => row.kind === "morning_brief");
  const text = brief?.body || "No brief yet today.";
  return (
    <p className={size === "s" ? "line-clamp-2 text-[13px] leading-5 text-muted" : "text-[13px] leading-5 text-muted"}>
      {text}
    </p>
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
      <span className="display text-[28px] leading-none">{shell.data ? count : "—"}</span>
      <span className="text-[12.5px] text-muted">waiting</span>
    </Link>
  );
}

export function PeopleGlance({ size }: { size: Size }) {
  const { ref, visible } = useWhenVisible();
  const people = useQuery({ queryKey: ["people"], queryFn: api.people, enabled: visible, staleTime: 30_000 });
  const rows = (people.data?.people ?? []).slice(0, limitFor(size, 3, 6));
  return (
    <div ref={ref}>
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
      ) : (
        <p className="text-[12.5px] text-muted">{people.data ? "No one here yet. Placeholders have no email — rename or delete them." : " "}</p>
      )}
      <Link href="/context?tab=people" className="mt-2 inline-block text-[12px] text-accent hover:underline">
        All people
      </Link>
    </div>
  );
}

export function ReposGlance({ size }: { size: Size }) {
  const { ref, visible } = useWhenVisible();
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repos, enabled: visible, staleTime: 30_000 });
  const rows = (repos.data?.repos ?? []).slice(0, limitFor(size, 1, 5));
  return (
    <div ref={ref}>
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
        <p className="text-[12.5px] text-muted">{repos.data ? "No repo yet. Connect one when you have it — this tile does not invent one." : " "}</p>
      )}
    </div>
  );
}

export function MeetingsGlance({ size }: { size: Size }) {
  const { ref, visible } = useWhenVisible();
  const cues = useQuery({ queryKey: ["meeting-cues"], queryFn: api.meetingCues, enabled: visible, staleTime: 30_000 });
  const rows = (cues.data?.cues ?? []).slice(0, limitFor(size, 1, 3));
  return (
    <div ref={ref}>
      {rows.length ? (
        <ul className="space-y-1">
          {rows.map((cue) => (
            <li key={cue.artifactId ?? cue.start} className="truncate text-[13.5px]">
              {cue.title}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-muted">{cues.data ? "Nothing on the calendar." : " "}</p>
      )}
      <Link href="/meetings" className="mt-2 inline-block text-[12px] text-accent hover:underline">
        Open meetings
      </Link>
    </div>
  );
}

export function ArtifactsGlance({ size }: { size: Size }) {
  const { ref, visible } = useWhenVisible();
  const artifacts = useQuery({ queryKey: ["artifacts", "widget"], queryFn: () => api.artifacts({}), enabled: visible, staleTime: 30_000 });
  const rows = (artifacts.data?.artifacts ?? []).slice(0, limitFor(size, 1, 8));
  return (
    <div ref={ref}>
      {rows.length ? (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li key={row.id} className="truncate text-[13.5px]">
              <Link href="/context?tab=artifacts" className="hover:text-accent">
                {row.title || row.kind}
              </Link>
              {size !== "s" ? <span className="ml-2 text-[12px] text-muted">{row.kind}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-muted">{artifacts.data ? "No artifacts yet." : " "}</p>
      )}
    </div>
  );
}

export function GraphGlance({ size }: { size: Size }) {
  return (
    <div className="flex h-full min-h-[96px] flex-col" data-graph-size={size}>
      <GraphTab compact />
    </div>
  );
}

export function RecentLinks({ size }: { size: Size }) {
  const { ref, visible } = useWhenVisible();
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, enabled: visible, staleTime: 15_000 });
  const rows = [...(tasks.data?.tasks ?? [])]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, size === "s" ? 3 : 8);
  return (
    <div ref={ref}>
      <ul className="space-y-1">
        {rows.map((task) => (
          <li key={task.id} className="truncate text-[13.5px]">
            <Link href={`/tasks/${task.id}`} className="hover:text-accent">
              {task.title}
            </Link>
            {task.taskType ? <span className="ml-2 text-[11px] uppercase tracking-wide text-faint">{task.taskType}</span> : null}
          </li>
        ))}
      </ul>
      {!rows.length && tasks.data ? <p className="text-[12.5px] text-muted">Nothing recent.</p> : null}
    </div>
  );
}

export function taskChip(task: TaskRecord) {
  if (!task.taskType) return null;
  return <span className="text-[11px] uppercase tracking-wide text-faint">{task.taskType}</span>;
}
