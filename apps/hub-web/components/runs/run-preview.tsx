"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Copy,
  FileText,
  FolderGit2,
  Globe,
  Laptop,
  ListTree,
  MessageSquare,
  Pencil,
  ScrollText,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  SquareArrowOutUpRight,
  Terminal,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { MarkdownText } from "@/components/markdown-text";
import { Spinner, Tag, Tabs, cx } from "@/components/ui";
import { api, type RunDetail, type RunJob } from "@/lib/api";
import { dateTime, plural } from "@/lib/format";
import { useModalFocus } from "@/lib/modal-focus";
import { duration, modelsSeen, sameModel, toolStats, traceEntries, usd, type TraceCall, type TraceEntry, type TraceKind } from "@/lib/run-trace";

export const RUN_OUTCOME: Record<string, { label: string; tone: "green" | "red" | "yellow" | "gray" | "orange" | "blue" }> = {
  success: { label: "Done", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Stopped", tone: "gray" },
  needs_info: { label: "Needs info", tone: "orange" },
  waiting_approval: { label: "Waiting for you", tone: "yellow" },
};

const LIVE = new Set(["queued", "claimed", "running", "stopping", "waiting_approval"]);

/** Still going: not ended, and its job (when it has one) not stopped; a run an older server never closed is not live. */
function runIsLive(run: RunDetail, job: RunJob | null): boolean {
  return !run.endedAt && (!job || LIVE.has(job.status));
}
const DELIVERY: Record<string, string> = { local: "Local only", commit: "May commit", push: "May push" };

type Tab = "trace" | "result" | "files" | "activity" | "log";
type Filter = "all" | "tools" | "thinking" | "messages";

/** The run, opened from the Runs page: its trace, result, files, activity and log, beside the list. */
export function RunPreview({ runId, onClose }: { runId: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, true, onClose);
  const detail = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId),
    refetchInterval: (query) => (query.state.data && runIsLive(query.state.data.run, query.state.data.job) ? 3000 : false),
  });
  if (typeof document === "undefined") return null;
  const data = detail.data;
  return createPortal(
    <div
      ref={ref}
      data-modal-layer={`run-${runId}`}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Run"
      className="fixed inset-0 z-[70] flex justify-end bg-black/40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="run-sheet flex h-full w-[min(920px,100vw)] min-w-0 flex-col border-l border-line bg-bg shadow-pop">
        {detail.isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : !data ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-muted">
            {detail.error ? (detail.error as Error).message : "This run is gone."}
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <RunSheet run={data.run} job={data.job} onClose={onClose} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function RunSheet({ run, job, onClose }: { run: RunDetail; job: RunJob | null; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("trace");
  const live = runIsLive(run, job);
  const outcome = run.outcome
    ? (RUN_OUTCOME[run.outcome] ?? { label: run.outcome, tone: "gray" as const })
    : live
      ? { label: "Running", tone: "blue" as const }
      : { label: job?.status === "interrupted" ? "Interrupted" : "Ended", tone: "gray" as const };
  // A run an older server never closed ends when its job did.
  const endedAt = run.endedAt ?? (live ? null : (job?.finishedAt ?? null));
  const entries = useMemo(() => traceEntries(run.steps, run.startedAt, endedAt), [run.steps, run.startedAt, endedAt]);
  const taskId = run.task.id;
  const elapsed = duration((endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(run.startedAt));
  const tabs: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: "trace", label: "Trace", badge: entries.length || undefined },
    { id: "result", label: "Result" },
    ...(job?.files.length ? [{ id: "files" as const, label: "Files", badge: job.files.length }] : []),
    ...(job ? [{ id: "activity" as const, label: "Activity" }, { id: "log" as const, label: "Log" }] : []),
  ];
  return (
    <>
      <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <Tag tone={outcome.tone}>{outcome.label}</Tag>
            {job ? <span className="font-medium text-ink">{job.engineName}</span> : <span>{run.worker === "workspace" ? "Agent" : "Delegated run"}</span>}
            <span>·</span>
            <span>{dateTime(run.startedAt)}</span>
            {elapsed ? (
              <>
                <span>·</span>
                <span>{live ? `${elapsed} so far` : elapsed}</span>
              </>
            ) : null}
          </div>
          <h2 className="mt-1.5 text-[17px] font-semibold leading-6">{run.task.title}</h2>
        </div>
        <Link href={`/tasks/${taskId}`} className="btn shrink-0 gap-1.5 py-1 text-[12.5px]" title="Open the task page">
          <SquareArrowOutUpRight size={13} /> Open task
        </Link>
        <button type="button" className="icon-btn shrink-0" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-4">
        <Facts run={run} job={job} entries={entries} />
        {run.error ? (
          <div className="mt-3 flex gap-2 rounded-md border border-danger/35 bg-danger/[0.07] px-3 py-2 text-[13px]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
            <span className="min-w-0 break-words">{run.error}</span>
          </div>
        ) : null}
        <div className="mt-4">
          <Tabs label="Run sections" tabs={tabs} value={tab} onChange={setTab} />
        </div>
        {tab === "trace" ? <Trace entries={entries} live={live} /> : null}
        {tab === "result" ? <Result run={run} /> : null}
        {tab === "files" && job ? <Files job={job} /> : null}
        {tab === "activity" && job ? <Activity jobId={job.id} live={live} run={run} /> : null}
        {tab === "log" && job ? <Log jobId={job.id} live={live} /> : null}
      </div>
    </>
  );
}

function Fact({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-raised px-2.5 py-2" title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 truncate text-[13px]">{children}</div>
    </div>
  );
}

function Facts({ run, job, entries }: { run: RunDetail; job: RunJob | null; entries: TraceEntry[] }) {
  const asked = job?.model ?? run.requestedModel ?? run.plannerModel ?? null;
  const seen = modelsSeen(run.steps);
  const answered = job?.modelUsed ?? seen[seen.length - 1] ?? null;
  const differs = Boolean(asked && answered && !sameModel(asked, answered));
  const tokensIn = job?.tokensIn ?? entries.reduce((sum, entry) => sum + (entry.tokensIn ?? 0), 0);
  const tokensOut = job?.tokensOut ?? entries.reduce((sum, entry) => sum + (entry.tokensOut ?? 0), 0);
  const calls = job?.toolCalls ?? entries.reduce((sum, entry) => sum + entry.calls.length, 0);
  const credits = run.steps.reduce<number | null>((sum, step) => (sum === null || step.credits == null ? sum : sum + step.credits), 0);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Fact label="Harness" hint="What ran the model and its tools">
        {job ? job.engineName : "Ensemble"}
        {job?.engine === "ensemble" && job.provider ? <span className="text-muted"> · {job.provider}</span> : null}
      </Fact>
      <Fact label="Model asked for" hint={job?.reasoningEffort ? `Thinking: ${job.reasoningEffort}` : undefined}>
        <span className="font-mono text-[12.5px]">{asked ?? "—"}</span>
        {job?.reasoningEffort && job.reasoningEffort !== "default" ? <span className="text-muted"> · {job.reasoningEffort}</span> : null}
      </Fact>
      <Fact label="Answered by" hint={seen.length > 1 ? `Models seen: ${seen.join(", ")}` : "The model the provider reported"}>
        {answered ? (
          <span className={cx("font-mono text-[12.5px]", differs && "text-warn")}>
            {differs ? <AlertTriangle size={12} className="mr-1 inline" /> : null}
            {answered}
          </span>
        ) : (
          <span className="text-muted">{run.endedAt ? "Not reported" : "—"}</span>
        )}
      </Fact>
      <Fact label="Where">
        {job ? (
          <span className="inline-flex items-center gap-1">
            {job.where === "device" ? <Laptop size={12} /> : job.where === "server" ? <Server size={12} /> : <Laptop size={12} />}
            {job.where === "device" ? job.deviceName ?? "A paired computer" : job.where === "server" ? "Ensemble server" : "This computer"}
          </span>
        ) : (
          "Ensemble"
        )}
      </Fact>
      {job?.kind === "code" ? (
        <Fact label="Guardrails" hint={`${job.sandbox ? "Sandboxed" : "Not sandboxed"} · internet ${job.networkAccess ? "on" : "off"} · ${DELIVERY[job.delivery] ?? job.delivery}`}>
          <span className="inline-flex items-center gap-1.5">
            {job.sandbox ? <ShieldCheck size={12} className="text-ok" /> : <ShieldAlert size={12} className="text-warn" />}
            {job.sandbox ? "Sandbox" : "No sandbox"}
            <span className="text-faint">·</span>
            <Globe size={12} className={job.networkAccess ? "" : "text-faint"} />
            {job.networkAccess ? "Internet" : "Offline"}
            <span className="text-faint">·</span>
            {DELIVERY[job.delivery] ?? job.delivery}
          </span>
        </Fact>
      ) : null}
      {job?.folder || job?.repoUrl ? (
        <Fact label="Folder" hint={job.repoUrl ?? undefined}>
          <span className="inline-flex items-center gap-1 font-mono text-[12px]">
            <FolderGit2 size={12} />
            {job.folder ?? job.repoUrl}
            {job.branch ? <span className="text-muted"> · {job.branch}</span> : null}
          </span>
        </Fact>
      ) : null}
      <Fact label="Work" hint={job ? `Limits: ${job.limits.turns} turns · ${job.limits.toolCalls} tool calls · ${job.limits.minutes} min` : undefined}>
        {job ? `${plural(job.turns, "turn")} · ` : ""}
        {plural(calls, "tool call")}
      </Fact>
      <Fact label="Tokens" hint="In / out">
        {tokensIn || tokensOut ? `${tokensIn.toLocaleString()} / ${tokensOut.toLocaleString()}` : "—"}
      </Fact>
      <Fact label="Cost" hint="An estimate: the harness's own, or from token counts and list prices">
        {job?.costUsd != null ? usd(job.costUsd) : credits ? `${Math.round(credits * 10) / 10} credits` : "—"}
      </Fact>
    </div>
  );
}

const ICONS: Array<[RegExp, typeof Wrench]> = [
  [/bash|command|shell|exec|terminal|run_command/i, Terminal],
  [/read|view|open|cat/i, FileText],
  [/edit|write|patch|apply|create_file|filechange|replace/i, Pencil],
  [/grep|glob|search|find|ls|list/i, Search],
  [/web|fetch|http|url|browse/i, Globe],
];

function toolIcon(name: string) {
  return ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? Wrench;
}

const FILTERS: Array<{ id: Filter; label: string; match: (kind: TraceKind) => boolean }> = [
  { id: "all", label: "All", match: () => true },
  { id: "tools", label: "Tool calls", match: (kind) => kind === "tools" },
  { id: "thinking", label: "Thinking", match: (kind) => kind === "thinking" },
  { id: "messages", label: "Messages", match: (kind) => kind === "message" || kind === "result" || kind === "step" },
];

function Trace({ entries, live }: { entries: TraceEntry[]; live: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [openAll, setOpenAll] = useState<boolean | null>(null);
  const stats = useMemo(() => toolStats(entries), [entries]);
  if (!entries.length) {
    return (
      <div className="rounded-md border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">
        {live ? "Nothing recorded yet. Steps show up here as the agent works." : "No steps were recorded for this run. Runs on a paired computer with Ensemble older than 0.3.5 report only the result."}
      </div>
    );
  }
  const shown = entries.filter((entry) => FILTERS.find((row) => row.id === filter)!.match(entry.kind) || (filter === "thinking" && Boolean(entry.reasoning)));
  const calls = entries.reduce((sum, entry) => sum + entry.calls.length, 0);
  const failed = entries.reduce((sum, entry) => sum + entry.calls.filter((call) => call.ok === false).length, 0);
  const toolMs = stats.reduce((sum, row) => sum + row.ms, 0);
  return (
    <div>
      {stats.length ? (
        <div className="mb-3 rounded-md border border-line px-3 py-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px] text-muted">
            <span>
              {plural(calls, "tool call")}
              {failed ? <span className="text-danger"> · {failed} failed</span> : null}
              {toolMs ? ` · ${duration(toolMs)} in tools` : ""}
            </span>
            <span className="text-faint">Time per tool</span>
          </div>
          <div className="mt-2 space-y-1">
            {stats.slice(0, 8).map((row) => {
              const Icon = toolIcon(row.name);
              const share = toolMs ? row.ms / toolMs : 0;
              return (
                <div key={row.name} className="flex items-center gap-2 text-[12px]">
                  <Icon size={12} className="shrink-0 text-faint" />
                  <span className="w-36 shrink-0 truncate font-mono">{row.name}</span>
                  <span className="w-12 shrink-0 text-right text-muted">×{row.count}</span>
                  <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, share * 100)}%` }} />
                  </div>
                  <span className="w-14 shrink-0 text-right tabular-nums text-muted">{duration(row.ms) || "—"}</span>
                  {row.failed ? <span className="shrink-0 text-danger">{row.failed} failed</span> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {FILTERS.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => setFilter(row.id)}
            className={cx("rounded-full border px-2.5 py-0.5 text-[12px]", filter === row.id ? "border-accent bg-[var(--accent-soft)] text-ink" : "border-line text-muted hover:text-ink")}
          >
            {row.label}
          </button>
        ))}
        <div className="flex-1" />
        <button type="button" className="text-[12px] text-muted hover:text-ink" onClick={() => setOpenAll(openAll ? false : true)}>
          {openAll ? "Collapse all" : "Expand all"}
        </button>
      </div>
      <ol className="relative space-y-1.5">
        {shown.map((entry) => (
          <TraceRow key={`${entry.id}:${openAll}`} entry={entry} defaultOpen={openAll ?? (entry.kind === "result" || entry.status === "failed")} />
        ))}
        {live ? (
          <li className="flex items-center gap-2 px-2 py-1.5 text-[12.5px] text-muted">
            <Spinner size={12} /> Working…
          </li>
        ) : null}
      </ol>
    </div>
  );
}

function StatusMark({ status, ok }: { status: string; ok?: boolean | null }) {
  if (status === "running" || ok === null) return <CircleDashed size={14} className="shrink-0 animate-spin text-accent [animation-duration:2.4s]" />;
  if (status === "failed" || ok === false) return <XCircle size={14} className="shrink-0 text-danger" />;
  return <CheckCircle2 size={14} className="shrink-0 text-ok" />;
}

function Timeline({ entry }: { entry: TraceEntry }) {
  if (entry.offset == null) return <div className="hidden w-24 shrink-0 sm:block" />;
  return (
    <div className="relative hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-raised sm:block" title="When it ran, within the whole run">
      <div
        className={cx("absolute inset-y-0 rounded-full", entry.status === "failed" ? "bg-danger" : entry.kind === "thinking" ? "bg-[var(--tag-purple-fg)]" : "bg-accent")}
        style={{ left: `${entry.offset * 100}%`, width: `max(3px, ${(entry.width ?? 0) * 100}%)` }}
      />
    </div>
  );
}

function TraceRow({ entry, defaultOpen }: { entry: TraceEntry; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const single = entry.calls.length === 1 ? entry.calls[0]! : null;
  const Icon =
    entry.kind === "thinking" ? Brain : entry.kind === "message" ? MessageSquare : entry.kind === "result" ? ListTree : single ? toolIcon(single.name) : entry.calls.length ? Wrench : ScrollText;
  const label =
    entry.kind === "tools"
      ? single
        ? single.name
        : `${entry.calls.length} tool calls`
      : entry.kind === "thinking"
        ? "Thinking"
        : entry.kind === "message"
          ? "Message"
          : entry.kind === "result"
            ? "Result"
            : entry.title;
  const detail =
    entry.kind === "tools"
      ? single
        ? single.summary && single.summary !== single.name
          ? single.summary
          : entry.title !== single.name
            ? entry.title
            : firstLine(single.args)
        : entry.calls.map((call) => call.name).join(", ")
      : firstLine(entry.kind === "thinking" ? entry.reasoning : entry.text || entry.error);
  const hasBody = Boolean(entry.reasoning || entry.text || entry.error || entry.calls.some((call) => call.args || call.output));
  return (
    <li className={cx("rounded-md border", entry.status === "failed" ? "border-danger/35" : "border-line", open && "bg-panel")}>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => hasBody && setOpen(!open)}
        aria-expanded={hasBody ? open : undefined}
      >
        <ChevronRight size={12} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90", !hasBody && "invisible")} />
        <Icon size={14} className={cx("shrink-0", entry.kind === "thinking" ? "text-[var(--tag-purple-fg)]" : "text-muted")} />
        <span className={cx("shrink-0 text-[13px] font-medium", entry.kind === "tools" && "font-mono text-[12.5px]")}>{label}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{detail}</span>
        {entry.model && entry.kind !== "tools" ? <span className="hidden shrink-0 font-mono text-[11px] text-faint md:inline">{entry.model}</span> : null}
        {entry.tokensIn || entry.tokensOut ? <span className="hidden shrink-0 text-[11px] text-faint lg:inline">{((entry.tokensIn ?? 0) + (entry.tokensOut ?? 0)).toLocaleString()} tok</span> : null}
        <Timeline entry={entry} />
        <span className="w-14 shrink-0 text-right text-[11.5px] tabular-nums text-muted">{duration(entry.ms)}</span>
        {entry.kind === "tools" || entry.status === "failed" || entry.status === "running" ? <StatusMark status={entry.status} ok={single ? single.ok : undefined} /> : <span className="w-[14px] shrink-0" />}
      </button>
      {open && hasBody ? (
        <div className="space-y-2.5 border-t border-line px-3 py-2.5">
          {entry.reasoning ? (
            <Section label="Thinking" icon={<Brain size={12} />}>
              <div className="whitespace-pre-wrap text-[12.5px] italic leading-5 text-muted">{entry.reasoning}</div>
            </Section>
          ) : null}
          {entry.calls.map((call) => (
            <CallDetail key={call.key} call={call} many={entry.calls.length > 1} />
          ))}
          {entry.text ? (
            entry.kind === "tools" ? (
              <Section label="Said" icon={<MessageSquare size={12} />}>
                <MarkdownText text={entry.text} className="space-y-2 text-[13px] leading-[1.55]" />
              </Section>
            ) : (
              <MarkdownText text={entry.text} className="space-y-2 text-[13px] leading-[1.55]" />
            )
          ) : null}
          {entry.error && entry.error !== entry.text ? <div className="whitespace-pre-wrap text-[12.5px] text-danger">{entry.error}</div> : null}
        </div>
      ) : null}
    </li>
  );
}

function CallDetail({ call, many }: { call: TraceCall; many: boolean }) {
  const Icon = toolIcon(call.name);
  return (
    <div className="space-y-1.5">
      {many ? (
        <div className="flex items-center gap-2 text-[12.5px]">
          <Icon size={12} className="text-faint" />
          <span className="font-mono font-medium">{call.name}</span>
          {call.summary ? <span className="min-w-0 flex-1 truncate text-muted">{call.summary}</span> : <span className="flex-1" />}
          <span className="tabular-nums text-muted">{duration(call.ms)}</span>
          <StatusMark status={call.running ? "running" : "done"} ok={call.ok} />
        </div>
      ) : null}
      {call.args ? <CodeView label="Input" text={call.args} /> : null}
      {call.output ? <CodeView label={call.ok === false ? "Error" : "Output"} text={call.output} danger={call.ok === false} /> : call.running ? <div className="text-[12px] text-muted">Waiting for the result…</div> : null}
    </div>
  );
}

function Section({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1 text-[11px] uppercase tracking-wide text-faint">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

function CodeView({ label, text, danger }: { label: string; text: string; danger?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cx("overflow-hidden rounded-md border", danger ? "border-danger/35" : "border-line")}>
      <div className="flex items-center justify-between bg-raised px-2 py-0.5 text-[11px] text-faint">
        <span className={cx("uppercase tracking-wide", danger && "text-danger")}>{label}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1 hover:text-ink"
          onClick={() =>
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          <Copy size={11} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-bg p-2 font-mono text-[11.5px] leading-[1.5]">{text}</pre>
    </div>
  );
}

function Result({ run }: { run: RunDetail }) {
  if (!run.result) {
    return <div className="rounded-md border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">{run.endedAt ? "This run left no written result." : "The result shows here when the run finishes."}</div>;
  }
  return (
    <div className="rounded-lg border border-line px-4 py-3">
      <MarkdownText text={run.result} />
    </div>
  );
}

function Files({ job }: { job: RunJob }) {
  const max = Math.max(1, ...job.files.map((file) => file.added + file.removed));
  const added = job.files.reduce((sum, file) => sum + file.added, 0);
  const removed = job.files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div>
      <div className="mb-2 text-[12.5px] text-muted">
        {plural(job.files.length, "file")} changed · <span className="text-ok">+{added}</span> <span className="text-danger">−{removed}</span>
        {job.where === "device" ? " · the changes stay on that computer" : ""}
      </div>
      <div className="divide-y divide-[var(--line)] rounded-md border border-line">
        {job.files.map((file) => (
          <div key={file.path} className="flex items-center gap-3 px-3 py-1.5 text-[12.5px]">
            <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
            <span className="w-12 shrink-0 text-right tabular-nums text-ok">+{file.added}</span>
            <span className="w-12 shrink-0 text-right tabular-nums text-danger">−{file.removed}</span>
            <div className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-raised sm:flex">
              <div className="h-full bg-ok" style={{ width: `${(file.added / max) * 100}%` }} />
              <div className="h-full bg-danger" style={{ width: `${(file.removed / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      {job.results.length ? (
        <div className="mt-3 flex flex-wrap gap-3 text-[12.5px]">
          {job.results.map((result) =>
            result.url.startsWith("https://") ? (
              <a key={result.url} href={result.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {result.kind === "pr" ? "Pull request" : result.kind === "commit" ? `Commit ${(result.sha ?? "").slice(0, 7)}` : "Branch"}
              </a>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  prepared: "Folder ready",
  tool: "Tool",
  command: "Command",
  engine: "Engine",
  sandbox: "Sandbox",
  needs_me: "Needs you",
  not_sandboxed: "Not sandboxed",
  trust_revoked: "Trust removed",
  interrupted: "Interrupted",
  engine_new_session: "New session",
  commit_undone: "Commit undone",
  planted: "Flagged",
};

function eventText(kind: string, data: Record<string, unknown>): string {
  if (kind === "command") return `$ ${String(data.command ?? "")}${data.exitCode !== undefined ? ` → exit ${String(data.exitCode)}` : ""}`;
  if (kind === "tool") return String(data.summary ?? data.name ?? "");
  if (kind === "prepared") return [data.root ?? data.folder, data.branch, data.sandboxed === true ? "sandboxed" : data.sandboxed === false ? "not sandboxed" : null].filter(Boolean).map(String).join(" · ");
  if (kind === "not_sandboxed") return String(data.reason ?? "");
  if (kind === "engine") return [data.engine, data.model, data.version].filter(Boolean).map(String).join(" · ");
  if (kind === "sandbox") return [data.mechanism, data.strength, data.network === true ? "internet on" : data.network === false ? "internet off" : null].filter(Boolean).map(String).join(" · ");
  if (kind === "decision") return `${String(data.question ?? "")}${data.recommended ? ` → ${String(data.recommended)}` : ""}`;
  if (kind === "commit_undone") return String(data.note ?? "");
  if (kind === "planted") return `${String(data.folder ?? "")}: ${Array.isArray(data.files) ? data.files.map(String).join(", ") : ""} can run code when opened or built`;
  return String(data.title ?? data.summary ?? data.reason ?? data.note ?? data.message ?? "");
}

function Activity({ jobId, live, run }: { jobId: string; live: boolean; run: RunDetail }) {
  const detail = useQuery({ queryKey: ["job", jobId], queryFn: () => api.job(jobId), refetchInterval: live ? 3000 : false });
  if (detail.isLoading) return <Spinner />;
  const events = detail.data?.events ?? [];
  const approvals = run.approvals ?? [];
  if (!events.length && !approvals.length) return <div className="text-[13px] text-muted">Nothing happened around this run besides its steps.</div>;
  return (
    <ol className="space-y-1">
      {events.map((event) => (
        <li key={event.id} className="flex gap-3 text-[12.5px]">
          <span className="w-16 shrink-0 tabular-nums text-faint">{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
          <span className="w-24 shrink-0 text-muted">{EVENT_LABEL[event.kind] ?? event.kind}</span>
          <span className={cx("min-w-0 flex-1 break-words", event.kind === "command" && "font-mono text-[12px]", event.data.ok === false && "text-danger")}>
            {eventText(event.kind, event.data)}
            {typeof event.data.ms === "number" ? <span className="text-faint"> · {duration(event.data.ms)}</span> : null}
          </span>
        </li>
      ))}
      {approvals.map((approval) => (
        <li key={approval.id} className="flex gap-3 text-[12.5px]">
          <span className="w-16 shrink-0 tabular-nums text-faint">{new Date(approval.requestedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
          <span className="w-24 shrink-0 text-muted">Approval</span>
          <span className="min-w-0 flex-1">
            {approval.title} <span className="text-faint">· {approval.decision ?? "waiting"}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Log({ jobId, live }: { jobId: string; live: boolean }) {
  const logs = useQuery({ queryKey: ["job-logs", jobId], queryFn: () => api.jobLogs(jobId), refetchInterval: live ? 2500 : false });
  if (logs.isLoading) return <Spinner />;
  const chunks = logs.data?.chunks ?? [];
  if (!chunks.length) return <div className="text-[13px] text-muted">No output was logged.</div>;
  return (
    <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-panel p-3 font-mono text-[11.5px] leading-[1.5] text-muted">
      {chunks.map((chunk) => chunk.text).join("")}
    </pre>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n").find((row) => row.trim()) ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

export function RunWhere({ where, deviceName }: { where?: RunJob["where"] | null; deviceName?: string | null }) {
  if (!where) return null;
  const Icon = where === "server" ? Server : Laptop;
  return (
    <span className="inline-flex items-center gap-1">
      <Icon size={12} /> {where === "device" ? deviceName ?? "Your computer" : where === "server" ? "Ensemble server" : "This computer"}
    </span>
  );
}
