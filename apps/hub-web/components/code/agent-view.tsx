"use client";

/**
 * The Code tab's agentic view (docs/16 §9): a thread with the person's own coding agent, in a folder on
 * one of their computers, or in no folder (a new folder in that computer's Ensemble workspace) for work
 * that needs no repository. Each message is a chat run (`POST /api/agent/assign` with `chat` and
 * `surface: "code"`) that continues the agent's own session, so every run rule and the run's review
 * apply. The thread shows each turn's work live (thinking, commands with their output, edits, Ensemble's
 * tools, the raw log), its questions and permission requests answered in place, the reply with cards for
 * the Ensemble records it made, the files it changed (which open in the editor's review), and what to do
 * with the reply without a model: copy it, keep it on a page, a task, meeting notes or a deliverable.
 * While a turn works, a new message steers it or stops it and goes next.
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
  Check,
  CheckCheck,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  CornerDownRight,
  ExternalLink,
  Eye,
  File,
  FilePen,
  FileText,
  Flag,
  FolderGit2,
  GitBranch,
  Hand,
  House,
  Laptop,
  ChartLine,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Pin,
  Search,
  Sparkles,
  Square,
  SquareTerminal,
  Table,
  Trash2,
  Users,
  WifiOff,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon, EnsembleIcon } from "@/components/agent-icon";
import { AgentPicker, TuningPicker, agentOptions, modelOf, type AgentChoice } from "@/components/agent/agent-picker";
import { ToolsPicker } from "@/components/agent/tools-picker";
import { ChatText } from "@/components/chat-text";
import { copyText } from "@/components/context-menu/builders";
import { openContextMenu } from "@/components/context-menu/menu-store";
import { MarkdownText } from "@/components/markdown-text";
import { MentionTextarea } from "@/components/mentions/mention-field";
import { MentionPopover, useMentionMenu } from "@/components/mentions/mention-menu";
import { useToast } from "@/components/toast";
import { InfoTip, MenuItem, Popover, Spinner, Tag, cx } from "@/components/ui";
import { api, type AgentDecisionRecord, type AssignInput, type CodeThread, type CodeThreadPlace, type CodeTurn, type KeptPage } from "@/lib/api";
import { useAutoGrow } from "@/lib/auto-grow";
import {
  commandOf,
  compactCount,
  editLines,
  elapsed,
  folderName,
  inputLines,
  isLive,
  linkedTasks,
  liveReply,
  recordLinks,
  splitMentions,
  thought,
  threadTitle,
  toolLine,
  toolOutput,
  turnMs,
  withMentions,
  workRows,
  type RecordLink,
  type WorkRow,
} from "@/lib/code-agent";
import { deviceDecisionView } from "@/lib/device-copy";
import { computerAgent, engineAssign, engineModel } from "@/lib/engine-models";
import { usePersistentState } from "@/lib/prefs";
import { defaultProfile, profileAgent, quickProfile } from "@/lib/run-profiles";
import { traceEntries } from "@/lib/run-trace";
import { KeepPicker, refreshThreads, threadMenu, turnMenu, useCodeThreads, useDeleteThread, useRenameThread } from "./agent-actions";
import type { ThreadPlace } from "./agent-sessions";
import { BranchMenu } from "./branch-menu";
import { FileIcon } from "./file-icon";
import { FolderPicker } from "./folder-picker";
import { machineState } from "./machine-switcher";
import { useLinkNavigate } from "./quick-open";

type Mode = "ask" | "review" | "unattended";

const MODES: Array<{ id: Mode; title: string; text: string; icon: LucideIcon | typeof AgentIcon }> = [
  { id: "ask", title: "Ask", text: "Asks before commands and edits. Reading goes ahead.", icon: Hand },
  { id: "review", title: "Review only", text: "Works freely in its folder. Asks you decisions.", icon: Eye },
  { id: "unattended", title: "Run unattended", text: "Never waits for you. Keys, system files and Ensemble's code stay off limits.", icon: AgentIcon },
];

const FOLDER_SUGGESTIONS = ["Explain how this repository is organised", "Find a failing test and fix it", "Write a page about what changed today"];
const NO_FOLDER_SUGGESTIONS = ["Make a page that plans next week", "Draw a diagram of how our services talk", "Plot last month's tasks by status"];

const MAX_MESSAGE = 8000;
const POLL_MS = 1500;
/** How often an open thread says it is open, so its requests stay in it (hub-api lib/code-watch.ts). */
const WATCH_MS = 15_000;

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

/**
 * While the thread is on screen it says so every few seconds: its agent's requests are then answered
 * here and stay out of Needs me. Hidden or closed, it says so once, and they go back there.
 */
function useThreadWatch(threadId: string | null, visible: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    if (!threadId || !visible) return;
    const say = (open: boolean) => void api.watchCodeThread(threadId, open).catch(() => undefined);
    const beat = () => {
      if (document.visibilityState === "visible") say(true);
    };
    beat();
    const timer = window.setInterval(beat, WATCH_MS);
    const onVisibility = () => (document.visibilityState === "visible" ? say(true) : say(false));
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      say(false);
      void client.invalidateQueries({ queryKey: ["decisions"] });
    };
  }, [threadId, visible, client]);
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
  /** The thread is on screen (not a hidden tab): it answers its own requests. */
  visible?: boolean;
  /** The files a turn at work is editing now, relative to the thread's folder (the editor follows them). */
  onEditing?: (paths: string[]) => void;
  /** Closes the thread's tab, where it is one. */
  onClose?: (() => void) | null;
};

export function AgentView({ threadId, onThread, draft, onDraft, places, folders, placesLoading = false, viewOnly, onOpenFile, onOpenFolder, visible = true, onEditing, onClose = null }: AgentViewProps) {
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useLinkNavigate();
  const list = useCodeThreads();
  const listed = list.data?.threads.find((row) => row.id === threadId) ?? null;
  const thread = useQuery({
    queryKey: ["code-thread", threadId],
    queryFn: () => api.codeThread(threadId!),
    enabled: Boolean(threadId),
    // Live turns are read often; server events (components/live.tsx) bring changes sooner still.
    refetchInterval: (query) => (query.state.data?.turns.some((turn) => isLive(turn.status)) ? POLL_MS : false),
  });
  useThreadWatch(viewOnly ? null : threadId, visible);
  const turns = useMemo(() => (threadId ? (thread.data?.turns ?? []) : []), [threadId, thread.data]);
  const live = turns.find((turn) => isLive(turn.status)) ?? null;
  const last = turns[turns.length - 1] ?? null;
  const place: ThreadPlace = threadId ? (thread.data?.thread.place ?? listed?.place ?? draft) : draft;
  const placeInfo: CodeThreadPlace = threadId ? (thread.data?.thread.place ?? listed?.place ?? { ...draft, deviceName: null, workdir: null }) : { ...draft, deviceName: null, workdir: null };
  const computer = places.find((row) => (row.deviceId ?? null) === (place.deviceId ?? null)) ?? null;
  const tasks = useMemo(() => linkedTasks(turns.map((turn) => turn.instructions ?? "")), [turns]);
  const [sending, setSending] = useState<{ text: string; steer: boolean } | null>(null);
  const [inject, setInject] = useState<{ text: string; mentions: PageMention[]; nonce: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const rename = useRenameThread();
  // A deleted thread's tab closes with it.
  const remove = useDeleteThread(() => (onClose ? onClose() : onThread(null)));
  const [pinned, setPinned] = usePersistentState<string[]>("ensemble.code.pinned", []);
  const asks = useMemo(() => (threadId ? (thread.data?.asks ?? []) : []), [threadId, thread.data]);

  // A finished turn changed the folder: the sessions list, source control and open files read it again.
  const lastStatus = last?.status;
  useEffect(() => {
    if (!lastStatus || isLive(lastStatus)) return;
    refreshThreads(client);
    for (const key of [["scm"], ["code-versions"], ["code-source"], ["code-progress"]]) void client.invalidateQueries({ queryKey: key });
  }, [lastStatus, client]);

  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToEnd = useRef(true);
  const [contentTick, setContentTick] = useState(0);
  const contentKey = `${turns.length}:${last?.status}:${last?.toolCalls}:${last?.progress}:${sending?.text ?? ""}:${asks.length}:${contentTick}`;
  useEffect(() => {
    const box = scroller.current;
    if (box && pinnedToEnd.current) box.scrollTop = box.scrollHeight;
  }, [contentKey, threadId]);

  const title = threadId ? (thread.data?.thread.title ?? listed?.title ?? "Thread") : "New thread";
  const threadRow: CodeThread | null = threadId ? (listed ?? (thread.data ? { id: threadId, title, createdAt: "", updatedAt: "", turns: turns.length, last: last ? { id: last.id, status: last.status, engine: last.provider, model: last.model } : null, place: placeInfo } : null)) : null;
  const folderOpen = place.folder && onOpenFolder ? () => onOpenFolder({ deviceId: place.deviceId, folder: place.folder! }) : null;
  const go = navigate.go;
  const stop = async () => {
    if (!live) return;
    await api.stopJob(live.id).catch((error: Error) => toast(error.message, { tone: "error" }));
    refreshThreads(client, threadId);
  };

  /** Sends one message: a new turn, a steer of the turn at work, or a turn after stopping it. */
  const send = async (shown: string, input: Omit<AssignInput, "taskId">, how: "send" | "steer" | "replace"): Promise<boolean> => {
    setSending({ text: shown, steer: how === "steer" });
    pinnedToEnd.current = true;
    let made: string | null = null;
    try {
      let id = threadId;
      if (!id) {
        const created = await api.createCodeThread({ folder: place.folder, ...(place.deviceId ? { deviceId: place.deviceId } : {}), title: threadTitle(shown), message: shown });
        id = made = created.thread.id;
        client.setQueryData<{ threads: CodeThread[] }>(["code-threads"], (old) => ({ threads: [created.thread, ...(old?.threads ?? [])] }));
      }
      const working = id === threadId ? live : null;
      if (how === "steer" && working) {
        await api.steerCodeThread(id, { jobId: working.id, turn: input });
      } else {
        if (how === "replace" && working) await api.stopJob(working.id);
        const previous = id === threadId ? last?.id : undefined;
        await api.assign({ ...input, taskId: id, ...(previous ? { continueFromJobId: previous } : {}) });
      }
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
  };

  // The files the turn at work is editing, for the editor to follow (and say so).
  const editingRef = useRef(onEditing);
  editingRef.current = onEditing;
  const [editing, setEditing] = useState<string[]>([]);
  const editingKey = editing.join("\n");
  useEffect(() => {
    editingRef.current?.(editingKey ? editingKey.split("\n") : []);
  }, [editingKey]);
  useEffect(() => () => editingRef.current?.([]), []);

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
              stop: live ? () => void stop() : null,
              viewOnly,
            }),
          );
        }}
      >
        <AgentIcon size={14} className={cx("mx-1 shrink-0", live ? "agent-live-mark" : "text-muted")} aria-hidden />
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
        {live ? <span className="agent-shimmer shrink-0 text-[11.5px]">{live.status === "waiting_approval" ? "Waiting for you" : "Working"}</span> : null}
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
        {onClose ? (
          <button type="button" className="icon-btn h-7 w-7" aria-label="Close the thread" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
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
        <div className="agent-timeline mx-auto flex w-full max-w-[860px] flex-col gap-6 px-4 pb-6 pt-5 sm:px-6">
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
              computerName={computer?.name ?? turn.deviceName ?? placeInfo.deviceName ?? "this computer"}
              computerOnline={turn.deviceId ? (turn.deviceOnline ?? computer?.online ?? true) : true}
              tasks={tasks}
              viewOnly={viewOnly}
              asks={asks.filter((row) => row.detail.jobId === turn.id || row.sessionId === turn.id)}
              onOpenFile={(path) => onOpenFile(place, path)}
              go={go}
              onQuote={(text) => setInject({ text: `${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`, mentions: [], nonce: Date.now() })}
              onAgain={(text, mentions) => setInject({ text, mentions, nonce: Date.now() })}
              suggestions={index === turns.length - 1 && !isLive(turn.status) && !viewOnly ? followUps(turn, tasks) : []}
              onSuggest={(text, mentions) => setInject({ text, mentions, nonce: Date.now() })}
              onStop={() => void stop()}
              onGrow={() => setContentTick((tick) => tick + 1)}
              onEditing={isLive(turn.status) ? setEditing : null}
            />
          ))}
          {sending ? <UserMessage text={sending.text} mentions={[]} steer={sending.steer} pending /> : null}
        </div>
      </div>
      {navigate.link}
      <Composer
        threadId={threadId}
        threadToolsOff={threadId ? (thread.data?.thread.toolsOff ?? null) : null}
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
        onSend={send}
        onStop={stop}
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
          text={`Each message runs your own coding agent on ${inSentence(placeName)}, with its own sign-in, under the mode you pick below and your default run profile. Type @ to point it at a task, a person, a file or a diagram. While this thread is open its questions wait here; closed, they wait in Needs me. Review and accept its changes in the editor.`}
        />
      </p>
    </div>
  );
}

const UserMessage = memo(function UserMessage({ text, mentions, pending = false, steer = false }: { text: string; mentions: PageMention[]; pending?: boolean; steer?: boolean }) {
  return (
    <div className="flex flex-col items-end gap-1" data-testid="agent-user-message">
      {steer ? (
        <span className="flex items-center gap-1 text-[11.5px] text-muted">
          <CornerDownRight size={11} aria-hidden /> Steered while it worked
        </span>
      ) : null}
      <div className={cx("agent-user max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2 text-[13.5px]", pending && "opacity-70", steer && "agent-user-steer")}>
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
  computerName,
  computerOnline,
  tasks,
  viewOnly,
  asks,
  onOpenFile,
  go,
  onQuote,
  onAgain,
  suggestions,
  onSuggest,
  onStop,
  onGrow,
  onEditing,
}: {
  turn: CodeTurn;
  threadId: string;
  title: string;
  place: ThreadPlace;
  computerName: string;
  computerOnline: boolean;
  tasks: Array<{ id: string; label: string }>;
  viewOnly: boolean;
  asks: AgentDecisionRecord[];
  onOpenFile: (path: string) => void;
  go: (href: string) => void;
  onQuote: (text: string) => void;
  onAgain: (text: string, mentions: PageMention[]) => void;
  suggestions: Array<{ text: string; mentions: PageMention[] }>;
  onSuggest: (text: string, mentions: PageMention[]) => void;
  onStop: () => void;
  onGrow: () => void;
  onEditing: ((paths: string[]) => void) | null;
}) {
  const live = isLive(turn.status);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? live;
  const [tab, setTab] = useState<"steps" | "log">("steps");
  // A live turn's steps are read even folded: its reply streams from them.
  const run = useQuery({
    queryKey: ["run", turn.runId],
    queryFn: () => api.run(turn.runId!),
    enabled: Boolean(turn.runId) && (expanded || live),
    refetchInterval: live ? POLL_MS : false,
    staleTime: live ? 0 : Number.POSITIVE_INFINITY,
  });
  const now = useNow(live);
  const entries = useMemo(() => (run.data ? traceEntries(run.data.run.steps, run.data.run.startedAt, run.data.run.endedAt, now) : []), [run.data, now]);
  const reply = live ? liveReply(entries) : (turn.summary ?? "");
  const rows = useMemo(() => workRows(entries, place.folder ?? "", reply), [entries, place.folder, reply]);
  const asked = useMemo(() => splitMentions(turn.instructions ?? ""), [turn.instructions]);
  const records = useMemo(() => recordLinks(reply), [reply]);
  const took = elapsed(turnMs(turn, now));
  const failed = turn.status === "failed" || turn.status === "blocked" || turn.status === "interrupted";
  const reviewId = place.deviceId ? (turn.deviceReviewId ?? null) : turn.reviewId;
  const reviewHref = (path?: string) => (reviewId ? `/code/review?${new URLSearchParams({ ...(place.deviceId ? { device: place.deviceId } : {}), review: reviewId, ...(path ? { file: path } : {}), view: "editor" }).toString()}` : null);
  const finished = !live && Boolean(reply.trim());
  const offline = turn.status === "queued" && Boolean(turn.deviceId) && !computerOnline;
  const thinking = live && turn.status === "running" && !rows.some((row) => row.type === "tool" && row.running);
  const lastRow = rows[rows.length - 1];

  // The editor follows the files this turn edits while it works.
  const editingKey = live ? [...new Set(rows.flatMap((row) => (row.type === "tool" && row.kind === "edit" && row.path ? [row.path] : [])))].join("\n") : "";
  useEffect(() => {
    onEditing?.(editingKey ? editingKey.split("\n") : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingKey]);
  // New work keeps the thread scrolled to its end, where the person reads it.
  useEffect(() => {
    if (live) onGrow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, reply.length, live]);

  const status = offline
    ? `Waiting for ${computerName}`
    : turn.status === "queued"
      ? turn.deviceId
        ? `Waiting for ${inSentence(computerName)} to start it`
        : turn.waitingFor || "Waiting to start"
      : turn.status === "claimed"
        ? `Starting on ${inSentence(computerName)}`
        : turn.status === "waiting_approval"
          ? "Waiting for you"
          : turn.status === "stopping"
            ? "Stopping"
            : live
              ? turn.progress || "Working"
              : `Worked for ${took}${turn.toolCalls ? ` · ${turn.toolCalls} tool ${turn.toolCalls === 1 ? "call" : "calls"}` : ""}`;
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
      <UserMessage text={asked.text} mentions={asked.mentions} steer={turn.steer} />
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <button type="button" className="agent-work-toggle" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
            <ChevronRight size={13} className={cx("shrink-0 transition-transform", expanded && "rotate-90")} aria-hidden />
            <span className={cx("min-w-0 truncate", live && !offline && "agent-shimmer")}>{status}</span>
            {live && turn.status !== "queued" ? <span className="shrink-0 tabular-nums text-faint">· {took}</span> : null}
          </button>
          {expanded && (turn.runId || turn.deviceId) ? (
            <div className="agent-work-tabs" role="tablist" aria-label="Show">
              {(["steps", "log"] as const).map((id) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                  {id === "steps" ? "Steps" : "Log"}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {offline ? (
          <div className="agent-offline" role="status" data-testid="agent-offline">
            <WifiOff size={14} className="mt-0.5 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-ink">{computerName} is offline</div>
              <div className="text-[12.5px] text-muted">
                Your message starts when Ensemble runs there again.{" "}
                <InfoTip label="How to bring it back" text="Ensemble is not running on that computer, or it is asleep or off. Open the Ensemble app there, or run `ensemble runner start` in a terminal on it. The message waits and starts on its own." />
              </div>
            </div>
            {!viewOnly ? (
              <button type="button" className="btn-ghost h-7 px-2 text-[12px]" onClick={onStop}>Cancel</button>
            ) : null}
          </div>
        ) : null}
        {expanded && tab === "log" ? <TurnLog turn={turn} live={live} /> : null}
        {expanded && tab === "steps" && !offline ? (
          <div className="agent-work" data-testid="agent-work">
            {run.isLoading && turn.runId ? <div className="py-1 pl-6"><Spinner size={12} /></div> : null}
            {!rows.length && !run.isLoading && !live ? <p className="pl-6 text-[12px] text-faint">No tool calls.</p> : null}
            {rows.map((row) => <WorkLine key={row.id} row={row} active={live && row === lastRow} onOpenFile={onOpenFile} />)}
            {thinking && lastRow?.type !== "thinking" && turn.status === "running" ? (
              <div className="agent-work-row">
                <span className="agent-work-gutter"><span className="agent-dot agent-dot-live" /></span>
                <span className="agent-shimmer">{reply ? "Writing" : "Thinking"}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {asks.map((decision) => (
        <AskCard key={decision.id} decision={decision} threadId={threadId} viewOnly={viewOnly} />
      ))}
      {reply ? (
        <div className={cx("agent-reply text-[13.5px]", live && "agent-streaming")} data-testid="agent-reply">
          <MarkdownText text={reply} />
        </div>
      ) : null}
      {records.length && !live ? <RecordCards records={records} /> : null}
      {failed ? (
        <div className="agent-alert" role="alert">
          <CircleAlert size={14} className="mt-0.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{turn.error || "The agent stopped before it finished."}</span>
        </div>
      ) : null}
      {turn.status === "cancelled" ? <p className="text-[12.5px] text-muted">{turn.steeredBy ? "Stopped for your update below." : "Stopped."}</p> : null}
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

/** The run's own log, as the computer wrote it, following its end while the turn works. */
function TurnLog({ turn, live }: { turn: CodeTurn; live: boolean }) {
  const device = Boolean(turn.deviceId);
  const logs = useQuery({
    queryKey: ["job-logs", turn.id],
    queryFn: async () => (device ? (await api.jobLogs(turn.id)).chunks.map((chunk) => chunk.text).join("") : ((await api.job(turn.id)).log ?? "")),
    refetchInterval: live ? 2000 : false,
  });
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const node = box.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [logs.data]);
  return (
    <pre ref={box} className="agent-term agent-log" data-testid="agent-log">
      {logs.isLoading ? "" : logs.data?.trim() ? logs.data : live ? "Nothing logged yet." : "Nothing was logged."}
    </pre>
  );
}

const DOT_KINDS = new Set(["read", "search", "web", "plan", "agent", "ask", "other", "think"]);

/** One row of a turn's work: a thought, something the agent said on the way, or a tool call. */
function WorkLine({ row, active, onOpenFile }: { row: WorkRow; active: boolean; onOpenFile: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  if (row.type === "thinking") return <ThoughtRow text={row.text} live={active} />;
  if (row.type === "message") {
    return (
      <div className="agent-work-row items-start">
        <span className="agent-work-gutter" aria-hidden />
        <div className="min-w-0 flex-1 text-[12.5px] text-muted"><MarkdownText text={row.text} /></div>
      </div>
    );
  }
  const line = toolLine(row.name, row.args, row.summary);
  const command = commandOf(row.args);
  const out = row.output ? toolOutput(row.output) : { text: "", exitCode: null };
  const failed = row.ok === false || (out.exitCode !== null && out.exitCode !== 0);
  const Icon: LucideIcon | typeof EnsembleIcon | null = command || row.kind === "command" ? SquareTerminal : row.kind === "edit" ? FilePen : line.ensemble || row.kind === "ensemble" || row.kind === "apps" ? EnsembleIcon : null;
  const detail = command ? null : line.detail && line.detail !== row.path ? line.detail : null;
  const canOpen = Boolean(command || out.text || (row.args && row.args !== "{}"));
  return (
    <div className="flex flex-col" data-kind={line.ensemble ? "ensemble" : command ? "command" : row.kind}>
      <div className={cx("agent-work-row", failed && "text-danger")}>
        <span className="agent-work-gutter">
          {Icon ? <Icon size={13} className={cx(failed ? "text-danger" : line.ensemble ? "text-accent" : "text-faint")} aria-hidden /> : <span className={cx("agent-dot", DOT_KINDS.has(row.kind) && "agent-dot-quiet", row.running && "agent-dot-live")} aria-hidden />}
        </span>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => canOpen && setOpen(!open)} aria-expanded={canOpen ? open : undefined} title={command?.command ?? line.label}>
          <span className={cx("shrink-0", row.running && "agent-shimmer")}>{line.label}</span>
          {command ? <code className="agent-cmd min-w-0 truncate">{command.command}</code> : null}
          {detail ? <span className="min-w-0 truncate text-faint">{detail}</span> : null}
        </button>
        {row.path ? (
          <button type="button" className="agent-file-chip" onClick={() => onOpenFile(row.path!)} title={`Open ${row.path} in the editor`}>
            <FileIcon name={row.path} size={12} /> <span className="truncate">{row.path.split("/").pop()}</span>
          </button>
        ) : null}
        {out.exitCode !== null && out.exitCode !== 0 ? <span className="agent-exit">exit {out.exitCode}</span> : null}
        {row.running ? <Spinner size={11} /> : row.ms != null ? <span className="shrink-0 tabular-nums text-faint">{elapsed(row.ms)}</span> : null}
      </div>
      {open ? <ToolDetail row={row} command={command?.command ?? null} output={out} /> : null}
    </div>
  );
}

/** A thought as its title; the rest opens under it. Only a thought being written moves. */
function ThoughtRow({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const { title, body } = thought(text);
  return (
    <div className="flex flex-col">
      <div className="agent-work-row">
        <span className="agent-work-gutter"><span className={cx("agent-dot agent-dot-quiet", live && "agent-dot-live")} aria-hidden /></span>
        <button type="button" className="min-w-0 flex-1 truncate text-left text-faint" onClick={() => body && setOpen(!open)} aria-expanded={body ? open : undefined}>
          <span className={cx(live && "agent-shimmer")}>{title || "Thinking"}</span>
        </button>
      </div>
      {open && body ? (
        <div className="agent-thought-body">
          <MarkdownText text={body} />
        </div>
      ) : null}
    </div>
  );
}

/** A tool call opened: a command as a terminal, an edit as its lines, anything else as its input and answer. */
function ToolDetail({ row, command, output }: { row: Extract<WorkRow, { type: "tool" }>; command: string | null; output: { text: string; exitCode: number | null } }) {
  if (command) {
    return (
      <pre className="agent-term" data-testid="agent-term">
        <span className="agent-term-prompt">$ </span>
        {command}
        {output.text ? `\n${output.text}` : ""}
        {output.exitCode !== null && output.exitCode !== 0 ? <span className="agent-term-exit">{`\nexit code ${output.exitCode}`}</span> : null}
      </pre>
    );
  }
  const lines = row.kind === "edit" ? editLines(row.args) : null;
  if (lines?.length) {
    return (
      <pre className="agent-term agent-diff">
        {lines.map((line, index) => (
          <span key={index} className={cx("block", line.sign === "+" ? "agent-diff-add" : line.sign === "-" ? "agent-diff-del" : line.sign === "@" ? "text-faint" : undefined)}>
            {line.sign === "@" ? line.text : `${line.sign} ${line.text}`}
          </span>
        ))}
      </pre>
    );
  }
  const input = inputLines(row.args);
  return (
    <div className="agent-tool-detail">
      {input.length ? (
        <dl className="agent-tool-input">
          {input.map(([key, value]) => (
            <div key={key} className="contents">
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {output.text ? <pre className="agent-term">{output.text}</pre> : null}
    </div>
  );
}

const RECORD_ICON: Record<RecordLink["kind"], LucideIcon> = { file: File, page: FileText, task: CheckSquare, diagram: Workflow, plot: ChartLine, project: Flag, meeting: Users, dataset: Table };
const RECORD_KIND: Record<RecordLink["kind"], string> = { file: "File", page: "Page", task: "Task", diagram: "Diagram", plot: "Plot", project: "Project", meeting: "Meeting notes", dataset: "Dataset" };

/** The Ensemble records a reply links to, as cards that open them. */
function RecordCards({ records }: { records: RecordLink[] }) {
  return (
    <div className="agent-records" data-testid="agent-records">
      {records.map((record) => {
        const Icon = RECORD_ICON[record.kind];
        const extension = record.kind === "file" && record.label ? /\.([a-z0-9]{1,5})$/i.exec(record.label)?.[1]?.toUpperCase() : null;
        return (
          <Link key={`${record.kind}:${record.id}`} href={record.href} className="agent-record">
            <span className="agent-record-icon">
              <Icon size={15} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-ink">{record.label ?? RECORD_KIND[record.kind]}</span>
              <span className="flex items-center gap-1 text-[11px] text-faint">
                <EnsembleIcon size={10} aria-hidden /> {RECORD_KIND[record.kind]} in Ensemble{extension ? ` · ${extension}` : ""}
              </span>
            </span>
            <ExternalLink size={12} className="shrink-0 text-faint" aria-hidden />
          </Link>
        );
      })}
    </div>
  );
}

/**
 * A question or permission request of the turn, answered here in one step: Allow, Allow for this run,
 * Don't allow, or an option of a question. A computer that keeps an answer to itself says so.
 */
function AskCard({ decision, threadId, viewOnly }: { decision: AgentDecisionRecord; threadId: string; viewOnly: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const question = decision.event === "question";
  const device = Boolean(decision.detail.deviceId);
  const view = device
    ? deviceDecisionView({ tier: decision.detail.tier, event: decision.event, options: decision.detail.options, deviceName: decision.detail.deviceName, confirm: decision.detail.confirm, allowCustom: decision.detail.allowCustom, recommended: decision.detail.recommended })
    : null;
  const decide = useMutation({
    mutationFn: (input: { decision: "allow" | "deny"; scope?: "once" | "session"; reason?: string }) =>
      // Pressing Allow here is the confirmation: a risky allow is not asked twice.
      api.decideAgent(decision.id, { decision: input.decision, scope: device ? "once" : (input.scope ?? "once"), reason: input.reason, confirmed: input.decision === "allow" && decision.detail.confirm ? true : undefined }),
    onMutate: () => {
      client.setQueryData<Awaited<ReturnType<typeof api.codeThread>>>(["code-thread", threadId], (old) => (old ? { ...old, asks: (old.asks ?? []).filter((row) => row.id !== decision.id) } : old));
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["code-thread", threadId] });
      void client.invalidateQueries({ queryKey: ["decisions"] });
    },
  });
  const busy = decide.isPending || viewOnly || decision.canAnswer === false;
  const options = question ? (decision.detail.options ?? []).filter(Boolean) : [];
  const custom = question && decision.detail.allowCustom !== false;
  const outside = decision.toolName === "outside" || decision.toolName === "outside-read";
  const push = decision.toolName === "git push";
  return (
    <div className="agent-ask" data-testid="agent-ask" role="group" aria-label={question ? "The agent asks" : "The agent asks to"}>
      <div className="flex items-start gap-2">
        <span className="agent-ask-mark" aria-hidden>{question ? "?" : "!"}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink">{decision.title}</div>
          {!question && decision.detail.command ? <pre className="agent-term mt-1.5">{decision.detail.command}</pre> : null}
          {!question && decision.cwd ? <div className="mt-1 truncate font-mono text-[11.5px] text-faint">{decision.cwd}</div> : null}
        </div>
      </div>
      {view?.kind === "approve-on-computer" ? (
        <p className="mt-2 text-[12.5px] text-muted">{view.message} Turn on “Accept approvals from the web” there to answer here.</p>
      ) : question ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {options.map((option, index) => (
            <button key={`${index}:${option}`} type="button" className="agent-ask-option" disabled={busy} onClick={() => decide.mutate({ decision: "allow", reason: option })}>
              <span className="w-4 shrink-0 font-mono text-[11px] text-faint">{String.fromCharCode(65 + index)}</span>
              <span className="min-w-0 flex-1 text-left">{option}</span>
              {decision.detail.recommended === option ? <Tag tone="purple">Recommended</Tag> : null}
            </button>
          ))}
          {custom ? (
            <div className="flex gap-1.5">
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && typed.trim() && !busy && decide.mutate({ decision: "allow", reason: typed.trim() })}
                placeholder={options.length ? "Or type your own answer" : "Your answer"}
                aria-label="Your answer"
                className="field h-8 min-w-0 flex-1 text-[12.5px]"
              />
              <button type="button" className="btn-primary h-8" disabled={busy || !typed.trim()} onClick={() => decide.mutate({ decision: "allow", reason: typed.trim() })}>
                Answer
              </button>
            </div>
          ) : null}
          <button type="button" className="btn-ghost self-start text-[12px]" disabled={busy} onClick={() => decide.mutate({ decision: "deny" })}>
            Skip, let it decide
          </button>
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button type="button" className="btn-primary h-8" disabled={busy} onClick={() => decide.mutate({ decision: "allow", scope: outside ? "session" : "once" })}>
            <Check size={13} aria-hidden /> {outside ? "Allow for this run" : "Allow"}
          </button>
          {!device && !outside && !push ? (
            <button type="button" className="btn h-8" disabled={busy} onClick={() => decide.mutate({ decision: "allow", scope: "session" })}>
              <CheckCheck size={13} aria-hidden /> Allow for this run
            </button>
          ) : null}
          <button type="button" className="btn-ghost h-8" disabled={busy} onClick={() => decide.mutate({ decision: "deny", reason: typed.trim() || undefined })}>
            <X size={13} aria-hidden /> Don&apos;t allow
          </button>
          {decide.isPending ? <Spinner size={12} /> : null}
        </div>
      )}
    </div>
  );
}

const KEPT_ICON: Record<KeptPage["kind"], LucideIcon> = { page: FileText, task: CheckSquare, meeting: Users, deliverable: Flag };

/**
 * What to do with a finished reply without a model: copy it, keep it in Ensemble (a page, a task, meeting
 * notes or a deliverable, marked as the agent's with where it came from), add it to a task the thread
 * mentioned, mark that task done.
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
  const keepMenu = (label: string, initial: "page" | "task" | "meeting" | "deliverable", Icon: LucideIcon, hint: string) => (
    <Popover
      width={332}
      maxHeight={460}
      trigger={(open, toggle) => (
        <button type="button" className="agent-chip" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} title={hint}>
          <Icon size={12} aria-hidden /> {label} <ChevronDown size={11} aria-hidden />
        </button>
      )}
    >
      {(close) => <KeepPicker threadId={threadId} jobId={turn.id} title={title} tasks={tasks} initial={initial} onDone={close} />}
    </Popover>
  );
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
        <>
          {keepMenu("Keep on a page", "page", NotebookPen, "Keep this reply on a page, marked as the agent's")}
          {keepMenu("Add to a task", "task", CheckSquare, "Put this reply on a new task on a board, or on a task you have")}
          {keepMenu("More", "meeting", MoreHorizontal, "Keep it in meeting notes or a deliverable")}
        </>
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
      {kept.map((row) => {
        const Icon = KEPT_ICON[row.kind] ?? FileText;
        return (
          <Link key={`${row.kind}:${row.id}`} href={row.href} className="agent-kept" title="Open where this reply was kept">
            <Icon size={11} aria-hidden /> <span className="max-w-[14rem] truncate">On {row.title}</span>
          </Link>
        );
      })}
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
function PlaceBar({ place, placeInfo, editable, onDraft, places, folders, live }: { place: ThreadPlace; placeInfo: CodeThreadPlace; editable: boolean; onDraft: ((place: ThreadPlace) => void) | null; places: PlaceChoice[]; folders: FolderChoice[]; live: boolean }) {
  const client = useQueryClient();
  const computer = places.find((row) => (row.deviceId ?? null) === (place.deviceId ?? null));
  const computerName = computer?.name ?? placeInfo.deviceName ?? "This computer";
  const here = folders.filter((row) => (row.deviceId ?? null) === (place.deviceId ?? null));
  const folder = place.folder ? (here.find((row) => row.path === place.folder) ?? null) : null;
  const folderLabel = place.folder ? (folder?.name ?? folderName(place.folder)) : "No folder";
  const [picking, setPicking] = useState(false);
  const remote = places.some((row) => row.deviceId);
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, enabled: remote && editable, staleTime: 30_000 });
  const seen = new Map((devices.data?.devices ?? []).map((row) => [row.id, row.lastSeenAt]));
  const target = place.deviceId ? ({ kind: "device", deviceId: place.deviceId } as const) : ({ kind: "local" } as const);
  const canPickFolder = editable && Boolean(onDraft) && (computer?.online ?? true);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5 px-1.5 pt-1.5" data-testid="agent-placebar">
      {editable && onDraft && places.length > 1 && !place.folder ? (
        <Popover
          width={260}
          trigger={(open, toggle) => (
            <button
              type="button"
              className="agent-chip"
              aria-haspopup="listbox"
              aria-expanded={open}
              onClick={() => {
                // Each computer as it is now, not as it was when the page loaded.
                if (!open) void client.invalidateQueries({ queryKey: ["devices"] });
                toggle();
              }}
              title="The computer the agent runs on"
            >
              <Laptop size={12} aria-hidden /> {computerName} <OnlineMark online={computer?.online ?? true} /> <ChevronDown size={11} aria-hidden />
            </button>
          )}
        >
          {(close) => (
            <div className="py-1" role="listbox" aria-label="Computers">
              <div className="flex items-center gap-2 px-3 pb-1 text-[11.5px] text-faint">
                <span className="flex-1">Run the agent on</span>
                {devices.isFetching ? <Spinner size={11} /> : null}
              </div>
              {places.map((row) => {
                const on = (row.deviceId ?? null) === (place.deviceId ?? null);
                return (
                  <button
                    key={row.deviceId ?? "local"}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-hover"
                    onClick={() => {
                      onDraft({ deviceId: row.deviceId, folder: null });
                      close();
                    }}
                  >
                    <Laptop size={14} className="shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{row.name}</span>
                      <span className="flex items-center gap-1.5 text-[11.5px] text-faint">
                        <OnlineMark online={row.online} /> {machineState(row.online, row.deviceId ? seen.get(row.deviceId) : null)}
                      </span>
                    </span>
                    {on ? <Check size={13} className="shrink-0 text-accent" aria-hidden /> : null}
                  </button>
                );
              })}
            </div>
          )}
        </Popover>
      ) : (
        <span className="agent-chip agent-chip-static" title={!editable ? "A thread stays on the computer it started on" : place.folder ? "The folder is on this computer. Work without a folder to pick another" : "The computer the agent runs on"}>
          <Laptop size={12} aria-hidden /> {computerName}
        </span>
      )}
      {editable && onDraft ? (
        <span className="inline-flex items-center">
          <button
            type="button"
            className="agent-chip"
            disabled={!canPickFolder}
            onClick={() => setPicking(true)}
            title={!canPickFolder ? `${computerName} is offline: pick a folder when it is back` : place.folder ?? "No folder: a new folder in Ensemble's workspace, when the agent needs one. Click to pick one"}
            data-testid="agent-folder"
          >
            {place.folder ? <FolderGit2 size={12} aria-hidden /> : <House size={12} aria-hidden />} <span className="max-w-[14rem] truncate">{folderLabel}</span>
          </button>
          {place.folder ? (
            <button type="button" className="icon-btn h-6 w-6" aria-label="Work without a folder" title="Work without a folder" onClick={() => onDraft({ deviceId: place.deviceId, folder: null })}>
              <X size={12} />
            </button>
          ) : null}
          <FolderPicker
            open={picking}
            onClose={() => setPicking(false)}
            target={target}
            computerName={computerName}
            title="Pick a folder for the agent"
            action="Use folder"
            fallback={here.map((row) => ({ path: row.path, name: row.name }))}
            onPick={(picked) => {
              setPicking(false);
              onDraft({ deviceId: place.deviceId, folder: picked.path });
            }}
          />
        </span>
      ) : (
        <span className="agent-chip agent-chip-static" title={place.folder ?? "A new folder in Ensemble's workspace"}>
          {place.folder ? <FolderGit2 size={12} aria-hidden /> : <House size={12} aria-hidden />} <span className="max-w-[14rem] truncate">{folderLabel}</span>
        </span>
      )}
      {place.folder && (computer?.online ?? true) ? (
        <BranchMenu
          target={target}
          repo={place.folder}
          branch={folder?.branch ?? null}
          disabled={live ? "The agent is working in this folder. Switch branches when it is done." : null}
          trigger={(open, toggle, current) => (
            <button type="button" className="agent-chip" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} title="The folder's branch: switch, or start a new one" data-testid="agent-branch">
              <GitBranch size={12} aria-hidden /> <span className="max-w-[10rem] truncate">{current ?? "Branch"}</span> <ChevronDown size={11} aria-hidden />
            </button>
          )}
        />
      ) : null}
    </div>
  );
}

function OnlineMark({ online }: { online: boolean }) {
  return <span className={cx("inline-block h-1.5 w-1.5 shrink-0 rounded-full", online ? "bg-ok" : "bg-faint")} aria-label={online ? "Online" : "Offline"} />;
}

function Composer({
  threadId,
  threadToolsOff,
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
  /** The thread's switched-off tools, as its latest turn ran (null for a new thread). */
  threadToolsOff: string[] | null;
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
  onSend: (shown: string, input: Omit<AssignInput, "taskId">, how: "send" | "steer" | "replace") => Promise<boolean>;
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
  // Tools: what was changed here, else the thread's own, else the run profile's (a new thread).
  const [toolsChoice, setToolsChoice] = useState<string[] | null>(null);
  const shownThread = useRef(threadId);
  useEffect(() => {
    // A different thread starts from its own choices; a new one that just started keeps what was picked.
    if (shownThread.current && shownThread.current !== threadId) setToolsChoice(null);
    shownThread.current = threadId;
  }, [threadId]);
  const toolsOff = toolsChoice ?? threadToolsOff ?? profile?.toolsOff ?? [];

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
  const note = !blocker && !online ? `${computerName} is offline. Your message waits until Ensemble runs there again.` : null;
  const working = Boolean(live) && !sending;
  const canSend = !blocker && !sending && places.length > 0 && Boolean(choice) && Boolean(profile) && text.trim().length > 0 && text.length <= MAX_MESSAGE;

  const send = async (how: "send" | "steer" | "replace") => {
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
      ...(toolsOff.length ? { toolsOff } : {}),
    };
    setText("");
    const ok = await onSend(shown, input, live ? how : "send");
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
        <div className={cx("agent-composer compound-field", blocker && "opacity-80", working && "is-working")}>
          <PlaceBar place={place} placeInfo={placeInfo} editable={draftable} onDraft={onDraft} places={places} folders={folders} live={Boolean(live)} />
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
                // While it works: Enter steers, Ctrl or ⌘+Enter stops it and sends this next.
                void send(working && (event.metaKey || event.ctrlKey) ? "replace" : working ? "steer" : "send");
              }
            }}
            placeholder={viewOnly ? "View only" : working ? "Steer it: say what to change, Enter sends" : `Ask ${agent?.label ?? "your agent"} to change the code or make a page, board or plot. @ to mention`}
            aria-label="Message to the agent"
            className="block w-full resize-none bg-transparent px-3 pt-1.5 text-[13.5px] leading-6 outline-none placeholder:text-faint"
          />
          <MentionPopover menu={menu} />
          <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5 pt-1">
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
            <ToolsPicker value={toolsOff} onChange={setToolsChoice} scope="thread" />
            <div className="flex-1" />
            {working && text.trim() ? (
              <>
                <button type="button" className="agent-chip" onClick={() => void send("replace")} disabled={!canSend} title="Stop what it is doing and send this instead (Ctrl+Enter)" aria-label="Stop and send">
                  <Square size={10} className="fill-current" aria-hidden /> <span className="max-sm:hidden">Stop and send</span>
                </button>
                <button type="button" className="agent-steer" onClick={() => void send("steer")} disabled={!canSend} title="Change what it is doing now; it keeps its work (Enter)">
                  <CornerDownRight size={13} aria-hidden /> Steer
                </button>
              </>
            ) : working ? (
              <button type="button" className="agent-send is-stop" onClick={() => void onStop()} aria-label="Stop the agent" title="Stop">
                <Square size={12} className="fill-current" aria-hidden />
              </button>
            ) : (
              <button type="button" className="agent-send" onClick={() => void send("send")} disabled={!canSend} aria-label="Send" title="Send (Enter)">
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
