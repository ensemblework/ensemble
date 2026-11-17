"use client";

/**
 * The Code tab's agentic view (docs/16 §9): a thread with the person's own coding agent, in a folder on
 * one of their computers, or in no folder (a new folder in that computer's Ensemble workspace) for work
 * that needs no repository. Each message is a chat run (`POST /api/agent/assign` with `chat` and
 * `surface: "code"`) that continues the agent's own session, so every run rule, Needs me and the run's
 * review apply. The thread shows each turn's work, its questions (the Needs me card itself), the reply,
 * the files it changed (which open in the editor's review to accept or reject), and what to do with the
 * reply without a model: copy it, keep it on a page, add it to a task it mentioned, mark that task done.
 *
 * The timeline's shape (a collapsible work log per turn, tool rows by kind, the turn's changed files
 * with their line counts, a place bar over the composer) follows T3 Code's thread and Cursor's agent
 * (https://github.com/pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.), drawn with
 * Ensemble's own components.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isCodeEngine, type CodeEngine, type PageMention } from "@ensemble/shared-types";
import {
  ArrowUp,
  Brain,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  Eye,
  FilePen,
  FileSearch,
  FolderGit2,
  Globe,
  Hand,
  House,
  Laptop,
  ListTodo,
  MessageCircleQuestion,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Pin,
  Plug,
  Search,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  Users,
  Wrench,
  GitBranch,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon, EnsembleIcon } from "@/components/agent-icon";
import { AgentPicker, TuningPicker, agentOptions, modelOf, type AgentChoice } from "@/components/agent/agent-picker";
import { ChatText } from "@/components/chat-text";
import { copyText } from "@/components/context-menu/builders";
import { openContextMenu } from "@/components/context-menu/menu-store";
import { ProviderLogo } from "@/components/connectors/provider-logo";
import { MarkdownText } from "@/components/markdown-text";
import { MentionTextarea } from "@/components/mentions/mention-field";
import { MentionPopover, useMentionMenu } from "@/components/mentions/mention-menu";
import { DecisionCard, usePendingDecisions } from "@/components/needs-me/editor-decisions";
import { useToast } from "@/components/toast";
import { InfoTip, MenuItem, Popover, Spinner, cx } from "@/components/ui";
import { api, type AgentDecisionRecord, type AssignInput, type CodeThread, type CodeThreadPlace, type CodeTurn } from "@/lib/api";
import { useAutoGrow } from "@/lib/auto-grow";
import { compactCount, elapsed, folderName, isLive, linkedTasks, liveReply, splitMentions, threadTitle, turnMs, withMentions, workRows, type ToolKind, type WorkRow } from "@/lib/code-agent";
import { computerAgent, engineAssign, engineModel } from "@/lib/engine-models";
import { usePersistentState } from "@/lib/prefs";
import { defaultProfile, profileAgent, quickProfile } from "@/lib/run-profiles";
import { traceEntries } from "@/lib/run-trace";
import { KeepPicker, refreshThreads, threadMenu, turnMenu, useCodeThreads, useDeleteThread, useRenameThread } from "./agent-actions";
import type { ThreadPlace } from "./agent-sessions";
import { FileIcon } from "./file-icon";
import { useLinkNavigate } from "./quick-open";

type Mode = "ask" | "review" | "unattended";

const MODES: Array<{ id: Mode; title: string; text: string; icon: LucideIcon | typeof AgentIcon }> = [
  { id: "ask", title: "Ask", text: "Asks before commands and edits. Reading goes ahead.", icon: Hand },
  { id: "review", title: "Review only", text: "Works freely in its folder. Asks you decisions.", icon: Eye },
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

const FOLDER_SUGGESTIONS = ["Explain how this repository is organised", "Find a failing test and fix it", "Write a page about what changed today"];
const NO_FOLDER_SUGGESTIONS = ["Make a page that plans next week", "Draw a diagram of how our services talk", "Plot last month's tasks by status"];

const MAX_MESSAGE = 8000;
const POLL_MS = 1500;

/** A computer a new thread may run on. */
export type PlaceChoice = { deviceId: string | null; name: string; online: boolean };
/** A folder a new thread may work in, on one computer. */
export type FolderChoice = { deviceId: string | null; path: string; name: string; branch: string | null };

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

/** "This computer" reads as "this computer" inside a sentence; a computer's own name stays as it is. */
const inSentence = (place: string) => (/^This /.test(place) ? place.toLowerCase() : place);

const samePlace = (a: ThreadPlace, b: ThreadPlace) => (a.deviceId ?? null) === (b.deviceId ?? null) && (a.folder ?? null) === (b.folder ?? null);

export type AgentViewProps = {
  /** The thread shown, or null for a new one. */
  threadId: string | null;
  onThread: (id: string | null) => void;
  /** Where a new thread works: the IDE's folder, or what was picked on Code's home. */
  draft: ThreadPlace;
  onDraft: ((place: ThreadPlace) => void) | null;
  /** Computers a new thread may run on (the IDE: its own). */
  places: PlaceChoice[];
  /** Folders a new thread may work in, per computer (the IDE: its own). */
  folders: FolderChoice[];
  /** The computers are still being read: no "pair a computer" yet. */
  placesLoading?: boolean;
  viewOnly: boolean;
  /** Opens a file of a thread's folder in the editor. */
  onOpenFile: (place: ThreadPlace, path: string) => void;
  /** Opens a thread's folder in the editor; null where the editor already shows it. */
  onOpenFolder: ((place: { deviceId: string | null; folder: string }) => void) | null;
};

export function AgentView({ threadId, onThread, draft, onDraft, places, folders, placesLoading = false, viewOnly, onOpenFile, onOpenFolder }: AgentViewProps) {
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useLinkNavigate();
  const list = useCodeThreads();
  const listed = list.data?.threads.find((row) => row.id === threadId) ?? null;
  const thread = useQuery({
    queryKey: ["code-thread", threadId],
    queryFn: () => api.codeThread(threadId!),
    enabled: Boolean(threadId),
    refetchInterval: (query) => (query.state.data?.turns.some((turn) => isLive(turn.status)) ? POLL_MS : false),
  });
  const turns = useMemo(() => (threadId ? (thread.data?.turns ?? []) : []), [threadId, thread.data]);
  const live = turns.find((turn) => isLive(turn.status)) ?? null;
  const last = turns[turns.length - 1] ?? null;
  const place: ThreadPlace = threadId ? (thread.data?.thread.place ?? listed?.place ?? draft) : draft;
  const placeInfo: CodeThreadPlace = threadId ? (thread.data?.thread.place ?? listed?.place ?? { ...draft, deviceName: null, workdir: null }) : { ...draft, deviceName: null, workdir: null };
  const computer = places.find((row) => (row.deviceId ?? null) === (place.deviceId ?? null)) ?? null;
  const tasks = useMemo(() => linkedTasks(turns.map((turn) => turn.instructions ?? "")), [turns]);
  const [sending, setSending] = useState<string | null>(null);
  const [inject, setInject] = useState<{ text: string; mentions: PageMention[]; nonce: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const rename = useRenameThread();
  const remove = useDeleteThread(() => onThread(null));
  const [pinned, setPinned] = usePersistentState<string[]>("ensemble.code.pinned", []);

  // Questions wait on Needs me; while a turn works they are read often, so its card shows here at once.
  const pending = usePendingDecisions();
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void client.invalidateQueries({ queryKey: ["decisions"] }), 3000);
    return () => window.clearInterval(timer);
  }, [live, client]);
  const asks = useMemo(() => {
    const ids = new Set(turns.map((turn) => turn.id));
    return pending.decisions.filter((row) => (row.detail.jobId && ids.has(row.detail.jobId)) || (threadId && row.detail.taskId === threadId));
  }, [pending.decisions, turns, threadId]);

  // A finished turn changed the folder: the sessions list and source control read it again.
  const lastStatus = last?.status;
  useEffect(() => {
    if (!lastStatus || isLive(lastStatus)) return;
    refreshThreads(client);
    void client.invalidateQueries({ queryKey: ["scm"] });
  }, [lastStatus, client]);

  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToEnd = useRef(true);
  const contentKey = `${turns.length}:${last?.status}:${last?.toolCalls}:${last?.progress}:${sending ?? ""}:${asks.length}`;
  useEffect(() => {
    const box = scroller.current;
    if (box && pinnedToEnd.current) box.scrollTop = box.scrollHeight;
  }, [contentKey, threadId]);

  const title = threadId ? (thread.data?.thread.title ?? listed?.title ?? "Thread") : "New thread";
  const threadRow: CodeThread | null = threadId ? (listed ?? (thread.data ? { id: threadId, title, createdAt: "", updatedAt: "", turns: turns.length, last: last ? { id: last.id, status: last.status, engine: last.provider, model: last.model } : null, place: placeInfo } : null)) : null;
  const folderOpen = place.folder && onOpenFolder ? () => onOpenFolder({ deviceId: place.deviceId, folder: place.folder! }) : null;
  const go = navigate.go;

  return (
    <div className="agent-view flex min-h-0 min-w-0 flex-1 flex-col" data-testid="agent-view">
      <div
        className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-sidebar px-2 text-[12.5px]"
        data-testid="agent-threadbar"
        onContextMenu={(event) => {
          if (!threadRow) return;
          openContextMenu(event, () =>
            threadMenu(threadRow, {
              open: () => undefined,
              rename: viewOnly ? null : () => setRenaming(true),
              pinned: pinned.includes(threadRow.id),
              togglePin: () => setPinned((rows) => (rows.includes(threadRow.id) ? rows.filter((row) => row !== threadRow.id) : [threadRow.id, ...rows])),
              openFolder: folderOpen,
              newHere: () => onThread(null),
              remove: () => remove.mutate(threadRow.id),
              stop: live ? () => void api.stopJob(live.id).finally(() => refreshThreads(client, threadId)) : null,
              viewOnly,
            }),
          );
        }}
      >
        <AgentIcon size={14} className="mx-1 shrink-0 text-muted" aria-hidden />
        {renaming && threadId ? (
          <TitleField
            title={title}
            onDone={(next) => {
              setRenaming(false);
              if (next && next !== title) rename.mutate({ id: threadId, title: next });
            }}
          />
        ) : (
          <button type="button" className="min-w-0 truncate text-left font-medium" title={threadId && !viewOnly ? "Double-click to rename" : title} onDoubleClick={() => threadId && !viewOnly && setRenaming(true)}>
            {title}
          </button>
        )}
        {pinned.includes(threadId ?? "") ? <Pin size={11} className="shrink-0 text-faint" aria-label="Pinned" /> : null}
        <div className="flex-1" />
        {folderOpen ? (
          <button type="button" className="agent-chip" onClick={folderOpen} title="Open this folder in the editor">
            <ExternalLink size={12} aria-hidden /> Editor
          </button>
        ) : null}
        {threadId && !viewOnly ? (
          <Popover
            width={220}
            align="right"
            trigger={(open, toggle) => (
              <button type="button" className="icon-btn h-7 w-7" aria-haspopup="menu" aria-expanded={open} aria-label="Thread actions" title="Thread actions" onClick={toggle}>
                <MoreHorizontal size={14} />
              </button>
            )}
          >
            {(close) => (
              <div className="py-1" role="menu">
                <MenuItem onClick={() => { close(); setRenaming(true); }}>
                  <Pencil size={13} /> Rename
                </MenuItem>
                <MenuItem onClick={() => { close(); setPinned((rows) => (rows.includes(threadId) ? rows.filter((row) => row !== threadId) : [threadId, ...rows])); }}>
                  <Pin size={13} /> {pinned.includes(threadId) ? "Unpin" : "Pin to the top"}
                </MenuItem>
                {!live ? (
                  <MenuItem onClick={() => { close(); remove.mutate(threadId); }}>
                    <Trash2 size={13} /> Delete thread
                  </MenuItem>
                ) : null}
              </div>
            )}
          </Popover>
        ) : null}
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const box = event.currentTarget;
          pinnedToEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 96;
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
            threadId && thread.isLoading ? (
              <div className="flex justify-center py-16"><Spinner size={16} /></div>
            ) : (
              <EmptyThread place={place} placeName={computer?.name ?? placeInfo.deviceName ?? "this computer"} />
            )
          ) : null}
          {turns.map((turn, index) => (
            <Turn
              key={turn.id}
              turn={turn}
              threadId={threadId!}
              title={title}
              place={place}
              tasks={tasks}
              viewOnly={viewOnly}
              asks={asks.filter((row) => row.detail.jobId === turn.id || (isLive(turn.status) && !row.detail.jobId))}
              onOpenFile={(path) => onOpenFile(place, path)}
              go={go}
              onQuote={(text) => setInject({ text: `${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`, mentions: [], nonce: Date.now() })}
              onAgain={(text, mentions) => setInject({ text, mentions, nonce: Date.now() })}
              suggestions={index === turns.length - 1 && !isLive(turn.status) && !viewOnly ? followUps(turn, tasks) : []}
              onSuggest={(text, mentions) => setInject({ text, mentions, nonce: Date.now() })}
            />
          ))}
          {sending ? <UserMessage text={sending} mentions={[]} pending /> : null}
        </div>
      </div>
      {navigate.link}
      <Composer
        threadId={threadId}
        place={place}
        placeInfo={placeInfo}
        draftable={!threadId && Boolean(onDraft)}
        onDraft={onDraft}
        places={places}
        folders={folders}
        placesLoading={placesLoading}
        viewOnly={viewOnly}
        live={live}
        sending={sending !== null}
        inject={inject}
        suggestions={!turns.length && !threadId ? (place.folder ? FOLDER_SUGGESTIONS : NO_FOLDER_SUGGESTIONS) : null}
        onSend={async (shown, input) => {
          setSending(shown);
          pinnedToEnd.current = true;
          let made: string | null = null;
          try {
            let id = threadId;
            if (!id) {
              const created = await api.createCodeThread({ folder: place.folder, ...(place.deviceId ? { deviceId: place.deviceId } : {}), title: threadTitle(shown) });
              id = made = created.thread.id;
              client.setQueryData<{ threads: CodeThread[] }>(["code-threads"], (old) => ({ threads: [created.thread, ...(old?.threads ?? [])] }));
            }
            const previous = id === threadId ? last?.id : undefined;
            await api.assign({ ...input, taskId: id, ...(previous ? { continueFromJobId: previous } : {}) });
            if (made) onThread(made);
            await client.invalidateQueries({ queryKey: ["code-thread", id] });
            refreshThreads(client);
            return true;
          } catch (error) {
            // A thread whose first message could not start is not kept.
            if (made) await api.deleteTask(made).catch(() => undefined);
            refreshThreads(client);
            toast((error as Error).message, { tone: "error" });
            return false;
          } finally {
            setSending(null);
          }
        }}
        onStop={async () => {
          if (!live) return;
          await api.stopJob(live.id).catch((error: Error) => toast(error.message, { tone: "error" }));
          refreshThreads(client, threadId);
        }}
      />
    </div>
  );
}

/** What the person may want next, as messages they can send (the agent does the work). */
function followUps(turn: CodeTurn, tasks: Array<{ id: string; label: string }>): Array<{ text: string; mentions: PageMention[] }> {
  if (turn.status !== "succeeded") return [];
  const rows: Array<{ text: string; mentions: PageMention[] }> = [];
  for (const task of tasks.slice(0, 2)) {
    const mention: PageMention = { kind: "task", id: task.id, label: task.label };
    rows.push({ text: `Write what changed on @task:${task.label} and move it on its board`, mentions: [mention] });
  }
  if (turn.files?.length) rows.push({ text: "Run the tests and fix what fails", mentions: [] });
  if (!tasks.length) rows.push({ text: "Make a task on my board for what is left to do", mentions: [] });
  return rows.slice(0, 3);
}

function TitleField({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const [draft, setDraft] = useState(title);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      autoFocus
      value={draft}
      maxLength={200}
      aria-label="Thread name"
      className="field h-7 min-w-0 max-w-[420px] flex-1 px-2 text-[12.5px]"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finish(draft.trim() || null)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(draft.trim() || null);
        else if (event.key === "Escape") finish(null);
      }}
    />
  );
}

function EmptyThread({ place, placeName }: { place: ThreadPlace; placeName: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-14 text-center" data-testid="agent-empty">
      <AgentIcon size={30} className="text-faint" aria-hidden />
      <h2 className="text-[17px] font-semibold">{place.folder ? `Code with your agent in ${folderName(place.folder)}` : "Work with your agent"}</h2>
      <p className="max-w-[460px] text-[13px] text-muted">
        {place.folder ? "It edits this folder and can make pages, boards, diagrams and plots in Ensemble." : "No folder needed: it can make pages, boards, diagrams and plots, and work in a new folder when it has to."}{" "}
        <InfoTip
          label="About the agent"
          text={`Each message runs your own coding agent on ${inSentence(placeName)}, with its own sign-in, under the mode you pick below and your default run profile. Type @ to point it at a task, a person, a file or a diagram. Its questions also wait in Needs me. Review and accept its changes in the editor.`}
        />
      </p>
    </div>
  );
}

const UserMessage = memo(function UserMessage({ text, mentions, pending = false }: { text: string; mentions: PageMention[]; pending?: boolean }) {
  return (
    <div className="flex justify-end" data-testid="agent-user-message">
      <div className={cx("agent-user max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2 text-[13.5px]", pending && "opacity-70")}>
        <ChatText text={text} mentions={mentions} />
      </div>
    </div>
  );
});

function Turn({
  turn,
  threadId,
  title,
  place,
  tasks,
  viewOnly,
  asks,
  onOpenFile,
  go,
  onQuote,
  onAgain,
  suggestions,
  onSuggest,
}: {
  turn: CodeTurn;
  threadId: string;
  title: string;
  place: ThreadPlace;
  tasks: Array<{ id: string; label: string }>;
  viewOnly: boolean;
  asks: AgentDecisionRecord[];
  onOpenFile: (path: string) => void;
  go: (href: string) => void;
  onQuote: (text: string) => void;
  onAgain: (text: string, mentions: PageMention[]) => void;
  suggestions: Array<{ text: string; mentions: PageMention[] }>;
  onSuggest: (text: string, mentions: PageMention[]) => void;
}) {
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
  const rows = useMemo(() => workRows(entries, place.folder ?? "", reply), [entries, place.folder, reply]);
  const asked = useMemo(() => splitMentions(turn.instructions ?? ""), [turn.instructions]);
  const took = elapsed(turnMs(turn, now));
  const failed = turn.status === "failed" || turn.status === "blocked" || turn.status === "interrupted";
  const reviewId = place.deviceId ? (turn.deviceReviewId ?? null) : turn.reviewId;
  const reviewHref = (path?: string) => (reviewId ? `/code/review?${new URLSearchParams({ ...(place.deviceId ? { device: place.deviceId } : {}), review: reviewId, ...(path ? { file: path } : {}), view: "editor" }).toString()}` : null);
  const waiting = turn.status === "queued" || turn.status === "claimed";
  const finished = !live && Boolean(reply.trim());
  return (
    <article
      className="flex flex-col gap-3"
      data-testid="agent-turn"
      aria-busy={live}
      onContextMenu={(event) =>
        openContextMenu(event, () =>
          turnMenu({
            reply: finished ? reply : "",
            message: asked.text,
            threadId,
            jobId: turn.id,
            title,
            tasks,
            runId: turn.runId ?? null,
            reviewHref: turn.files?.length ? reviewHref() : null,
            quote: () => onQuote(reply),
            again: live ? null : () => onAgain(asked.text, asked.mentions),
            viewOnly,
            go,
          }),
        )
      }
    >
      <UserMessage text={asked.text} mentions={asked.mentions} />
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
      {finished ? <ReplyActions turn={turn} threadId={threadId} title={title} reply={reply} tasks={tasks} viewOnly={viewOnly} /> : null}
      {suggestions.length ? (
        <div className="flex flex-wrap gap-1.5" data-testid="agent-followups">
          {suggestions.map((row) => (
            <button key={row.text} type="button" className="agent-suggestion" onClick={() => onSuggest(row.text, row.mentions)} title="Put this in the message box">
              <Sparkles size={11} className="mr-1 inline-block text-accent" aria-hidden />
              {row.text.replace(/@task:/g, "")}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/**
 * What to do with a finished reply without a model: copy it, keep it on a page (marked as the agent's,
 * with where it came from), add it to a task the thread mentioned, mark that task done.
 */
function ReplyActions({ turn, threadId, title, reply, tasks, viewOnly }: { turn: CodeTurn; threadId: string; title: string; reply: string; tasks: Array<{ id: string; label: string }>; viewOnly: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const keepToTask = useMutation({
    mutationFn: (taskId: string) => api.keepCodeTurn(threadId, { jobId: turn.id, taskId }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["code-thread", threadId] }),
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const markDone = useMutation({
    mutationFn: (task: { id: string; label: string }) => api.patchTask(task.id, { status: "done" }),
    onSuccess: (result, task) => {
      void client.invalidateQueries({ queryKey: ["tasks"] });
      toast(`${task.label} is done.`, {
        action: result.undoEntryId ? { label: "Undo", run: () => void api.undo(result.undoEntryId ?? undefined).then(() => client.invalidateQueries({ queryKey: ["tasks"] })) } : undefined,
      });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const kept = turn.saved ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="agent-reply-actions">
      <button
        type="button"
        className="agent-chip"
        onClick={() => {
          void copyText(reply).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        title="Copy the reply"
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />} {copied ? "Copied" : "Copy"}
      </button>
      {viewOnly ? null : (
        <Popover
          width={316}
          maxHeight={420}
          trigger={(open, toggle) => (
            <button type="button" className="agent-chip" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} title="Keep this reply on a page, marked as the agent's">
              <NotebookPen size={12} aria-hidden /> Keep on a page <ChevronDown size={11} aria-hidden />
            </button>
          )}
        >
          {(close) => <KeepPicker threadId={threadId} jobId={turn.id} title={title} tasks={tasks} onDone={close} />}
        </Popover>
      )}
      {!viewOnly
        ? tasks.slice(0, 2).map((task) => {
            const added = kept.some((row) => row.taskId === task.id);
            return (
              <span key={task.id} className="contents">
                {added ? null : (
                  <button type="button" className="agent-chip" disabled={keepToTask.isPending} onClick={() => keepToTask.mutate(task.id)} title={`Add the reply to the page of ${task.label}`}>
                    <NotebookPen size={12} aria-hidden /> <span className="max-w-[12rem] truncate">Add to {task.label}</span>
                  </button>
                )}
                <button type="button" className="agent-chip" disabled={markDone.isPending} onClick={() => markDone.mutate(task)} title={`Move ${task.label} to Done`}>
                  <CheckCheck size={12} aria-hidden /> <span className="max-w-[12rem] truncate">Mark {task.label} done</span>
                </button>
              </span>
            );
          })
        : null}
      {kept.map((row) => (
        <Link key={row.pageId} href={row.taskId ? `/tasks/${row.taskId}` : `/pages/${row.pageId}`} className="agent-kept" title="Open the page this reply was kept on">
          <Check size={11} aria-hidden /> <span className="max-w-[14rem] truncate">On {row.title}</span>
        </Link>
      ))}
    </div>
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

/**
 * Where a thread works, over the message box: the computer, the folder (or none) and its branch. A new
 * thread on Code's home picks them; a thread that has started keeps its own.
 */
function PlaceBar({ place, placeInfo, editable, onDraft, places, folders }: { place: ThreadPlace; placeInfo: CodeThreadPlace; editable: boolean; onDraft: ((place: ThreadPlace) => void) | null; places: PlaceChoice[]; folders: FolderChoice[] }) {
  const computer = places.find((row) => (row.deviceId ?? null) === (place.deviceId ?? null));
  const computerName = computer?.name ?? placeInfo.deviceName ?? "This computer";
  const here = folders.filter((row) => (row.deviceId ?? null) === (place.deviceId ?? null));
  const folder = place.folder ? (here.find((row) => row.path === place.folder) ?? null) : null;
  const folderLabel = place.folder ? (folder?.name ?? folderName(place.folder)) : "No folder";
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = here.filter((row) => !needle || row.name.toLowerCase().includes(needle) || row.path.toLowerCase().includes(needle)).slice(0, 60);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5 px-1.5 pt-1.5" data-testid="agent-placebar">
      {editable && onDraft && places.length > 1 ? (
        <Popover
          width={240}
          trigger={(open, toggle) => (
            <button type="button" className="agent-chip" aria-haspopup="menu" aria-expanded={open} onClick={toggle} title="The computer the agent runs on">
              <Laptop size={12} aria-hidden /> {computerName} <ChevronDown size={11} aria-hidden />
            </button>
          )}
        >
          {(close) =>
            places.map((row) => (
              <MenuItem
                key={row.deviceId ?? "local"}
                active={(row.deviceId ?? null) === (place.deviceId ?? null)}
                hint={row.online ? "online" : "offline"}
                onClick={() => {
                  onDraft({ deviceId: row.deviceId, folder: null });
                  close();
                }}
              >
                {row.name}
              </MenuItem>
            ))
          }
        </Popover>
      ) : (
        <span className="agent-chip agent-chip-static" title="The computer the agent runs on">
          <Laptop size={12} aria-hidden /> {computerName}
        </span>
      )}
      {editable && onDraft ? (
        <Popover
          width={320}
          maxHeight={380}
          trigger={(open, toggle) => (
            <button type="button" className="agent-chip" aria-haspopup="menu" aria-expanded={open} onClick={toggle} title={place.folder ?? "No folder: a new folder in Ensemble's workspace, when the agent needs one"}>
              {place.folder ? <FolderGit2 size={12} aria-hidden /> : <House size={12} aria-hidden />} <span className="max-w-[14rem] truncate">{folderLabel}</span> <ChevronDown size={11} aria-hidden />
            </button>
          )}
        >
          {(close) => (
            <div className="flex flex-col">
              {here.length > 6 ? (
                <label className="compound-field m-1 flex h-8 items-center gap-1.5 rounded-md border border-line px-2">
                  <Search size={13} className="shrink-0 text-faint" aria-hidden />
                  <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a folder" aria-label="Find a folder" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" />
                </label>
              ) : null}
              <MenuItem
                active={!place.folder}
                hint="workspace"
                onClick={() => {
                  onDraft({ deviceId: place.deviceId, folder: null });
                  close();
                }}
              >
                <House size={13} /> No folder
              </MenuItem>
              {shown.map((row) => (
                <MenuItem
                  key={row.path}
                  active={row.path === place.folder}
                  hint={row.branch ?? undefined}
                  onClick={() => {
                    onDraft({ deviceId: place.deviceId, folder: row.path });
                    close();
                  }}
                >
                  <FolderGit2 size={13} /> <span className="truncate" title={row.path}>{row.name}</span>
                </MenuItem>
              ))}
              {!here.length ? <p className="px-3 py-1.5 text-[12px] text-muted">No folders Code can use on {inSentence(computerName)}. Add them in Settings.</p> : null}
            </div>
          )}
        </Popover>
      ) : (
        <span className="agent-chip agent-chip-static" title={place.folder ?? "A new folder in Ensemble's workspace"}>
          {place.folder ? <FolderGit2 size={12} aria-hidden /> : <House size={12} aria-hidden />} <span className="max-w-[14rem] truncate">{folderLabel}</span>
        </span>
      )}
      {folder?.branch ? (
        <span className="agent-chip agent-chip-static" title="The folder's branch: the agent works on it as it is">
          <GitBranch size={12} aria-hidden /> <span className="max-w-[10rem] truncate">{folder.branch}</span>
        </span>
      ) : null}
    </div>
  );
}

function Composer({
  threadId,
  place,
  placeInfo,
  draftable,
  onDraft,
  places,
  folders,
  placesLoading,
  viewOnly,
  live,
  sending,
  inject,
  suggestions,
  onSend,
  onStop,
}: {
  threadId: string | null;
  place: ThreadPlace;
  placeInfo: CodeThreadPlace;
  draftable: boolean;
  onDraft: ((place: ThreadPlace) => void) | null;
  places: PlaceChoice[];
  folders: FolderChoice[];
  placesLoading: boolean;
  viewOnly: boolean;
  live: CodeTurn | null;
  sending: boolean;
  inject: { text: string; mentions: PageMention[]; nonce: number } | null;
  suggestions: string[] | null;
  onSend: (shown: string, input: Omit<AssignInput, "taskId">) => Promise<boolean>;
  onStop: () => Promise<void>;
}) {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const subscriptions = useQuery({ queryKey: ["subscriptions"], queryFn: api.subscriptions, staleTime: 30_000 });
  const deviceId = place.deviceId;
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
  const menu = useMentionMenu({ value: text, onValue: setText, inputRef: box });
  useAutoGrow(box, text, 10);
  useEffect(() => {
    if (!inject) return;
    for (const mention of inject.mentions) menu.remember(mention);
    setText(inject.text);
    window.setTimeout(() => {
      box.current?.focus();
      box.current?.setSelectionRange(inject.text.length, inject.text.length);
    }, 0);
    // The menu's helpers change each render; a new nonce is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inject?.nonce]);

  const computerRow = places.find((row) => (row.deviceId ?? null) === (deviceId ?? null)) ?? null;
  const computerName = computerRow?.name ?? placeInfo.deviceName ?? "this computer";
  const online = computerRow ? computerRow.online : true;
  const where = inSentence(computerName);
  const blocker = viewOnly
    ? "View only: the space's owner sends messages here."
    : !places.length && !placesLoading
      ? "Pair a computer to work with your agent."
      : !agents.some((row) => row.ready) && subscriptions.data
        ? `No coding agent is signed in on ${where}.`
        : agent && !agent.ready
          ? `${agent.label} is ${agent.note} on ${where}.`
          : null;
  // An offline computer keeps the message queued until it is back: a note, not a stop.
  const note = !blocker && !online ? `${computerName} is offline. Your message waits until it is back.` : null;
  const busy = Boolean(live) || sending;
  const canSend = !blocker && !busy && places.length > 0 && Boolean(choice) && Boolean(profile) && text.trim().length > 0 && text.length <= MAX_MESSAGE;

  const send = async () => {
    if (!canSend || !choice || !profile) return;
    const engine = choice.provider as CodeEngine;
    const view = engineModel(computerAgent(engine, subscriptions.data, deviceId, device?.capabilities), choice.model);
    const shown = text.trim();
    const mentions = menu.takeMentions(shown);
    const input: Omit<AssignInput, "taskId"> = {
      kind: "code",
      ...engineAssign(engine, { model: choice.model, effort: choice.effort, context: choice.context, fast: choice.fast }, view),
      instructions: withMentions(shown, mentions).slice(0, MAX_MESSAGE),
      ...(place.folder ? { folder: place.folder } : {}),
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
    const ok = await onSend(shown, input);
    if (ok) menu.clear();
    else setText((current) => current || shown);
    box.current?.focus();
  };

  return (
    <div className="shrink-0 px-3 pb-3 pt-1 sm:px-6" data-testid="agent-composer">
      <div className="mx-auto w-full max-w-[860px]">
        {suggestions && !viewOnly ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {suggestions.map((suggestion) => (
              <button key={suggestion} type="button" className="agent-suggestion" onClick={() => { setText(suggestion); box.current?.focus(); }}>
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
        <div className={cx("agent-composer compound-field", blocker && "opacity-80")}>
          <PlaceBar place={place} placeInfo={placeInfo} editable={draftable} onDraft={onDraft} places={places} folders={folders} />
          <MentionTextarea
            menu={menu}
            value={text}
            rows={1}
            disabled={viewOnly}
            maxLength={MAX_MESSAGE}
            onKeyDown={(event) => {
              if (menu.onKeyDown(event)) return;
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={viewOnly ? "View only" : `Ask ${agent?.label ?? "your agent"} to change the code or make a page, board or plot. @ to mention`}
            aria-label="Message to the agent"
            className="block w-full resize-none bg-transparent px-3 pt-1.5 text-[13.5px] leading-6 outline-none placeholder:text-faint"
          />
          <MentionPopover menu={menu} />
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
            {blocker && !viewOnly ? (
              !places.length ? (
                <Link href="/settings#devices" className="text-accent hover:underline">Pair a computer</Link>
              ) : (
                <Link href="/settings?tab=assistant#models" className="text-accent hover:underline">Settings › Models</Link>
              )
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export { samePlace };
