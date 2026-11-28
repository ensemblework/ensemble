"use client";

/**
 * The agent's sessions in Code's side panel (docs/16 §9), as Cursor and T3 Code list theirs: New thread,
 * a search, pinned threads, then one group per folder (and computer, when there are several) with
 * "No folder" for threads that work in a new workspace folder; each thread with its state, its agent
 * and how long ago it worked. Right-click a thread or a group for what fits it; double-click or F2
 * renames a thread.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isCodeEngine } from "@ensemble/shared-types";
import { ChevronRight, CircleAlert, Clock, Copy, FolderGit2, FolderOpen, Hand, House, Mail, Pin, Plus, RotateCcw, Search, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentActivityMark } from "../motion/agent-activity-mark";
import { copyText } from "@/components/context-menu/builders";
import { openContextMenu } from "@/components/context-menu/menu-store";
import { ProviderLogo } from "@/components/connectors/provider-logo";
import { useToast } from "@/components/toast";
import { SkeletonRows, cx } from "@/components/ui";
import { api, type CodeThread } from "@/lib/api";
import { groupThreads, isLive, shortAgo, type ThreadGroup } from "@/lib/code-agent";
import { usePersistentState } from "@/lib/prefs";
import { PanelHeader } from "./ide-chrome";
import { refreshThreads, threadMenu, threadState, useCodeThreads, useDeleteThread, useRenameThread, useSeenThreads } from "./agent-actions";

export type ThreadPlace = { deviceId: string | null; folder: string | null };

const SHOWN = 8;

export function AgentSessions({
  selected,
  onVisibleSelected,
  current = null,
  machine = null,
  onSelect,
  onNew,
  onOpenFolder,
  viewOnly,
}: {
  selected: string | null;
  onVisibleSelected?: (id: string | null) => void;
  /** The IDE's own folder: its group comes first. */
  current?: ThreadPlace | null;
  /** Only the threads on this machine (Code shows one at a time); null lists every thread. */
  machine?: { deviceId: string | null; online?: boolean } | null;
  onSelect: (thread: CodeThread) => void;
  onNew: (place: ThreadPlace | null) => void;
  onOpenFolder: (place: { deviceId: string | null; folder: string }) => void;
  viewOnly: boolean;
}) {
  const client = useQueryClient();
  const threads = useCodeThreads();
  const [pinned, setPinned] = usePersistentState<string[]>("ensemble.code.pinned", []);
  const [collapsed, setCollapsed] = usePersistentState<string[]>("ensemble.code.closedGroups", []);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [more, setMore] = useState<string[]>([]);
  const { seen } = useSeenThreads();
  const rename = useRenameThread();
  const remove = useDeleteThread((id) => {
    if (id === selected) onNew(current);
  });

  const all = useMemo(() => (threads.data?.threads ?? []).filter((row) => !machine || (row.place.deviceId ?? null) === (machine.deviceId ?? null)), [threads.data, machine?.deviceId]);
  const computers = new Set(all.map((row) => row.place.deviceId ?? "local")).size;
  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const list = groupThreads(needle ? all.filter((row) => row.title.toLowerCase().includes(needle)) : all, new Set(pinned), { computers });
    if (!current) return list;
    const here = list.findIndex((group) => !group.pinned && group.deviceId === current.deviceId && group.folder === current.folder);
    return here > 0 ? [...list.slice(0, here).filter((group) => group.pinned), list[here]!, ...list.filter((group, index) => index !== here && !group.pinned)] : list;
  }, [all, pinned, needle, computers, current]);

  const togglePin = (id: string) => setPinned((list) => (list.includes(id) ? list.filter((row) => row !== id) : [id, ...list].slice(0, 50)));
  const toggleGroup = (key: string) => setCollapsed((list) => (list.includes(key) ? list.filter((row) => row !== key) : [...list, key]));

  const rowMenu = (thread: CodeThread) =>
    threadMenu(thread, {
      open: () => onSelect(thread),
      rename: viewOnly ? null : () => setRenaming(thread.id),
      pinned: pinned.includes(thread.id),
      togglePin: () => togglePin(thread.id),
      openFolder: thread.place.folder ? () => onOpenFolder({ deviceId: thread.place.deviceId, folder: thread.place.folder! }) : null,
      newHere: () => onNew(thread.place),
      remove: () => remove.mutate(thread.id),
      stop: thread.last ? () => void api.stopJob(thread.last!.id).finally(() => refreshThreads(client, thread.id)) : null,
      viewOnly,
    });

  const groupMenu = (group: ThreadGroup) => ({
    title: group.label,
    sections: [
      {
        items: [
          ...(!group.pinned && !viewOnly ? [{ id: "new", label: group.folder ? "New thread in this folder" : "New thread without a folder", icon: Plus, run: () => onNew({ deviceId: group.deviceId, folder: group.folder }) }] : []),
          ...(group.folder ? [{ id: "open", label: "Open the folder in the editor", icon: FolderOpen, run: () => onOpenFolder({ deviceId: group.deviceId, folder: group.folder! }) }] : []),
          ...(group.folder ? [{ id: "copy", label: "Copy the folder's path", icon: Copy, run: () => copyText(group.folder!) }] : []),
        ],
      },
      { items: [{ id: "fold", label: collapsed.includes(group.key) ? "Expand" : "Collapse", icon: ChevronRight, run: () => toggleGroup(group.key) }] },
    ],
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="agent-sessions">
      <PanelHeader title="Agent">
        {viewOnly ? null : (
          <button type="button" className="icon-btn h-6 w-6" title="New thread" aria-label="New thread" onClick={() => onNew(current)}>
            <Plus size={14} />
          </button>
        )}
      </PanelHeader>
      <div className="space-y-1.5 px-2 pb-2">
        {viewOnly ? null : (
          <button type="button" className={cx("agent-new-thread", selected === null && "is-selected")} onClick={() => onNew(current)}>
            <Plus size={14} aria-hidden /> New thread
          </button>
        )}
        <label className="compound-field flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-2">
          <Search size={12} className="shrink-0 text-faint" aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a thread" aria-label="Find a thread" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" />
          {query ? (
            <button type="button" className="text-faint hover:text-ink" aria-label="Clear" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          ) : null}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3" aria-label="Threads">
        {threads.isLoading ? <div className="px-2"><SkeletonRows count={4} /></div> : null}
        {threads.error ? (
          <div className="px-3 text-[12.5px] text-muted">
            {(threads.error as Error).message}{" "}
            <button type="button" className="text-accent hover:underline" onClick={() => void threads.refetch()}>Retry</button>
          </div>
        ) : null}
        {threads.data && !groups.length ? <p className="px-3 py-1 text-[12.5px] text-muted">{needle ? "No thread matches." : "No threads yet."}</p> : null}
        {groups.map((group) => {
          const shut = collapsed.includes(group.key) && !needle && !group.threads.some((row) => row.id === selected);
          const open = more.includes(group.key) || needle;
          const shown = open ? group.threads : group.threads.slice(0, SHOWN);
          const Icon = group.pinned ? Pin : group.folder ? FolderGit2 : House;
          return (
            <section key={group.key} className="mt-1" aria-label={group.label}>
              <div className="group flex items-center pr-1.5" onContextMenu={(event) => openContextMenu(event, () => groupMenu(group))}>
                <button type="button" className="agent-group" aria-expanded={!shut} onClick={() => toggleGroup(group.key)} title={group.folder ?? (group.pinned ? "Pinned threads" : "Threads that work in a new folder in Ensemble's workspace")}>
                  <ChevronRight size={12} className={cx("shrink-0 transition-transform", !shut && "rotate-90")} aria-hidden />
                  <Icon size={13} className="shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                </button>
                {!group.pinned && !viewOnly ? (
                  <button type="button" className="icon-btn h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" title={group.folder ? "New thread in this folder" : "New thread without a folder"} aria-label={`New thread in ${group.label}`} onClick={() => onNew({ deviceId: group.deviceId, folder: group.folder })}>
                    <Plus size={13} />
                  </button>
                ) : null}
              </div>
              {shut ? null : (
                <ul>
                  {shown.map((thread) => (
                    <li key={thread.id}>
                      {renaming === thread.id ? (
                        <RenameRow
                          title={thread.title}
                          onDone={(title) => {
                            setRenaming(null);
                            if (title && title !== thread.title) rename.mutate({ id: thread.id, title });
                          }}
                        />
                      ) : (
                        <SessionRow
                          thread={thread}
                          state={threadState(thread, seen, machine?.online)}
                          selected={thread.id === selected}
                          onVisible={thread.id === selected ? onVisibleSelected : undefined}
                          onOpen={() => onSelect(thread)}
                          onRename={viewOnly ? null : () => setRenaming(thread.id)}
                          onDelete={viewOnly ? null : () => remove.mutate(thread.id)}
                          onMenu={(event) => openContextMenu(event, () => rowMenu(thread))}
                        />
                      )}
                    </li>
                  ))}
                  {group.threads.length > SHOWN && !needle ? (
                    <li>
                      <button type="button" className="agent-more" onClick={() => setMore((list) => (list.includes(group.key) ? list.filter((row) => row !== group.key) : [...list, group.key]))}>
                        {open ? "Show fewer" : `Show ${group.threads.length - SHOWN} more`}
                      </button>
                    </li>
                  ) : null}
                </ul>
              )}
            </section>
          );
        })}
        {viewOnly ? null : <ThreadBin machine={machine} />}
      </div>
    </div>
  );
}

/**
 * Deleted threads, kept 7 days (hub-api `CODE_THREAD_BIN_DAYS`), then gone for good on their own. Each
 * can come back as it was, or go now.
 */
function ThreadBin({ machine }: { machine: { deviceId: string | null } | null }) {
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = usePersistentState("ensemble.code.binOpen", false);
  const bin = useQuery({ queryKey: ["code-thread-bin"], queryFn: api.codeThreadBin, staleTime: 30_000 });
  const rows = (bin.data?.threads ?? []).filter((row) => !machine || (row.place.deviceId ?? null) === (machine.deviceId ?? null));
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreCodeThread(id),
    onSuccess: () => refreshThreads(client),
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  const purge = useMutation({
    mutationFn: (id: string) => api.purgeCodeThread(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["code-thread-bin"] }),
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  if (!rows.length) return null;
  return (
    <section className="mt-3 border-t border-line pt-1" aria-label="Bin" data-testid="agent-bin">
      <button type="button" className="agent-group w-full" aria-expanded={open} onClick={() => setOpen(!open)} title="Deleted threads stay here 7 days, then go for good">
        <ChevronRight size={12} className={cx("shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
        <Trash2 size={13} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left">Bin</span>
        <span className="text-[11px] font-normal tabular-nums text-faint">{rows.length}</span>
      </button>
      {open ? (
        <ul>
          {rows.map((thread) => (
            <li key={thread.id} className="group flex items-center gap-1 py-0.5 pl-[33px] pr-1.5 text-[12.5px]">
              <span className="min-w-0 flex-1 truncate text-muted" title={thread.title}>{thread.title}</span>
              <span className="shrink-0 text-[11px] text-faint group-hover:hidden">{thread.purgeAt ? daysLeft(thread.purgeAt) : ""}</span>
              <button type="button" className="icon-btn hidden h-6 w-6 group-hover:inline-flex focus-visible:inline-flex" title="Restore" aria-label={`Restore ${thread.title}`} disabled={restore.isPending} onClick={() => restore.mutate(thread.id)}>
                <RotateCcw size={12} />
              </button>
              <button type="button" className="icon-btn hidden h-6 w-6 group-hover:inline-flex focus-visible:inline-flex" title="Delete for good" aria-label={`Delete ${thread.title} for good`} disabled={purge.isPending} onClick={() => purge.mutate(thread.id)}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** "6d left", "today": how long a thread in the Bin has. */
export function daysLeft(purgeAt: string, now = Date.now()): string {
  const days = Math.ceil((Date.parse(purgeAt) - now) / 86_400_000);
  return days <= 1 ? "today" : `${days}d left`;
}

const STATE_LABEL = { running: "Running", offline: "Offline", queued: "Queued", claimed: "Starting", stopping: "Stopping", waiting_approval: "Needs you", new: "Unread", failed: "Failed", read: "Read" } as const;
const STATE_ICON = { offline: Clock, queued: Clock, claimed: Clock, stopping: Square, waiting_approval: Hand, new: Mail, failed: CircleAlert };

function SessionRow({ thread, state, selected, onVisible, onOpen, onRename, onDelete, onMenu }: { thread: CodeThread; state: keyof typeof STATE_LABEL; selected: boolean; onVisible?: (id: string | null) => void; onOpen: () => void; onRename: (() => void) | null; onDelete: (() => void) | null; onMenu: (event: React.MouseEvent) => void }) {
  const status = thread.last?.status;
  const live = status && isLive(status);
  const Icon = state !== "read" && state !== "running" ? STATE_ICON[state] : null;
  const row = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!onVisible || state !== "running" || !row.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => onVisible(entry.isIntersecting ? thread.id : null));
    observer.observe(row.current);
    return () => { observer.disconnect(); onVisible(null); };
  }, [thread.id, state, onVisible]);
  return (
    <button
      type="button"
      className={cx("agent-session", selected && "is-selected")}
      ref={row}
      aria-current={selected ? "true" : undefined}
      title={thread.title}
      onClick={onOpen}
      onDoubleClick={onRename ?? undefined}
      onContextMenu={onMenu}
      onKeyDown={(event) => {
        if (event.key === "F2" && onRename) {
          event.preventDefault();
          onRename();
        } else if ((event.key === "Delete" || (event.key === "Backspace" && (event.metaKey || event.ctrlKey))) && onDelete && !live) {
          event.preventDefault();
          onDelete();
        }
      }}
      data-testid="agent-session"
    >
      <span className="agent-thread-mark" title={STATE_LABEL[state]}>
        <AgentActivityMark size="micro" kind={state === "running" ? "infinity" : null} />
        {Icon ? <Icon size={13} className={cx("agent-state-icon", state === "failed" ? "text-danger" : "text-muted")} aria-hidden /> : null}
      </span>
      <span className={cx("min-w-0 flex-1 truncate", (state === "new" || state === "failed") && "font-medium text-ink")}>
        {thread.title}
        <span className="sr-only">, {STATE_LABEL[state]}</span>
      </span>
      {thread.last?.engine && isCodeEngine(thread.last.engine) ? <ProviderLogo id={thread.last.engine} size={11} /> : null}
      <span className="shrink-0 tabular-nums text-[11px] text-faint">{live || state === "failed" ? STATE_LABEL[state] : shortAgo(thread.updatedAt)}</span>
    </button>
  );
}

function RenameRow({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const [draft, setDraft] = useState(title);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <div className="px-2 py-0.5">
      <input
        autoFocus
        value={draft}
        maxLength={200}
        aria-label="Thread name"
        className="field h-7 w-full px-2 text-[12.5px]"
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => finish(draft.trim() || null)}
        onKeyDown={(event) => {
          if (event.key === "Enter") finish(draft.trim() || null);
          else if (event.key === "Escape") finish(null);
        }}
      />
    </div>
  );
}
