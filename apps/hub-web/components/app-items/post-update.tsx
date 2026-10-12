"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useId, useState } from "react";
import { api } from "@/lib/api";
import { APP_ITEM_QUERY, appItemsApi } from "@/lib/api-app-items";
import { useModuleOn } from "@/lib/use-module";
import { BrandLogo } from "../connectors/brand-logo";
import { useToast } from "../toast";
import { Spinner, cx } from "../ui";
import { ProblemNote, problemText } from "./app-item-picker";
import { sourceInfo, useAppItemSources } from "./use-app-items";

/**
 * On a task linked to an issue, card or ticket: write an update and post it there
 * as a comment. Nothing is sent until Post is pressed.
 */
export function PostUpdate({ taskId, className }: { taskId: string; className?: string }) {
  const { sources, allowed } = useAppItemSources();
  const toast = useToast();
  const workspaceOn = useModuleOn("workspace");
  const textId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [fromRun, setFromRun] = useState(false);
  const target = useQuery({ queryKey: APP_ITEM_QUERY.updateTarget(taskId), queryFn: () => appItemsApi.updateTarget(taskId), enabled: allowed, retry: false, staleTime: 60_000 });
  // The task page's agent panel already loads these runs.
  const jobs = useQuery({ queryKey: ["task-jobs", taskId], queryFn: () => api.taskJobs(taskId), enabled: allowed && workspaceOn });
  const post = useMutation({
    mutationFn: () => appItemsApi.postUpdate(taskId, draft.trim()),
    onSuccess: (result) => {
      const url = result.url;
      toast(`Posted to ${sourceInfo(sources, result.source).name}.`, {
        tone: "ok",
        ...(url ? { action: { label: "Open ↗", run: () => void window.open(url, "_blank", "noopener,noreferrer") } } : {}),
      });
      setDraft("");
      setFromRun(false);
      setOpen(false);
    },
  });

  const goal = target.data?.target;
  if (!allowed || !goal) return null;
  const app = sourceInfo(sources, goal.source);
  const label = goal.title.length > 60 ? `${goal.title.slice(0, 59)}…` : goal.title;

  if (!open) {
    return (
      <button
        type="button"
        className={cx("flex items-center gap-1.5 text-[12.5px] text-muted hover:text-ink", className)}
        onClick={() => {
          const latest = jobs.data?.jobs[0];
          const summary = latest?.status === "succeeded" ? (latest.summary?.trim() ?? "") : "";
          if (!draft && summary) {
            setDraft(summary);
            setFromRun(true);
          }
          post.reset();
          setOpen(true);
        }}
      >
        <BrandLogo id={app.logo} name={app.name} size={14} decorative /> Post an update to {app.name}
      </button>
    );
  }

  return (
    <div className={cx("rounded-lg border border-line p-3 text-[13px]", className)} data-testid="post-update">
      <label htmlFor={textId} className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium">
        <BrandLogo id={app.logo} name={app.name} size={14} decorative /> Post an update to {app.name}
      </label>
      <textarea
        id={textId}
        autoFocus
        value={draft}
        maxLength={20_000}
        onChange={(event) => {
          setDraft(event.target.value);
          if (!event.target.value) setFromRun(false);
        }}
        placeholder="What changed, what is next, and anything you need from them."
        className="field min-h-[96px] w-full resize-y text-[13px] leading-5"
      />
      {fromRun ? <p className="mt-1 text-[11.5px] text-faint">Filled in from the last agent run. Edit it before you post.</p> : null}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-[12px] text-muted">
          Comments on{" "}
          {goal.url ? (
            <a href={goal.url} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
              “{label}”
            </a>
          ) : (
            `“${label}”`
          )}{" "}
          in {app.name} as you.
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <button type="button" className="btn-ghost" disabled={post.isPending} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!draft.trim() || post.isPending} onClick={() => post.mutate()}>
            {post.isPending ? <Spinner size={12} /> : <Send size={12} aria-hidden />} Post
          </button>
        </span>
      </div>
      {post.error ? <ProblemNote message={problemText(post.error)} className="mt-2" /> : null}
    </div>
  );
}
