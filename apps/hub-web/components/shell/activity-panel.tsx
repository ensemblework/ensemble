"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AgentIcon as Orbit } from "@/components/agent-icon";
import { ArrowUpRight, CircleStop, Code2, FileText, MessageSquare, OctagonX, Pause, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { hasModule } from "@ensemble/shared-types/modules";
import { activityPollInterval } from "@/lib/activity-poll";
import { api, type AgentCall, type AgentJob } from "@/lib/api";
import { useElapsed } from "../agent/job-card";
import { usePeek } from "./peek";
import { useToast } from "../toast";
import { TrayDot } from "@/components/motion/slot";
import { InfoTip, Spinner, cx, useClickOutside } from "../ui";

const CALL_ICON: Record<string, typeof Orbit> = { assistant: MessageSquare, fetch: RefreshCw, run: Orbit, workspace: Orbit };
const CALL_LABEL: Record<string, string> = { assistant: "Assistant", fetch: "Fetch", run: "Agent run", workspace: "Agent task" };

type Tone = "offline" | "paused" | "working" | "needs" | "queued" | "idle";

function Row({ icon: Icon, title, detail, since, live, tone, onOpen, action }: { icon: typeof Orbit; title: string; detail?: string | null; since?: string | null; live?: boolean; tone?: "needs"; onOpen?: () => void; action?: React.ReactNode }) {
  const elapsed = useElapsed(since ?? null, Boolean(live));
  const body = (
    <>
      <span className="activity-row-icon" data-tone={tone} aria-hidden><Icon size={14} /></span>
      <span className="activity-row-text">
        <span className="activity-row-title">{title}</span>
        {detail ? <span className="activity-row-detail">{detail}</span> : null}
      </span>
      {elapsed ? <span className="activity-row-time">{elapsed}</span> : null}
    </>
  );
  return (
    <div className="activity-row">
      {onOpen ? <button type="button" className="activity-row-main" onClick={onOpen}>{body}</button> : <div className="activity-row-main">{body}</div>}
      {action}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <section className="activity-section">
      <h3>{title}<span className="activity-section-count">{count}</span></h3>
      {children}
    </section>
  );
}

function StopButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} className="activity-stop" onClick={onClick}>
      <CircleStop size={14} />
    </button>
  );
}

export function ActivityControls({ connected = true, serverError = false }: { connected?: boolean; serverError?: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const peek = usePeek();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const sync = () => setHidden(document.visibilityState === "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  const ref = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    // Escape (handled by useClickOutside) hands focus back to the pill when it was in the panel.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && ref.current?.contains(document.activeElement)) pill.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const workspaceOn = hasModule(shell.data?.modules, "workspace");
  const state = useQuery({
    queryKey: ["agent-state"],
    queryFn: api.agentState,
    enabled: workspaceOn,
    staleTime: 15_000,
    refetchInterval: (query) => {
      if (!workspaceOn) return false;
      const body = query.state.data;
      const idle = body != null && !body.paused && body.calls.length + body.running.length + body.waiting.length + body.queued.length === 0;
      return activityPollInterval({ hidden, open, idle });
    },
  });
  const data = state.data;
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["agent-state"] });
    void client.invalidateQueries({ queryKey: ["workspace"] });
    void client.invalidateQueries({ queryKey: ["task-jobs"] });
  };
  const stop = useMutation({ mutationFn: (id: string) => api.stopActivity(id), onSuccess: refresh });
  const stopJob = useMutation({ mutationFn: (id: string) => api.stopJob(id), onSuccess: refresh });
  const kill = useMutation({
    mutationFn: () => (data?.paused ? api.resumeAgent() : api.pauseAgent()),
    onSuccess: (result) => {
      const stopped = (result as { stopped?: number } | undefined)?.stopped;
      toast(data?.paused ? "Resumed. Model calls are allowed again." : `Paused. ${stopped ? `${stopped} running task${stopped === 1 ? "" : "s"} stopped. ` : ""}Nothing calls a model until you resume.`, {
        tone: data?.paused ? "ok" : "error",
      });
      refresh();
    },
  });
  const stopAll = useMutation({
    mutationFn: api.stopAll,
    onSuccess: (result) => {
      toast(`Stopped ${result.stopped} and cleared ${result.cancelled} from the queue.`);
      refresh();
    },
  });

  const calls: AgentCall[] = data?.calls ?? [];
  const running: AgentJob[] = data?.running ?? [];
  const waiting: AgentJob[] = data?.waiting ?? [];
  const queued: AgentJob[] = data?.queued ?? [];
  const busy = calls.length + running.length;
  const paused = data?.paused ?? false;
  const label = !connected ? (serverError ? "Server error" : "Offline") : paused ? "Paused" : busy ? `Working · ${busy}` : waiting.length ? "Needs you" : queued.length ? "Queued" : "Idle";
  const tone: Tone = !connected ? "offline" : paused ? "paused" : busy ? "working" : waiting.length ? "needs" : queued.length ? "queued" : "idle";
  const word = !connected ? (serverError ? "Server error" : "Offline") : paused ? "Paused" : busy ? "Working" : waiting.length ? "Needs you" : queued.length ? "Queued" : "Idle";
  const count = tone === "working" ? busy : tone === "needs" ? waiting.length : tone === "queued" ? queued.length : 0;
  // Waiting for you is the one thing that needs a person; it gets a mark even while other work runs.
  const attention = connected && !paused && waiting.length > 0;
  const summary = paused
    ? "Nothing calls a model until you resume."
    : [busy ? `${busy} running` : "", waiting.length ? `${waiting.length} waiting for you` : "", queued.length ? `${queued.length} queued` : ""].filter(Boolean).join(" · ") || "No AI call is running or waiting.";
  const heading = paused ? "Paused" : busy ? "Running now" : waiting.length ? "Needs you" : queued.length ? "Queued" : "Nothing running";
  const anything = busy + waiting.length + queued.length > 0;

  const jobRow = (job: AgentJob, needs?: boolean) => (
    <Row
      key={job.id}
      icon={job.kind === "code" ? Code2 : FileText}
      title={job.title}
      detail={job.status === "queued" ? `#${job.position} · ${job.waitingFor ?? job.model}` : job.progress ?? job.model}
      since={job.status === "queued" ? null : job.startedAt}
      live={job.status !== "queued"}
      tone={needs ? "needs" : undefined}
      onOpen={() => (peek.open(job.taskId), setOpen(false))}
      action={<StopButton label={job.status === "queued" ? "Remove from the queue" : "Stop this task now"} onClick={() => stopJob.mutate(job.id)} />}
    />
  );

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      <button
        ref={pill}
        type="button"
        onClick={() => setOpen(!open)}
        className="activity-pill"
        data-tone={tone}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={connected ? "Live updates. What the AI is doing right now." : serverError ? "Ensemble's server is answering with errors. Retrying…" : "Reconnecting to the Hub…"}
        aria-label={connected ? `Activity: ${label}${attention && tone !== "needs" ? `, ${waiting.length} waiting for you` : ""}` : serverError ? "Ensemble's server is answering with errors" : "Reconnecting to the Hub"}
      >
        <span className="activity-pill-mark">
          <TrayDot state={tone === "queued" ? "idle" : tone} />
          {attention || tone === "paused" || tone === "offline" ? <span className="activity-pill-dot" data-tone={attention ? "needs" : tone} aria-hidden /> : null}
        </span>
        <span className="activity-pill-label">{word}</span>
        {count ? <span className="activity-pill-count">{count}</span> : null}
        {!paused && busy && queued.length ? <span className="activity-pill-more" title={`${queued.length} queued`}>+{queued.length}</span> : null}
      </button>
      <button
        type="button"
        onClick={() => kill.mutate()}
        disabled={kill.isPending || !data}
        className={cx("icon-btn", paused ? "bg-[var(--tag-red-bg)] text-[var(--tag-red-fg)] hover:text-ink" : "hover:text-danger")}
        title={paused ? "Resume: allow model calls again" : "Kill switch: stop every AI call and task now, start nothing new"}
        aria-label={paused ? "Resume model calls" : "Kill switch: pause every AI call and task"}
      >
        {kill.isPending ? <Spinner size={13} /> : paused ? <Play size={14} /> : <Pause size={14} />}
      </button>
      {open ? (
        <div data-activity-panel role="dialog" aria-label="Activity" className="activity-panel pop-in fixed inset-x-3 top-12 z-50 lg:absolute lg:inset-x-auto lg:right-0 lg:top-full lg:mt-2 lg:w-[380px]">
          <header className="activity-head">
            <div className="min-w-0 flex-1">
              <h2>{heading}</h2>
              <p>{summary}</p>
            </div>
            <Link href="/runs" onClick={() => setOpen(false)} className="activity-runs">
              Runs <ArrowUpRight size={13} aria-hidden />
            </Link>
          </header>
          {anything ? (
            <div className="activity-feed">
              <Section title="Waiting for you" count={waiting.length}>
                {waiting.map((job) => jobRow(job, true))}
              </Section>
              <Section title="Model calls" count={calls.length}>
                {calls.map((call) => (
                  <Row
                    key={call.id}
                    icon={CALL_ICON[call.kind] ?? Orbit}
                    title={`${CALL_LABEL[call.kind] ?? call.kind}: ${call.label}`}
                    detail={[call.model, call.detail].filter(Boolean).join(" · ")}
                    since={call.startedAt}
                    live
                    action={<StopButton label="Stop this call" onClick={() => stop.mutate(call.id)} />}
                  />
                ))}
              </Section>
              <Section title="Agent tasks" count={running.length}>
                {running.map((job) => jobRow(job))}
              </Section>
              <Section title="Queued" count={queued.length}>
                {queued.map((job) => jobRow(job))}
              </Section>
            </div>
          ) : null}
          {shell.data?.space?.shared ? (
            <p className="activity-note">
              The kill switch here is {shell.data.space.shared.owner.name}'s. Stop your own runs from their cards; they run on your computer.
            </p>
          ) : (
            <div className="activity-foot">
              <button type="button" className="btn flex-1 justify-center text-danger" disabled={stopAll.isPending || !anything} onClick={() => stopAll.mutate()}>
                <OctagonX size={13} /> Stop everything
              </button>
              <button type="button" className={cx("btn flex-1 justify-center", paused && "border-ok text-ok")} disabled={kill.isPending} onClick={() => kill.mutate()}>
                {paused ? <Play size={13} /> : <Pause size={13} />} {paused ? "Resume" : "Pause (kill switch)"}
              </button>
              <InfoTip label="About stopping" text="Stop kills running commands and aborts model requests at once. A provider may still bill a request it already received." />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
