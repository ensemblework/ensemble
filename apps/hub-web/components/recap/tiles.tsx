"use client";

import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowUpRight,
  Bot,
  CalendarCheck,
  CircleCheck,
  Flame,
  FolderCheck,
  Inbox,
  PackageCheck,
  Scale,
  Trophy,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import type { WeeklyRecap } from "@/lib/api";
import { dayLabel, dayMonth, plural } from "./format";

/** The recap's card: the desk tile look, sized by the recap grid (data-md / data-lg spans). */
export function RecapTile({
  title,
  icon: Icon,
  meta,
  right,
  md,
  lg,
  className,
  children,
  labelledBy,
}: {
  title: string;
  icon: LucideIcon;
  meta?: ReactNode;
  right?: ReactNode;
  md?: 6;
  lg?: 4 | 5 | 6 | 7 | 8;
  className?: string;
  children: ReactNode;
  labelledBy?: string;
}) {
  const id = labelledBy ?? `recap-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className={`recap-tile${className ? ` ${className}` : ""}`} data-md={md} data-lg={lg} aria-labelledby={id}>
      <header className="recap-tile-head">
        <Icon size={14} strokeWidth={2.1} aria-hidden />
        <h2 id={id}>{title}</h2>
        {meta != null ? <span className="recap-tile-meta">{meta}</span> : null}
        {right != null ? <div className="recap-tile-right">{right}</div> : null}
      </header>
      {children}
    </section>
  );
}

const HIGHLIGHT: Record<string, { icon: LucideIcon; hue: string }> = {
  deliverable: { icon: PackageCheck, hue: "var(--chart-violet)" },
  project_done: { icon: FolderCheck, hue: "var(--chart-blue)" },
  priority: { icon: Flame, hue: "var(--chart-rose)" },
  best_day: { icon: Trophy, hue: "var(--accent)" },
  project_push: { icon: TrendingUp, hue: "var(--chart-blue)" },
  streak: { icon: CalendarCheck, hue: "var(--chart-amber)" },
  first_run: { icon: Bot, hue: "var(--chart-teal)" },
  clear: { icon: Inbox, hue: "var(--ok)" },
  agents: { icon: Bot, hue: "var(--chart-teal)" },
  decisions: { icon: Scale, hue: "var(--chart-violet)" },
};

export function Highlights({ rows }: { rows: WeeklyRecap["highlights"] }) {
  if (!rows.length) {
    return <p className="recap-empty-line">Highlights show up as you finish work: your best day, high-priority wins and delivered milestones.</p>;
  }
  return (
    <ul className="recap-highlights">
      {rows.map((row) => {
        const look = HIGHLIGHT[row.kind] ?? { icon: CircleCheck, hue: "var(--accent)" };
        const Icon = look.icon;
        const body = (
          <>
            <span className="recap-highlight-icon" aria-hidden><Icon size={15} strokeWidth={2} /></span>
            <span className="recap-highlight-text">
              <b>{row.title}</b>
              <span>{row.detail}</span>
            </span>
            {row.href ? <ArrowUpRight size={14} aria-hidden /> : null}
          </>
        );
        const style = { ["--hue" as string]: look.hue } as CSSProperties;
        return (
          <li key={`${row.kind}-${row.title}`}>
            {row.href ? (
              <Link href={row.href} className="recap-highlight" style={style}>{body}</Link>
            ) : (
              <div className="recap-highlight" style={style}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function Projects({ rows }: { rows: WeeklyRecap["projects"] }) {
  if (!rows.length) {
    return (
      <p className="recap-empty-line">
        No project work moved this week. Tasks linked to a project show up here. <Link href="/projects">Open projects</Link>
      </p>
    );
  }
  return (
    <ul className="recap-projects">
      {rows.map((row) => {
        const scale = Math.max(1, row.completed + row.open);
        return (
          <li key={row.id}>
            <div className="recap-project-top">
              <Link href={row.href}>{row.name}</Link>
              <span>
                <b>{row.completed}</b> done · {row.open} open{row.created ? ` · ${row.created} new` : ""}
              </span>
            </div>
            <div
              className="recap-project-bar"
              role="img"
              aria-label={`${row.name}: ${plural(row.completed, "task")} done this week, ${row.open} still open${row.created ? `, ${row.created} added` : ""}`}
            >
              {row.completed ? <i data-part="done" style={{ width: `${(row.completed / scale) * 100}%` }} /> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function AgentBars({ rows }: { rows: WeeklyRecap["agents"]["byAgent"] }) {
  const peak = Math.max(1, ...rows.map((row) => row.runs));
  return (
    <ul className="recap-bars" aria-label="Runs by agent">
      {rows.map((row) => (
        <li key={row.name} className="recap-bar-row" style={{ ["--swatch" as string]: "var(--recap-agents)" }}>
          <i aria-hidden />
          <span>{row.name}</span>
          <b>{plural(row.runs, "run")}</b>
          <span className="recap-bar-track" aria-hidden><i style={{ width: `${(row.runs / peak) * 100}%` }} /></span>
        </li>
      ))}
    </ul>
  );
}

function Rows({ rows, empty, max = 5, more }: { rows: Array<{ key: string; href: string; title: string; side?: ReactNode }>; empty: string; max?: number; more?: { href: string; label: string } }) {
  if (!rows.length) return <p className="recap-empty-line">{empty}</p>;
  return (
    <>
      <ul className="recap-rows">
        {rows.slice(0, max).map((row) => (
          <li key={row.key}>
            <Link href={row.href} className="recap-row">
              <span>{row.title}</span>
              {row.side}
            </Link>
          </li>
        ))}
      </ul>
      {more && rows.length > max ? (
        <Link href={more.href} className="recap-link mt-2">
          {more.label}
          <ArrowUpRight size={13} aria-hidden />
        </Link>
      ) : null}
    </>
  );
}

/** Due soon, overdue and waiting on you. A past week shows only what it left open. */
export function Ahead({ data }: { data: WeeklyRecap }) {
  const { ahead } = data;
  const overdue = (
    <section aria-label="Overdue">
      <h3>
        {data.current ? "Overdue" : "Left open"}
        <span>{ahead.overdueTotal ? ahead.overdueTotal : ""}</span>
      </h3>
      <Rows
        rows={ahead.overdue.map((row) => ({ key: row.href + row.title, href: row.href, title: row.title, side: row.detail ? <small data-tone="danger">due {row.detail}</small> : null }))}
        empty={data.current ? "Nothing is overdue." : "Nothing was overdue at the end of this week."}
        more={{ href: "/board", label: `See all ${ahead.overdueTotal} on the board` }}
      />
    </section>
  );
  if (!data.current) return <div className="recap-ahead recap-ahead-past">{overdue}</div>;
  return (
    <div className="recap-ahead">
      <section aria-label="Due soon">
        <h3>
          Due soon <span>through {dayMonth(ahead.dueRange.until)}</span>
        </h3>
        <Rows
          rows={ahead.dueNextWeek.map((row) => ({
            key: row.href + row.title,
            href: row.href,
            title: row.title,
            side: (
              <small data-tone={row.detail ? "accent" : undefined}>
                {row.detail ? `${row.detail} · ` : ""}
                {row.due === data.today ? "today" : dayLabel(row.due)}
              </small>
            ),
          }))}
          empty={`Nothing is due through ${dayMonth(ahead.dueRange.until)}.`}
          more={{ href: "/board", label: "See everything on the board" }}
        />
      </section>
      {overdue}
      <section aria-label="Waiting on you">
        <h3>Waiting on you</h3>
        {ahead.waiting.count ? (
          <div className="recap-waiting">
            <span className="recap-num">{ahead.waiting.count}</span>
            <span className="text-[12.5px] text-muted">{ahead.waiting.count === 1 ? "approval or question" : "approvals and questions"} in Needs me</span>
            <Link href={ahead.waiting.href} className="btn mt-1">Open Needs me</Link>
          </div>
        ) : (
          <p className="recap-empty-line">Nothing is waiting on you. Agents can keep going.</p>
        )}
      </section>
    </div>
  );
}

type RecordTab = "done" | "decided" | "meetings";

/** What happened, item by item, for reference and the export. Secondary to the numbers above. */
export function Record({ data }: { data: WeeklyRecap }) {
  const tabs = ([
    { id: "done", label: "Finished", count: data.done.length },
    { id: "decided", label: "Decided", count: data.decided.length },
    { id: "meetings", label: "Meetings", count: data.meetings.length },
  ] as Array<{ id: RecordTab; label: string; count: number }>).filter((tab) => tab.count > 0);
  const [picked, setPicked] = useState<RecordTab | null>(null);
  const [all, setAll] = useState(false);
  const tab = tabs.find((row) => row.id === picked) ?? tabs[0];
  if (!tab) return null;
  const limit = all ? Infinity : 10;
  const rows = tab.id === "done" ? data.done : tab.id === "decided" ? data.decided : [];
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="recap-tabs" role="tablist" aria-label="The week item by item">
          {tabs.map((row, index) => (
            <button
              key={row.id}
              type="button"
              role="tab"
              id={`recap-tab-${row.id}`}
              aria-selected={row.id === tab.id}
              aria-controls="recap-record-panel"
              tabIndex={row.id === tab.id ? 0 : -1}
              onClick={() => { setPicked(row.id); setAll(false); }}
              onKeyDown={(event) => {
                const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (!step) return;
                event.preventDefault();
                const next = tabs[(index + step + tabs.length) % tabs.length]!;
                setPicked(next.id);
                setAll(false);
                (event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#recap-tab-${next.id}`))?.focus();
              }}
            >
              {row.label}
              <span>{row.count}</span>
            </button>
          ))}
        </div>
      </div>
      <div id="recap-record-panel" role="tabpanel" aria-labelledby={`recap-tab-${tab.id}`}>
        {tab.id === "meetings" ? (
          <ul className="recap-record">
            {data.meetings.slice(0, limit).map((meeting) => (
              <li key={meeting.href} className="recap-meeting">
                <Link href={meeting.href}>{meeting.title}</Link>
                <small>{meeting.when}</small>
                {meeting.summary ? <p>{meeting.summary}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <ul className="recap-record">
            {rows.slice(0, limit).map((row, index) => (
              <li key={`${row.href}-${index}`}>
                <Link href={row.href} className="recap-row">
                  <span>{row.title}</span>
                  {row.detail && row.detail !== "Done" ? <small>{row.detail}</small> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {tab.count > 10 ? (
          <button type="button" className="recap-link mt-3" onClick={() => setAll((value) => !value)} aria-expanded={all}>
            {all ? "Show fewer" : `Show all ${tab.count}`}
          </button>
        ) : null}
      </div>
    </>
  );
}
