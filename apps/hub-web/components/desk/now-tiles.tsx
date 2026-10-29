"use client";

import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Bot, Check, CircleCheck, Crosshair, Flame } from "lucide-react";
import type { ReactNode } from "react";
import { hasModule } from "@ensemble/shared-types/modules";
import { api, type AgentJob, type DeskLive } from "@/lib/api";
import { useElapsed } from "@/components/agent/job-card";
import { usePeek } from "@/components/shell/peek";
import { useToast } from "@/components/toast";
import { DueChip, PriorityChip, StatusGlyph, useFitRows } from "./rows";
import { doneByDay, doneStreak, focusQueue, localDay } from "./tile-data";
import { TileEmpty } from "./ui";

type DeskTask = DeskLive["tasks"][number];

/** Fixed row heights (desk.css `.focus-item`, `.agent-list > li`), so only whole rows are drawn. */
const FOCUS_H = 52;
const AGENT_H = 58;

function Foot({ href, children }: { href: string; children: string }) {
  return <div className="lfoot"><Link className="lmore" href={href}>{children}<ArrowRight size={12} aria-hidden="true" /></Link></div>;
}

/* ── Focus now ─────────────────────────────────────────────────────────── */

/** The three open tasks to do next, with Done and Open on each. */
export function FocusNow({ live, preview = false }: { live: DeskLive; preview?: boolean }) {
  const fit = useFitRows(3, FOCUS_H);
  const rows = focusQueue(live.tasks, live.today, Math.min(3, fit.count));
  if (!rows.length) return <TileEmpty icon={Crosshair} label="Nothing open. A clear desk." action={preview ? undefined : "Plan on the board"} href="/board" />;
  return (
    <div className="lwrap" data-visual="focus-now">
      <ol ref={fit.ref} className="focus-list" aria-label="Focus now">
        {rows.map((task, index) => preview ? <FocusItem key={task.id} task={task} index={index} today={live.today} /> : <LiveFocusItem key={task.id} task={task} index={index} today={live.today} />)}
      </ol>
      {preview ? null : <Foot href="/board">Open your board</Foot>}
    </div>
  );
}

function FocusItem({ task, index, today, actions }: { task: DeskTask; index: number; today: string; actions?: ReactNode }) {
  return (
    <li className="focus-item" data-focus-task={task.id} data-rank={index + 1}>
      <div className="focus-main">
        <span className="focus-title" title={task.title}>{task.title}</span>
        <span className="focus-meta">
          <StatusGlyph status={task.status} />
          <span>{task.status === "in_progress" ? "In progress" : "To do"}</span>
          <PriorityChip priority={task.priority} />
          <DueChip due={task.due} status={task.status} today={today} />
        </span>
      </div>
      {actions}
    </li>
  );
}

function LiveFocusItem({ task, index, today }: { task: DeskTask; index: number; today: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const peek = usePeek();
  async function done() {
    const snapshot = client.getQueryData<DeskLive>(["desk-live"]);
    if (snapshot) client.setQueryData<DeskLive>(["desk-live"], { ...snapshot, tasks: snapshot.tasks.map((row) => (row.id === task.id ? { ...row, status: "done" } : row)) });
    try {
      const result = await api.patchTask(task.id, { status: "done" });
      toast(`Done: “${task.title}”.`, {
        action: {
          label: "Undo",
          run: () => {
            void (async () => {
              if (result.undoEntryId) await api.undo(result.undoEntryId);
              else await api.patchTask(task.id, { status: task.status });
              await Promise.all([client.invalidateQueries({ queryKey: ["desk-live"] }), client.invalidateQueries({ queryKey: ["tasks"] })]);
            })();
          },
        },
      });
    } catch (error) {
      if (snapshot) client.setQueryData(["desk-live"], snapshot);
      toast((error as Error).message, { tone: "error" });
    } finally {
      void client.invalidateQueries({ queryKey: ["desk-live"] });
      void client.invalidateQueries({ queryKey: ["tasks"] });
    }
  }
  return (
    <FocusItem
      task={task}
      index={index}
      today={today}
      actions={
        <span className="focus-acts">
          <button type="button" className="focus-act" aria-label={`Mark “${task.title}” done`} title="Mark done" onClick={() => void done()}>
            <Check size={13} strokeWidth={2.4} />
          </button>
          <button type="button" className="focus-act" aria-label={`Open “${task.title}”`} title="Open" onClick={() => peek.open(task.id)}>
            <ArrowUpRight size={13} />
          </button>
        </span>
      }
    />
  );
}

/* ── Agents at work ────────────────────────────────────────────────────── */

type JobLike = Pick<AgentJob, "id" | "taskId" | "title" | "status" | "progress" | "startedAt" | "toolCalls" | "maxToolCalls" | "position">;

function sampleJobs(live: DeskLive): { running: JobLike[]; queued: JobLike[]; waiting: number } {
  const open = live.tasks.filter((task) => ["todo", "in_progress"].includes(task.status));
  const job = (task: DeskTask | undefined, index: number, status: AgentJob["status"]): JobLike[] =>
    task ? [{ id: `job-${task.id}`, taskId: task.id, title: task.title, status, progress: status === "running" ? ["Reading the code", "Running the tests"][index % 2]! : null, startedAt: null, toolCalls: [18, 7][index % 2]!, maxToolCalls: 80, position: status === "queued" ? index + 1 : null }] : [];
  return { running: [...job(open[0], 0, "running"), ...job(open[1], 1, "running")], queued: job(open[2], 0, "queued"), waiting: 1 };
}

/** Agent runs working now and next in line, from the same live state the top bar polls. */
export function AgentsAtWork({ live, preview = false }: { live: DeskLive; preview?: boolean }) {
  if (preview) return <AgentsView {...sampleJobs(live)} preview />;
  return <LiveAgents />;
}

function LiveAgents() {
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const on = hasModule(shell.data?.modules, "workspace");
  const state = useQuery({ queryKey: ["agent-state"], queryFn: api.agentState, enabled: on, staleTime: 15_000 });
  const needs = (shell.data?.approvals ?? 0) + (shell.data?.decisions ?? 0) + (shell.data?.nodeApprovals ?? 0);
  if (shell.isSuccess && !on) return <TileEmpty icon={Bot} label="Agents are switched off in this space." />;
  if (!state.data) return <TileEmpty icon={Bot} label={state.isError ? "Agent activity could not load." : "Checking on your agents…"} />;
  return <AgentsView running={state.data.running} queued={state.data.queued} waiting={needs} paused={state.data.paused} />;
}

function AgentsView({ running, queued, waiting, paused = false, preview = false }: { running: JobLike[]; queued: JobLike[]; waiting: number; paused?: boolean; preview?: boolean }) {
  const fit = useFitRows(2, AGENT_H);
  const jobs = [...running, ...queued];
  const needs = waiting > 0 ? (
    preview ? <span className="agent-needs">{waiting} needs you</span> : <Link className="agent-needs" href="/needs-me">{waiting} {waiting === 1 ? "needs" : "need"} you</Link>
  ) : null;
  if (!running.length && !queued.length) {
    return (
      <div className="lwrap">
        {needs ? <div className="agent-summary">{needs}</div> : null}
        <TileEmpty icon={Bot} label={paused ? "Agents are paused." : "No agents running right now."} action={preview ? undefined : "Open Runs"} href="/runs" />
      </div>
    );
  }
  return (
    <div className="lwrap" data-visual="agents">
      <div className="agent-summary">
        <span><b>{running.length}</b> working</span>
        {queued.length ? <span><b>{queued.length}</b> queued</span> : null}
        {paused ? <span className="agent-paused">Paused</span> : null}
        {needs}
      </div>
      <ul ref={fit.ref} className="agent-list" aria-label="Agent runs">
        {jobs.slice(0, fit.count).map((job) => <AgentRow key={job.id} job={job} preview={preview} />)}
      </ul>
      {preview ? null : <Foot href="/runs">{jobs.length > fit.count ? `${jobs.length - fit.count} more in Runs` : "Open Runs"}</Foot>}
    </div>
  );
}

function AgentRow({ job, preview }: { job: JobLike; preview: boolean }) {
  const peek = usePeek();
  const live = job.status !== "queued";
  const elapsed = useElapsed(job.startedAt, live && !preview);
  const share = job.maxToolCalls > 0 && job.toolCalls > 0 ? Math.min(1, job.toolCalls / job.maxToolCalls) : null;
  const body = (
    <>
      <span className="agent-glyph" data-state={live ? "running" : "queued"} aria-hidden="true" />
      <span className="agent-main">
        <span className="agent-title" title={job.title}>{job.title}</span>
        <span className="agent-line">{live ? job.progress || "Working…" : `#${job.position ?? 1} in the queue`}</span>
      </span>
      {elapsed ? <span className="agent-time">{elapsed}</span> : null}
      {live ? (
        <span className="agent-bar" data-indeterminate={share == null ? "1" : undefined} title={share == null ? undefined : `${job.toolCalls} of ${job.maxToolCalls} tool calls`}>
          <i style={share == null ? undefined : { width: `${Math.max(4, share * 100)}%` }} />
        </span>
      ) : null}
    </>
  );
  return <li>{preview ? <div className="agent-row">{body}</div> : <button type="button" className="agent-row" onClick={() => peek.open(job.taskId)}>{body}</button>}</li>;
}

/* ── Your week ─────────────────────────────────────────────────────────── */

const SAMPLE_WEEK = [2, 3, 1, 4, 2, 0, 3];

/** Tasks finished on each of the last seven days, the total, and the streak. */
export function YourWeek({ live, preview = false }: { live: DeskLive; preview?: boolean }) {
  if (preview) {
    const days = SAMPLE_WEEK.map((count, index) => ({ day: new Date(Date.parse(`${live.today}T00:00:00Z`) + (index - 6) * 86_400_000).toISOString().slice(0, 10), count }));
    return <WeekView days={days} streak={4} preview />;
  }
  return <LiveWeek />;
}

function LiveWeek() {
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, staleTime: 30_000 });
  if (!tasks.data) return <TileEmpty icon={CircleCheck} label={tasks.isError ? "Your finished work could not load." : "Counting what you finished…"} />;
  const today = localDay(new Date().toISOString());
  return <WeekView days={doneByDay(tasks.data.tasks, today)} streak={doneStreak(tasks.data.tasks, today)} />;
}

function WeekView({ days, streak, preview = false }: { days: Array<{ day: string; count: number }>; streak: number; preview?: boolean }) {
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const max = Math.max(1, ...days.map((day) => day.count));
  const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  return (
    <div className="lwrap" data-visual="your-week">
      <div className="week-head">
        <div className="week-total"><strong className="num">{total}</strong><span>finished in 7 days</span></div>
        {streak > 0 ? <span className="week-streak" title="Days in a row with at least one finished task"><Flame size={12} aria-hidden="true" />{streak}-day streak</span> : null}
      </div>
      <div className="week-bars" role="img" aria-label={days.map((day) => `${label(day.day)}: ${day.count}`).join(", ")}>
        {days.map((day, index) => (
          <div key={day.day} className="week-day" data-today={index === days.length - 1 ? "1" : undefined}>
            <span className="week-track"><i style={{ height: `${day.count ? Math.max(8, (day.count / max) * 100) : 0}%` }} /></span>
            <small>{label(day.day).slice(0, 2)}</small>
          </div>
        ))}
      </div>
      {preview ? null : <Foot href="/recap">Weekly recap</Foot>}
    </div>
  );
}
