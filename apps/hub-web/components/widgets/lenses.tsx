"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { WIDGET_REGISTRY, type TileConfig, type WidgetId } from "@ensemble/shared-types/widgets";
import { api } from "@/lib/api";
import { shortDate } from "@/lib/format";

type Feed = Awaited<ReturnType<typeof api.widgetFeed>>;
type Task = Feed["tasks"][number];

function useFeed() {
  return useQuery({ queryKey: ["widget-feed"], queryFn: api.widgetFeed, staleTime: 30_000 });
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - start.getTime()) / 86_400_000);
}

function dayLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)}d over`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${days}d`;
}

function within(iso: string | null, horizon: number): boolean {
  const days = daysUntil(iso);
  return days !== null && days <= horizon;
}

function Empty({ type, hint }: { type: WidgetId; hint?: string }) {
  const spec = WIDGET_REGISTRY[type];
  return (
    <div className="flex h-full min-h-[4.5rem] flex-col justify-end">
      <p className="text-[14px] text-ink">{spec.empty ?? "Nothing here yet."}</p>
      <p className="mt-1 text-[12.5px] leading-snug text-muted">{hint ?? spec.blurb}</p>
    </div>
  );
}

function Rows({ rows, cap }: { rows: Array<{ id: string; title: string; meta?: string; href?: string }>; cap: number }) {
  const shown = rows.slice(0, cap);
  const more = rows.length - shown.length;
  return (
    <ul className="lens-list space-y-0.5">
      {shown.map((row) => (
        <li key={row.id} className="lens-row flex items-baseline justify-between gap-3 py-0.5 text-[13px]">
          {row.href ? (
            <Link href={row.href} className="min-w-0 truncate hover:underline">
              {row.title}
            </Link>
          ) : (
            <span className="min-w-0 truncate">{row.title}</span>
          )}
          {row.meta ? <span className="shrink-0 text-[12px] text-muted">{row.meta}</span> : null}
        </li>
      ))}
      {more > 0 ? <li className="pt-1 text-[12px] text-muted">{more} more</li> : null}
    </ul>
  );
}

function openTasks(tasks: Task[], type: string, config?: TileConfig): Task[] {
  return tasks.filter((task) => {
    if (task.status === "done" || task.status === "dropped") return false;
    if (task.taskType !== type) return false;
    if (config?.projectId && task.projectId !== config.projectId) return false;
    return true;
  });
}

function BigDate({ label, title, type }: { label: string; title: string; type: WidgetId }) {
  return (
    <div className="flex h-full flex-col justify-end">
      <div className="display text-[40px] leading-none tracking-tight">{label}</div>
      <div className="mt-1 truncate text-[13px] text-muted">{title}</div>
      <span className="sr-only">{WIDGET_REGISTRY[type].label}</span>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "•";
}

function personName(people: Array<{ id: string; name: string }>, value: string): string | null {
  const hit = people.find((person) => person.id === value || person.name === value);
  if (hit) return hit.name;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)) return null;
  return value;
}

function Ring({ fraction, label }: { fraction: number; label: string }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, fraction));
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden className="shrink-0 text-accent">
      <circle cx="24" cy="24" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="4" />
      <circle
        cx="24"
        cy="24"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${c * clamped} ${c}`}
        transform="rotate(-90 24 24)"
      />
      <text x="24" y="28" textAnchor="middle" fontSize="11" fill="currentColor">
        {label}
      </text>
    </svg>
  );
}

function LogRow({ taskType, unit }: { taskType: string; unit: string }) {
  const client = useQueryClient();
  const [title, setTitle] = useState("");
  const [measure, setMeasure] = useState("");
  return (
    <form
      className="mt-2 flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        const value = Number(measure);
        if (!title.trim() || !Number.isInteger(value) || value < 0 || value > 100000) return;
        void api.createTask({ title: title.trim(), taskType, measure: value, status: "done" }).then(() => {
          setTitle("");
          setMeasure("");
          void client.invalidateQueries({ queryKey: ["widget-feed"] });
        });
      }}
    >
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Note" aria-label="Entry" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" />
      <input value={measure} onChange={(event) => setMeasure(event.target.value)} inputMode="numeric" placeholder={unit} aria-label={unit} className="w-14 bg-transparent text-right text-[12.5px] outline-none placeholder:text-faint" />
      <button type="submit" className="text-[12px] text-accent">
        Log
      </button>
    </form>
  );
}

export function LensTile({ type, config }: { type: WidgetId; config?: TileConfig }) {
  const feed = useFeed();
  const reviews = useQuery({
    queryKey: ["reviews", "needs"],
    queryFn: () => api.reviews("needs", false),
    enabled: type === "review-queue",
    staleTime: 30_000,
  });
  const plots = useQuery({
    queryKey: ["plots"],
    queryFn: api.plots,
    enabled: type === "saved-plots",
    staleTime: 30_000,
  });
  if (type === "saved-plots") {
    if (!plots.data) return <p className="text-[13px] text-muted">Looking…</p>;
    const rows = plots.data.plots.map((plot) => ({ id: plot.id, title: plot.title, meta: plot.datasetName ?? undefined, href: `/plots/${plot.id}` }));
    if (!rows.length) return <Empty type={type} />;
    return <Rows rows={rows} cap={6} />;
  }
  if (type === "review-queue") {
    const rows = (reviews.data?.reviews ?? []).slice(0, 8).map((row) => ({ id: row.id, title: row.repoPath.split("/").pop() || row.repoPath, href: "/code" }));
    if (!reviews.data) return <p className="text-[13px] text-muted">Looking…</p>;
    if (!rows.length) return <Empty type={type} />;
    return <Rows rows={rows} cap={8} />;
  }
  if (!feed.data) return <p className="text-[13px] text-muted">Looking…</p>;
  const data = feed.data;
  const horizon = config?.horizonDays ?? 14;
  const projectId = config?.projectId;

  if (type === "countdown") {
    const next = data.deliverables
      .filter((row) => row.due && (!projectId || row.projectId === projectId))
      .map((row) => ({ ...row, days: daysUntil(row.due) }))
      .filter((row) => row.days !== null)
      .sort((a, b) => a.days! - b.days!)[0];
    if (!next) {
      return (
        <div>
          <Empty type={type} />
          <Link href="/today" className="mt-2 inline-block text-[12.5px] text-muted underline-offset-2 hover:underline">
            Add a deliverable
          </Link>
        </div>
      );
    }
    return <BigDate type={type} label={dayLabel(next.days!)} title={next.title} />;
  }

  if (type === "reading-queue") {
    const fromArtifacts = config?.source === "artifacts";
    const rows = fromArtifacts
      ? data.artifacts.filter((row) => !projectId || row.projectId === projectId).map((row) => ({ id: row.id, title: row.title }))
      : openTasks(data.tasks, "reading", config).map((row) => ({ id: row.id, title: row.title, href: `/tasks/${row.id}` }));
    if (!rows.length) return <Empty type={type} />;
    return (
      <ul className="space-y-1">
        {rows.slice(0, 6).map((row) => (
          <li key={row.id} className="flex items-center gap-2 text-[13px]">
            <span className="text-[11px] uppercase tracking-wide text-faint">{row.title.toLowerCase().includes("paper") ? "Paper" : "Note"}</span>
            <span className="min-w-0 flex-1 truncate">{row.title}</span>
          </li>
        ))}
      </ul>
    );
  }

  if (type === "decisions" || type === "open-questions" || type === "change-requests" || type === "test-log" || type === "grading-queue") {
    const taskType = type === "decisions" ? "decision" : type === "open-questions" ? "question" : type === "change-requests" ? "change" : type === "test-log" ? "test" : "marking";
    const rows = openTasks(data.tasks, taskType, config);
    if (!rows.length) return <Empty type={type} />;
    if (type === "grading-queue") {
      const done = data.tasks.filter((task) => task.taskType === "marking" && task.status === "done").length;
      const total = done + rows.length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      return (
        <div>
          <div className="text-[13px] text-muted">{done} marked · {rows.length} left</div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        </div>
      );
    }
    if (type === "test-log") {
      return (
        <ul className="flex flex-wrap gap-1.5">
          {rows.slice(0, 8).map((row) => {
            const pass = (row.measure ?? 0) >= 50;
            return (
              <li key={row.id} className="rounded-full px-2 py-0.5 text-[12px]" style={{ background: pass ? "#8fbfa822" : "#ffb4ae22", color: pass ? "#8fbfa8" : "#ffb4ae" }}>
                {pass ? "Pass" : "Fail"} {row.title}
              </li>
            );
          })}
        </ul>
      );
    }
    if (type === "change-requests") {
      return (
        <ul className="flex flex-wrap gap-1.5">
          {rows.slice(0, 8).map((row) => (
            <li key={row.id} className="rounded-full bg-accent/15 px-2 py-0.5 text-[12px] text-accent">
              {row.status === "in_progress" ? "In progress" : "Open"} · {row.title}
            </li>
          ))}
        </ul>
      );
    }
    return (
      <Rows
        rows={rows.map((row) => ({ id: row.id, title: row.title, meta: row.due ? dayLabel(daysUntil(row.due) ?? 0) : undefined, href: `/tasks/${row.id}` }))}
        cap={8}
      />
    );
  }

  if (type === "person-load" || type === "group-load") {
    const open = data.tasks.filter((task) => task.status !== "done" && task.status !== "dropped" && (!projectId || task.projectId === projectId));
    const counts = new Map<string, number>();
    for (const task of open) {
      const names = task.people.length ? task.people : [];
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const named = [...counts.entries()]
      .map(([raw, count]) => ({ name: personName(data.people, raw), count }))
      .filter((row): row is { name: string; count: number } => Boolean(row.name))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
    if (!named.length) return <Empty type={type} hint={type === "group-load" ? "Add the group as people on the project." : undefined} />;
    const max = named[0]?.count ?? 1;
    return (
      <ul className="space-y-1.5">
        {named.map((row) => (
          <li key={row.name} className="flex items-center gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[9px] font-medium text-accent">{initials(row.name)}</span>
            <span className="w-16 shrink-0 truncate text-[12.5px]">{row.name}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
              <span className="block h-full bg-accent" style={{ width: `${Math.round((row.count / max) * 100)}%` }} />
            </span>
            <span className="w-4 text-right text-[11px] text-muted">{row.count}</span>
          </li>
        ))}
      </ul>
    );
  }

  if (type === "quiz-pile") {
    const page = data.pages.find((row) => !projectId || row.projectId === projectId) ?? data.pages[0];
    if (!page || page.lines.length === 0) return <Empty type={type} />;
    return (
      <div>
        <Rows rows={page.lines.slice(0, 10).map((line, index) => ({ id: `${page.taskId}-${index}`, title: line }))} cap={10} />
        <Link href={`/tasks/${page.taskId}`} className="mt-2 inline-block text-[12.5px] text-muted hover:underline">
          Ask on the page
        </Link>
      </div>
    );
  }

  if (type === "timetable") {
    const rows = data.events.map((row) => ({ id: row.id, title: row.title, meta: dayLabel(daysUntil(row.start) ?? 0) }));
    if (!rows.length) return <Empty type={type} />;
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
    return (
      <div>
        <div className="mb-2 flex justify-between text-[11px] uppercase tracking-wide text-faint">
          {days.map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <Rows rows={rows} cap={4} />
      </div>
    );
  }

  if (type === "assignment-countdown") {
    const next = data.deliverables
      .map((row) => ({ ...row, days: daysUntil(row.due) }))
      .filter((row) => row.days !== null && (!projectId || row.projectId === projectId))
      .sort((a, b) => a.days! - b.days!)[0];
    if (!next) return <Empty type={type} />;
    return <BigDate type={type} label={dayLabel(next.days!)} title={next.title} />;
  }

  if (type === "exam-countdown") {
    const exam = data.tasks
      .filter((task) => task.taskType === "exam" && task.due && task.status !== "dropped")
      .map((task) => ({ ...task, days: daysUntil(task.due) }))
      .sort((a, b) => (a.days ?? 999) - (b.days ?? 999))[0];
    if (!exam || exam.days === null) return <Empty type={type} hint="Put a date on the exam. This tile stays up until you do." />;
    const span = 120;
    return (
      <div className="flex items-center gap-3">
        <Ring fraction={Math.max(0, 1 - exam.days / span)} label={String(Math.max(0, exam.days))} />
        <div>
          <div className="display text-[28px] leading-none">{Math.max(0, exam.days)}</div>
          <div className="mt-1 text-[12.5px] text-muted">{exam.days === 1 ? "day" : "days"} · {exam.title}</div>
        </div>
      </div>
    );
  }

  if (type === "lesson-next") {
    const next = openTasks(data.tasks, "lesson", config)[0];
    if (!next) return <Empty type={type} />;
    return (
      <div>
        <Link href={`/tasks/${next.id}`} className="text-[15px] font-medium hover:underline">
          {next.title}
        </Link>
        <p className="mt-1 text-[12.5px] text-muted">Open the page when you are ready to teach it.</p>
      </div>
    );
  }

  if (type === "class-list") {
    const rows = data.people.map((person) => ({ id: person.id, title: person.name }));
    if (!rows.length) return <Empty type={type} />;
    return <Rows rows={rows} cap={12} />;
  }

  if (type === "matter-dates") {
    const rows = [
      ...data.deliverables.filter((row) => !projectId || row.projectId === projectId).map((row) => ({
        id: row.id,
        title: row.title,
        due: row.due,
        meta: row.due ? `${dayLabel(daysUntil(row.due) ?? 0)} · ${shortDate(row.due)}` : "No date",
      })),
      ...data.reminders.map((row) => ({
        id: row.id,
        title: row.title,
        due: row.dueDate,
        meta: `${dayLabel(daysUntil(row.dueDate) ?? 0)} · ${shortDate(row.dueDate)}`,
      })),
    ]
      .sort((a, b) => {
        if (!a.due && !b.due) return 0;
        if (!a.due) return 1;
        if (!b.due) return -1;
        return new Date(a.due).getTime() - new Date(b.due).getTime();
      })
      .slice(0, 8);
    if (!rows.length) return <Empty type={type} />;
    return <Rows rows={rows} cap={8} />;
  }

  if (type === "limitation") {
    const rows = data.tasks
      .filter((task) => task.taskType === "limitation" && task.status !== "dropped" && (!projectId || task.projectId === projectId))
      .filter((task) => (config?.horizonDays ? within(task.due, horizon) || !task.due : true))
      .map((task) => ({ id: task.id, title: task.title, meta: task.due ? dayLabel(daysUntil(task.due) ?? 0) : "No date", href: `/tasks/${task.id}` }));
    if (!rows.length) return <Empty type={type} hint="A missing limitation date stays on screen. We do not guess the rule." />;
    return (
      <ul className="space-y-1">
        {rows.slice(0, 4).map((row) => {
          const days = daysUntil(data.tasks.find((task) => task.id === row.id)?.due ?? null) ?? 99;
          const tone = days <= 3 ? "#ffb4ae" : days <= 10 ? "#e4c56e" : "#8fbfa8";
          return (
            <li key={row.id}>
              <Link href={row.href ?? "#"} className="flex items-center gap-2 text-[13px]">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone }} />
                <span className="min-w-0 flex-1 truncate">{row.title}</span>
                <span className="text-[12px] text-muted">{row.meta}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    );
  }

  if (type === "clause-pair") {
    const drafts = data.artifacts.slice(0, 2);
    if (drafts.length < 2) return <Empty type={type} />;
    return (
      <div className="space-y-1">
        {drafts.map((row) => (
          <div key={row.id} className="truncate text-[13px]">
            {row.title}
          </div>
        ))}
        <button type="button" className="mt-2 text-[12.5px] text-muted hover:text-ink" onClick={() => window.dispatchEvent(new CustomEvent("ensemble:ask"))}>
          Compare
        </button>
      </div>
    );
  }

  if (type === "time-week") {
    const start = Date.now() - 7 * 86_400_000;
    const minutes = data.tasks
      .filter((task) => task.taskType === "time" && task.measure && new Date(task.updatedAt).getTime() >= start)
      .reduce((sum, task) => sum + (task.measure ?? 0), 0);
    const days = [0, 1, 2, 3, 4, 5, 6].map((offset) => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (6 - offset));
      const end = start.getTime() + 86_400_000;
      return data.tasks
        .filter((task) => task.taskType === "time" && task.measure && new Date(task.updatedAt).getTime() >= start.getTime() && new Date(task.updatedAt).getTime() < end)
        .reduce((sum, task) => sum + (task.measure ?? 0), 0);
    });
    const peak = Math.max(1, ...days);
    return (
      <div>
        <div className="display text-[22px] leading-none">{minutes || 0}</div>
        <p className="text-[12px] text-muted">minutes this week</p>
        <div className="mt-2 flex h-8 items-end gap-1">
          {days.map((value, index) => (
            <span key={index} className="flex-1 rounded-sm bg-accent" style={{ height: `${Math.max(8, Math.round((value / peak) * 100))}%`, opacity: value ? 1 : 0.25 }} />
          ))}
        </div>
        <LogRow taskType="time" unit="min" />
      </div>
    );
  }

  if (type === "syllabus") {
    const subjects = (projectId ? data.projects.filter((row) => row.id === projectId) : data.projects).filter((row) => row.total > 0).slice(0, 4);
    if (!subjects.length) return <Empty type={type} />;
    return (
      <ul className="space-y-2">
        {subjects.map((row) => {
          const pct = Math.round((row.done / row.total) * 100);
          return (
            <li key={row.id}>
              <div className="flex items-center justify-between text-[12.5px]">
                <span className="truncate">{row.name}</span>
                <span className="text-muted">{row.done}/{row.total}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
                <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  if (type === "mock-log") {
    const rows = data.tasks
      .filter((task) => task.taskType === "mock")
      .slice(0, 8)
      .map((task) => ({ id: task.id, title: task.title, meta: task.measure === null ? undefined : String(task.measure), href: `/tasks/${task.id}` }));
    if (!rows.length) {
      return (
        <div>
          <Empty type={type} />
          <LogRow taskType="mock" unit="score" />
        </div>
      );
    }
    const scores = rows.map((row) => Number(row.meta)).filter((value) => Number.isFinite(value));
    const max = Math.max(100, ...scores, 1);
    const width = 120;
    const height = 28;
    const points = scores
      .map((score, index) => {
        const x = scores.length === 1 ? width / 2 : (index / (scores.length - 1)) * width;
        const y = height - (score / max) * height;
        return `${x},${y}`;
      })
      .join(" ");
    return (
      <div>
        {scores.length ? (
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="text-accent" aria-hidden>
            <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={points} />
          </svg>
        ) : null}
        <Rows rows={rows} cap={5} />
        <LogRow taskType="mock" unit="score" />
      </div>
    );
  }

  if (type === "revision-due") {
    const rows = openTasks(data.tasks, "revision", config)
      .filter((task) => within(task.due, horizon) || !task.due)
      .sort((a, b) => (daysUntil(a.due) ?? 9999) - (daysUntil(b.due) ?? 9999))
      .map((task) => ({
        id: task.id,
        title: task.title,
        meta: task.due ? `${dayLabel(daysUntil(task.due) ?? 0)} · ${shortDate(task.due)}` : undefined,
        href: `/tasks/${task.id}`,
      }));
    if (!rows.length) return <Empty type={type} />;
    return <Rows rows={rows} cap={8} />;
  }

  if (type === "daily-target") {
    const target = config?.target ?? 20;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const done = data.tasks.filter((task) => task.completedAt && new Date(task.completedAt).getTime() >= start.getTime()).length;
    const pct = Math.min(100, Math.round((done / target) * 100));
    return (
      <div>
        <div className="display text-[28px] leading-none">
          {done} <span className="text-[16px] text-muted">of {target}</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  if (type === "affairs") {
    const cutoff = Date.now() - 2 * 86_400_000;
    const rows = data.tasks
      .filter((task) => task.taskType === "affairs" && new Date(task.updatedAt).getTime() >= cutoff)
      .map((task) => ({ id: task.id, title: task.title, href: `/tasks/${task.id}` }));
    if (!rows.length) return <Empty type={type} hint="What you saved. We do not fetch the news." />;
    return <Rows rows={rows} cap={5} />;
  }

  if (type === "spec-register") {
    const rows = data.artifacts.filter((row) => !projectId || row.projectId === projectId).map((row) => ({ id: row.id, title: row.title }));
    if (!rows.length) return <Empty type={type} />;
    return <Rows rows={rows} cap={8} />;
  }

  if (type === "one-on-ones") {
    const rows = data.meetings.map((row) => ({ id: row.id, title: row.title || "Note", href: "/meetings" }));
    if (!rows.length) return <Empty type={type} />;
    return (
      <ul className="space-y-1.5">
        {data.meetings.slice(0, 5).map((row) => (
          <li key={row.id} className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 text-[9px] text-accent">{initials(row.title || "Note")}</span>
            <span className="min-w-0 flex-1 truncate text-[13px]">{row.title || "Note"}</span>
            <span className="text-[11px] text-muted">{shortDate(row.updatedAt)}</span>
          </li>
        ))}
      </ul>
    );
  }

  if (type === "okr-strip") {
    const rows = data.deliverables.filter((row) => !projectId || row.projectId === projectId).slice(0, 4);
    if (!rows.length) return <Empty type={type} />;
    return (
      <ul className="space-y-2">
        {rows.map((row) => {
          const days = daysUntil(row.due);
          const pct = days === null ? 20 : Math.max(8, Math.min(100, 100 - days * 3));
          return (
            <li key={row.id}>
              <div className="truncate text-[12.5px]">{row.title}</div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
                <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  if (type === "completed") {
    const rows = data.tasks
      .filter((task) => task.status === "done")
      .slice(0, 6)
      .map((task) => ({ id: task.id, title: task.title, href: `/tasks/${task.id}` }));
    if (!rows.length) return <Empty type={type} />;
    return (
      <div>
        <Rows rows={rows} cap={6} />
        <Link href="/settings#completed" className="mt-2 inline-block text-[12.5px] text-muted underline-offset-2 hover:underline">
          Open completed
        </Link>
      </div>
    );
  }

  if (type === "incident-now") {
    const rows = data.tasks
      .filter((task) => task.status === "blocked" || task.taskType === "incident")
      .slice(0, 5)
      .map((task) => ({ id: task.id, title: task.title, href: `/tasks/${task.id}` }));
    if (!rows.length) return null;
    return <Rows rows={rows} cap={5} />;
  }

  return <Empty type={type} />;
}

export function incidentOpen(tasks: Array<{ status: string; taskType: string | null }> | undefined): boolean {
  if (!tasks) return false;
  return tasks.some((task) => task.status === "blocked" || task.taskType === "incident");
}
