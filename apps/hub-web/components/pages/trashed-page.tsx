"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EMPTY_PAGE } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { useEntities } from "@/lib/entities";
import { relative } from "@/lib/format";
import { blockEditor, warmPeek } from "@/lib/warm";
import { LoadError } from "../load-error";
import { useToast } from "../toast";

/** "This page is in Trash" with Restore. Nothing on screen can be edited until it is restored. */
export function TrashBanner({ kind, id, deletedAt, onRestored }: { kind: "page" | "task"; id: string; deletedAt?: string | null; onRestored: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const restore = useMutation({
    mutationFn: () => api.restoreDeleted({ kind, id }),
    onSuccess: (result) => {
      if (!result.restored) {
        toast(`This ${kind} is no longer in Trash.`, { tone: "error" });
        return;
      }
      void client.invalidateQueries({ queryKey: ["deleted"] });
      void client.invalidateQueries({ queryKey: kind === "page" ? ["pages"] : ["tasks"] });
      toast(kind === "page" ? "Page restored." : "Task restored.", { tone: "ok" });
      onRestored();
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line-strong bg-raised px-4 py-3 text-[13.5px]" data-trashed={kind}>
      <Trash2 size={16} className="shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-ink">This {kind} is in Trash.</span>{" "}
        <span className="text-muted">{deletedAt ? `Deleted ${relative(deletedAt)}. ` : ""}Restore it to edit it again.</span>
      </span>
      <button type="button" className="btn-primary" disabled={restore.isPending} onClick={() => restore.mutate()}>
        <RotateCcw size={13} aria-hidden /> {restore.isPending ? "Restoring…" : `Restore ${kind}`}
      </button>
      <Link href="/trash" className="btn-ghost">Open Trash</Link>
    </div>
  );
}

function useBlockEditor() {
  const [Editor, setEditor] = useState(() => blockEditor);
  useEffect(() => {
    if (Editor) return;
    let live = true;
    void warmPeek().then(() => {
      if (live && blockEditor) setEditor(() => blockEditor);
    });
    return () => {
      live = false;
    };
  }, [Editor]);
  return Editor;
}

/** A page in Trash, opened from history or a link: read-only, with Restore. */
export function TrashedPage({ pageId, onRestored }: { pageId: string; onRestored: () => void }) {
  const page = useQuery({ queryKey: ["standalone-page", pageId, "trashed"], queryFn: () => api.trashedPage(pageId), refetchOnWindowFocus: false });
  const entities = useEntities();
  const Editor = useBlockEditor();
  if (page.isLoading) return <div className="p-10 text-muted">Loading…</div>;
  return (
    <div className="mx-auto w-full max-w-[900px] px-4 pb-24 pt-6 sm:px-16 sm:pt-10">
      <TrashBanner kind="page" id={pageId} deletedAt={page.data?.deletedAt} onRestored={onRestored} />
      {page.data ? (
        <>
          <h1 className="text-[32px] font-semibold leading-tight tracking-tight text-ink/80">{page.data.title || "Untitled"}</h1>
          <div className="mt-6 border-t border-line pt-4" aria-label="Page content (read-only)">
            {Editor ? (
              <Editor initial={page.data.content ?? EMPTY_PAGE} entities={entities.get} onChange={() => undefined} editable={false} comments={false} placeholder="" />
            ) : (
              <div className="skeleton mt-4 h-64 w-full" />
            )}
          </div>
        </>
      ) : (
        <LoadError error={page.error} what="this page" retrying={page.isFetching} onRetry={() => void page.refetch()} />
      )}
    </div>
  );
}

/** A task in Trash: Restore brings back the task and its page. */
export function TrashedTask({ taskId, onRestored }: { taskId: string; onRestored: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[900px] px-4 pt-6 sm:px-16 sm:pt-10">
      <TrashBanner kind="task" id={taskId} onRestored={onRestored} />
    </div>
  );
}
