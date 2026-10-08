"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_PAGE, type PageDocument, type PageMention } from "@ensemble/shared-types";
import { ApiError, api, currentLink, currentShare, withLink, withShare } from "@/lib/api";
import { useEntities } from "@/lib/entities";
import { blockEditor, warmPeek } from "@/lib/warm";
import { mentionHref } from "../editor/editor-commands";
import { useToast } from "../toast";
import { Dialog } from "../ui";
import { PageLoadFailure } from "./page-load";
import { PageTitleField } from "./title-field";
import { isPageEnsembleBusy } from "../comments/ensemble-bus";
import { announceTyping, onResource, tabId, usePresence } from "@/lib/presence";
import { PagePeople } from "../sharing/page-people";
import { ShareButton } from "../sharing/share-dialog";
import { useSpaceAccess } from "@/lib/access";
import { ExportMenu } from "../export-menu";
import { pageDoc } from "@/lib/export/items";

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
export function NotePage({
  pageId,
  focusTitle = false,
  shared,
}: {
  pageId: string;
  focusTitle?: boolean;
  /** Opened from a share link: no board or delete actions, and read-only unless it may be edited. */
  shared?: { role: "view" | "edit"; link?: boolean };
}) {
  const client = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const entities = useEntities();
  const Editor = useBlockEditor();
  const [leaving, setLeaving] = useState(false);
  const page = useQuery({
    queryKey: ["standalone-page", pageId],
    queryFn: () => api.standalonePage(pageId),
    refetchOnWindowFocus: false,
    enabled: !leaving,
  });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [epoch, setEpoch] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const revision = useRef(0);
  const pending = useRef<PageDocument | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const titleSave = useRef<Promise<unknown> | null>(null);
  // The share (or none) this page was opened under. The last save on leaving must go there.
  const openedAs = useRef(currentShare());
  const openedLink = useRef(currentLink());
  const loaded = Boolean(page.data);
  const access = useSpaceAccess();
  const canEdit = shared ? shared.role === "edit" : access.canEdit;
  const others = onResource(usePresence(), "page", pageId);
  const watching = Boolean(shared) || others.length > 0;
  const [remote, setRemote] = useState<{ doc: PageDocument; stamp: number } | null>(null);
  const watchingRef = useRef(watching);
  watchingRef.current = watching;

  // Someone else saved: take their version when you have nothing unsaved. Your own saves
  // come back with the revision you already hold and change nothing.
  useEffect(() => {
    if (!watching) return;
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; pageId?: string; action?: string }>).detail;
      if ((detail?.id ?? detail?.pageId) !== pageId) return;
      if (pending.current || inFlight.current) return;
      void api
        .standalonePage(pageId)
        .then((fresh) => {
          if (pending.current || inFlight.current || fresh.revision === revision.current) return;
          revision.current = fresh.revision;
          client.setQueryData(["standalone-page", pageId], fresh);
          setRemote({ doc: fresh.content ?? EMPTY_PAGE, stamp: Date.now() });
        })
        .catch(() => undefined);
    };
    window.addEventListener("ensemble:page", onSaved);
    return () => window.removeEventListener("ensemble:page", onSaved);
  }, [watching, pageId, client]);

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
    while (inFlight.current) {
      if (!(await inFlight.current)) return false;
    }
    const doc = pending.current;
    if (!doc) return true;
    pending.current = null;
    setSaveState("saving");
    const work = (async () => {
      try {
        const saved = await withLink(openedLink.current, () => withShare(openedAs.current, () => api.saveStandalonePage(pageId, { revision: revision.current, content: doc })));
        revision.current = saved.revision;
        setSaveState(pending.current ? "dirty" : "saved");
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          toast("This page changed elsewhere (another tab, or someone you share it with). Reloaded the latest version.", { tone: "error" });
          await client.refetchQueries({ queryKey: ["standalone-page", pageId] });
          setEpoch((value) => value + 1);
        } else {
          pending.current ??= doc;
          toast((error as Error).message, { tone: "error" });
        }
        setSaveState("error");
        return false;
      }
    })();
    inFlight.current = work;
    try {
      return await work;
    } finally {
      if (inFlight.current === work) inFlight.current = null;
    }
  }, [client, pageId, toast]);

  const convert = useMutation({
    onMutate: () => setLeaving(true),
    mutationFn: async () => {
      if (isPageEnsembleBusy("page", pageId)) throw new Error("Wait for Ensemble to finish before adding this page to the board.");
      window.clearTimeout(timer.current);
      if (titleSave.current) await titleSave.current;
      if (!(await flush())) throw new Error("Save the page before adding it to the board.");
      return api.convertPage("page", pageId, revision.current);
    },
    onSuccess: (result) => {
      void client.invalidateQueries();
      router.push(`/tasks/${result.id}`);
    },
    onError: (error: Error) => {
      setLeaving(false);
      if (pending.current) timer.current = window.setTimeout(() => void flush(), 700);
      toast(error.message, { tone: "error" });
    },
  });

  const onChange = useCallback(
    (doc: PageDocument) => {
      pending.current = doc;
      setSaveState("dirty");
      if (watchingRef.current) announceTyping((typing) => api.sendPresence({ tabId: tabId(), typing }));
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
    <div className="mx-auto w-full max-w-[900px] px-4 pb-24 pt-6 sm:px-16 sm:pt-10" inert={leaving}>
      <div className="mb-3 flex items-center justify-between text-[12.5px] text-muted">
        <span>
          {shared?.link
            ? canEdit
              ? "Public link · anyone with it can edit"
              : "Public link · view only"
            : shared
              ? canEdit
                ? "Shared with you · can edit"
                : "Shared with you · view only"
              : canEdit
                ? "Pages"
                : "Pages · view only"}
        </span>
        <div className="flex items-center gap-2">
          <PagePeople kind="page" id={pageId} />
          {shared || !canEdit ? <ExportMenu load={async () => pageDoc(await api.standalonePage(pageId).catch(() => record))} /> : (
            <>
              <button type="button" className="btn-ghost" disabled={convert.isPending} onClick={() => convert.mutate()}>
                <CheckSquare size={13} /> Add to board
              </button>
              <button type="button" className="icon-btn" title="Delete" aria-label="Delete page" onClick={() => setConfirming(true)}>
                <Trash2 size={14} />
              </button>
              <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
              <ExportMenu load={async () => pageDoc(await api.standalonePage(pageId).catch(() => record))} />
              <ShareButton compact target={{ kind: "page", resourceId: pageId, title: record.title }} />
            </>
          )}
        </div>
      </div>
      {canEdit ? (
        <PageTitleField value={record.title} autoFocus={focusTitle} onSave={(title) => {
          titleSave.current = rename.mutateAsync(title);
          void titleSave.current.catch(() => undefined);
        }} />
      ) : (
        <h1 className="text-[32px] font-semibold leading-tight tracking-tight">{record.title || "Untitled"}</h1>
      )}
      <div className="mt-6 flex items-center justify-between border-t border-line pt-3 text-[12px] text-muted">
        <span className="font-medium">Page content</span>
        <span className={saveState === "error" ? "text-danger" : undefined}>
          {saveState === "saved"
            ? "All changes saved"
            : saveState === "saving"
              ? "Saving…"
              : saveState === "dirty"
                ? "Unsaved changes"
                : "Could not save. Retry on the next edit."}
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
            page={{ kind: "page", id: pageId }}
            editable={!leaving && canEdit}
            remote={remote}
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
