"use client";

/**
 * Rows Code's Welcome and Explorer share: an agent change to review, a repository (named by
 * `lib/code-repos.ts`, never by a folder id), and a section that folds open and closed.
 */
import { ChevronRight, FolderGit2, GitBranch, Laptop } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { cx } from "@/components/ui";
import type { ReviewSummary } from "@/lib/api";
import { repoSecond, shortBranch, type RepoView } from "@/lib/code-repos";
import { plural, relative } from "@/lib/format";
import { usePersistentState } from "@/lib/prefs";

export function reviewState(review: Pick<ReviewSummary, "completedAt" | "decisions">): { label: string; dot: string } {
  if (review.completedAt) return { label: "Reviewed", dot: "bg-ok" };
  if (review.decisions) return { label: "In review", dot: "bg-warn" };
  return { label: "Not reviewed", dot: "bg-accent" };
}

export function Lines({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cx("shrink-0 font-mono text-[11px] tabular-nums", className)} aria-label={`${added} lines added, ${removed} removed`}>
      <span className="text-ok">+{added}</span> <span className="text-danger">−{removed}</span>
    </span>
  );
}

/** An agent change to review: its task, then where and how big. */
export function ReviewItem({ review, repo, href, where, compact = false }: { review: ReviewSummary; repo: string; href: string; where?: string | null; compact?: boolean }) {
  const state = reviewState(review);
  const meta = [repo, shortBranch(review.branch), compact ? null : plural(review.files, "file"), compact ? null : review.model, where ?? null, relative(review.createdAt)].filter(Boolean);
  return (
    <Link href={href} className="group flex min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover focus-visible:bg-hover" title={`${review.title} — ${state.label}`}>
      <span className={cx("mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full", state.dot)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{review.title}</span>
          {compact ? null : <Lines added={review.added} removed={review.removed} />}
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-[11.5px] text-muted">
          <span className="min-w-0 flex-1 truncate">
            {meta.join(" · ")}
            {review.reachable === false ? " · checkout not found" : ""}
          </span>
          {compact ? <Lines added={review.added} removed={review.removed} className="text-[10.5px]" /> : null}
        </span>
      </span>
    </Link>
  );
}

/** A repository: its name, then its branch and what else tells it apart. */
export function RepoItem({ repo, href, where, dense = false }: { repo: RepoView; href: string; where?: string | null; dense?: boolean }) {
  const branch = shortBranch(repo.branch);
  const second = repoSecond(repo, where);
  return (
    <Link
      href={href}
      title={repo.kind === "run" ? repo.name : repo.path}
      className={cx("flex min-w-0 items-center gap-2 rounded-md px-2 hover:bg-hover focus-visible:bg-hover", dense ? "py-1" : "py-1.5")}
    >
      <FolderGit2 size={14} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ink">{repo.name}</span>
        {second ? (
          <span className="flex min-w-0 items-center gap-1 truncate text-[11.5px] text-muted">
            {branch && repo.kind !== "run" ? <GitBranch size={10} className="shrink-0" /> : null}
            <span className="truncate">{second}</span>
          </span>
        ) : null}
      </span>
      {repo.others.length ? (
        <span className="shrink-0 rounded bg-raised px-1 text-[10.5px] tabular-nums text-muted" title={`${plural(repo.others.length + 1, "checkout")} like this one; this is the newest`}>
          ×{repo.others.length + 1}
        </span>
      ) : null}
    </Link>
  );
}

/** A heading that folds its rows away, like a section of VS Code's Explorer. `persist` keeps it folded across visits. */
export function Fold({ title, count, open: initial = true, children, actions, icon, persist }: { title: ReactNode; count?: number; open?: boolean; children: ReactNode; actions?: ReactNode; icon?: ReactNode; persist?: string }) {
  const [local, setLocal] = useState(initial);
  const [saved, setSaved] = usePersistentState<Record<string, boolean>>("ensemble.code.folds", {});
  const open = persist ? saved[persist] ?? initial : local;
  const setOpen = (next: boolean) => (persist ? setSaved((current) => ({ ...current, [persist]: next })) : setLocal(next));
  return (
    <section className="min-w-0">
      <div className="group flex h-7 items-center gap-1 pr-1.5">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1 pl-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-ink" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={12} className={cx("shrink-0 transition-transform", open && "rotate-90")} />
          {icon}
          <span className="min-w-0 truncate">{title}</span>
          {count !== undefined ? <span className="ml-1 rounded bg-raised px-1.5 font-normal normal-case tracking-normal tabular-nums">{count}</span> : null}
        </button>
        {actions}
      </div>
      {open ? <div className="pb-2">{children}</div> : null}
    </section>
  );
}

/** Repositories, with run checkouts folded away under their own heading. */
export function RepoList({ repos, hrefOf, empty }: { repos: RepoView[]; hrefOf: (path: string) => string; empty: ReactNode }) {
  const folders = repos.filter((repo) => repo.kind !== "run");
  const runs = repos.filter((repo) => repo.kind === "run");
  const runCount = runs.reduce((sum, repo) => sum + 1 + repo.others.length, 0);
  if (!repos.length) return <div className="px-3 py-1 text-[12.5px] text-muted">{empty}</div>;
  return (
    <div className="space-y-0.5 px-1">
      {folders.map((repo) => (
        <RepoItem key={repo.path} repo={repo} href={hrefOf(repo.path)} dense />
      ))}
      {runs.length ? (
        <Fold title="Run checkouts" count={runCount} open={false}>
          {runs.map((repo) => (
            <RepoItem key={repo.path} repo={repo} href={hrefOf(repo.path)} dense />
          ))}
        </Fold>
      ) : null}
    </div>
  );
}

export function InlineError({ error, retry, where }: { error: unknown; retry: () => void; where?: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 text-[12.5px]" role="alert">
      <span className="min-w-0 text-danger [overflow-wrap:anywhere]">
        {where ? `${where}: ` : ""}
        {(error as Error)?.message ?? "Could not load."}
      </span>
      <button type="button" className="btn-ghost px-1.5 py-0 text-[12px]" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

export function ComputerName({ name, online }: { name: string; online: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Laptop size={12} className="shrink-0" />
      <span className="min-w-0 truncate normal-case tracking-normal">{name}</span>
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", online ? "bg-ok" : "bg-faint")} aria-label={online ? "online" : "offline"} />
    </span>
  );
}
