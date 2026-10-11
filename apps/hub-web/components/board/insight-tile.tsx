"use client";

import { ArrowUpRight, Plus, X } from "lucide-react";
import type { TaskRecord } from "@/lib/api";
import type { Role } from "../onboarding/roles";
import { INSIGHT_CATALOG, insightTitle } from "./insight-catalog";
import { ACTIVE, boardTasks, completedDays, dayKey, idleDays, matchesFocus, openTasks, ownerBucket, type BoardFocus, type InsightId, type OwnerContext } from "./insight-data";

const COLORS = ["var(--chart-blue)", "var(--chart-violet)", "var(--chart-amber)", "var(--chart-teal)"];
const OWNER_LABELS = { me: "Me", agent: "Agent", team: "Teammates", unassigned: "Unassigned" };
const same = (a: BoardFocus | null, b: BoardFocus) => JSON.stringify(a) === JSON.stringify(b);

type Props = { id: InsightId; role: Role; tasks: TaskRecord[]; who: OwnerContext; now: number; cap: number; focus?: BoardFocus | null; onFocus: (focus: BoardFocus | null) => void; onOpen?: (id: string) => void; onIdea?: () => void; onRemove?: () => void; preview?: boolean };

export function InsightTile({ id, role, tasks: raw, who, now, cap, focus = null, onFocus, onOpen, onIdea, onRemove, preview }: Props) {
  const spec = INSIGHT_CATALOG[id];
  const Icon = spec.icon;
  const tasks = boardTasks(raw), open = openTasks(tasks);
  const choose = (next: BoardFocus) => onFocus(same(focus, next) ? null : next);
  const action = (label: string, next: BoardFocus) => <button type="button" className="insight-action" aria-pressed={same(focus, next)} onClick={() => choose(next)}>{label}<ArrowUpRight size={12} /></button>;
  const metric = (value: number | string, label: string) => <div className="insight-metric"><strong>{value}</strong><span>{label}</span></div>;
  const taskList = (rows: TaskRecord[], age = false) => <div className="insight-tasks">{rows.slice(0, 2).map((t) => <button key={t.id} type="button" disabled={!onOpen || preview} onClick={() => onOpen?.(t.id)}><span>{t.title}</span>{age && <small>{idleDays(t, now)}d quiet</small>}</button>)}</div>;
  let body;
  if (id === "flow") {
    const groups = [
      { label: "Planned", value: tasks.filter((t) => ["proposed", "todo"].includes(t.status)).length, status: "planned" },
      { label: "In progress", value: tasks.filter((t) => t.status === "in_progress").length, status: "in_progress" },
      { label: "Waiting", value: tasks.filter((t) => ["blocked", "waiting_approval"].includes(t.status)).length, status: "waiting" },
      { label: "Done", value: tasks.filter((t) => t.status === "done").length, status: "done" },
    ];
    let offset = 0;
    body = <div className="insight-flow"><div className="insight-ring"><svg viewBox="0 0 100 100" role="img" aria-label={groups.map((g) => `${g.label}: ${g.value}`).join(", ")}><circle cx="50" cy="50" r="40" fill="none" stroke="var(--chart-track)" strokeWidth="9" />{groups.map((g, i) => { const length = tasks.length ? g.value / tasks.length * 251.327 : 0; const at = offset; offset += length; return <circle key={g.label} cx="50" cy="50" r="40" fill="none" stroke={COLORS[i]} strokeWidth="9" strokeDasharray={`${Math.max(0, length - (g.value === tasks.length ? 0 : 2))} 251.327`} strokeDashoffset={-at} transform="rotate(-90 50 50)" />; })}</svg><span><strong>{tasks.length ? Math.round(groups[3]!.value / tasks.length * 100) : 0}%</strong><small>complete</small></span></div><div className="insight-legend">{groups.map((g, i) => <button key={g.label} type="button" aria-pressed={same(focus, { kind: "status", value: g.status })} onClick={() => choose({ kind: "status", value: g.status })}><i style={{ background: COLORS[i] }} /><span>{g.label}</span><b>{g.value}</b></button>)}</div></div>;
  } else if (id === "ownership") {
    body = <div className="insight-owners">{(["me", "agent", "team", "unassigned"] as const).map((owner, i) => { const n = open.filter((t) => ownerBucket(t, who) === owner).length; return <button type="button" key={owner} aria-pressed={same(focus, { kind: "owner", value: owner })} onClick={() => choose({ kind: "owner", value: owner })}><span>{OWNER_LABELS[owner]}</span><i><b style={{ width: `${open.length ? n / open.length * 100 : 0}%`, background: COLORS[i] }} /></i><strong>{n}</strong></button>; })}</div>;
  } else if (id === "done") {
    const days = completedDays(tasks, now), max = Math.max(1, ...days.map((d) => d.count));
    const total = tasks.filter((t) => matchesFocus(t, { kind: "done" }, who, now)).length;
    body = <><div className="insight-completed">{metric(total, "finished in 7 days")}<div className="insight-spark" role="img" aria-label={days.map((d) => `${d.label}: ${d.count}`).join(", ")}>{days.map((d) => <div key={d.day}><i style={{ height: `${d.count / max * 45}px` }} /><small>{d.label.slice(0, 1)}</small></div>)}</div></div>{action("See completed work", { kind: "done" })}</>;
  } else if (id === "capacity") {
    const count = tasks.filter((t) => t.status === "in_progress").length;
    const limit = Math.max(1, cap);
    body = <>{metric(`${count} / ${limit}`, "tasks in progress")}<div className="insight-cap-track"><i style={{ width: `${Math.min(100, count / limit * 100)}%`, background: count > limit ? "var(--chart-rose)" : "var(--chart-teal)" }} /></div>{action(count > limit ? `${count - limit} above your WIP cap` : `${Math.max(0, limit - count)} before your WIP cap`, { kind: "status", value: "in_progress" })}</>;
  } else if (id === "agent" || id === "my-work") {
    const bucket = id === "agent" ? "agent" : "me";
    const owned = open.filter((t) => ownerBucket(t, who) === bucket);
    const active = owned.filter((t) => t.status === "in_progress").length;
    const waiting = owned.filter((t) => ["blocked", "waiting_approval"].includes(t.status)).length;
    body = <>{metric(owned.length, id === "agent" ? "agent-owned tasks" : "tasks with you")}<div className="insight-mini-stats"><span><i style={{ background: COLORS[1] }} />{active} in progress</span><span><i style={{ background: COLORS[2] }} />{waiting} waiting</span></div>{action("Focus this work", { kind: "owner", value: bucket })}</>;
  } else if (id === "ideas") {
    const ideas = tasks.filter((t) => t.status === "proposed");
    const unassigned = ideas.filter((t) => t.owner === "unassigned").length;
    body = <>{metric(ideas.length, "proposals to shape")}<p className="insight-note">{unassigned ? `${unassigned} still need an owner` : ideas.length ? "Ready for a next step" : "Make room for your next thought"}</p><div className="insight-actions">{action("View proposals", { kind: "ideas" })}{onIdea && <button type="button" className="insight-action" onClick={onIdea}><Plus size={12} />Capture idea</button>}</div></>;
  } else if (id === "deadlines") {
    const today = dayKey(new Date(now));
    const rows = open.filter((t) => matchesFocus(t, { kind: "deadlines" }, who, now));
    const overdue = rows.filter((t) => t.due!.slice(0, 10) < today).length;
    body = <><div className="insight-deadlines"><div>{metric(overdue, "overdue")}</div><div>{metric(rows.length - overdue, "due within 7 days")}</div></div>{action("See dated work", { kind: "deadlines" })}</>;
  } else {
    const rows = tasks.filter((t) => matchesFocus(t, { kind: id }, who, now)).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    body = <>{metric(rows.length, id === "stale" ? "quiet for 7+ days" : "waiting tasks")}{rows.length ? taskList(rows, id === "stale") : <p className="insight-note">{id === "stale" ? "Open work has recent updates" : "Nothing blocked or awaiting approval"}</p>}{action(id === "stale" ? "Give these a fresh look" : "Find the next step", { kind: id })}</>;
  }
  return <section className="board-insight" data-board-insight={id} aria-label={insightTitle(id, role)}><header><Icon size={14} /><h3>{insightTitle(id, role)}</h3>{onRemove && <button type="button" aria-label={`Remove ${insightTitle(id, role)} tile`} onClick={onRemove}><X size={12} /></button>}</header><div className="insight-content">{body}</div></section>;
}
