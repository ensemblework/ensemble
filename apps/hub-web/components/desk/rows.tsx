"use client";

import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { useLayoutEffect, useState, type ReactNode } from "react";
import type { DeskLive } from "@/lib/api";
import { personInitials } from "@/lib/initials";
import { dayLabel, isLate } from "./tile-data";

/** One row height for every list tile, so how many fit is plain arithmetic. Keep in step with `.lrow` in desk.css. */
export const ROW_H = 34;
const FOOT_H = 28;

/** Rows that fit a desktop tile of `r` grid rows before it is measured: 72px rows, 12px gaps, header, padding and footer. */
export function rowsForSpan(r: number): number {
  return Math.max(1, Math.floor((r * 72 + (r - 1) * 12 - 58 - FOOT_H) / ROW_H));
}

/**
 * How many whole rows fit the list's box, times how many columns of `minCol` px fit across it.
 * A box that grows with its content (phones) keeps the first estimate.
 */
export function useFitRows(estimate: number, rowH = ROW_H, minCol = 0, gap = 0) {
  // A callback ref: the list may mount after the first render (once its data arrives).
  const [el, ref] = useState<HTMLElement | null>(null);
  const [fit, setFit] = useState({ count: estimate, cols: 1 });
  useLayoutEffect(() => setFit((prev) => ({ ...prev, count: estimate * prev.cols })), [estimate]);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const height = el.clientHeight;
      const cols = minCol ? Math.max(1, Math.floor((el.clientWidth + gap) / (minCol + gap))) : 1;
      if (height > 0) setFit({ count: Math.max(1, Math.floor((height + gap + 1) / (rowH + gap))) * cols, cols });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, rowH, minCol, gap]);
  return { ref, count: fit.count, cols: fit.cols };
}

export type ListRow = { id: string; title: string; href?: string; glyph: ReactNode; label?: string; chips?: ReactNode };

/** A status glyph in the Linear style: hollow to do, half-filled in progress, a filled mark when stuck or done. */
export function StatusGlyph({ status }: { status: string }) {
  const tone = status === "in_progress" ? "var(--chart-amber)" : status === "done" ? "var(--chart-teal)" : status === "blocked" || status === "waiting_approval" ? "var(--chart-rose)" : status === "proposed" ? "var(--chart-violet)" : "var(--muted)";
  if (status === "done") return <span className="lglyph" style={{ background: tone, color: "var(--tile)" }}><Check size={9} strokeWidth={3.4} /></span>;
  return (
    <svg className="lglyph" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5.6" fill="none" stroke={tone} strokeWidth="1.6" strokeDasharray={status === "proposed" ? "2.2 2" : undefined} />
      {status === "in_progress" ? <path d="M7 3.2 A3.8 3.8 0 0 1 7 10.8 Z" fill={tone} /> : null}
      {status === "blocked" || status === "waiting_approval" ? <circle cx="7" cy="7" r="3" fill={tone} /> : null}
    </svg>
  );
}

const STATUS_LABEL: Record<string, string> = { proposed: "Proposed", in_progress: "In progress", blocked: "Blocked", waiting_approval: "Waiting on you", done: "Done" };

/** When it is due, as a small chip: Overdue in the danger tone, Today in the accent, else the date. */
export function DueChip({ due, status, today }: { due: string | null; status: string; today: string }) {
  if (!due) return null;
  const day = due.slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  if (isLate({ due, status }, today)) return <span className="lchip" data-tone="danger" title={`Overdue since ${dayLabel(day, today)}`}>{dayLabel(day, today)}</span>;
  if (day === today) return <span className="lchip" data-tone="accent">Today</span>;
  if (day === tomorrow) return <span className="lchip">Tomorrow</span>;
  return <span className="lchip">{dayLabel(day, today)}</span>;
}

/** Only the priorities worth a glance get a chip; Medium and Low stay quiet. */
export function PriorityChip({ priority }: { priority?: string | null }) {
  if (priority === "critical") return <span className="lchip" data-prio="critical">Urgent</span>;
  if (priority === "p0") return <span className="lchip" data-prio="high">High</span>;
  return null;
}

type DeskTask = DeskLive["tasks"][number] & { priority?: string | null };

/** A task as a list row. `meta` (a tile's own note, such as a court or a type) stands in for the date when there is none. */
export function taskRow(task: DeskTask, today: string, preview = false, meta?: string): ListRow {
  return {
    id: task.id,
    title: task.title,
    href: preview ? undefined : `/tasks/${encodeURIComponent(task.id)}`,
    glyph: <StatusGlyph status={task.status} />,
    label: STATUS_LABEL[task.status],
    chips: <><PriorityChip priority={task.priority} />{task.due ? <DueChip due={task.due} status={task.status} today={today} /> : meta ? <span className="lchip">{meta}</span> : null}</>,
  };
}

export function plainRow(row: { id: string; title: string; meta?: string }, kind: "dot" | "person", tone: string): ListRow {
  return {
    id: row.id,
    title: row.title,
    glyph: kind === "person" ? <span className="lglyph lavatar" style={{ color: tone, background: `color-mix(in srgb, ${tone} 16%, transparent)` }}>{personInitials(row.title)}</span> : <span className="lglyph"><i style={{ background: tone }} /></span>,
    chips: row.meta ? <span className="lchip">{row.meta}</span> : null,
  };
}

/**
 * A list tile: light rows, as many whole rows as the tile holds, then "View all N" when some are left out.
 * `footer` is the tile's own quiet action (Add …), kept on the same line.
 */
export function RowList({ rows, estimate, href, footer, preview = false, label }: { rows: ListRow[]; estimate: number; href?: string; footer?: ReactNode; preview?: boolean; label: string }) {
  const { ref, count } = useFitRows(estimate);
  const shown = rows.slice(0, count);
  const more = rows.length > shown.length;
  return (
    <div className="lwrap" data-visual="task-rows">
      <div ref={ref} className="llist" role="list" aria-label={label}>
        {shown.map((row) => {
          const body = <>{row.glyph}<span className="ltitle" title={row.title}>{row.title}</span>{row.label ? <span className="llabel">{row.label}</span> : null}{row.chips}</>;
          return row.href ? (
            <Link key={row.id} role="listitem" className="lrow" href={row.href}>{body}</Link>
          ) : (
            <div key={row.id} role="listitem" className="lrow">{body}</div>
          );
        })}
      </div>
      {footer || (more && href && !preview) ? (
        <div className="lfoot">
          {footer}
          {more && href && !preview ? <Link className="lmore" href={href}>View all {rows.length}<ArrowRight size={12} aria-hidden="true" /></Link> : null}
        </div>
      ) : null}
    </div>
  );
}
