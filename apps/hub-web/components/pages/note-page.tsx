"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_PAGE, type PageDocument, type PageMention } from "@ensemble/shared-types";
import { ApiError, api } from "@/lib/api";
import { useEntities } from "@/lib/entities";
import { blockEditor, warmPeek } from "@/lib/warm";
import { mentionHref } from "../editor/editor-commands";
import { useToast } from "../toast";
import { Dialog } from "../ui";
import { PageLoadFailure } from "./page-load";
import { PageTitleField } from "./title-field";

type SaveState = "saved" | "saving" | "dirty" | "error";

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

/** The same block editor linked task pages use, for a note that is not a task. */
export function NotePage({ pageId, focusTitle = false }: { pageId: string; focusTitle?: boolean }) {
  const client = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const entities = useEntities();
  const Editor = useBlockEditor();
  const page = useQuery({
    queryKey: ["standalone-page", pageId],
    queryFn: () => api.standalonePage(pageId),
    refetchOnWindowFocus: false,
  });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [epoch, setEpoch] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const revision = useRef(0);
  const pending = useRef<PageDocument | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const loaded = Boolean(page.data);

  const initialDoc = useMemo(() => {
    if (!page.data) return null;
    revision.current = page.data.revision;
    return page.data.content ?? EMPTY_PAGE;
    // The editor owns the document after the first load. See the task page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, loaded, epoch]);

  const rename = useMutation({
    mutationFn: (title: string) => api.renamePage(pageId, title),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["pages"] });
      void client.invalidateQueries({ queryKey: ["standalone-page", pageId] });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });

  const remove = useMutation({
    mutationFn: () => api.deletePage(pageId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["pages"] });
      router.push("/today");
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });

  const flush = useCallback(async () => {
    const doc = pending.current;
    if (!doc) return;
    pending.current = null;
    setSaveState("saving");
    try {
      const saved = await api.saveStandalonePage(pageId, { revision: revision.current, content: doc });
      revision.current = saved.revision;
      setSaveState(pending.current ? "dirty" : "saved");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast("This page changed in another tab. Reloaded the latest version.", { tone: "error" });
        await client.refetchQueries({ queryKey: ["standalone-page", pageId] });
        setEpoch((value) => value + 1);
      } else {
        toast((error as Error).message, { tone: "error" });
      }
      setSaveState("error");
    }
  }, [client, pageId, toast]);

  const onChange = useCallback(
    (doc: PageDocument) => {
      pending.current = doc;
      setSaveState("dirty");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 700);
    },
    [flush],
  );

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  const onMentionClick = useCallback(
    (mention: PageMention) => {
      const href = mentionHref(mention);
      if (href) router.push(href);
    },
    [router],
  );

  if (page.isLoading) return <div className="p-10 text-muted">Loading…</div>;
  if (!page.data) {
    const missing = page.error instanceof ApiError && page.error.status === 404;
    return <PageLoadFailure missing={missing} onRetry={() => void page.refetch()} />;
  }

  const record = page.data;
  return (
    <div className="mx-auto w-full max-w-[900px] px-4 pb-24 pt-6 sm:px-16 sm:pt-10">
      <div className="mb-3 flex items-center justify-between text-[12.5px] text-muted">
        <span>Pages</span>
        <button type="button" className="icon-btn" title="Delete" aria-label="Delete page" onClick={() => setConfirming(true)}>
          <Trash2 size={14} />
        </button>
      </div>
      <PageTitleField value={record.title} autoFocus={focusTitle} onSave={(title) => rename.mutate(title)} />
      <div className="mt-6 flex items-center justify-between border-t border-line pt-3 text-[12px] text-muted">
        <span className="font-medium">Page content</span>
        <span className={saveState === "error" ? "text-danger" : undefined}>
          {saveState === "saved"
            ? "All changes saved"
            : saveState === "saving"
              ? "Saving…"
              : saveState === "dirty"
                ? "Unsaved changes"
                : "Could not save — retrying on next edit"}
        </span>
      </div>
      <div className="mt-4">
        {initialDoc && Editor ? (
          <Editor
            key={`${pageId}-${epoch}`}
            initial={initialDoc}
            entities={entities.get}
            onChange={onChange}
            onMentionClick={onMentionClick}
          />
        ) : initialDoc ? (
          <div className="skeleton mt-4 h-64 w-full" />
        ) : null}
      </div>
      <Dialog open={confirming} onClose={() => setConfirming(false)} title="Delete this page?" width={420}>
        <p className="text-[13.5px] leading-5 text-muted">
          Delete “{record.title || "Untitled"}”? This removes the note. It does not change tasks or the board.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setConfirming(false);
              remove.mutate();
            }}
          >
            Delete page
          </button>
        </div>
      </Dialog>
    </div>
  );
}
