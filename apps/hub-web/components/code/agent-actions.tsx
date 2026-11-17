"use client";

/**
 * What can be done with a thread of the Code tab's agent and its turns (docs/16 §9), shared by the
 * sessions list, the thread's header and a turn's right-click: open, rename, pin, open its folder in the
 * editor, start another thread there, stop, delete, and keep a reply on a page with no model involved
 * (an agent block that says where it came from, hub-api pages/agent-output.ts).
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { CheckSquare, Copy, ExternalLink, FilePlus2, FileText, FolderOpen, Link2, NotebookPen, Pencil, Pin, PinOff, Plus, Search, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { copyText } from "@/components/context-menu/builders";
import type { MenuSpec } from "@/components/context-menu/menu-store";
import { useToast } from "@/components/toast";
import { Spinner, cx } from "@/components/ui";
import { api, type CodeThread } from "@/lib/api";
import { isLive, shortAgo } from "@/lib/code-agent";

/** Every thread, kept fresh while one works. */
export function useCodeThreads() {
  return useQuery({
    queryKey: ["code-threads"],
    queryFn: api.codeThreads,
    staleTime: 5_000,
    refetchInterval: (query) => (query.state.data?.threads.some((row) => row.last && isLive(row.last.status)) ? 3_000 : 30_000),
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

export type KeepTarget = { pageId: string } | { taskId: string } | { newPage: { title: string } };

/**
 * Keeps a turn's reply on a page. `announce`: say where it went, for a reply kept from somewhere it is
 * not on screen (the sessions list); in the thread the turn shows it itself.
 */
export function useKeepTurn(threadId: string) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ jobId, target }: { jobId: string; target: KeepTarget; announce?: boolean }) => api.keepCodeTurn(threadId, { jobId, ...target }),
    onSuccess: (result, input) => {
      void client.invalidateQueries({ queryKey: ["code-thread", threadId] });
      void client.invalidateQueries({ queryKey: ["pages"] });
      if (input.announce) toast(`Kept on ${result.page.title}.`, { action: { label: "Open", run: () => window.location.assign(result.page.href) } });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
}

/**
 * Where to keep a reply: a new page (named after the thread, or what is typed), a task the thread
 * mentioned, or any page found by its title.
 */
export function KeepPicker({ threadId, jobId, title, tasks = [], announce = false, onDone }: { threadId: string; jobId: string; title: string; tasks?: Array<{ id: string; label: string }>; announce?: boolean; onDone: () => void }) {
  const keep = useKeepTurn(threadId);
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setNeedle(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);
  const pages = useQuery({ queryKey: ["pages", "keep", needle], queryFn: () => (needle ? api.searchPages(needle) : api.pages()), staleTime: 15_000 });
  const listed = useMemo(() => (pages.data?.pages ?? []).slice(0, 40), [pages.data]);
  const matchedTasks = tasks.filter((task) => !needle || task.label.toLowerCase().includes(needle.toLowerCase()));
  const pick = (target: KeepTarget) => keep.mutate({ jobId, target, announce }, { onSuccess: onDone });
  const newTitle = query.trim() || title;
  return (
    <div className="flex w-[300px] max-w-full flex-col" data-testid="keep-picker">
      <label className="compound-field mx-1 mb-1 mt-1 flex h-8 items-center gap-1.5 rounded-md border border-line px-2">
        <Search size={13} className="shrink-0 text-faint" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              pick({ newPage: { title: newTitle.slice(0, 200) } });
            }
          }}
          placeholder="Find a page, or name a new one"
          aria-label="Find a page, or name a new one"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
        />
        {keep.isPending ? <Spinner size={12} /> : null}
      </label>
      <div className="max-h-[300px] overflow-y-auto py-1" role="listbox" aria-label="Pages">
        <KeepRow icon={FilePlus2} label={`New page “${newTitle}”`} onPick={() => pick({ newPage: { title: newTitle.slice(0, 200) } })} disabled={keep.isPending} />
        {matchedTasks.length ? <div className="px-2.5 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-faint">Mentioned tasks</div> : null}
        {matchedTasks.map((task) => (
          <KeepRow key={task.id} icon={CheckSquare} label={task.label} hint="task page" onPick={() => pick({ taskId: task.id })} disabled={keep.isPending} />
        ))}
        <div className="px-2.5 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-faint">{needle ? "Matching pages" : "Recent pages"}</div>
        {pages.isLoading ? <div className="flex justify-center py-2"><Spinner size={12} /></div> : null}
        {!pages.isLoading && !listed.length ? <p className="px-2.5 py-1.5 text-[12px] text-muted">{needle ? "No page matches." : "No pages yet."}</p> : null}
        {listed.map((page) => (
          <KeepRow key={page.id} icon={FileText} label={page.title || "Untitled"} hint={shortAgo(page.updatedAt)} onPick={() => pick({ pageId: page.id })} disabled={keep.isPending} />
        ))}
      </div>
    </div>
  );
}

function KeepRow({ icon: Icon, label, hint, onPick, disabled }: { icon: typeof FileText; label: string; hint?: string; onPick: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="option" aria-selected={false} disabled={disabled} onClick={onPick} className={cx("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover disabled:opacity-60")}>
      <Icon size={13} className="shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 text-[11px] text-faint">{hint}</span> : null}
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
            ? [{ id: "keep", label: "Keep the last reply on a page", icon: NotebookPen, submenu: () => ({ width: 320, render: (close: () => void) => <KeepPicker threadId={thread.id} jobId={lastReply} title={thread.title} announce onDone={close} /> }) }]
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
            ? [{ id: "keep", label: "Keep the reply on a page", icon: NotebookPen, submenu: () => ({ width: 320, render: (close: () => void) => <KeepPicker threadId={deps.threadId} jobId={deps.jobId} title={deps.title} tasks={deps.tasks} onDone={close} /> }) }]
            : []),
          ...(deps.reviewHref ? [{ id: "review", label: "Review its changes", icon: FolderOpen, run: () => deps.go(deps.reviewHref!) }] : []),
          ...(deps.runId ? [{ id: "run", label: "Open the run", icon: ExternalLink, run: () => deps.go(`/runs?run=${deps.runId}`) }] : []),
        ],
      },
      { items: deps.again && !deps.viewOnly ? [{ id: "again", label: "Use this message again", icon: Plus, run: deps.again }] : [] },
    ],
  };
}
