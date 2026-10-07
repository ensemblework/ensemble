"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Bot, Code2, FileText, MessageSquare, OctagonX, Pause, Play, RefreshCw, Square } from "lucide-react";
import Link from "next/link";
import { hasModule } from "@ensemble/shared-types/modules";
import { activityPollInterval } from "@/lib/activity-poll";
import { api, type AgentCall, type AgentJob } from "@/lib/api";
import { useElapsed } from "../agent/job-card";
import { usePeek } from "./peek";
import { useToast } from "../toast";
import { TrayDot } from "@/components/motion/slot";
import { Spinner, cx, useClickOutside } from "../ui";

const CALL_ICON: Record<string, typeof Bot> = { assistant: MessageSquare, fetch: RefreshCw, run: Bot, workspace: Bot };
const CALL_LABEL: Record<string, string> = { assistant: "Assistant", fetch: "Fetch", run: "Agent run", workspace: "Agent task" };

function Row({ icon: Icon, title, detail, since, live, action }: { icon: typeof Bot; title: string; detail?: string | null; since?: string | null; live?: boolean; action?: React.ReactNode }) {
  const elapsed = useElapsed(since ?? null, Boolean(live));
  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
      <Icon size={13} className="mt-0.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium">{title}</div>
        {detail ? <div className="truncate text-[11.5px] text-muted">{detail}</div> : null}
      </div>
      {elapsed ? <span className="shrink-0 pt-0.5 text-[11px] text-faint">{elapsed}</span> : null}
      {action}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <div className="py-1">
      <div className="px-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
        {title} · {count}
      </div>
      {children}
    </div>
  );
}

export function ActivityControls({ connected = true }: { connected?: boolean }) {
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
  useClickOutside(ref, () => setOpen(false), open);
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
  const label = !connected ? "Offline" : paused ? "Paused" : busy ? `Working · ${busy}` : waiting.length ? "Needs you" : queued.length ? "Queued" : "Idle";

  const jobRow = (job: AgentJob) => (
    <div key={job.id} role="button" onClick={() => (peek.open(job.taskId), setOpen(false))} className="cursor-pointer">
      <Row
        icon={job.kind === "code" ? Code2 : FileText}
        title={job.title}
        detail={job.status === "queued" ? `#${job.position} · ${job.model}` : job.progress ?? job.model}
        since={job.status === "queued" ? null : job.startedAt}
        live={job.status !== "queued"}
        action={
          <button
            type="button"
            title={job.status === "queued" ? "Remove from the queue" : "Stop this task now"}
            className="icon-btn h-6 w-6 shrink-0"
            onClick={(event) => {
              event.stopPropagation();
              stopJob.mutate(job.id);
            }}
          >
            <Square size={11} />
          </button>
        }
      />
    </div>
  );

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cx("flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] hover:bg-hover", paused ? "text-danger" : "text-muted")}
        title={connected ? "Live updates. What the AI is doing right now." : "Reconnecting to the Hub…"}
        aria-label={connected ? `Activity: ${label}` : "Reconnecting to the Hub"}
      >
        <TrayDot state={!connected ? "offline" : paused ? "paused" : busy ? "working" : waiting.length ? "needs" : "idle"} />
        <span className="hidden whitespace-nowrap lg:inline">{label}</span>
        {!paused && queued.length ? <span className="hidden rounded bg-raised px-1 text-[11px] text-muted lg:inline">+{queued.length}</span> : null}
      </button>
      <button
        type="button"
        onClick={() => kill.mutate()}
        disabled={kill.isPending || !data}
        className={cx("icon-btn", paused ? "bg-[var(--tag-red-bg)] text-[var(--tag-red-fg)] hover:text-ink" : "hover:text-danger")}
        title={paused ? "Resume: allow model calls again" : "Kill switch: stop every AI call and task now, start nothing new"}
      >
        {kill.isPending ? <Spinner size={13} /> : paused ? <Play size={14} /> : <Pause size={14} />}
      </button>
      {open ? (
        <div className="pop-in fixed inset-x-3 top-12 z-50 rounded-lg bg-raised p-1.5 shadow-pop lg:absolute lg:inset-x-auto lg:right-0 lg:top-full lg:mt-1 lg:w-[380px]">
          <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
            <span className="text-[13px] font-semibold">{paused ? "Paused, nothing calls a model" : busy ? "Running now" : "Nothing running"}</span>
            <Link href="/workspace" onClick={() => setOpen(false)} className="text-[12px] text-accent hover:underline">
              Workspace
            </Link>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            <Section title="Model calls" count={calls.length}>
              {calls.map((call) => (
                <Row
                  key={call.id}
                  icon={CALL_ICON[call.kind] ?? Bot}
                  title={`${CALL_LABEL[call.kind] ?? call.kind}: ${call.label}`}
                  detail={[call.model, call.detail].filter(Boolean).join(" · ")}
                  since={call.startedAt}
                  live
                  action={
                    <button type="button" title="Stop this call" className="icon-btn h-6 w-6 shrink-0" onClick={() => stop.mutate(call.id)}>
                      <Square size={11} />
                    </button>
                  }
                />
              ))}
            </Section>
            <Section title="Agent tasks" count={running.length}>
              {running.map(jobRow)}
            </Section>
            <Section title="Waiting for you" count={waiting.length}>
              {waiting.map(jobRow)}
            </Section>
            <Section title="Queued" count={queued.length}>
              {queued.map(jobRow)}
            </Section>
            {!busy && !waiting.length && !queued.length ? <div className="px-2 py-3 text-[12.5px] text-muted">No AI call is running or waiting.</div> : null}
          </div>
          <div className="mt-1 flex items-center gap-2 border-t border-line px-1 pt-1.5">
            <button type="button" className="btn flex-1 justify-center text-danger" disabled={stopAll.isPending || (!busy && !queued.length && !waiting.length)} onClick={() => stopAll.mutate()}>
              <OctagonX size={13} /> Stop everything
            </button>
            <button type="button" className={cx("btn flex-1 justify-center", paused && "border-ok text-ok")} disabled={kill.isPending} onClick={() => kill.mutate()}>
              {paused ? <Play size={13} /> : <Pause size={13} />} {paused ? "Resume" : "Pause (kill switch)"}
            </button>
          </div>
          <div className="px-2 pb-0.5 pt-1.5 text-[11px] leading-4 text-faint">
            Stop kills running commands and aborts model requests at once. A provider may still bill a request it already received.
          </div>
        </div>
      ) : null}
    </div>
  );
}
