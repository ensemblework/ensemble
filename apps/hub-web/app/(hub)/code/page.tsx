"use client";

import { useQuery } from "@tanstack/react-query";
import { FolderGit2, TerminalSquare } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ComputersCode } from "@/components/code/computers-code";
import { DeviceChanges } from "@/components/code/device-changes";
import { Terminal } from "@/components/code/terminal";
import { useSpaceAccess } from "@/lib/access";
import { ShareButton } from "@/components/sharing/share-dialog";
import { Empty, PageHeader, QueryError, SkeletonRows, Tag } from "@/components/ui";
import { ApiError, api, hostOnly, type ReviewSummary } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useHostCode } from "@/lib/use-module";

function ReviewRow({ review }: { review: ReviewSummary }) {
  const state = review.completedAt ? { label: "Reviewed", tone: "green" as const } : review.decisions ? { label: "In review", tone: "yellow" as const } : { label: "Not reviewed", tone: "blue" as const };
  const total = Math.max(review.added + review.removed, 1);
  return (
    <Link href={`/code/review?review=${review.id}`} className="row-tile flex flex-col items-stretch gap-3 rounded-md border-b border-b-line px-3 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold">{review.title}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-muted">
          {review.repoPath.split("/").slice(-2).join("/")} · {review.branch} · local only · {review.model} · {dateTime(review.createdAt)}
          {!review.reachable ? " · checkout not found" : ""}
        </div>
      </div>
      <div className="flex w-full flex-col items-end gap-1 sm:w-44 sm:shrink-0">
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
  const params = useSearchParams();
  const router = useRouter();
  const [filter, setFilter] = useState<"needs" | "reviewed" | "all">("needs");
  const [expired, setExpired] = useState(false);
  const hostCode = useHostCode();
  const reviews = useQuery({ queryKey: ["reviews", filter, expired], queryFn: () => api.reviews(filter, expired), enabled: hostCode !== false });
  const repos = useQuery({ queryKey: ["code-repos"], queryFn: api.codeRepos, enabled: hostCode !== false });
  // Ensemble on the web: this server's folders belong to its operator; your agents' changes are on your computers.
  // The shell says so up front; the API's refusal is the fallback while it has not.
  const onComputers = hostCode === false || hostOnly(reviews.error);
  const loading = !onComputers && (reviews.isPending || repos.isPending);
  const [terminal, setTerminal] = useState(false);
  const scrolledSection = useRef<string|null>(null);
  useEffect(() => {
    const section = window.location.hash.slice(1);
    if (loading || !["reviews", "local-repositories"].includes(section) || scrolledSection.current === section) return;
    document.getElementById(section)?.scrollIntoView({ block:"start" });
    scrolledSection.current = section;
  }, [loading]);
  const access = useSpaceAccess();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "`" && !access.guest) {
        event.preventDefault();
        setTerminal((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [access.guest]);
  return (
    <div className="flex h-full flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto max-w-[980px] px-4 pb-24 pt-8 sm:px-10">
      <PageHeader
        title="Code"
        description={
          access.guest
            ? `What the agents changed in ${access.owner ?? "this"}'s space. View only: accepting, rejecting, editing and pushing stay with them.`
            : onComputers
              ? "The code on your paired computers: review what an agent changed (accept keeps it, reject puts the old lines back), edit any file, commit and push, and use the terminal, unlocked with your passkey. The code stays on that computer."
              : "Review what an agent changed, one change at a time: accept keeps it, reject puts the old lines back on disk, and you can write any part yourself. Then commit and push from the same place."
        }
        actions={
          access.guest || onComputers ? null : (
            <span className="flex items-center gap-2">
              {shell.data?.space ? <ShareButton target={{ kind: "code", resourceId: shell.data.space.id, title: "Code" }} /> : null}
              <button type="button" className="btn" onClick={() => setTerminal(!terminal)} title="Ctrl+`">
                <TerminalSquare size={13} /> Terminal
              </button>
            </span>
          )
        }
      />
      {onComputers ? (
        <>
          <ComputersCode />
          <h2 id="reviews" className="mb-1 scroll-mt-4 text-[17px] font-semibold">Runs on your computers</h2>
          <DeviceChanges
            openJobId={params.get("job")}
            openPath={params.get("file")}
            onOpen={(jobId) => router.replace(jobId ? `/code?job=${jobId}` : "/code", { scroll: false })}
          />
        </>
      ) : (
      <>
      <div id="reviews" className="mb-3 flex scroll-mt-4 flex-wrap items-center gap-3 text-[13px]">
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
      {reviews.error ? (
        <QueryError error={reviews.error} retry={() => void reviews.refetch()}>
          {reviews.error instanceof ApiError && reviews.error.status === 403 ? <Link href="/settings#devices" className="text-accent underline">Set up a paired computer</Link> : null}
        </QueryError>
      ) : reviews.isLoading ? (
        <SkeletonRows count={3} />
      ) : (reviews.data?.reviews ?? []).length === 0 ? (
        <Empty>No agent changes waiting. Repository jobs from the Workspace land here when they finish.</Empty>
      ) : (
        <div>{reviews.data!.reviews.map((review) => <ReviewRow key={review.id} review={review} />)}</div>
      )}
      </>
      )}

      {hostOnly(repos.error) ? null : (
      <>
      <h2 id="local-repositories" className="mb-1 mt-10 scroll-mt-4 text-[17px] font-semibold">Local repositories</h2>
      <p className="mb-3 text-[12.5px] text-muted">
        Checkouts inside the Ensemble workspace and the folders in{" "}
        <Link href="/settings#terminal" className="underline underline-offset-2">
          Settings › Folders Code can use
        </Link>
        . Open one to review your own uncommitted changes, stage hunks and push.
      </p>
      {repos.error ? (
        <QueryError error={repos.error} retry={() => void repos.refetch()}>
          {repos.error instanceof ApiError && repos.error.status === 403 ? <Link href="/settings#devices" className="text-accent underline">Set up a paired computer</Link> : null}
        </QueryError>
      ) : repos.isLoading ? (
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
      </>
      )}
    </div>
    </div>
    {terminal && !access.guest && !onComputers ? <Terminal onClose={() => setTerminal(false)} /> : null}
    </div>
  );
}
