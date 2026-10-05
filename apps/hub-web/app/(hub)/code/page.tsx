"use client";

import { useQuery } from "@tanstack/react-query";
import { FolderGit2, TerminalSquare } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Terminal } from "@/components/code/terminal";
import { Empty, PageHeader, SkeletonRows, Tag } from "@/components/ui";
import { api, type ReviewSummary } from "@/lib/api";
import { dateTime } from "@/lib/format";

function ReviewRow({ review }: { review: ReviewSummary }) {
  const state = review.completedAt ? { label: "Reviewed", tone: "green" as const } : review.decisions ? { label: "In review", tone: "yellow" as const } : { label: "Not reviewed", tone: "blue" as const };
  const total = Math.max(review.added + review.removed, 1);
  return (
    <Link href={`/code/review?review=${review.id}`} className="row-tile flex items-center gap-4 rounded-md border-b border-b-line px-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold">{review.title}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-muted">
          {review.repoPath.split("/").slice(-2).join("/")} · {review.branch} · local only · {review.model} · {dateTime(review.createdAt)}
          {!review.reachable ? " · checkout not found" : ""}
        </div>
      </div>
      <div className="flex w-44 flex-col items-end gap-1">
        <div className="text-[12px]">
          {review.files} file{review.files === 1 ? "" : "s"} <span className="text-ok">+{review.added}</span>{" "}
          <span className="text-danger">−{review.removed}</span>
        </div>
        <div className="flex w-full items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded bg-raised">
            <div className="h-full bg-ok" style={{ width: `${(review.added / total) * 100}%` }} />
          </div>
          <Tag tone={state.tone}>{state.label}</Tag>
        </div>
      </div>
    </Link>
  );
}

export default function CodePage() {
  const [filter, setFilter] = useState<"needs" | "reviewed" | "all">("needs");
  const [expired, setExpired] = useState(false);
  const reviews = useQuery({ queryKey: ["reviews", filter, expired], queryFn: () => api.reviews(filter, expired) });
  const repos = useQuery({ queryKey: ["code-repos"], queryFn: api.codeRepos });
  const [terminal, setTerminal] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "`") {
        event.preventDefault();
        setTerminal((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="flex h-full flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto max-w-[980px] px-10 pb-24 pt-8">
      <PageHeader
        title="Code"
        description="Review what an agent changed, one change at a time: accept keeps it, reject puts the old lines back on disk, and you can write any part yourself. Then commit and push from the same place."
        actions={
          <button type="button" className="btn" onClick={() => setTerminal(!terminal)} title="Ctrl+`">
            <TerminalSquare size={13} /> Terminal
          </button>
        }
      />
      <div className="mb-3 flex items-center gap-3 text-[13px]">
        <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} className="field py-1">
          <option value="needs">Needs review</option>
          <option value="reviewed">Reviewed</option>
          <option value="all">All</option>
        </select>
        <label className="flex items-center gap-2 text-muted">
          <input type="checkbox" checked={expired} onChange={(event) => setExpired(event.target.checked)} className="accent-[rgb(var(--accent-rgb))]" />
          Show expired (older than {reviews.data?.ttlDays ?? 14} days)
        </label>
      </div>
      {reviews.isLoading ? (
        <SkeletonRows count={3} />
      ) : (reviews.data?.reviews ?? []).length === 0 ? (
        <Empty>No agent changes waiting. Repository jobs from the Workspace land here when they finish.</Empty>
      ) : (
        <div>{reviews.data!.reviews.map((review) => <ReviewRow key={review.id} review={review} />)}</div>
      )}

      <h2 className="mb-1 mt-10 text-[17px] font-semibold">Local repositories</h2>
      <p className="mb-3 text-[12.5px] text-muted">
        Checkouts inside the Ensemble workspace and the folders in{" "}
        <Link href="/settings#terminal" className="underline underline-offset-2">
          Settings › Folders Code can use
        </Link>
        . Open one to review your own uncommitted changes, stage hunks and push.
      </p>
      {repos.isLoading ? (
        <SkeletonRows count={3} />
      ) : (repos.data?.repos ?? []).length === 0 ? (
        <Empty>No git checkouts found under {repos.data?.roots.join(", ") || "the workspace root"}.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {repos.data!.repos.map((repo) => (
            <Link key={repo} href={`/code/review?repo=${encodeURIComponent(repo)}`} className="tile flex items-center gap-2 rounded-md bg-panel px-3 py-2.5 text-[13px]">
              <FolderGit2 size={15} className="text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{repo.split("/").pop()}</span>
                <span className="block truncate font-mono text-[11px] text-faint">{repo}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
    </div>
    {terminal ? <Terminal onClose={() => setTerminal(false)} /> : null}
    </div>
  );
}
