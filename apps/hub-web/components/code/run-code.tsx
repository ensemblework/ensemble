"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File, FileCode2, Folder, FolderOpen, Laptop, ListTree, Maximize2, Minimize2, RefreshCw, Server, SquareArrowOutUpRight, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Spinner, cx } from "@/components/ui";
import { api, type AgentJob, type FolderEntry, type JobFileEntry } from "@/lib/api";
import { fileEditor, warmFileEditor } from "@/lib/warm";

type Selected = { path: string; live: boolean };

const STATUS: Record<JobFileEntry["status"], { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "text-ok", label: "Added" },
  modified: { letter: "M", className: "text-warn", label: "Modified" },
  deleted: { letter: "D", className: "text-danger", label: "Deleted" },
};

function size(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function useEditor() {
  const [Editor, setEditor] = useState(() => fileEditor);
  useEffect(() => {
    if (Editor) return;
    let live = true;
    // If the editor chunk cannot load, the file still shows as plain text.
    void warmFileEditor()
      .then(() => {
        if (live && fileEditor) setEditor(() => fileEditor);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [Editor]);
  return Editor;
}

const noop = () => undefined;

/**
 * A task run's code, like an editor: the files the agent changed first (their text as the computer
 * sent it when the run ended), then the task's whole folder, read from the computer one folder or
 * file at a time when you open it. Read-only. Full screen fills the window.
 */
export function RunCode({ job, initialPath, onClose }: { job: AgentJob; initialPath?: string | null; onClose?: () => void }) {
  const [full, setFull] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(initialPath ? { path: initialPath, live: false } : null);
  const [browsing, setBrowsing] = useState(false);
  const files = useQuery({ queryKey: ["job-files", job.id], queryFn: () => api.jobFiles(job.id) });
  const changed = files.data?.files ?? [];
  const live = files.data?.live;
  const textBlocked = files.data?.text && !files.data.text.available ? files.data.text.reason : null;

  // A file named in the address (from the run or the task page) opens even when this view is already open.
  useEffect(() => {
    if (initialPath) setSelected({ path: initialPath, live: false });
  }, [initialPath]);
  const where = job.deviceId ? job.deviceName ?? "your computer" : "this computer";

  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  // The first changed file with text opens by itself.
  useEffect(() => {
    if (selected || !changed.length) return;
    const first = changed.find((file) => file.stored) ?? changed.find((file) => file.status !== "deleted");
    if (first) setSelected({ path: first.path, live: false });
  }, [changed, selected]);

  return (
    <div
      className={cx("flex min-h-0 flex-col overflow-hidden border border-line bg-bg", full ? "fixed inset-0 z-[70]" : "h-[72vh] rounded-lg")}
      data-testid="run-code"
      role={full ? "dialog" : undefined}
      aria-label={full ? `Code of ${job.title}` : undefined}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-raised px-3 py-2">
        <FileCode2 size={15} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold">{job.title}</div>
          <div className="flex items-center gap-1.5 truncate text-[11.5px] text-muted">
            {job.deviceId ? <Laptop size={11} /> : <Server size={11} />}
            <span className="truncate">
              {where}
              {job.folderLabel ? ` · ${job.folderLabel}` : ""}
              {job.branch ? ` · ${job.branch}` : ""}
            </span>
          </div>
        </div>
        {job.runId ? (
          <Link href={`/runs?run=${job.runId}`} className="btn-ghost shrink-0 gap-1 px-2 py-0.5 text-[12px]" title="Every step and tool call">
            <ListTree size={12} /> Run
          </Link>
        ) : null}
        <Link href={`/tasks/${job.taskId}`} className="btn-ghost shrink-0 gap-1 px-2 py-0.5 text-[12px]">
          <SquareArrowOutUpRight size={12} /> Task
        </Link>
        <button type="button" className="icon-btn shrink-0" onClick={() => setFull(!full)} title={full ? "Exit full screen (Esc)" : "Full screen"} aria-label={full ? "Exit full screen" : "Full screen"}>
          {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        {onClose ? (
          <button type="button" className="icon-btn shrink-0" onClick={onClose} title="Close" aria-label="Close">
            <X size={15} />
          </button>
        ) : null}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(200px,280px)_1fr]">
        <aside className="min-h-0 overflow-y-auto border-r border-line bg-panel py-2 text-[12.5px]" aria-label="Files">
          <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Changed by the agent{changed.length ? ` · ${changed.length}` : ""}</div>
          {textBlocked ? <div className="px-3 pb-1.5 text-[11.5px] text-muted">{textBlocked}</div> : null}
          {files.isLoading ? (
            <div className="px-3 py-1">
              <Spinner size={12} />
            </div>
          ) : files.error ? (
            <div className="px-3 py-1 text-danger">{(files.error as Error).message}</div>
          ) : changed.length === 0 ? (
            <div className="px-3 py-1 text-muted">{job.finishedAt ? "No files changed (a cloned repository is not counted)." : "Shows when the run ends."}</div>
          ) : (
            <ul>
              {changed.map((file) => {
                const status = STATUS[file.status];
                const parts = file.path.split("/");
                const name = parts.pop();
                const active = selected?.path === file.path && !selected.live;
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => file.status !== "deleted" && setSelected({ path: file.path, live: false })}
                      className={cx("flex w-full min-w-0 items-center gap-1.5 px-3 py-[3px] text-left hover:bg-hover", active && "bg-[var(--accent-soft)]", file.status === "deleted" && "cursor-default opacity-60")}
                      title={`${status.label}: ${file.path}${file.skipped ? ` (${file.skipped})` : ""}`}
                    >
                      <span className={cx("w-3 shrink-0 font-mono text-[11px] font-semibold", status.className)}>{status.letter}</span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className={cx(file.status === "deleted" && "line-through")}>{name}</span>
                        {parts.length ? <span className="ml-1.5 text-[11px] text-faint">{parts.join("/")}</span> : null}
                      </span>
                      {file.added || file.removed ? (
                        <span className="shrink-0 font-mono text-[10.5px]">
                          <span className="text-ok">+{file.added}</span> <span className="text-danger">−{file.removed}</span>
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-3 border-t border-line pt-2">
            <button
              type="button"
              className="flex w-full items-center gap-1 px-3 pb-1 text-left text-[11px] font-semibold uppercase tracking-wide text-faint hover:text-ink"
              onClick={() => setBrowsing(!browsing)}
              aria-expanded={browsing}
            >
              <ChevronRight size={11} className={cx("transition-transform", browsing && "rotate-90")} /> Folder on {where}
            </button>
            {browsing ? (
              live && !live.available ? (
                <div className="px-3 py-1 text-[12px] text-muted">{live.reason}</div>
              ) : (
                <FolderNode jobId={job.id} path="" depth={0} selected={selected} onOpen={(path) => setSelected({ path, live: true })} />
              )
            ) : (
              <div className="px-3 text-[11.5px] text-faint">Read from {where} when you open it. Git's own files and secrets files are never shown.</div>
            )}
          </div>
        </aside>
        <FileView jobId={job.id} selected={selected} where={where} liveAvailable={live?.available ?? false} onReadLive={(path) => setSelected({ path, live: true })} />
      </div>
    </div>
  );
}

function FolderNode({ jobId, path, depth, selected, onOpen }: { jobId: string; path: string; depth: number; selected: Selected | null; onOpen: (path: string) => void }) {
  const listing = useQuery({ queryKey: ["job-tree", jobId, path], queryFn: () => api.jobTree(jobId, path), staleTime: 15_000, retry: false });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (listing.isLoading) {
    return (
      <div className="py-1" style={{ paddingLeft: 12 + depth * 12 }}>
        <Spinner size={11} />
      </div>
    );
  }
  if (listing.error) {
    return (
      <div className="py-1 pr-3 text-[12px] text-danger" style={{ paddingLeft: 12 + depth * 12 }}>
        {(listing.error as Error).message}
      </div>
    );
  }
  const data = listing.data?.listing;
  if (!data) return null;
  return (
    <ul>
      {data.entries.map((entry: FolderEntry) => {
        const child = path ? `${path}/${entry.name}` : entry.name;
        const isDir = entry.kind === "dir";
        // A link that leads outside the folder (or nowhere) is shown, never opened.
        const outside = entry.kind === "link";
        const expanded = Boolean(open[entry.name]);
        const active = selected?.live && selected.path === child;
        return (
          <li key={entry.name}>
            <button
              type="button"
              disabled={outside}
              title={outside ? "A link that leads outside the task's folder" : undefined}
              onClick={() => (isDir ? setOpen({ ...open, [entry.name]: !expanded }) : onOpen(child))}
              className={cx("flex w-full min-w-0 items-center gap-1 py-[3px] pr-3 text-left hover:bg-hover disabled:cursor-default disabled:opacity-50", active && "bg-[var(--accent-soft)]")}
              style={{ paddingLeft: 12 + depth * 12 }}
              aria-expanded={isDir ? expanded : undefined}
            >
              {isDir ? <ChevronRight size={11} className={cx("shrink-0 text-faint transition-transform", expanded && "rotate-90")} /> : <span className="w-[11px] shrink-0" />}
              {isDir ? expanded ? <FolderOpen size={12} className="shrink-0 text-muted" /> : <Folder size={12} className="shrink-0 text-muted" /> : <File size={12} className="shrink-0 text-faint" />}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {!isDir && entry.size != null ? <span className="shrink-0 text-[10.5px] text-faint">{size(entry.size)}</span> : null}
            </button>
            {isDir && expanded ? <FolderNode jobId={jobId} path={child} depth={depth + 1} selected={selected} onOpen={onOpen} /> : null}
          </li>
        );
      })}
      {data.truncated ? <li className="py-1 text-[11px] text-faint" style={{ paddingLeft: 12 + depth * 12 }}>Only the first 1,000 entries.</li> : null}
      {data.hidden ? (
        <li className="py-0.5 text-[11px] text-faint" style={{ paddingLeft: 12 + depth * 12 }}>
          {data.hidden} hidden (git's own files, secrets files)
        </li>
      ) : null}
    </ul>
  );
}

function FileView({ jobId, selected, where, liveAvailable, onReadLive }: { jobId: string; selected: Selected | null; where: string; liveAvailable: boolean; onReadLive: (path: string) => void }) {
  const Editor = useEditor();
  const file = useQuery({
    queryKey: ["job-file", jobId, selected?.path, selected?.live],
    queryFn: () => api.jobFile(jobId, selected!.path, selected!.live),
    enabled: Boolean(selected),
    staleTime: 30_000,
    retry: false,
  });
  const content = file.data?.file.content ?? "";
  const lines = useMemo(() => (content ? content.split("\n").length : 0), [content]);
  if (!selected) {
    return <div className="flex items-center justify-center p-6 text-center text-[13px] text-muted">Pick a file. The agent&apos;s changes are listed first; the folder opens from {where}.</div>;
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-[12px]">
        <span className="min-w-0 flex-1 truncate font-mono">{selected.path}</span>
        {file.data ? (
          <span className="shrink-0 text-faint">
            {file.data.source === "stored" ? "as the run left it" : `read from ${where}`}
            {file.data.file.size ? ` · ${size(file.data.file.size)}` : ""}
            {lines ? ` · ${lines} lines` : ""}
          </span>
        ) : null}
        {liveAvailable && file.data?.source === "stored" ? (
          <button type="button" className="btn-ghost shrink-0 gap-1 px-1.5 py-0 text-[11.5px]" onClick={() => onReadLive(selected.path)} title={`Read it now from ${where}`}>
            <RefreshCw size={11} /> Now
          </button>
        ) : null}
      </div>
      {file.data?.file.truncated ? <div className="shrink-0 border-b border-line bg-raised px-3 py-1 text-[11.5px] text-muted">Showing the first part of a large file.</div> : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {file.isLoading ? (
          <div className="p-4">
            <Spinner />
          </div>
        ) : file.error ? (
          <div className="p-4 text-[13px] text-danger">{(file.error as Error).message}</div>
        ) : file.data?.file.binary ? (
          <div className="p-4 text-[13px] text-muted">A binary file ({size(file.data.file.size)}). It is not shown.</div>
        ) : Editor ? (
          <Editor path={selected.path} value={content} readOnly onChange={noop} onCursor={noop} onSave={noop} />
        ) : (
          <pre className="whitespace-pre-wrap p-3 font-mono text-[12px] leading-5">{content}</pre>
        )}
      </div>
    </div>
  );
}
