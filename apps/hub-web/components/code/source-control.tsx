"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleX,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";
import { useToast } from "../toast";
import { Spinner, cx } from "../ui";

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <ChevronRight size={12} className={cx("transition-transform", open && "rotate-90")} />
        {title}
        <span className="ml-auto rounded bg-raised px-1.5 font-normal normal-case">{count}</span>
      </button>
      {open ? children : null}
    </div>
  );
}

export function SourceControl({ repo, onOpenFile }: { repo: string; onOpenFile: (path: string) => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [message, setMessage] = useState("");
  const [showActions, setShowActions] = useState(true);
  const scm = useQuery({ queryKey: ["scm", repo], queryFn: () => api.scm(repo), refetchInterval: 15_000 });
  const actions = useQuery({ queryKey: ["actions", repo], queryFn: () => api.actions(repo), enabled: showActions, refetchInterval: 60_000 });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["scm", repo] });
    void client.invalidateQueries({ queryKey: ["code-source"] });
    void client.invalidateQueries({ queryKey: ["code-diff"] });
  };
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  if (scm.isLoading) return <div className="p-3"><Spinner /></div>;
  if (!scm.data) return <div className="p-3 text-[12px] text-muted">{(scm.error as Error | null)?.message ?? "Not a git repository."}</div>;
  const status = scm.data;
  const nothingStaged = status.staged.length === 0;

  return (
    <div className="space-y-2 p-2 text-[12.5px]">
      <div className="flex items-center gap-1.5 px-1">
        <GitBranch size={13} className="text-muted" />
        <span className="font-medium">{status.branch}</span>
        {status.ahead ? <span className="flex items-center text-muted"><ArrowUp size={11} />{status.ahead}</span> : null}
        {status.behind ? <span className="flex items-center text-muted"><ArrowDown size={11} />{status.behind}</span> : null}
        <div className="flex-1" />
        <button type="button" className="icon-btn h-6 w-6" title="Refresh" onClick={refresh}>
          <RefreshCw size={12} />
        </button>
        <button type="button" className="icon-btn h-6 w-6" title="Pull (fast-forward only)" onClick={() => run.mutate(() => api.pull(repo))}>
          <ArrowDown size={13} />
        </button>
        <button type="button" className="icon-btn h-6 w-6" title="Push to origin" onClick={() => run.mutate(() => api.push(repo).then(() => toast("Pushed.", { tone: "ok" })))}>
          <ArrowUp size={13} />
        </button>
      </div>
      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        rows={2}
        placeholder={`Message (commit on "${status.branch}")`}
        className="field w-full text-[12.5px]"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && message.trim()) {
            run.mutate(() => api.commit(repo, message.trim(), nothingStaged).then(() => setMessage("")));
          }
        }}
      />
      <button
        type="button"
        className="btn-primary w-full justify-center"
        disabled={!message.trim() || run.isPending || (nothingStaged && status.unstaged.length === 0)}
        onClick={() => run.mutate(() => api.commit(repo, message.trim(), nothingStaged).then(() => setMessage("")))}
      >
        <GitCommitHorizontal size={13} />
        {nothingStaged ? "Commit all" : "Commit staged"}
      </button>

      <Group title="Staged changes" count={status.staged.length}>
        {status.staged.map((entry) => (
          <div key={`s-${entry.path}`} className="row-tile group flex items-center gap-1 rounded px-1.5 py-0.5">
            <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onOpenFile(entry.path)}>{entry.path}</button>
            <span className="text-2xs text-faint">{entry.index}</span>
            <button type="button" className="icon-btn h-5 w-5 opacity-0 group-hover:opacity-100" title="Unstage" onClick={() => run.mutate(() => api.unstage(repo, [entry.path]))}>
              <Minus size={11} />
            </button>
          </div>
        ))}
      </Group>
      <Group title="Changes" count={status.unstaged.length + status.untracked.length}>
        {[...status.unstaged, ...status.untracked].map((entry) => (
          <div key={`u-${entry.path}`} className="row-tile group flex items-center gap-1 rounded px-1.5 py-0.5">
            <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onOpenFile(entry.path)}>{entry.path}</button>
            <span className="text-2xs text-faint">{entry.index === "?" ? "U" : entry.worktree}</span>
            {entry.index !== "?" ? (
              <button
                type="button"
                className="icon-btn h-5 w-5 opacity-0 group-hover:opacity-100"
                title="Discard changes"
                onClick={() => window.confirm(`Discard your changes to ${entry.path}? This cannot be undone.`) && run.mutate(() => api.discard(repo, [entry.path]))}
              >
                <Undo2 size={11} />
              </button>
            ) : null}
            <button type="button" className="icon-btn h-5 w-5 opacity-0 group-hover:opacity-100" title="Stage" onClick={() => run.mutate(() => api.stage(repo, [entry.path]))}>
              <Plus size={11} />
            </button>
          </div>
        ))}
      </Group>
      <Group title="Recent commits" count={status.log.length}>
        {status.log.slice(0, 8).map((commit) => (
          <div key={commit.sha} className="px-1.5 py-0.5" title={`${commit.sha}\n${commit.author}`}>
            <div className="truncate">{commit.subject}</div>
            <div className="text-2xs text-faint">{commit.sha.slice(0, 7)} · {commit.author} · {commit.when}</div>
          </div>
        ))}
      </Group>
      <div>
        <button type="button" onClick={() => setShowActions(!showActions)} className="flex w-full items-center gap-1 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
          <ChevronRight size={12} className={cx("transition-transform", showActions && "rotate-90")} />
          GitHub Actions {status.github ? <span className="font-normal normal-case text-faint">· {status.github}</span> : null}
        </button>
        {showActions ? (
          actions.isLoading ? (
            <div className="px-2"><Spinner size={12} /></div>
          ) : actions.data && !actions.data.available ? (
            <div className="px-2 text-[12px] text-muted">{actions.data.reason}</div>
          ) : actions.data && actions.data.available ? (
            actions.data.runs.length === 0 ? (
              <div className="px-2 text-[12px] text-muted">No workflow runs on this branch.</div>
            ) : (
              actions.data.runs.map((runRow) => {
                const Icon = runRow.status !== "completed" ? CircleDot : runRow.conclusion === "success" ? CircleCheck : CircleX;
                return (
                  <a key={runRow.id} href={runRow.url} target="_blank" rel="noreferrer" className="row-tile flex items-center gap-1.5 rounded px-1.5 py-1">
                    <Icon size={12} className={runRow.status !== "completed" ? "pulse-dot text-warn" : runRow.conclusion === "success" ? "text-ok" : "text-danger"} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{runRow.title}</span>
                      <span className="block text-2xs text-faint">{runRow.workflow} · {runRow.event} · {relative(runRow.createdAt)}</span>
                    </span>
                    <ExternalLink size={11} className="text-faint" />
                  </a>
                );
              })
            )
          ) : null
        ) : null}
      </div>
    </div>
  );
}
