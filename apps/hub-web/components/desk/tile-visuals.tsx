"use client";

import { useState, type ReactNode } from "react";
import { ArrowRight, BookOpen, Check, ChevronLeft, ChevronRight, FileText } from "lucide-react";
import type { DeskLive } from "@/lib/api";
import { personInitials } from "@/lib/initials";
import type { Spec } from "./live-board";
import { AgentsAtWork, FocusNow, YourWeek } from "./now-tiles";
import { plainRow, RowList, rowsForSpan, taskRow, type ListRow } from "./rows";
import { CHART_COLORS as COLORS, datedItems, dayLabel, isLate, mockScores, ratio, taskSegments, timeSegments, weekAhead, type Segment } from "./tile-data";

const short = (day: string) => new Date(`${day.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const round = (n: number) => Number(n.toFixed(1)).toLocaleString("en-GB");
const tone = (i: number) => COLORS[i % COLORS.length]!;
function Empty({ children }: { children: ReactNode }) { return <p className="visual-empty">{children}</p>; }
function Metric({ value, label, note }: { value: ReactNode; label: string; note?: string }) {
  return <div className="visual-metric"><strong className="num">{value}</strong><div><span>{label}</span>{note && <small>{note}</small>}</div></div>;
}

export function Donut({ segments, label, unit = "", value, interactive = true }: { segments: Segment[]; label: string; unit?: string; value?: string; interactive?: boolean }) {
  const [selected, setSelected] = useState<number | null>(null);
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const selectedSegment = selected == null ? null : segments[selected];
  const LegendRow = interactive ? "button" : "div";
  let offset = 0;
  return <div className="visual-donut" data-visual="donut">
    <div className="visual-ring">
      <svg viewBox="0 0 120 120" role="img" aria-label={`${label}: ${segments.map((s) => `${s.label} ${round(s.value)}${unit}`).join(", ")}`}>
        <circle cx="60" cy="60" r="48" fill="none" stroke="var(--chart-track)" strokeWidth="11" />
        {segments.map((s, i) => {
          const length = ratio(s.value, total) * 3.0159;
          const start = offset; offset += length;
          return <circle key={s.label} cx="60" cy="60" r="48" fill="none" stroke={s.color} strokeWidth={selected === i ? 14 : 11} strokeDasharray={`${Math.max(0, length - (segments.filter((x) => x.value > 0).length > 1 ? 3 : 0))} 301.59`} strokeDashoffset={-start} transform="rotate(-90 60 60)" opacity={selected != null && selected !== i ? .3 : 1}><title>{`${s.label}: ${round(s.value)}${unit}`}</title></circle>;
        })}
      </svg>
      <div className="visual-ring-value"><strong className="num">{selectedSegment ? round(selectedSegment.value) : value ?? round(total)}</strong><small>{selectedSegment ? unit || "items" : label}</small></div>
    </div>
    <div className="visual-legend">{segments.map((s, i) => <LegendRow key={s.label} type={interactive ? "button" : undefined} aria-pressed={interactive ? selected === i : undefined} onClick={interactive ? () => setSelected(selected === i ? null : i) : undefined} className="visual-legend-row"><i style={{ background: s.color }} /><span>{s.label}</span><b>{round(s.value)}{unit}</b></LegendRow>)}</div>
  </div>;
}

function Columns({ segments, label }: { segments: Segment[]; label: string }) {
  const max = Math.max(1, ...segments.map((s) => s.value));
  return <div className="visual-columns" data-visual="columns" role="img" aria-label={`${label}: ${segments.map((s) => `${s.label} ${s.value}`).join(", ")}`}>
    {segments.map((s) => <div key={s.label} className="visual-column"><b>{round(s.value)}</b><div className="visual-column-track"><i style={{ height: `${s.value / max * 100}%`, background: s.color }} /></div><span>{s.label}</span></div>)}
  </div>;
}

function Calendar({ live, interactive }: { live: DeskLive; interactive: boolean }) {
  const Day = interactive ? "button" : "span";
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(live.today);
  const today = new Date(`${live.today}T00:00:00Z`);
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1));
  const year = first.getUTCFullYear(), month = first.getUTCMonth();
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const pad = (first.getUTCDay() + 6) % 7;
  const rows = datedItems(live);
  const chosen = rows.filter((r) => r.day === selected);
  const date = (n: number) => `${year}-${String(month + 1).padStart(2, "0")}-${String(n).padStart(2, "0")}`;
  return <div className="visual-calendar" data-visual="calendar">
    <div className="visual-calendar-head"><strong>{first.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}</strong><div>{interactive && <><button type="button" aria-label="Previous month" onClick={() => setOffset(offset - 1)}><ChevronLeft size={15} /></button><button type="button" aria-label="Next month" onClick={() => setOffset(offset + 1)}><ChevronRight size={15} /></button></>}</div></div>
    <div className="visual-calendar-grid">{["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <small key={i}>{d}</small>)}{Array.from({ length: pad }, (_, i) => <span key={`pad${i}`} />)}{Array.from({ length }, (_, i) => {
      const day = date(i + 1), events = rows.filter((r) => r.day === day);
      return <Day key={day} className="calendar-day" type={interactive ? "button" : undefined} aria-label={`${short(day)}, ${events.length} due`} aria-pressed={interactive ? selected === day : undefined} data-selected={selected === day || undefined} data-today={day === live.today || undefined} onClick={interactive ? () => setSelected(day) : undefined}>{i + 1}<i style={{ background: events.length ? COLORS[0] : "transparent" }} /></Day>;
    })}</div>
    <div className="visual-calendar-agenda" aria-live="polite"><small>{short(selected)} · {chosen.length} due</small>{chosen.length ? chosen.slice(0, 2).map((r) => <div key={r.id}>{r.title}</div>) : <div>No deadlines. Room to focus.</div>}</div>
  </div>;
}

function Scores({ live, interactive }: { live: DeskLive; interactive: boolean }) {
  const all = mockScores(live);
  const subjects = [...new Set(all.map((r) => r.subject || "General"))];
  const [subject, setSubject] = useState<string | null>(null);
  const active = subject && subjects.includes(subject) ? subject : subjects[0];
  const scores = all.filter((r) => (r.subject || "General") === active).slice(0, 8).reverse();
  if (!scores.length) return <Empty>Log a score and its maximum to start the chart.</Empty>;
  const x = (i: number) => scores.length === 1 ? 170 : 28 + i * 284 / (scores.length - 1);
  const y = (v: number) => 112 - v * .9;
  const points = scores.map((s, i) => `${x(i)},${y(s.value)}`).join(" ");
  return <div className="visual-scores" data-visual="score-line">
    <div className="visual-score-head"><Metric value={`${round(scores.at(-1)!.value)}%`} label="latest score" />{interactive ? <select aria-label="Score subject" value={active} onChange={(e) => setSubject(e.target.value)}>{subjects.map((s) => <option key={s}>{s}</option>)}</select> : <small>{active}</small>}</div>
    <svg viewBox="0 0 340 146" role="img" aria-label={scores.map((s) => `${s.label}: ${round(s.value)}%`).join(", ")}>
      {[0, 50, 100].map((n) => <g key={n}><line x1="28" y1={y(n)} x2="312" y2={y(n)} stroke="var(--chart-track)" strokeDasharray="3 5" /><text x="1" y={y(n) + 3} fill="var(--muted)" fontSize="9">{n}</text></g>)}
      {scores.length > 1 && <><polygon points={`28,112 ${points} 312,112`} fill="var(--chart-blue)" opacity=".09" /><polyline points={points} fill="none" stroke="var(--chart-blue)" strokeWidth="3" strokeLinejoin="round" /></>}
      {scores.map((s, i) => <g key={s.id}><circle cx={x(i)} cy={y(s.value)} r="5" fill="var(--chart-blue)" stroke="var(--tile)" strokeWidth="2"><title>{`${s.label}: ${round(s.value)}%`}</title></circle><text x={x(i)} y="135" textAnchor="middle" fill="var(--muted)" fontSize="10">{i + 1}</text></g>)}
    </svg><small>Recorded attempts · oldest to newest</small>
  </div>;
}

function Grading({ live }: { live: DeskLive }) {
  const expected = live.grading.reduce((n, r) => n + r.expected, 0);
  const marked = live.grading.reduce((n, r) => n + Math.min(r.expected, Math.max(0, r.marked)), 0);
  return <div className="visual-grading" data-visual="grading"><Metric value={expected - marked} label="left to mark" note={`${marked} of ${expected} submissions marked`} /><div className="visual-progress-track"><i style={{ width: `${ratio(marked, expected)}%`, background: COLORS[0] }} /></div><div className="visual-grade-grid">{live.grading.map((r, i) => <div key={r.id} className="visual-grade-card"><strong>{r.className}</strong><span><b style={{ color: tone(i) }}>{Math.round(ratio(r.marked, r.expected))}%</b><small>{r.marked}/{r.expected} marked</small></span><div className="visual-progress-track"><i style={{ width: `${ratio(r.marked, r.expected)}%`, background: tone(i) }} /></div></div>)}</div></div>;
}

function People({ spec, live }: { spec: Spec; live: DeskLive }) {
  const ids = new Set(spec.rows(live).map((r) => r.id));
  const people = live.people.filter((p) => ids.has(p.id));
  return <div className="visual-people" data-visual="people-cards">{people.slice(0, spec.r <= 3 ? (spec.c <= 4 ? 2 : 4) : 6).map((p, i) => {
    const next = p.lastInteraction && p.oneOnOneDays ? new Date(Date.parse(`${p.lastInteraction.slice(0, 10)}T00:00:00Z`) + p.oneOnOneDays * 86400000).toISOString().slice(0, 10) : null;
    return <div key={p.id} className="visual-person"><span className="visual-avatar" style={{ color: tone(i), background: `color-mix(in srgb, ${tone(i)} 14%, transparent)` }}>{personInitials(p.name)}</span><div><strong>{p.name}</strong><small>{p.role || "On your team"}</small>{spec.key === "ones" && <span className="visual-tag" data-urgent={Boolean(next && next < live.today)}>{next ? `${next < live.today ? "Overdue" : "Next"} · ${short(next)}` : `Every ${p.oneOnOneDays} days`}</span>}{spec.key !== "ones" && p.lastInteraction && <small>Last contact · {short(p.lastInteraction)}</small>}</div></div>;
  })}</div>;
}

function Documents({ spec, live, preview }: { spec: Spec; live: DeskLive; preview: boolean }) {
  const rows = spec.rows(live).filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i);
  const reading = ["read", "reading", "affairs"].includes(spec.key);
  return <div className="visual-documents" data-visual="document-cards">{rows.slice(0, spec.r <= 3 ? 2 : 4).map((r, i) => {
    const task = live.tasks.find((t) => t.id === r.id);
    const status = task?.pipelineStage || task?.matterStage || (task?.status === "done" ? "Finished" : task?.status === "in_progress" ? "In progress" : reading ? "To read" : "Draft");
    const late = task ? isLate(task, live.today) : false;
    const content = <><span className="visual-document-icon" style={{ color: tone(i) }}>{reading ? <BookOpen size={20} /> : <FileText size={20} />}</span><strong title={r.title}>{r.title}</strong><span className="visual-document-tags"><span className="visual-tag">{status}</span>{task?.due ? <span className="visual-tag" data-urgent={late}>{late ? "Overdue · " : ""}{dayLabel(task.due, live.today)}</span> : null}</span><small>{reading ? "Reading queue" : "Document workspace"}<ArrowRight size={12} /></small></>;
    return preview || !task ? <div key={r.id} className="visual-document">{content}</div> : <a key={r.id} href={`/tasks/${encodeURIComponent(r.id)}`} className="visual-document">{content}</a>;
  })}</div>;
}

function Timeline({ spec, live }: { spec: Spec; live: DeskLive }) {
  const ids = new Set(spec.rows(live).map((r) => r.id));
  const dated = datedItems(live).filter((r) => ids.has(r.id));
  const fallback = spec.rows(live).filter((r) => !dated.some((d) => d.id === r.id));
  return <div className="visual-timeline" data-visual="date-agenda">{[...dated.map((r) => ({ ...r, meta: dayLabel(r.day, live.today) })), ...fallback.map((r) => ({ ...r, day: "" }))].slice(0, 5).map((r, i) => <div key={r.id}><span className="visual-date" style={{ color: r.day && r.day < live.today ? "var(--chart-rose)" : tone(i) }}>{r.meta || "Next"}</span><span className="visual-timeline-dot" style={{ background: tone(i) }} /><strong title={r.title}>{r.title}</strong></div>)}</div>;
}

type VisualProps = { spec: Spec; live: DeskLive; preview?: boolean; interactive?: boolean; footer?: ReactNode; href?: string };

export function TileVisuals(props: VisualProps) {
  return <>{tileVisual(props).node}</>;
}

/** The tile's picture. `list` says it drew its own footer (the quiet add and "View all"), so the caller must not. */
export function tileVisual({ spec, live, preview = false, interactive = true, footer, href }: VisualProps): { node: ReactNode; list: boolean } {
  const key = spec.key;
  const drawn = (node: ReactNode) => ({ node, list: false });
  if (key === "focus-now") return { node: <FocusNow live={live} preview={preview} />, list: true };
  if (key === "agents") return { node: <AgentsAtWork live={live} preview={preview} />, list: true };
  if (key === "your-week") return { node: <YourWeek live={live} preview={preview} />, list: true };
  if (key === "progress") return drawn(<Donut interactive={interactive} segments={taskSegments(live)} label="tasks" />);
  if (key === "workload") return drawn(<><Metric value={taskSegments(live).slice(1).reduce((s, r) => s + r.value, 0)} label="open tasks" /><Columns segments={taskSegments(live)} label="Task status" /></>);
  if (["time-split", "hours", "billable", "unbilled"].includes(key)) return drawn(timeSegments(live).length ? <Donut interactive={interactive} segments={timeSegments(live)} label="hours logged" unit="h" /> : <Empty>Log time to see how your hours are distributed.</Empty>);
  if (key === "calendar") return drawn(<Calendar live={live} interactive={interactive} />);
  if (key === "due-week") {
    const week = weekAhead(live);
    const days = week.days.map((d, i) => ({ label: new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }), value: d.value, color: tone(i) }));
    const late = week.overdue ? [{ label: "Late", value: week.overdue, color: "var(--chart-rose)" }] : [];
    const total = week.overdue + days.reduce((s, d) => s + d.value, 0);
    return drawn(<><Metric value={total} label={week.overdue ? "due or overdue" : "due in 7 days"} note={week.overdue ? `${week.overdue} overdue` : undefined} /><Columns segments={[...late, ...days]} label={week.overdue ? "Overdue, then due in the next seven days" : "Due in the next seven days"} /></>);
  }
  if (key === "mocks") return drawn(<Scores live={live} interactive={interactive} />);
  if (key === "marking") return drawn(<Grading live={live} />);
  if (["attendance", "streak"].includes(key)) {
    const { present, absent } = live.attendance;
    return drawn(<Donut interactive={interactive} segments={[{ label: "Present", value: present, color: tone(0) }, { label: "Absent", value: absent, color: tone(3) }]} label="attendance" value={`${Math.round(ratio(present, present + absent))}%`} />);
  }
  if (key === "accuracy") {
    const scores = mockScores(live);
    const avg = scores.length ? scores.reduce((s, r) => s + r.value, 0) / scores.length : 0;
    return drawn(scores.length ? <><Metric value={`${Math.round(avg)}%`} label="average score" note={`${scores.length} recorded attempts`} /><div className="visual-progress-track"><i style={{ width: `${avg}%`, background: tone(0) }} /></div><div className="visual-score-pills">{scores.slice(0, 3).map((s, i) => <span key={s.id}><i style={{ background: tone(i) }} /><strong>{s.subject || s.label}</strong><b>{round(s.value)}%</b></span>)}</div></> : <Empty>No scored attempts yet.</Empty>);
  }
  if (["people", "group", "advisor", "out", "ones"].includes(key)) return drawn(<People spec={spec} live={live} />);
  if (["read", "reading", "affairs", "drafts"].includes(key)) return drawn(<Documents spec={spec} live={live} preview={preview} />);
  if (key === "cites") return drawn(<div className="visual-citations" data-visual="source-trail">{live.citations.slice(0, 4).map((r, i) => <div key={r.id}><span style={{ color: tone(i) }}>{String(i + 1).padStart(2, "0")}</span><section><strong>{r.fromTitle}</strong><small><ArrowRight size={12} />{r.toTitle}</small></section></div>)}</div>);
  if (["checks", "tests", "result"].includes(key)) {
    const counts = ["pass", "fail", "unknown"].map((status, i) => ({ label: status === "pass" ? "Passed" : status === "fail" ? "Failed" : "Unknown", value: live.tests.filter((r) => r.status === status).length, color: tone([0, 3, 2][i]!) }));
    return drawn(<><div className="visual-test-counts">{counts.map((s) => <div key={s.label}><strong className="num" style={{ color: s.color }}>{s.value}</strong><small>{s.label}</small></div>)}</div><div className="visual-checks">{live.tests.slice(0, 3).map((r) => <div key={r.id}><i style={{ background: r.status === "pass" ? tone(0) : r.status === "fail" ? tone(3) : tone(2) }} /><strong>{r.name}</strong><small>{r.status}</small></div>)}</div></>);
  }
  if (["syllabus", "revision", "concepts", "target"].includes(key)) {
    const type = key === "syllabus" ? "phase" : key === "concepts" ? "concept" : "revision";
    const rows = live.tasks.filter((t) => t.taskType === type);
    const done = rows.filter((t) => t.status === "done" || t.pipelineStage?.toLowerCase() === "done").length;
    return drawn(<div data-visual="phase-plan" className="visual-phases"><div className="visual-phase-summary"><strong>{done}<small> / {rows.length}</small></strong><span>completed {type === "phase" ? "units" : "topics"}</span></div>{rows.slice(0, 4).map((r, i) => <div key={r.id} className="visual-phase"><span style={{ color: tone(i), borderColor: tone(i) }}>{r.status === "done" || r.pipelineStage?.toLowerCase() === "done" ? <Check size={12} /> : i + 1}</span><section><strong title={r.title}>{r.title}</strong><small>{r.subject || (r.due ? `Due ${dayLabel(r.due, live.today)}` : r.pipelineStage || "To do")}</small></section></div>)}</div>);
  }
  if (["deadlines", "dels", "reminders", "brief", "filings", "paper", "hearings", "cause", "venue", "lead", "next", "hold"].includes(key)) return drawn(<Timeline spec={spec} live={live} />);
  if (key === "stages") {
    const rows = spec.rows(live);
    return drawn(<Donut interactive={interactive} segments={rows.map((r, i) => ({ label: r.title, value: Number(r.meta) || 0, color: tone(i) }))} label="matters" />);
  }
  if (key === "objectives" || key === "words") {
    const rows = key === "objectives" ? live.objectives.map((r) => ({ id: r.id, title: r.title, value: r.progress })) : live.tasks.filter((r) => r.taskType === "paper" && r.wordCount != null).map((r) => ({ id: r.id, title: r.title, value: r.wordCount! }));
    const max = key === "objectives" ? 100 : Math.max(1, ...rows.map((r) => r.value));
    return drawn(<div className="visual-bars" data-visual="measured-bars">{rows.slice(0, 4).map((r, i) => <div key={r.id}><header><strong>{r.title}</strong><b>{round(r.value)}{key === "objectives" ? "%" : " words"}</b></header><div className="visual-progress-track"><i style={{ width: `${ratio(r.value, max)}%`, background: tone(i) }} /></div></div>)}</div>);
  }
  const rows = spec.rows(live).filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i);
  const meetings = key === "meet" || key === "follow";
  const tasks = new Map(live.tasks.map((t) => [t.id, t]));
  const listRows: ListRow[] = rows.map((r, i) => {
    const task = tasks.get(r.id);
    if (task && !meetings) return { ...taskRow(task, live.today, preview, r.meta), title: r.title };
    return plainRow(r, meetings ? "person" : "dot", tone(i));
  });
  return { node: <RowList rows={listRows} estimate={rowsForSpan(spec.r)} href={href} footer={footer} preview={preview} label={spec.title} />, list: true };
}
