"use client";

/**
 * What can be done with a thread of the Code tab's agent and its turns (docs/16 §9), shared by the
 * sessions list, the thread's header and a turn's right-click: open, rename, pin, open its folder in the
 * editor, start another thread there, stop, delete, and keep a reply on a page with no model involved
 * (an agent block that says where it came from, hub-api pages/agent-output.ts).
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { CheckSquare, Copy, ExternalLink, FilePlus2, FileText, Flag, FolderOpen, Link2, NotebookPen, Pencil, Pin, PinOff, Plus, Search, Square, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { copyText } from "@/components/context-menu/builders";
import type { MenuSpec } from "@/components/context-menu/menu-store";
import { useToast } from "@/components/toast";
import { Spinner, cx } from "@/components/ui";
import { api, type CodeThread, type KeepTarget } from "@/lib/api";
import { usePersistentState } from "@/lib/prefs";
import { isLive, shortAgo } from "@/lib/code-agent";

/** Every thread, kept fresh while one works. */
export function useCodeThreads() {
  return useQuery({
    queryKey: ["code-threads"],
    queryFn: api.codeThreads,
    staleTime: 5_000,
    refetchInterval: (query) => (query.state.data?.threads?.some((row) => row.last && isLive(row.last.status)) ? 3_000 : 30_000),
  });
}

export function refreshThreads(client: QueryClient, threadId?: string | null) {
  void client.invalidateQueries({ queryKey: ["code-threads"] });
  if (threadId) void client.invalidateQueries({ queryKey: ["code-thread", threadId] });
}

/** Renaming a thread renames its task; the thread's own list and page read it again. */
export function useRenameThread() {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.patchTask(id, { title }),
    onSettled: (_data, _error, input) => refreshThreads(client, input.id),
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
}

/** Deleting a thread moves its task to Trash, with Undo. */
export function useDeleteThread(onDeleted?: (id: string) => void) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: (result, id) => {
      onDeleted?.(id);
      refreshThreads(client);
      toast("Thread moved to Trash.", {
        action: result?.undoEntryId ? { label: "Undo", run: () => void api.undo(result.undoEntryId ?? undefined).then(() => refreshThreads(client)).catch((error: Error) => toast(error.message, { tone: "error" })) } : undefined,
      });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
}

export type { KeepTarget };

/**
 * Keeps a turn's reply in Ensemble. `announce`: say where it went, for a reply kept from somewhere it is
 * not on screen (the sessions list); in the thread the turn shows it itself.
 */
export function useKeepTurn(threadId: string) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ jobId, target }: { jobId: string; target: KeepTarget; announce?: boolean }) => api.keepCodeTurn(threadId, { jobId, ...target }),
    onSuccess: (result, input) => {
      void client.invalidateQueries({ queryKey: ["code-thread", threadId] });
      for (const key of [["pages"], ["tasks"], ["meeting-sessions"], ["deliverables"]]) void client.invalidateQueries({ queryKey: key });
      if (input.announce) toast(`Kept on ${result.page.title}.`, { action: { label: "Open", run: () => window.location.assign(result.page.href) } });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
}

type KeepKind = "page" | "task" | "meeting" | "deliverable";

const KEEP_KINDS: Array<{ id: KeepKind; label: string; icon: typeof FileText }> = [
  { id: "page", label: "Page", icon: FileText },
  { id: "task", label: "Task", icon: CheckSquare },
  { id: "meeting", label: "Meeting", icon: Users },
  { id: "deliverable", label: "Deliverable", icon: Flag },
];

type KeepRowData = { key: string; icon: typeof FileText; label: string; hint?: string; target: KeepTarget };

/**
 * Where to keep a reply, with no model involved: a page, a task (a new one on a board, one the thread
 * mentioned, or any task), meeting notes, or a deliverable. Typing finds one or names a new one.
 */
export function KeepPicker({ threadId, jobId, title, tasks = [], announce = false, initial = "page", onDone }: { threadId: string; jobId: string; title: string; tasks?: Array<{ id: string; label: string }>; announce?: boolean; initial?: KeepKind; onDone: () => void }) {
  const keep = useKeepTurn(threadId);
  const [kind, setKind] = useState<KeepKind>(initial);
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [projectId, setProjectId] = usePersistentState<string | null>("ensemble.code.keepProject", null);
  useEffect(() => {
    const timer = window.setTimeout(() => setNeedle(query.trim().toLowerCase()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);
  const pages = useQuery({ queryKey: ["pages", "keep", needle], queryFn: () => (needle ? api.searchPages(needle) : api.pages()), staleTime: 15_000, enabled: kind === "page" });
  const allTasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, staleTime: 30_000, enabled: kind === "task" });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects, staleTime: 60_000, enabled: kind === "task" });
  const meetings = useQuery({ queryKey: ["meeting-sessions"], queryFn: api.meetingSessions, staleTime: 30_000, enabled: kind === "meeting" });
  const deliverables = useQuery({ queryKey: ["deliverables", "keep"], queryFn: () => api.deliverables(false), staleTime: 30_000, enabled: kind === "deliverable" });
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const name = (query.trim() || title).slice(0, 200);
  const activeProjects = (projects.data?.projects ?? []).filter((row) => row.status === "active");
  const project = activeProjects.find((row) => row.id === projectId) ?? null;

  const rows: { make: KeepRowData | null; groups: Array<{ label: string; rows: KeepRowData[] }>; loading: boolean; empty: string } = (() => {
    if (kind === "task") {
      const mentioned = tasks.filter((task) => matches(task.label)).map((task) => ({ key: `m:${task.id}`, icon: CheckSquare, label: task.label, hint: "mentioned", target: { taskId: task.id } as KeepTarget }));
      const seen = new Set(tasks.map((task) => task.id));
      const open = (allTasks.data?.tasks ?? [])
        .filter((task) => !seen.has(task.id) && task.status !== "done" && task.status !== "dropped" && matches(task.title))
        .slice(0, 40)
        .map((task) => ({ key: task.id, icon: CheckSquare, label: task.title, hint: task.status.replace(/_/g, " "), target: { taskId: task.id } as KeepTarget }));
      return {
        make: { key: "new", icon: Plus, label: `New task “${name}”`, hint: project ? project.name : "Inbox", target: { newTask: { title: name, projectId: project?.id ?? null } } },
        groups: [{ label: "Mentioned here", rows: mentioned }, { label: needle ? "Matching tasks" : "Open tasks", rows: open }],
        loading: allTasks.isLoading,
        empty: needle ? "No task matches." : "No open tasks.",
      };
    }
    if (kind === "meeting") {
      const list = (meetings.data?.sessions ?? []).filter((row) => matches(row.title)).slice(0, 40);
      return {
        make: { key: "new", icon: Plus, label: `New meeting notes “${name}”`, target: { newMeeting: { title: name } } },
        groups: [{ label: needle ? "Matching notes" : "Recent notes", rows: list.map((row) => ({ key: row.id, icon: Users, label: row.title || "Meeting notes", hint: shortAgo(row.startedAt), target: { meetingId: row.id } })) }],
        loading: meetings.isLoading,
        empty: needle ? "No meeting notes match." : "No meeting notes yet.",
      };
    }
    if (kind === "deliverable") {
      const list = (deliverables.data?.deliverables ?? []).filter((row) => matches(row.title) || matches(row.project.name)).slice(0, 40);
      return {
        make: null,
        groups: [{ label: needle ? "Matching deliverables" : "Upcoming deliverables", rows: list.map((row) => ({ key: row.id, icon: Flag, label: row.title, hint: row.project.name, target: { deliverableId: row.id } })) }],
        loading: deliverables.isLoading,
        empty: needle ? "No deliverable matches." : "No upcoming deliverables. Add one on a project.",
      };
    }
    const list = (pages.data?.pages ?? []).slice(0, 40);
    return {
      make: { key: "new", icon: FilePlus2, label: `New page “${name}”`, target: { newPage: { title: name } } },
      groups: [{ label: needle ? "Matching pages" : "Recent pages", rows: list.map((page) => ({ key: page.id, icon: FileText, label: page.title || "Untitled", hint: shortAgo(page.updatedAt), target: { pageId: page.id } })) }],
      loading: pages.isLoading,
      empty: needle ? "No page matches." : "No pages yet.",
    };
  })();
  const pick = (target: KeepTarget) => keep.mutate({ jobId, target, announce }, { onSuccess: onDone });
  const first = rows.make ?? rows.groups.flatMap((group) => group.rows)[0] ?? null;
  const placeholder = kind === "deliverable" ? "Find a deliverable" : `Find ${kind === "meeting" ? "meeting notes" : `a ${kind}`}, or name a new one`;
  return (
    <div className="flex w-[320px] max-w-full flex-col" data-testid="keep-picker">
      <div className="mx-1 mt-1 flex gap-0.5 rounded-lg border border-line bg-raised p-0.5" role="tablist" aria-label="Keep it on">
        {KEEP_KINDS.map((row) => {
          const Icon = row.icon;
          return (
            <button key={row.id} type="button" role="tab" aria-selected={kind === row.id} onClick={() => setKind(row.id)} className={cx("flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11.5px]", kind === row.id ? "bg-panel font-medium text-ink shadow-sm" : "text-muted hover:text-ink")}>
              <Icon size={12} aria-hidden /> {row.label}
            </button>
          );
        })}
      </div>
      <label className="compound-field mx-1 mb-1 mt-1.5 flex h-8 items-center gap-1.5 rounded-md border border-line px-2">
        <Search size={13} className="shrink-0 text-faint" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && first) {
              event.preventDefault();
              pick(first.target);
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
        />
        {keep.isPending ? <Spinner size={12} /> : null}
      </label>
      {kind === "task" && activeProjects.length ? (
        <label className="mx-1 mb-1 flex items-center gap-2 px-1.5 text-[11.5px] text-muted">
          <span className="shrink-0">New task on</span>
          <select value={project?.id ?? ""} onChange={(event) => setProjectId(event.target.value || null)} className="field h-7 min-w-0 flex-1 px-1.5 text-[12px]" aria-label="Board for a new task">
            <option value="">Inbox</option>
            {activeProjects.map((row) => (
              <option key={row.id} value={row.id}>{row.name}</option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="max-h-[300px] overflow-y-auto py-1" role="listbox" aria-label="Where to keep it">
        {rows.make ? <KeepRow icon={rows.make.icon} label={rows.make.label} hint={rows.make.hint} onPick={() => pick(rows.make!.target)} disabled={keep.isPending} /> : null}
        {rows.groups.map((group) =>
          group.rows.length ? (
            <div key={group.label}>
              <div className="px-2.5 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-faint">{group.label}</div>
              {group.rows.map((row) => (
                <KeepRow key={row.key} icon={row.icon} label={row.label} hint={row.hint} onPick={() => pick(row.target)} disabled={keep.isPending} />
              ))}
            </div>
          ) : null,
        )}
        {rows.loading ? <div className="flex justify-center py-2"><Spinner size={12} /></div> : null}
        {!rows.loading && !rows.groups.some((group) => group.rows.length) ? <p className="px-2.5 py-1.5 text-[12px] text-muted">{rows.empty}</p> : null}
      </div>
    </div>
  );
}

function KeepRow({ icon: Icon, label, hint, onPick, disabled }: { icon: typeof FileText; label: string; hint?: string; onPick: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="option" aria-selected={false} disabled={disabled} onClick={onPick} className={cx("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover disabled:opacity-60")}>
      <Icon size={13} className="shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className="max-w-[7rem] shrink-0 truncate text-[11px] text-faint">{hint}</span> : null}
    </button>
  );
}

/** A thread's link: Code's agent with the thread open. */
export const threadHref = (id: string) => `/code?view=agent&thread=${encodeURIComponent(id)}`;

export type ThreadMenuDeps = {
  open: () => void;
  rename: (() => void) | null;
  pinned: boolean;
  togglePin: () => void;
  /** Opens the thread's folder in the editor; null when it has no folder of its own. */
  openFolder: (() => void) | null;
  /** Starts a new thread where this one works. */
  newHere: (() => void) | null;
  remove: (() => void) | null;
  stop: (() => void) | null;
  viewOnly: boolean;
};

/** A thread's right-click menu, in the sessions list and the thread's header. */
export function threadMenu(thread: CodeThread, deps: ThreadMenuDeps): MenuSpec {
  const live = Boolean(thread.last && isLive(thread.last.status));
  const lastReply = thread.last && !live ? thread.last.id : null;
  return {
    title: thread.title,
    sections: [
      {
        items: [
          { id: "open", label: "Open", icon: ExternalLink, run: deps.open },
          ...(deps.rename ? [{ id: "rename", label: "Rename", icon: Pencil, hint: "F2", run: deps.rename }] : []),
          { id: "pin", label: deps.pinned ? "Unpin" : "Pin to the top", icon: deps.pinned ? PinOff : Pin, run: deps.togglePin },
        ],
      },
      {
        items: [
          ...(deps.openFolder ? [{ id: "folder", label: "Open the folder in the editor", icon: FolderOpen, run: deps.openFolder }] : []),
          ...(deps.newHere && !deps.viewOnly ? [{ id: "new-here", label: thread.place.folder ? "New thread in this folder" : "New thread without a folder", icon: Plus, run: deps.newHere }] : []),
        ],
      },
      {
        items: [
          ...(lastReply && !deps.viewOnly
            ? [{ id: "keep", label: "Keep the last reply in Ensemble", icon: NotebookPen, submenu: () => ({ width: 320, render: (close: () => void) => <KeepPicker threadId={thread.id} jobId={lastReply} title={thread.title} announce onDone={close} /> }) }]
            : []),
          { id: "link", label: "Copy a link to the thread", icon: Link2, run: () => copyText(new URL(threadHref(thread.id), window.location.origin).toString()) },
        ],
      },
      {
        items: [
          ...(live && deps.stop && !deps.viewOnly ? [{ id: "stop", label: "Stop the agent", icon: Square, run: deps.stop }] : []),
          ...(deps.remove && !deps.viewOnly && !live
            ? [{ id: "delete", label: "Delete thread", icon: Trash2, danger: true, run: deps.remove, confirm: () => ({ title: "Delete this thread?", body: "It goes to Trash, where you can restore it. The agent's changes stay in the folder.", action: "Delete", danger: true }) }]
            : []),
        ],
      },
    ],
  };
}

export type TurnMenuDeps = {
  reply: string;
  message: string;
  threadId: string;
  jobId: string;
  title: string;
  tasks: Array<{ id: string; label: string }>;
  runId: string | null;
  reviewHref: string | null;
  quote: () => void;
  again: (() => void) | null;
  viewOnly: boolean;
  /** Goes to a page of the Hub without reloading it. */
  go: (href: string) => void;
};

/** A turn's right-click menu in the thread. */
export function turnMenu(deps: TurnMenuDeps): MenuSpec {
  return {
    title: "Turn",
    sections: [
      {
        items: [
          ...(deps.reply ? [{ id: "copy-reply", label: "Copy the reply", icon: Copy, run: () => copyText(deps.reply) }] : []),
          { id: "copy-message", label: "Copy the message", icon: Copy, run: () => copyText(deps.message) },
          ...(deps.reply && !deps.viewOnly ? [{ id: "quote", label: "Quote it in a new message", icon: Pencil, run: deps.quote }] : []),
        ],
      },
      {
        items: [
          ...(deps.reply && !deps.viewOnly
            ? [{ id: "keep", label: "Keep the reply in Ensemble", icon: NotebookPen, submenu: () => ({ width: 320, render: (close: () => void) => <KeepPicker threadId={deps.threadId} jobId={deps.jobId} title={deps.title} tasks={deps.tasks} onDone={close} /> }) }]
            : []),
          ...(deps.reviewHref ? [{ id: "review", label: "Review its changes", icon: FolderOpen, run: () => deps.go(deps.reviewHref!) }] : []),
          ...(deps.runId ? [{ id: "run", label: "Open the run", icon: ExternalLink, run: () => deps.go(`/runs?run=${deps.runId}`) }] : []),
        ],
      },
      { items: deps.again && !deps.viewOnly ? [{ id: "again", label: "Use this message again", icon: Plus, run: deps.again }] : [] },
    ],
  };
}
