"use client";

/**
 * Commit and pull request in the Code tab (docs/16 §3). In a review: the files this run changed
 * (ticked) and your own changes (not ticked), so work you had before the run stays out unless you
 * tick it. A subject with the 50/72 guide, a Markdown description with Write | Preview, and
 * `Co-authored-by` when the agent's files are included. The commit holds exactly the ticked files,
 * as they are on disk, with hooks off. Pushing straight to the default branch asks first. A pull
 * request starts from the repository's template, or the agent's report. Drafts are kept per run.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, GitCommitHorizontal, GitPullRequestArrow, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MarkdownText } from "@/components/markdown-text";
import { useToast } from "@/components/toast";
import { Spinner, cx } from "@/components/ui";
import { confirmAction } from "@/components/ask-dialog";
import { useCodeApi, type Source } from "@/lib/code-target";
import { usePersistentState } from "@/lib/prefs";

type Draft = { subject: string; body: string; ticked: string[] | null; coAuthor: boolean; prTitle: string; prBody: string | null; base: string; prDraft: boolean };

const EMPTY: Draft = { subject: "", body: "", ticked: null, coAuthor: true, prTitle: "", prBody: null, base: "", prDraft: false };

export function commitMessage(subject: string, body: string, coAuthor: string | null): string {
  const parts = [subject.trim()];
  if (body.trim()) parts.push(body.trim());
  if (coAuthor) parts.push(coAuthor);
  return parts.join("\n\n");
}

/** The 50/72 guide: a subject up to 50 characters is good, past 72 too long; body lines up to 72. */
export function subjectTone(length: number): "ok" | "warn" | "danger" {
  return length <= 50 ? "ok" : length <= 72 ? "warn" : "danger";
}

export function CommitPanel({ source, draftKey, beforeCommit, pending = 0 }: { source: Source; draftKey: string; beforeCommit: () => Promise<unknown>; pending?: number }) {
  const { code, key } = useCodeApi();
  const client = useQueryClient();
  const toast = useToast();
  const plan = useQuery({ queryKey: ["commit-plan", key, source], queryFn: () => code.commitPlan(source), refetchInterval: 15_000, retry: false });
  const [draft, setDraft] = usePersistentState<Draft>(`ensemble.code.draft.${draftKey}`, EMPTY);
  const [preview, setPreview] = useState(false);
  const [pr, setPr] = useState<{ url: string; number: number } | null>(null);
  const data = plan.data;
  const update = (change: Partial<Draft>) => setDraft({ ...draft, ...change });

  const all = useMemo(() => [...(data?.run ?? []), ...(data?.before ?? [])], [data]);
  // Ticked by default: the run's own files. Your earlier work stays out until you tick it.
  const ticked = useMemo(() => new Set((draft.ticked ?? data?.run ?? []).filter((path) => all.includes(path))), [draft.ticked, data, all]);
  const includesRun = (data?.run ?? []).some((path) => ticked.has(path));
  const coAuthor = includesRun && draft.coAuthor ? `Co-authored-by: Ensemble agent${data?.model ? ` (${data.model})` : ""} <agent@ensemble.local>` : null;
  const longLines = draft.body.split("\n").filter((line) => line.length > 72).length;

  useEffect(() => {
    if (data && !draft.base && data.defaultBranch) update({ base: data.defaultBranch });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.defaultBranch]);

  const refresh = () => {
    for (const query of [["commit-plan", key, source], ["scm"], ["code-source", key, source], ["code-progress", key, source]]) void client.invalidateQueries({ queryKey: query });
  };
  const commit = useMutation({
    mutationFn: async () => {
      // Committing the agent's files while some of its changes are still undecided asks first.
      if (includesRun && pending > 0) {
        const yes = await confirmAction({ title: `${pending} of the agent's changes are not reviewed yet`, body: "Commit them as they are on disk?", confirm: "Commit anyway" });
        if (!yes) return null;
      }
      await beforeCommit();
      return code.commitPaths(source, [...ticked], commitMessage(draft.subject, draft.body, coAuthor));
    },
    onSuccess: (result) => {
      if (!result) return;
      toast(`Committed ${result.commit.slice(0, 7)} on ${result.branch}.`, { tone: "ok" });
      update({ subject: "", body: "", ticked: null, prTitle: draft.prTitle || draft.subject });
      refresh();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const push = useMutation({
    mutationFn: async () => {
      await beforeCommit();
      const scm = await code.scm((await code.codeSource(source)).repo);
      if (scm.defaultBranch && scm.branch === scm.defaultBranch) {
        const yes = await confirmAction({ title: `Push straight to ${scm.branch}?`, body: `${scm.branch} is this repository's default branch. Most changes go on a branch of their own and arrive through a pull request.`, confirm: `Push to ${scm.branch}` });
        if (!yes) return null;
      }
      return code.push(scm.repo);
    },
    onSuccess: (result) => {
      if (result) toast("Pushed.", { tone: "ok" });
      refresh();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const openPr = useMutation({
    mutationFn: () => code.pullRequest(source, { title: draft.prTitle.trim() || draft.subject.trim(), body: draft.prBody ?? data?.template ?? data?.proposal ?? "", base: draft.base, draft: draft.prDraft }),
    onSuccess: (result) => {
      setPr(result);
      toast(`Opened pull request #${result.number}.`, { tone: "ok" });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  if (plan.isLoading) return <div className="p-3"><Spinner /></div>;
  if (!data) return <div className="p-3 text-[12px] text-muted">{(plan.error as Error | null)?.message ?? "Not a git repository."}</div>;
  const tone = subjectTone(draft.subject.length);

  const group = (title: string, paths: string[]) =>
    paths.length ? (
      <div className="mt-1">
        <div className="px-1 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</div>
        {paths.map((path) => (
          <label key={path} className="row-tile flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5" title={path}>
            <input
              type="checkbox"
              checked={ticked.has(path)}
              onChange={(event) => {
                const next = new Set(ticked);
                if (event.target.checked) next.add(path);
                else next.delete(path);
                update({ ticked: [...next] });
              }}
              className="accent-[rgb(var(--accent-rgb))]"
            />
            <span className="min-w-0 flex-1 truncate">{path}</span>
          </label>
        ))}
      </div>
    ) : null;

  return (
    <div className="space-y-2 p-2 text-[12.5px]" data-testid="commit-panel">
      <div className="flex items-center gap-1">
        <input
          value={draft.subject}
          onChange={(event) => update({ subject: event.target.value })}
          placeholder={`Commit on "${data.branch}"`}
          aria-label="Commit subject"
          className="field min-w-0 flex-1 text-[12.5px]"
        />
        <span className={cx("w-10 shrink-0 text-right text-[11px] tabular-nums", tone === "ok" ? "text-faint" : tone === "warn" ? "text-warn" : "text-danger")} title="50 is good; past 72 is too long" data-testid="subject-count">
          {draft.subject.length}/50
        </span>
      </div>
      <div className="rounded-md border border-line">
        <div className="flex border-b border-line text-[11.5px]" role="tablist" aria-label="Description">
          {(["Write", "Preview"] as const).map((label) => (
            <button key={label} type="button" role="tab" aria-selected={(label === "Preview") === preview} onClick={() => setPreview(label === "Preview")} className={cx("px-2 py-0.5", (label === "Preview") === preview ? "bg-hover font-medium" : "text-muted")}>
              {label}
            </button>
          ))}
          <div className="flex-1" />
          {longLines ? <span className="px-2 py-0.5 text-warn">{longLines} line{longLines === 1 ? "" : "s"} over 72</span> : null}
        </div>
        {preview ? (
          <div className="min-h-[60px] p-2" data-testid="commit-preview">{draft.body.trim() ? <MarkdownText text={draft.body} /> : <span className="text-faint">Nothing to preview.</span>}</div>
        ) : (
          <textarea value={draft.body} onChange={(event) => update({ body: event.target.value })} rows={4} placeholder="Description (Markdown)" aria-label="Commit description" className="block w-full resize-y bg-transparent p-2 text-[12.5px] outline-none" />
        )}
      </div>
      {includesRun ? (
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          <input type="checkbox" checked={draft.coAuthor} onChange={(event) => update({ coAuthor: event.target.checked })} className="accent-[rgb(var(--accent-rgb))]" />
          <span className="truncate">Co-authored-by the agent</span>
        </label>
      ) : null}
      <button type="button" className="btn-primary w-full justify-center" disabled={!draft.subject.trim() || !ticked.size || commit.isPending} onClick={() => commit.mutate()}>
        {commit.isPending ? <Spinner size={12} /> : <GitCommitHorizontal size={13} />} Commit {ticked.size} file{ticked.size === 1 ? "" : "s"}
      </button>
      {group("Changes from this run", data.run)}
      {group(data.run.length ? "Your changes" : "Changes", data.before)}
      {!all.length ? <div className="px-1 text-muted">Nothing to commit.</div> : null}

      <button type="button" className="btn w-full justify-center" disabled={push.isPending} onClick={() => push.mutate()} title={data.defaultBranch && data.branch === data.defaultBranch ? `Asks first: ${data.branch} is the default branch` : "git push -u origin HEAD, hooks off"}>
        {push.isPending ? <Spinner size={12} /> : <Upload size={13} />} Push {data.branch}
      </button>

      {data.github ? (
        <details className="rounded-md border border-line p-2" data-testid="pr-section">
          <summary className="flex cursor-pointer items-center gap-1 font-medium"><GitPullRequestArrow size={13} /> Pull request</summary>
          <div className="mt-2 space-y-1.5">
            <input value={draft.prTitle} onChange={(event) => update({ prTitle: event.target.value })} placeholder={draft.subject || "Title"} aria-label="Pull request title" className="field w-full text-[12.5px]" />
            <textarea
              value={draft.prBody ?? data.template ?? data.proposal ?? ""}
              onChange={(event) => update({ prBody: event.target.value })}
              rows={5}
              aria-label="Pull request description"
              className="field w-full text-[12.5px]"
            />
            <div className="text-[11px] text-faint">{draft.prBody !== null ? "" : data.template ? "From the repository's template." : data.proposal ? "From the agent's report." : ""}</div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-[12px] text-muted">
                into
                <input value={draft.base} onChange={(event) => update({ base: event.target.value })} aria-label="Base branch" className="field w-28 py-0.5 font-mono text-[12px]" />
              </label>
              <label className="flex items-center gap-1 text-[12px] text-muted">
                <input type="checkbox" checked={draft.prDraft} onChange={(event) => update({ prDraft: event.target.checked })} className="accent-[rgb(var(--accent-rgb))]" /> Draft
              </label>
            </div>
            <button type="button" className="btn w-full justify-center" disabled={!draft.base || !(draft.prTitle.trim() || draft.subject.trim()) || openPr.isPending || data.branch === draft.base} onClick={() => openPr.mutate()} title="Push the branch first">
              {openPr.isPending ? <Spinner size={12} /> : <GitPullRequestArrow size={13} />} Open pull request on {data.github.owner}/{data.github.repo}
            </button>
            {data.branch === draft.base ? <div className="text-[11.5px] text-muted">Commit on a branch of its own first; this is the base.</div> : null}
            {pr ? (
              <a href={pr.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-accent hover:underline">
                #{pr.number} <ExternalLink size={11} />
              </a>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
