"use client";

import { useQuery } from "@tanstack/react-query";
import { FileCode2, FolderGit2, GitBranch, GitPullRequestArrow, Laptop, ListTree, SquareArrowOutUpRight } from "lucide-react";
import Link from "next/link";
import { jobTone } from "@/components/agent/job-card";
import { RunCode } from "@/components/code/run-code";
import { usePeek } from "@/components/shell/peek";
import { Empty, SkeletonRows, Tag } from "@/components/ui";
import { api, type AgentJob } from "@/lib/api";
import { plural, relative } from "@/lib/format";

/**
 * The Code tab on Ensemble on the web, run by run. Agents work on your paired computers and their
 * changes stay there (docs/25): this lists each code run. *Review & edit* opens its review in the editor
 * through that computer (protocol 4, `computers-code.tsx`); *Open code* shows the files it changed (the
 * text the computer sent when the run ended) and its folder, read from that computer when you open it.
 */
export function DeviceChanges({ openJobId, openPath, onOpen }: { openJobId?: string | null; openPath?: string | null; onOpen?: (jobId: string | null) => void }) {
  const peek = usePeek();
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, staleTime: 30_000 });
  const board = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, refetchInterval: 15_000 });
  const paired = devices.data?.devices ?? [];
  const jobs = board.data
    ? [...board.data.running, ...board.data.waiting, ...board.data.queued, ...board.data.completed, ...board.data.stopped].filter((job) => job.kind === "code" && job.deviceId)
    : [];
  const listed = openJobId ? jobs.find((job) => job.id === openJobId) : undefined;
  // A run older than the board's lists opens from its own record.
  const single = useQuery({ queryKey: ["job", openJobId], queryFn: () => api.job(openJobId!), enabled: Boolean(openJobId && board.data && !listed) });
  const open = listed ?? single.data?.job ?? null;
  if (devices.isLoading || board.isLoading) return <SkeletonRows count={3} />;
  if (!paired.length) {
    return (
      <Empty title="No paired computer yet">
        Agents work in folders on your own computer, and their changes stay there. <Link href="/settings#devices" className="text-accent underline">Set up a paired computer</Link> with the desktop app or the{" "}
        <code className="rounded bg-raised px-1 font-mono text-[12px]">ensemble</code> command, then assign a code task to it.
      </Empty>
    );
  }
  return (
    <div>
      {open ? (
        <div className="mb-5">
          <RunCode key={open.id} job={open} initialPath={openPath} onClose={onOpen ? () => onOpen(null) : undefined} />
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap gap-2">
        {paired.map((device) => (
          <div key={device.id} className="flex min-w-0 items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-[12.5px]">
            <Laptop size={13} className="shrink-0 text-muted" />
            <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{device.name}</span>
            <span className={device.online ? "text-ok" : "text-faint"}>{device.online ? "online" : "offline"}</span>
            {device.folders.length ? <span className="truncate text-faint">· {device.folders.slice(0, 3).join(", ")}{device.folders.length > 3 ? ` +${device.folders.length - 3}` : ""}</span> : null}
          </div>
        ))}
      </div>
      {jobs.length === 0 ? (
        <Empty>No code runs on your computers in the last two weeks. Assign a code task from a task page or the Workspace.</Empty>
      ) : (
        <div className="divide-y divide-[var(--line)] rounded-md border border-line">
          {jobs.map((job) => (
            <DeviceJobRow key={job.id} job={job} active={open?.id === job.id} onOpenTask={() => peek.open(job.taskId)} onOpenCode={onOpen ? () => onOpen(job.id) : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceJobRow({ job, active, onOpenTask, onOpenCode }: { job: AgentJob; active: boolean; onOpenTask: () => void; onOpenCode?: () => void }) {
  const state = jobTone(job);
  const files = job.files ?? [];
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div className={`px-3 py-2.5 ${active ? "bg-[var(--accent-soft)]" : ""}`}>
      <div className="flex flex-wrap items-start gap-3 [overflow-wrap:anywhere]">
        <div className="min-w-0 flex-1 basis-full sm:basis-0">
          {onOpenCode ? (
            <button type="button" className="block max-w-full truncate text-left text-[14px] font-semibold hover:underline" onClick={onOpenCode}>
              {job.title}
            </button>
          ) : (
            <div className="truncate text-[14px] font-semibold">{job.title}</div>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
            <span className="inline-flex items-center gap-1">
              <Laptop size={11} /> {job.deviceName ?? "Your computer"}
            </span>
            {job.folderLabel || job.repoUrl ? (
              <span className="inline-flex items-center gap-1 font-mono text-[11.5px]">
                <FolderGit2 size={11} /> {job.folderLabel ?? job.repoUrl}
              </span>
            ) : null}
            {job.branch ? (
              <span className="inline-flex items-center gap-1 font-mono text-[11.5px]">
                <GitBranch size={11} /> {job.branch}
              </span>
            ) : null}
            <span>{job.modelUsed ?? job.model}</span>
            {job.finishedAt ? <span>{relative(job.finishedAt)}</span> : null}
          </div>
        </div>
        <Tag tone={state.tone}>{state.label}</Tag>
      </div>
      {files.length ? (
        <details className="mt-1.5 text-[12px]">
          <summary className="cursor-pointer text-muted">
            {plural(files.length, "file")} changed · <span className="text-ok">+{added}</span> <span className="text-danger">−{removed}</span>
          </summary>
          <div className="mt-1 space-y-0.5 pl-3">
            {files.map((file) => (
              <div key={file.path} className="flex items-center gap-2 font-mono text-[11.5px]">
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
                <span className="text-ok">+{file.added}</span>
                <span className="text-danger">−{file.removed}</span>
              </div>
            ))}
          </div>
        </details>
      ) : job.finishedAt ? (
        <div className="mt-1.5 text-[12px] text-faint">No file changes reported.</div>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[12px]">
        {job.deviceId && job.deviceReviewId ? (
          <Link href={`/code/review?device=${encodeURIComponent(job.deviceId)}&review=${encodeURIComponent(job.deviceReviewId)}`} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
            <GitPullRequestArrow size={12} /> Review &amp; edit
          </Link>
        ) : null}
        {onOpenCode ? (
          <button type="button" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={onOpenCode}>
            <FileCode2 size={12} /> Open code
          </button>
        ) : null}
        {job.runId ? (
          <Link href={`/runs?run=${job.runId}`} className="inline-flex items-center gap-1 text-accent hover:underline">
            <ListTree size={12} /> View run
          </Link>
        ) : null}
        <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={onOpenTask}>
          <SquareArrowOutUpRight size={12} /> Open task
        </button>
        {(job.results ?? []).map((result) =>
          result.url.startsWith("https://") ? (
            <a key={result.url} href={result.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              {result.kind === "pr" ? "Pull request" : result.kind === "commit" ? `Commit ${(result.sha ?? result.url).slice(0, 7)}` : "Branch"}
            </a>
          ) : null,
        )}
      </div>
    </div>
  );
}
