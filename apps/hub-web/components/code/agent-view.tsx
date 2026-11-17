"use client";

/**
 * The Code tab's agentic view (docs/16 §9): a thread with the person's own coding agent, in the folder
 * the IDE has open, on the same computer. Each message is a chat run (`POST /api/agent/assign` with
 * `chat` and `surface: "code"`) that continues the agent's own session, so every run rule, Needs me
 * and the run's review apply. The thread shows the turn's work, its questions (the Needs me card
 * itself) and the files it changed, which open in the IDE's review to accept or reject.
 *
 * The timeline's shape (a collapsible work log per turn, tool rows by kind, the turn's changed files
 * with their line counts) follows T3 Code's thread (https://github.com/pingdotgg/t3code, MIT License,
 * Copyright (c) 2026 T3 Tools Inc.), drawn with Ensemble's own components.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isCodeEngine, type CodeEngine } from "@ensemble/shared-types";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Eye,
  FilePen,
  FileSearch,
  Globe,
  Hand,
  History,
  ListTodo,
  MessageCircleQuestion,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Search,
  Square,
  SquareTerminal,
  Trash2,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon, EnsembleIcon } from "@/components/agent-icon";
import { AgentPicker, TuningPicker, agentOptions, modelOf, type AgentChoice } from "@/components/agent/agent-picker";
import { ProviderLogo } from "@/components/connectors/provider-logo";
import { MarkdownText } from "@/components/markdown-text";
import { DecisionCard, usePendingDecisions } from "@/components/needs-me/editor-decisions";
import { useToast } from "@/components/toast";
import { InfoTip, MenuItem, Popover, Spinner, cx } from "@/components/ui";
import { api, type AgentDecisionRecord, type AssignInput, type CodeThread, type CodeTurn } from "@/lib/api";
import { useAutoGrow } from "@/lib/auto-grow";
import { compactCount, elapsed, isLive, liveReply, threadTitle, turnMs, workRows, type ToolKind, type WorkRow } from "@/lib/code-agent";
import { computerAgent, engineAssign, engineModel } from "@/lib/engine-models";
import { relative } from "@/lib/format";
import { usePersistentState } from "@/lib/prefs";
import { defaultProfile, profileAgent, quickProfile } from "@/lib/run-profiles";
import { traceEntries } from "@/lib/run-trace";
import { FileIcon } from "./file-icon";

type Mode = "ask" | "review" | "unattended";

const MODES: Array<{ id: Mode; title: string; text: string; icon: LucideIcon | typeof AgentIcon }> = [
  { id: "ask", title: "Ask", text: "Asks before commands and edits. Reading goes ahead.", icon: Hand },
  { id: "review", title: "Review only", text: "Works freely in this folder. Asks you decisions.", icon: Eye },
  { id: "unattended", title: "Run unattended", text: "Never waits for you. Keys, system files and Ensemble's code stay off limits.", icon: AgentIcon },
];

const TOOL_ICON: Record<ToolKind, LucideIcon | typeof EnsembleIcon> = {
  command: SquareTerminal,
  edit: FilePen,
  read: FileSearch,
  search: Search,
  web: Globe,
  ensemble: EnsembleIcon,
  apps: Plug,
  ask: MessageCircleQuestion,
  plan: ListTodo,
  agent: Users,
  think: Brain,
  other: Wrench,
};

const SUGGESTIONS = ["Explain how this repository is organised", "Find a failing test and fix it", "Write a page about what changed today"];

const MAX_MESSAGE = 8000;
const POLL_MS = 1500;

/** The seconds a live turn has run, ticking while it runs. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export type AgentViewProps = {
  /** The folder the IDE has open: the agent works here. */
  folder: string;
  folderName: string;
  /** The computer's name, for what the composer says when it cannot send. */
  placeName: string;
  /** A paired computer, or null for this one. */
  deviceId: string | null;
  /** The computer (and this browser) can be reached now. */
  online: boolean;
  viewOnly: boolean;
  /** Opens a file of the folder in the IDE's editor. */
  onOpenFile: (path: string) => void;
};

export function AgentView({ folder, folderName, placeName, deviceId, online, viewOnly, onOpenFile }: AgentViewProps) {
  const client = useQueryClient();
  const toast = useToast();
  const place = deviceId ?? "local";
  const threads = useQuery({ queryKey: ["code-threads", place, folder], queryFn: () => api.codeThreads(folder, deviceId ?? undefined), staleTime: 10_000 });
  const [chosen, setChosen] = usePersistentState<Record<string, string | null>>("ensemble.code.threads", {});
  const key = `${place}:${folder}`;
  const listed = threads.data?.threads;
  // The thread last open for this folder, else the newest; null starts a new one.
  const selected = useMemo(() => {
    const saved = chosen[key];
    if (saved === null) return null;
    if (saved && (!listed || listed.some((row) => row.id === saved))) return saved;
    return listed?.[0]?.id ?? null;
  }, [chosen, key, listed]);
  const select = useCallback((id: string | null) => setChosen((current) => ({ ...current, [key]: id })), [key, setChosen]);

  const thread = useQuery({
    queryKey: ["code-thread", selected],
    queryFn: () => api.codeThread(selected!),
    enabled: Boolean(selected),
    refetchInterval: (query) => (query.state.data?.turns.some((turn) => isLive(turn.status)) ? POLL_MS : false),
  });
  const turns = useMemo(() => (selected ? (thread.data?.turns ?? []) : []), [selected, thread.data]);
  const live = turns.find((turn) => isLive(turn.status)) ?? null;
  const last = turns[turns.length - 1] ?? null;
  const [sending, setSending] = useState<string | null>(null);

  // Questions wait on Needs me; while a turn works they are read often, so its card shows here at once.
  const pending = usePendingDecisions();
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void client.invalidateQueries({ queryKey: ["decisions"] }), 3000);
    return () => window.clearInterval(timer);
  }, [live, client]);
  const asks = useMemo(() => {
    const ids = new Set(turns.map((turn) => turn.id));
    return pending.decisions.filter((row) => (row.detail.jobId && ids.has(row.detail.jobId)) || (selected && row.detail.taskId === selected));
  }, [pending.decisions, turns, selected]);

  // A finished turn changed the folder: the IDE's lists and the source control panel read it again.
  const lastStatus = last?.status;
  useEffect(() => {
    if (!lastStatus || isLive(lastStatus)) return;
    void client.invalidateQueries({ queryKey: ["code-threads", place, folder] });
    void client.invalidateQueries({ queryKey: ["scm"] });
  }, [lastStatus, client, place, folder]);

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const contentKey = `${turns.length}:${last?.status}:${last?.toolCalls}:${last?.progress}:${sending ?? ""}:${asks.length}`;
  useEffect(() => {
    const box = scroller.current;
    if (box && pinned.current) box.scrollTop = box.scrollHeight;
  }, [contentKey, selected]);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: (result) => {
      select(null);
      void client.invalidateQueries({ queryKey: ["code-threads", place, folder] });
      toast("Thread moved to Trash.", {
        action: result?.undoEntryId
          ? { label: "Undo", run: () => void api.undo(result.undoEntryId ?? undefined).then(() => client.invalidateQueries({ queryKey: ["code-threads", place, folder] })).catch((error: Error) => toast(error.message, { tone: "error" })) }
          : undefined,
      });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.patchTask(id, { title }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["code-threads", place, folder] });
      void client.invalidateQueries({ queryKey: ["code-thread", selected] });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });

  const current = listed?.find((row) => row.id === selected) ?? null;
  const title = selected ? (thread.data?.thread.title ?? current?.title ?? "Thread") : "New thread";

  return (
    <div className="agent-view flex min-h-0 min-w-0 flex-1 flex-col" data-testid="agent-view">
      <ThreadBar
        title={title}
        threads={listed ?? []}
        loading={threads.isLoading}
        selected={selected}
        onSelect={select}
        onNew={() => select(null)}
        onRename={selected && !viewOnly ? (next) => rename.mutate({ id: selected, title: next }) : null}
        onDelete={selected && !viewOnly && !live ? () => remove.mutate(selected) : null}
      />
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const box = event.currentTarget;
          pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 96;
        }}
      >
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-4 pb-6 pt-5 sm:px-6">
          {thread.error ? (
            <div className="agent-alert" role="alert">
              <CircleAlert size={14} className="shrink-0 text-danger" />
              <span className="min-w-0 flex-1">{(thread.error as Error).message}</span>
              <button type="button" className="btn-ghost text-[12px]" onClick={() => void thread.refetch()}>Retry</button>
            </div>
          ) : null}
          {!turns.length && !sending ? (
            selected && thread.isLoading ? (
              <div className="flex justify-center py-16"><Spinner size={16} /></div>
            ) : (
              <EmptyThread folderName={folderName} placeName={placeName} />
            )
          ) : null}
          {turns.map((turn) => (
            <Turn key={turn.id} turn={turn} folder={folder} deviceId={deviceId} asks={asks.filter((row) => row.detail.jobId === turn.id || (isLive(turn.status) && !row.detail.jobId))} onOpenFile={onOpenFile} />
          ))}
          {sending ? <UserMessage text={sending} pending /> : null}
        </div>
      </div>
      <Composer
        folder={folder}
        deviceId={deviceId}
        placeName={placeName}
        online={online}
        viewOnly={viewOnly}
        live={live}
        sending={sending !== null}
        onSend={async (text, input) => {
          setSending(text);
          pinned.current = true;
          try {
            let id = selected;
            if (!id) {
              const made = await api.createCodeThread({ folder, ...(deviceId ? { deviceId } : {}), title: threadTitle(text) });
              id = made.thread.id;
              client.setQueryData<{ threads: CodeThread[] }>(["code-threads", place, folder], (old) => ({ threads: [made.thread, ...(old?.threads ?? [])] }));
              select(id);
            }
            const previous = (id === selected ? last : null)?.id;
            await api.assign({ ...input, taskId: id, ...(previous ? { continueFromJobId: previous } : {}) });
            await Promise.all([client.invalidateQueries({ queryKey: ["code-thread", id] }), client.invalidateQueries({ queryKey: ["code-threads", place, folder] })]);
            return true;
          } catch (error) {
            toast((error as Error).message, { tone: "error" });
            return false;
          } finally {
            setSending(null);
          }
        }}
        onStop={async () => {
          if (!live) return;
          await api.stopJob(live.id).catch((error: Error) => toast(error.message, { tone: "error" }));
          void client.invalidateQueries({ queryKey: ["code-thread", selected] });
        }}
        onSuggest={!turns.length ? SUGGESTIONS : null}
      />
    </div>
  );
}

function ThreadBar({
  title,
  threads,
  loading,
  selected,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  title: string;
  threads: CodeThread[];
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: ((title: string) => void) | null;
  onDelete: (() => void) | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  useEffect(() => setDraft(title), [title]);
  const save = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) onRename?.(next.slice(0, 200));
  };
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-sidebar px-2 text-[12.5px]" data-testid="agent-threadbar">
      <AgentIcon size={14} className="mx-1 shrink-0 text-muted" aria-hidden />
      {editing ? (
        <input
          autoFocus
          value={draft}
          maxLength={200}
          aria-label="Thread name"
          className="field h-7 min-w-0 max-w-[420px] flex-1 px-2 text-[12.5px]"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
            else if (event.key === "Escape") {
              setDraft(title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="min-w-0 truncate font-medium" title={title}>{title}</span>
      )}
      <div className="flex-1" />
      <Popover
        width={340}
        maxHeight={420}
        align="right"
        trigger={(open, toggle) => (
          <button type="button" className="agent-chip" aria-haspopup="menu" aria-expanded={open} onClick={toggle} title="Threads in this folder">
            <History size={13} aria-hidden /> Threads{threads.length ? <span className="tabular-nums text-faint">{threads.length}</span> : null}
          </button>
        )}
      >
        {(close) => (
          <div className="py-1" role="menu" aria-label="Threads in this folder">
            {loading ? <div className="flex justify-center py-3"><Spinner size={14} /></div> : null}
            {!loading && !threads.length ? <p className="px-3 py-2 text-[12.5px] text-muted">No threads in this folder yet.</p> : null}
            {threads.map((row) => (
              <button
                key={row.id}
                type="button"
                role="menuitemradio"
                aria-checked={row.id === selected}
                className={cx("flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover", row.id === selected && "bg-hover")}
                onClick={() => {
                  onSelect(row.id);
                  close();
                }}
              >
                {row.last?.engine && isCodeEngine(row.last.engine) ? <ProviderLogo id={row.last.engine} size={13} /> : <AgentIcon size={13} className="text-muted" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{row.title}</span>
                  <span className="block truncate text-[11px] text-faint">
                    {relative(row.updatedAt)} · {row.turns} {row.turns === 1 ? "message" : "messages"}
                  </span>
                </span>
                {row.last && isLive(row.last.status) ? <Spinner size={12} /> : row.id === selected ? <Check size={13} className="shrink-0 text-accent" aria-hidden /> : null}
              </button>
            ))}
          </div>
        )}
      </Popover>
      <button type="button" className="agent-chip" onClick={onNew} title="Start a new thread in this folder" disabled={!selected}>
        <Plus size={13} aria-hidden /> New
      </button>
      {onRename || onDelete ? (
        <Popover
          width={180}
          align="right"
          trigger={(open, toggle) => (
            <button type="button" className="icon-btn h-7 w-7" aria-haspopup="menu" aria-expanded={open} aria-label="Thread actions" title="Thread actions" onClick={toggle}>
              <MoreHorizontal size={14} />
            </button>
          )}
        >
          {(close) => (
            <div className="py-1" role="menu">
              {onRename ? (
                <MenuItem onClick={() => { close(); setEditing(true); }}>
                  <Pencil size={13} /> Rename
                </MenuItem>
              ) : null}
              {onDelete ? (
                <MenuItem onClick={() => { close(); onDelete(); }}>
                  <Trash2 size={13} /> Delete thread
                </MenuItem>
              ) : null}
            </div>
          )}
        </Popover>
      ) : null}
    </div>
  );
}

/** "This computer" reads as "this computer" inside a sentence; a computer's own name stays as it is. */
const inSentence = (place: string) => (/^This /.test(place) ? place.toLowerCase() : place);

function EmptyThread({ folderName, placeName }: { folderName: string; placeName: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-14 text-center" data-testid="agent-empty">
      <AgentIcon size={30} className="text-faint" aria-hidden />
      <h2 className="text-[17px] font-semibold">Code with your agent in {folderName}</h2>
      <p className="max-w-[460px] text-[13px] text-muted">
        It edits this folder and can make pages, boards, diagrams and plots in Ensemble.{" "}
        <InfoTip
          label="About the agent"
          text={`Each message runs your own coding agent on ${inSentence(placeName)}, with its own sign-in, under the mode you pick below and your default run profile. Its questions also wait in Needs me. Review and accept its changes in the editor.`}
        />
      </p>
    </div>
  );
}

const UserMessage = memo(function UserMessage({ text, pending = false }: { text: string; pending?: boolean }) {
  return (
    <div className="flex justify-end" data-testid="agent-user-message">
      <div className={cx("agent-user max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2 text-[13.5px]", pending && "opacity-70")}>{text}</div>
    </div>
  );
});

function Turn({ turn, folder, deviceId, asks, onOpenFile }: { turn: CodeTurn; folder: string; deviceId: string | null; asks: AgentDecisionRecord[]; onOpenFile: (path: string) => void }) {
  const live = isLive(turn.status);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? live;
  const run = useQuery({
    queryKey: ["run", turn.runId],
    queryFn: () => api.run(turn.runId!),
    enabled: Boolean(turn.runId) && expanded,
    refetchInterval: live ? POLL_MS : false,
    staleTime: live ? 0 : Number.POSITIVE_INFINITY,
  });
  const now = useNow(live);
  const entries = useMemo(() => (run.data ? traceEntries(run.data.run.steps, run.data.run.startedAt, run.data.run.endedAt, now) : []), [run.data, now]);
  const reply = live ? liveReply(entries) : (turn.summary ?? "");
  const rows = useMemo(() => workRows(entries, folder, reply), [entries, folder, reply]);
  const took = elapsed(turnMs(turn, now));
  const failed = turn.status === "failed" || turn.status === "blocked" || turn.status === "interrupted";
  const reviewId = deviceId ? (turn.deviceReviewId ?? null) : turn.reviewId;
  const reviewHref = (path?: string) => (reviewId ? `/code/review?${new URLSearchParams({ ...(deviceId ? { device: deviceId } : {}), review: reviewId, ...(path ? { file: path } : {}), view: "editor" }).toString()}` : null);
  const waiting = turn.status === "queued" || turn.status === "claimed";
  return (
    <article className="flex flex-col gap-3" data-testid="agent-turn" aria-busy={live}>
      <UserMessage text={turn.instructions ?? ""} />
      <div className="flex flex-col gap-2">
        <button type="button" className="agent-work-toggle" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
          <ChevronRight size={13} className={cx("shrink-0 transition-transform", expanded && "rotate-90")} aria-hidden />
          {live ? <Spinner size={12} /> : null}
          <span className="min-w-0 truncate">
            {waiting
              ? turn.waitingFor || (turn.status === "claimed" ? "Starting on the computer" : "Waiting to start")
              : live
                ? `${turn.status === "waiting_approval" ? "Waiting for you" : turn.progress || "Working"} · ${took}`
                : `Worked for ${took}${turn.toolCalls ? ` · ${turn.toolCalls} tool ${turn.toolCalls === 1 ? "call" : "calls"}` : ""}`}
          </span>
        </button>
        {expanded ? (
          <div className="agent-work" data-testid="agent-work">
            {run.isLoading && turn.runId ? <div className="py-1 pl-6"><Spinner size={12} /></div> : null}
            {!rows.length && !run.isLoading ? <p className="pl-6 text-[12px] text-faint">{live ? "Nothing yet." : "No tool calls."}</p> : null}
            {rows.map((row) => <WorkLine key={row.id} row={row} onOpenFile={onOpenFile} />)}
          </div>
        ) : null}
      </div>
      {asks.map((decision) => (
        <div key={decision.id} className="agent-ask" data-testid="agent-ask">
          <DecisionCard decision={decision} />
        </div>
      ))}
      {reply ? (
        <div className="agent-reply text-[13.5px]" data-testid="agent-reply">
          <MarkdownText text={reply} />
        </div>
      ) : null}
      {failed ? (
        <div className="agent-alert" role="alert">
          <CircleAlert size={14} className="mt-0.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{turn.error || "The agent stopped before it finished."}</span>
        </div>
      ) : null}
      {turn.status === "cancelled" ? <p className="text-[12.5px] text-muted">Stopped.</p> : null}
      {turn.files?.length ? <TurnFiles files={turn.files} href={reviewHref} /> : null}
      {!live ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-faint">
          {turn.provider && isCodeEngine(turn.provider) ? <ProviderLogo id={turn.provider} size={12} /> : null}
          <span>{turn.modelUsed || (turn.model && turn.model !== "default" ? turn.model : "Agent default")}</span>
          {turn.runId ? (
            <>
              <span aria-hidden>·</span>
              <Link href={`/runs?run=${turn.runId}`} className="hover:text-ink hover:underline">Run</Link>
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function WorkLine({ row, onOpenFile }: { row: WorkRow; onOpenFile: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  if (row.type === "thinking") {
    return (
      <div className="agent-work-row text-faint">
        <Brain size={13} className="mt-0.5 shrink-0" aria-hidden />
        <button type="button" className={cx("min-w-0 flex-1 text-left italic", !open && "truncate")} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <span className="whitespace-pre-wrap break-words">{row.text}</span> : row.text.split("\n")[0]}
        </button>
      </div>
    );
  }
  if (row.type === "message") {
    return (
      <div className="agent-work-row text-muted">
        <span className="w-[13px] shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 text-[12.5px]"><MarkdownText text={row.text} /></div>
      </div>
    );
  }
  const Icon = TOOL_ICON[row.kind];
  const detail = [row.args && row.args !== "{}" ? `Input\n${row.args}` : "", row.output ? `Output\n${row.output}` : ""].filter(Boolean).join("\n\n");
  return (
    <div className="flex flex-col">
      <div className={cx("agent-work-row", row.ok === false && "text-danger")}>
        <Icon size={13} className={cx("mt-0.5 shrink-0", row.ok === false ? "text-danger" : "text-faint")} aria-hidden />
        <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => setOpen(!open)} aria-expanded={open} title={row.summary}>
          {row.summary}
        </button>
        {row.path ? (
          <button type="button" className="agent-file-chip" onClick={() => onOpenFile(row.path!)} title={`Open ${row.path} in the editor`}>
            <FileIcon name={row.path} size={12} /> <span className="truncate">{row.path.split("/").pop()}</span>
          </button>
        ) : null}
        {row.running ? <Spinner size={11} /> : row.ms != null ? <span className="shrink-0 tabular-nums text-faint">{elapsed(row.ms)}</span> : null}
      </div>
      {open && detail ? <pre className="agent-work-detail">{detail}</pre> : null}
    </div>
  );
}

function TurnFiles({ files, href }: { files: Array<{ path: string; added: number; removed: number }>; href: (path?: string) => string | null }) {
  const added = files.reduce((sum, row) => sum + (row.added || 0), 0);
  const removed = files.reduce((sum, row) => sum + (row.removed || 0), 0);
  const all = href();
  return (
    <div className="agent-files" data-testid="agent-files">
      <div className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
        <span className="font-medium">
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <DiffStat added={added} removed={removed} />
        <div className="flex-1" />
        {all ? (
          <Link href={all} className="btn h-7 px-2.5 text-[12px]" title="Accept or reject these changes in the editor">
            Review changes
          </Link>
        ) : null}
      </div>
      <ul className="border-t border-line py-1">
        {files.slice(0, 50).map((file) => {
          const to = href(file.path);
          const body = (
            <>
              <FileIcon name={file.path} size={13} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.path}</span>
              <DiffStat added={file.added} removed={file.removed} />
            </>
          );
          return (
            <li key={file.path}>
              {to ? (
                <Link href={to} className="flex items-center gap-2 px-3 py-1 hover:bg-hover">{body}</Link>
              ) : (
                <div className="flex items-center gap-2 px-3 py-1">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] tabular-nums" aria-label={`${added} added, ${removed} removed`}>
      <span className="text-ok" aria-hidden>+{compactCount(added)}</span>
      <span className="text-danger" aria-hidden>−{compactCount(removed)}</span>
    </span>
  );
}

function Composer({
  folder,
  deviceId,
  placeName,
  online,
  viewOnly,
  live,
  sending,
  onSend,
  onStop,
  onSuggest,
}: {
  folder: string;
  deviceId: string | null;
  placeName: string;
  online: boolean;
  viewOnly: boolean;
  live: CodeTurn | null;
  sending: boolean;
  onSend: (text: string, input: Omit<AssignInput, "taskId">) => Promise<boolean>;
  onStop: () => Promise<void>;
  onSuggest: string[] | null;
}) {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const subscriptions = useQuery({ queryKey: ["subscriptions"], queryFn: api.subscriptions, staleTime: 30_000 });
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, enabled: Boolean(deviceId), staleTime: 30_000 });
  const device = deviceId ? devices.data?.devices.find((row) => row.id === deviceId) ?? null : null;
  const computer = useMemo(() => subscriptions.data?.computers?.find((row) => (deviceId ? row.id === deviceId : row.local)) ?? null, [subscriptions.data, deviceId]);
  const agents = useMemo(() => agentOptions({ computer, capabilities: device?.capabilities, plans: true, keys: false }), [computer, device?.capabilities]);
  const profile = useMemo(() => {
    const data = settings.data?.settings;
    return data ? defaultProfile(data.runProfiles, data.defaultRunProfileId, quickProfile(data.orchestration)) : null;
  }, [settings.data]);
  const [saved, setSaved] = usePersistentState<AgentChoice | null>("ensemble.code.agent", null);
  const [savedMode, setSavedMode] = usePersistentState<Mode | null>("ensemble.code.agentMode", null);
  const fallback = useMemo<AgentChoice | null>(() => {
    const fromProfile = profile ? profileAgent(profile) : null;
    if (fromProfile && isCodeEngine(fromProfile.provider) && agents.some((row) => row.id === fromProfile.provider && row.ready)) return fromProfile;
    const ready = agents.find((row) => row.ready);
    return ready ? { provider: ready.id, model: "", effort: "default" } : null;
  }, [profile, agents]);
  const choice = saved && isCodeEngine(saved.provider) ? saved : fallback;
  const agent = choice ? agents.find((row) => row.id === choice.provider) ?? null : null;
  const pickerModel = choice ? modelOf(agents, choice) : null;
  const mode: Mode = savedMode ?? profile?.mode ?? "review";
  const ModeIcon = MODES.find((row) => row.id === mode)!.icon;

  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(box, text, 10);

  const where = inSentence(placeName);
  const blocker = viewOnly
    ? "View only: the space's owner sends messages here."
    : !agents.some((row) => row.ready) && subscriptions.data
      ? `No coding agent is signed in on ${where}.`
      : agent && !agent.ready
        ? `${agent.label} is ${agent.note} on ${where}.`
        : null;
  // An offline computer keeps the message queued until it is back: a note, not a stop.
  const note = !blocker && !online ? `${placeName} is offline. Your message waits until it is back.` : null;
  const busy = Boolean(live) || sending;
  const canSend = !blocker && !busy && Boolean(choice) && Boolean(profile) && text.trim().length > 0 && text.length <= MAX_MESSAGE;

  const send = async () => {
    if (!canSend || !choice || !profile) return;
    const engine = choice.provider as CodeEngine;
    const view = engineModel(computerAgent(engine, subscriptions.data, deviceId, device?.capabilities), choice.model);
    const message = text.trim();
    const input: Omit<AssignInput, "taskId"> = {
      kind: "code",
      ...engineAssign(engine, { model: choice.model, effort: choice.effort, context: choice.context, fast: choice.fast }, view),
      instructions: message,
      folder,
      ...(deviceId ? { deviceId, useCredentials: false } : { useCredentials: profile.useCredentials }),
      chat: true,
      surface: "code",
      branchMode: "as-is",
      markDone: false,
      mode,
      sandbox: profile.sandbox,
      network: profile.network,
      delivery: profile.delivery,
      askBeforePublish: profile.askBeforePublish,
      ...(profile.maxMinutes ? { maxMinutes: profile.maxMinutes } : {}),
      ...(profile.maxToolCalls ? { maxToolCalls: profile.maxToolCalls } : {}),
      ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
      ...(profile.secrets?.length ? { secrets: profile.secrets } : {}),
    };
    setText("");
    const ok = await onSend(message, input);
    if (!ok) setText((current) => current || message);
    box.current?.focus();
  };

  return (
    <div className="shrink-0 px-3 pb-3 pt-1 sm:px-6" data-testid="agent-composer">
      <div className="mx-auto w-full max-w-[860px]">
        {onSuggest && !viewOnly ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {onSuggest.map((suggestion) => (
              <button key={suggestion} type="button" className="agent-suggestion" onClick={() => { setText(suggestion); box.current?.focus(); }}>
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
        <div className={cx("agent-composer compound-field", blocker && "opacity-80")}>
          <textarea
            ref={box}
            rows={1}
            value={text}
            disabled={viewOnly}
            maxLength={MAX_MESSAGE}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={viewOnly ? "View only" : `Ask ${agent?.label ?? "your agent"} to change the code, or to make a page, board or plot`}
            aria-label="Message to the agent"
            className="block w-full resize-none bg-transparent px-3 pt-2.5 text-[13.5px] leading-6 outline-none placeholder:text-faint"
          />
          <div className="flex items-center gap-1 px-1.5 pb-1.5 pt-1">
            <AgentPicker value={choice} onChange={(next) => setSaved(next)} agents={agents} label="Agent and model" compact />
            {choice ? <TuningPicker value={choice} model={pickerModel} onChange={(next) => setSaved(next)} label="Thinking and context" compact /> : null}
            <Popover
              width={300}
              trigger={(open, toggle) => (
                <button type="button" className="agent-chip" aria-haspopup="menu" aria-expanded={open} onClick={toggle} title="How the agent may act">
                  <ModeIcon size={12} aria-hidden /> <span className="max-md:hidden">{MODES.find((row) => row.id === mode)!.title}</span>
                </button>
              )}
            >
              {(close) => (
                <div className="py-1" role="menu" aria-label="How the agent may act">
                  {MODES.map((row) => {
                    const Icon = row.icon;
                    return (
                      <button key={row.id} type="button" role="menuitemradio" aria-checked={mode === row.id} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-hover" onClick={() => { setSavedMode(row.id); close(); }}>
                        <Icon size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px] font-medium">{row.title}</span>
                          <span className="block text-[11.5px] text-faint">{row.text}</span>
                        </span>
                        {mode === row.id ? <Check size={13} className="mt-0.5 shrink-0 text-accent" aria-hidden /> : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </Popover>
            <div className="flex-1" />
            {live ? (
              <button type="button" className="agent-send" onClick={() => void onStop()} aria-label="Stop the agent" title="Stop">
                <Square size={12} className="fill-current" aria-hidden />
              </button>
            ) : (
              <button type="button" className="agent-send" onClick={() => void send()} disabled={!canSend} aria-label="Send" title="Send (Enter)">
                {sending ? <Spinner size={13} /> : <ArrowUp size={15} aria-hidden />}
              </button>
            )}
          </div>
        </div>
        {blocker || note ? (
          <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted" role="status">
            <CircleAlert size={12} className="shrink-0" aria-hidden />
            {blocker ?? note}
            {blocker && !viewOnly ? <Link href="/settings?tab=assistant#models" className="text-accent hover:underline">Settings › Models</Link> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
