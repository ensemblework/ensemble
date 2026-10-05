"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Code2, FileText, GitBranch, Lock, RotateCcw, ShieldAlert, ShieldCheck, Square } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type AgentJob } from "@/lib/api";
import { interruptedLabel, pullRequestNumber, rerunAssignInput } from "@/lib/device-copy";
import { plural, relative } from "@/lib/format";
import { usePeek } from "../shell/peek";
import { useToast } from "../toast";
import { RunMark } from "@/components/motion/slot";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";
import { useModuleOn } from "@/lib/use-module";
import { PriorityTag, Spinner, Tag, cx } from "../ui";

export const JOB_STATE: Record<AgentJob["status"], { label: string; tone: "green" | "red" | "yellow" | "gray" | "blue" | "orange" }> = {
  queued: { label: "Queued", tone: "gray" },
  claimed: { label: "Starting", tone: "blue" },
  running: { label: "Working", tone: "blue" },
  stopping: { label: "Stopping", tone: "yellow" },
  waiting_approval: { label: "Needs you", tone: "orange" },
  blocked: { label: "Stopped at a limit", tone: "yellow" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Stopped", tone: "gray" },
  succeeded: { label: "Done", tone: "green" },
  interrupted: { label: "Interrupted", tone: "yellow" },
};

const RETRYABLE = new Set<AgentJob["status"]>(["interrupted", "failed", "cancelled", "blocked"]);

export function jobTone(job: Pick<AgentJob, "status" | "deviceId" | "deviceName" | "deviceOnline" | "deviceRevoked">): { label: string; tone: "green" | "red" | "yellow" | "gray" | "blue" | "orange" } {
  const name = job.deviceName || "your computer";
  if (job.status === "claimed") return { label: `Starting on ${name}`, tone: "blue" };
  if (job.status === "interrupted" && job.deviceId) return { label: interruptedLabel(job.deviceName, job.deviceRevoked), tone: "orange" };
  if (job.status === "queued" && job.deviceId && job.deviceOnline === false) return { label: `Waiting for ${name}`, tone: "gray" };
  if (job.status === "queued" && job.deviceId) return { label: `Queued for ${name}`, tone: "gray" };
  if (job.status === "running" && job.deviceId) return { label: `Working on ${name}`, tone: "blue" };
  return JOB_STATE[job.status];
}

const RESULT_LABEL: Record<string, string> = { pr: "Pull request", commit: "Commit", branch: "Branch" };

function resultLabel(kind: string, url: string, sha?: string): string {
  const number = pullRequestNumber(url);
  if (number) return `Pull request #${number}`;
  if (kind === "commit") return `Commit ${(sha || url).slice(0, 7)}`;
  if (kind === "pr") return "Link";
  return RESULT_LABEL[kind] ?? kind;
}

const DELIVERY: Record<AgentJob["delivery"], string> = { local: "local only", commit: "may commit", push: "may push" };

export function useElapsed(since: string | null, running: boolean): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!since) return "";
  const seconds = Math.max(0, Math.round(((running ? now : Date.now()) - new Date(since).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function StopButton({ job, compact }: { job: AgentJob; compact?: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const stop = useMutation({
    mutationFn: () => api.stopJob(job.id),
    onSuccess: () => {
      toast(job.deviceId ? (job.status === "queued" ? "Removed from the queue." : `Asked ${job.deviceName || "your computer"} to stop.`) : job.status === "queued" ? "Removed from the queue." : "Stopping. Its commands were killed.");
      void client.invalidateQueries({ queryKey: ["workspace"] });
      void client.invalidateQueries({ queryKey: ["agent-state"] });
      void client.invalidateQueries({ queryKey: ["task-jobs"] });
    },
  });
  return (
    <button
      type="button"
      className={cx("btn-ghost text-[12px]", compact ? "px-1.5 py-0" : "py-0.5")}
      onClick={(event) => {
        event.stopPropagation();
        stop.mutate();
      }}
      disabled={stop.isPending || job.status === "stopping"}
      title={job.status === "queued" ? "Remove from the queue" : "Stop now"}
    >
      <Square size={11} /> {job.status === "queued" ? "Cancel" : "Stop"}
    </button>
  );
}

/** A new job with the same settings. Never automatic: an interrupted job waits for this click. */
function RunAgainButton({ job, compact }: { job: AgentJob; compact?: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const retry = useMutation({
    mutationFn: () => api.retryJob(job.id),
    onSuccess: () => {
      toast("Queued again with the same settings.", { tone: "ok" });
      void client.invalidateQueries({ queryKey: ["workspace"] });
      void client.invalidateQueries({ queryKey: ["agent-state"] });
      void client.invalidateQueries({ queryKey: ["task-jobs"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  return (
    <button
      type="button"
      className={cx(compact ? "btn-ghost px-1.5 py-0 text-[12px]" : "btn py-0.5 text-[12px]")}
      onClick={(event) => {
        event.stopPropagation();
        retry.mutate();
      }}
      disabled={retry.isPending}
    >
      <RotateCcw size={11} /> Run again
    </button>
  );
}

export function JobCard({ job, wide }: { job: AgentJob; wide?: boolean }) {
  const peek = usePeek();
  const live = job.status === "claimed" || job.status === "running" || job.status === "stopping" || job.status === "waiting_approval";
  const showProgress = useDelayedFlag(Boolean(live && job.progress));
  const elapsed = useElapsed(job.startedAt, live);
  const state = jobTone(job);
  const Icon = job.kind === "code" ? Code2 : FileText;
  return (
    <div
      role="button"
      onClick={() => peek.open(job.taskId)}
      data-active={peek.peekId === job.taskId || undefined}
      className={cx("tile cursor-pointer space-y-1.5 rounded-md bg-panel px-3 py-2.5 text-[12.5px]", job.status === "failed" && "m-tool")}
      data-motion-slot={job.status === "waiting_approval" ? "needs.waiting" : job.status === "failed" ? "state.error" : job.status === "running" || job.status === "queued" ? "run.progress" : undefined}
      data-state={job.status === "waiting_approval" ? "waiting" : job.status === "failed" ? "error" : job.status === "queued" ? "queued" : job.status === "running" ? "running" : "done"}
    >
      <div className="flex items-start gap-1.5">
        <Icon size={13} className="mt-0.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 text-[13.5px] font-semibold leading-5">{job.title}</span>
        {job.position ? <span className="shrink-0 rounded bg-raised px-1.5 text-[11px] text-muted">#{job.position}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone={state.tone}>{state.label}</Tag>
        {job.origin === "web" ? <Tag tone="blue">from web</Tag> : null}
        <PriorityTag priority={job.priority} />
        {job.kind === "code" ? (
          <>
            <span title={job.deviceId ? (job.executionMode === "sandbox" ? "macOS sandbox" : `Runs unconfined on ${job.deviceName || "this computer"}`) : job.executionMode === "sandbox" ? "Sandboxed where this computer has an OS sandbox (macOS)" : "Runs unconfined on this computer"}>
              {job.executionMode === "sandbox" ? <ShieldCheck size={13} className="text-ok" /> : <ShieldAlert size={13} className="text-warn" />}
            </span>
            <span className="text-muted">{DELIVERY[job.delivery]}</span>
            {job.useCredentials ? <Lock size={12} className="text-warn" /> : null}
          </>
        ) : null}
      </div>
      {showProgress && job.progress ? (
        <div className="flex items-center gap-1.5 text-muted">
          {job.status === "running" || job.status === "queued" ? <RunMark state={job.status === "queued" ? "queued" : "running"} /> : null}
          <span className="min-w-0 flex-1 truncate">{job.progress}</span>
        </div>
      ) : null}
      {job.kind === "code" && (job.folder || job.repoUrl) ? (
        <div className="flex items-center gap-1 truncate font-mono text-[11.5px] text-faint">
          {job.branch ? <GitBranch size={11} /> : null}
          <span className="truncate">{(job.folder || job.repoUrl || "").split("/").slice(-2).join("/")}{job.branch ? ` · ${job.branch}` : ""}</span>
        </div>
      ) : null}
      {wide && (job.error || job.summary) ? <div className="line-clamp-2 text-muted">{job.error ?? job.summary}</div> : null}
      <JobResults job={job} />
      {job.status === "interrupted" && job.deviceId && !job.deviceRevoked ? <RunAgain job={job} /> : null}
      <div className="flex items-center justify-between gap-2 pt-0.5 text-[11.5px] text-faint">
        <span className="truncate">
          {job.model}
          {job.turns ? ` · ${plural(job.turns, "turn")} · ${plural(job.toolCalls, "tool")}` : ""}
          {elapsed ? ` · ${elapsed}` : job.finishedAt ? ` · ${relative(job.finishedAt)}` : ""}
        </span>
        {job.status === "queued" || live ? <StopButton job={job} compact /> : !job.deviceId && RETRYABLE.has(job.status) ? <RunAgainButton job={job} compact /> : null}
      </div>
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  tool: "Tool",
  command: "Command",
  needs_me: "Needs you",
  prepared: "Folder ready",
  not_sandboxed: "Not sandboxed",
  trust_revoked: "Trust removed",
};

/** The latest agent attempt for a task, live, on the task page. */
export function TaskAgentPanel({ taskId }: { taskId: string }) {
  const workspaceOn = useModuleOn("workspace");
  const jobs = useQuery({
    queryKey: ["task-jobs", taskId],
    queryFn: () => api.taskJobs(taskId),
    enabled: workspaceOn,
    refetchInterval: (query) => (query.state.data?.jobs.some((job) => ["queued", "claimed", "running", "stopping", "waiting_approval"].includes(job.status)) ? 3000 : false),
  });
  const job = jobs.data?.jobs[0];
  const [open, setOpen] = useState(false);
  const live = job ? ["claimed", "running", "stopping", "waiting_approval"].includes(job.status) : false;
  const detail = useQuery({ queryKey: ["job", job?.id], queryFn: () => api.job(job!.id), enabled: (open || live) && Boolean(job), refetchInterval: job && live ? 2000 : false });
  const logs = useQuery({ queryKey: ["job-logs", job?.id], queryFn: () => api.jobLogs(job!.id), enabled: open && Boolean(job), refetchInterval: open && job && ["claimed", "running", "waiting_approval"].includes(job.status) ? 2500 : false });
  const showProgress = useDelayedFlag(Boolean(live && job?.progress));
  const elapsed = useElapsed(job?.startedAt ?? null, live);
  if (!job) return null;
  const state = jobTone(job);
  return (
    <div className={cx("mt-4 rounded-lg border px-3 py-2.5 text-[12.5px]", live ? "border-[rgb(var(--accent-rgb)/0.45)] bg-[var(--accent-soft)]" : "border-line bg-raised")}>
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={state.tone}>{state.label}</Tag>
        {job.origin === "web" ? <Tag tone="blue">from web</Tag> : null}
        {job.position ? <span className="text-muted">#{job.position} in the queue</span> : null}
        <span className="text-muted">{job.kind === "code" ? "Code" : "Research"} · {job.model}</span>
        {job.turns ? <span className="text-faint">{job.turns} turns · {job.toolCalls} tools · {(job.tokensIn + job.tokensOut).toLocaleString()} tokens</span> : null}
        {elapsed ? <span className="text-faint">{elapsed}</span> : null}
        <div className="flex-1" />
        {job.reviewId ? (
          <Link href={`/code/review?review=${job.reviewId}`} className="text-accent hover:underline">
            Review changes
          </Link>
        ) : null}
        {job.status === "queued" || live ? <StopButton job={job} /> : !job.deviceId && RETRYABLE.has(job.status) ? <RunAgainButton job={job} /> : null}
      </div>
      {showProgress && job.progress ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-muted">
          {job.status === "running" || job.status === "queued" ? <RunMark state={job.status === "queued" ? "queued" : "running"} /> : null}
          {job.status === "waiting_approval" ? (
            <Link href="/needs-me" className="text-accent hover:underline">
              {job.progress} →
            </Link>
          ) : (
            <span className="truncate">{job.progress}</span>
          )}
        </div>
      ) : null}
      {!live && job.error ? <div className="mt-1.5 text-muted">{job.error}</div> : null}
      {live && detail.data?.log ? (
        <pre data-testid="job-live-log" className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-panel p-2 font-mono text-[11px] leading-4 text-muted">
          {detail.data.log.slice(-4000)}
        </pre>
      ) : null}
      <JobResults job={job} />
      {job.status === "interrupted" && job.deviceId && !job.deviceRevoked ? <RunAgain job={job} /> : null}
      <button type="button" onClick={() => setOpen(!open)} className="mt-1.5 flex items-center gap-1 text-[12px] text-muted hover:text-ink">
        <ChevronRight size={12} className={cx("transition-transform", open && "rotate-90")} /> What it did
      </button>
      {open ? (
        <div className="mt-1.5 max-h-72 space-y-1 overflow-y-auto border-l border-line pl-3">
          {detail.isLoading ? <Spinner size={12} /> : null}
          {(detail.data?.events ?? []).map((event) => {
            const data = event.data as Record<string, unknown>;
            const text =
              event.kind === "command"
                ? `$ ${String(data.command)} → exit ${String(data.exitCode)}`
                : event.kind === "tool"
                  ? String(data.summary ?? data.name)
                  : event.kind === "prepared"
                    ? `${String(data.root)}${data.branch ? ` · ${String(data.branch)}` : ""}${data.sandboxed ? " · sandboxed" : " · not sandboxed"}`
                    : event.kind === "not_sandboxed"
                      ? String(data.reason)
                      : event.kind === "trust_revoked"
                        ? `Trust for ${String(data.root)} was removed. Paused on Needs me.`
                        : String(data.title ?? event.kind);
            return (
              <div key={event.id} className="flex gap-2">
                <span className="w-[62px] shrink-0 text-faint">{EVENT_LABEL[event.kind] ?? event.kind}</span>
                <span className={cx("min-w-0 flex-1 break-words", event.kind === "command" && "font-mono text-[11.5px]", data.ok === false && "text-danger")}>{text}</span>
              </div>
            );
          })}
          {detail.data && !detail.data.events.length && !logs.data?.chunks.length ? <div className="text-muted">Nothing yet.</div> : null}
          {(logs.data?.chunks ?? []).map((chunk) => (
            <pre key={chunk.seqFrom} className="whitespace-pre-wrap break-words font-mono text-[11.5px] text-muted">
              {chunk.text}
            </pre>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function JobResults({ job }: { job: AgentJob }) {
  const results = job.results ?? [];
  if (!results.length) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {results.map((result) => (
        result.url.startsWith("https://") ? (
          <a key={`${result.kind}:${result.url}`} href={result.url} target="_blank" rel="noreferrer" className="text-accent hover:underline" onClick={(event) => event.stopPropagation()}>
            {resultLabel(result.kind, result.url, result.sha)}
          </a>
        ) : (
          <span key={`${result.kind}:${result.url}`}>{resultLabel(result.kind, result.url, result.sha)}</span>
        )
      ))}
    </div>
  );
}

function RunAgain({ job }: { job: AgentJob }) {
  const client = useQueryClient();
  const toast = useToast();
  const pushed = job.delivery === "push" || (job.results ?? []).length > 0;
  const again = useMutation({
    mutationFn: () => api.assign(rerunAssignInput(job)),
    onSuccess: () => {
      toast(job.deviceName ? `Queued again on ${job.deviceName}.` : "Queued again.", { tone: "ok" });
      void client.invalidateQueries({ queryKey: ["workspace"] });
      void client.invalidateQueries({ queryKey: ["task-jobs"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  return (
    <div className="space-y-1">
      {pushed ? <div className="text-[12px] text-muted">The branch might already exist. {job.deviceName || "Your computer"} will refuse a second push if it moved.</div> : null}
      <button
        type="button"
        className="btn py-0.5 text-[12px]"
        disabled={again.isPending}
        onClick={(event) => {
          event.stopPropagation();
          again.mutate();
        }}
      >
        Run again
      </button>
    </div>
  );
}
