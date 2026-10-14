"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { CheckSquare, FileText, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_PAGE, type PageDocument, type PageMention } from "@ensemble/shared-types";
import { ApiError, api, currentLink, currentShare, withLink, withShare } from "@/lib/api";
import { useEntities } from "@/lib/entities";
import { blockEditor, warmPeek } from "@/lib/warm";
import { mentionHref } from "../editor/editor-commands";
import { useToast } from "../toast";
import { PageLoadFailure } from "./page-load";
import { PageTitleField } from "./title-field";
import { isPageEnsembleBusy } from "../comments/ensemble-bus";
import { announceTyping, onResource, tabId, usePresence } from "@/lib/presence";
import { PagePeople } from "../sharing/page-people";
import { ShareButton } from "../sharing/share-dialog";
import { useSpaceAccess } from "@/lib/access";
import { ExportMenu } from "../export-menu";
import { pageDoc } from "@/lib/export/items";
import { SourceFileBanner, exportBackItems } from "../files/source-file-banner";
import { PAGE_FOCUS_CLASS, PageFocusBar, PageFocusButton, usePageFocus } from "./page-focus";

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
  const family = useQuery({ queryKey: ["pages"], queryFn: api.pages, enabled: !shared });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [epoch, setEpoch] = useState(0);
  const revision = useRef(0);
  const pending = useRef<PageDocument | null>(null);
  // What the editor holds now, saved or not: exporting back to the original's format reads it.
  const latest = useRef<PageDocument | null>(null);
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
  const focusMode = usePageFocus();

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
          latest.current = fresh.content ?? EMPTY_PAGE;
          setRemote({ doc: latest.current, stamp: Date.now() });
        })
        .catch(() => undefined);
    };
    window.addEventListener("ensemble:page", onSaved);
    return () => window.removeEventListener("ensemble:page", onSaved);
  }, [watching, pageId, client]);

  const initialDoc = useMemo(() => {
    if (!page.data) return null;
    revision.current = page.data.revision;
    latest.current = page.data.content ?? EMPTY_PAGE;
    return latest.current;
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
    mutationFn: async () => {
      if (titleSave.current) await titleSave.current;
      if (!(await flush())) throw new Error("Save the note before moving it to Trash.");
      return api.deletePage(pageId);
    },
    onSuccess: () => {
      void client.invalidateQueries();
      toast("Note moved to Trash.", { action: { label: "Undo", run: () => { void api.undo().then(() => { void client.invalidateQueries(); router.push(`/pages/${pageId}`); }).catch((error: Error) => toast(error.message, { tone: "error" })); } } });
      router.push("/today");
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });

  const deleteFromSidebar = useRef(() => remove.mutate());
  deleteFromSidebar.current = () => { if (!remove.isPending) remove.mutate(); };
  useEffect(() => {
    const handle = (event: Event) => {
      if ((event as CustomEvent<{ id: string }>).detail.id !== pageId) return;
      event.preventDefault();
      deleteFromSidebar.current();
    };
    window.addEventListener("ensemble:delete-page", handle);
    return () => window.removeEventListener("ensemble:delete-page", handle);
  }, [pageId]);

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

  const flushForBulk = useRef<(ids: string[]) => void>(() => undefined);
  flushForBulk.current = (ids) => {
    void (async () => {
      if (titleSave.current) await titleSave.current;
      if (!(await flush())) throw new Error("Save the note before moving these pages to Trash.");
      await api.deletePages(ids);
      void client.invalidateQueries();
      toast("Pages moved to Trash. One Undo restores them all.", { action: { label: "Undo", run: () => { void api.undo().then(() => client.invalidateQueries()); } } });
      router.push("/today");
    })().catch((error: Error) => toast(error.message, { tone: "error" }));
  };
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ ids: string[]; affected: string[] }>).detail;
      if (!detail.affected.includes(pageId)) return;
      event.preventDefault();
      flushForBulk.current(detail.ids);
    };
    window.addEventListener("ensemble:delete-pages", handler);
    return () => window.removeEventListener("ensemble:delete-pages", handler);
  }, [pageId]);

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
      latest.current = doc;
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
  const source = record.sourceFile ?? null;
  const pageNow = () => ({ title: record.title || "Untitled", doc: latest.current ?? record.content ?? EMPTY_PAGE });
  const exportExtra = exportBackItems(source, pageNow);
  const saveText =
    saveState === "saved" ? "All changes saved" : saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved changes" : "Could not save. Retry on the next edit.";
  return (
    <div
      ref={focusMode.layer}
      tabIndex={focusMode.active ? -1 : undefined}
      className={focusMode.active ? PAGE_FOCUS_CLASS : "mx-auto w-full max-w-[900px] px-4 pb-24 pt-6 sm:px-16 sm:pt-10"}
      inert={leaving}
      data-page-focus={focusMode.active ? "true" : undefined}
    >
      {focusMode.active ? <PageFocusBar status={saveText} error={saveState === "error"} onExit={focusMode.exit} /> : null}
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
          {shared || !canEdit ? (
            <>
              <PageFocusButton onEnter={focusMode.enter} />
              <ExportMenu load={async () => pageDoc(await api.standalonePage(pageId).catch(() => record))} extra={exportExtra} />
            </>
          ) : (
            <>
              <button type="button" className="btn-ghost" disabled={convert.isPending} onClick={() => convert.mutate()}>
                <CheckSquare size={13} /> Add to board
              </button>
              <button type="button" className="icon-btn" title="Delete" aria-label="Delete page" onClick={() => remove.mutate()}>
                <Trash2 size={14} />
              </button>
              <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
              <PageFocusButton onEnter={focusMode.enter} />
              <ExportMenu load={async () => pageDoc(await api.standalonePage(pageId).catch(() => record))} extra={exportExtra} />
              <ShareButton compact target={{ kind: "page", resourceId: pageId, title: record.title }} />
            </>
          )}
        </div>
      </div>
      {source ? <SourceFileBanner source={source} page={pageNow} /> : null}
      <div data-focus-keep>
        {canEdit ? (
          <PageTitleField value={record.title} autoFocus={focusTitle} onSave={(title) => {
            titleSave.current = rename.mutateAsync(title);
            void titleSave.current.catch(() => undefined);
          }} />
        ) : (
          <h1 className="text-[32px] font-semibold leading-tight tracking-tight">{record.title || "Untitled"}</h1>
        )}
      </div>
      {!shared && record.parentId ? <Link className="mt-3 inline-flex text-[12px] text-muted hover:text-ink" href={record.parentTaskId ? `/tasks/${record.parentTaskId}` : `/pages/${record.parentId}`}>← {family.data?.pages.find((parent) => parent.id === record.parentId)?.title || (record.parentTaskId ? "Parent task" : "Parent page")}</Link> : null}
      <div className="mt-6 flex items-center justify-between border-t border-line pt-3 text-[12px] text-muted">
        <span className="font-medium">Page content</span>
        <span className={saveState === "error" ? "text-danger" : undefined}>{saveText}</span>
      </div>
      <div className="mt-4" data-focus-keep>
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

      {!shared && family.data?.pages.some((child) => child.parentId === pageId) ? <nav aria-label="Nested pages" className="mt-6 space-y-1 border-t border-line pt-4">
        <p className="mb-2 text-[12px] font-medium text-muted">Nested pages</p>
        {family.data.pages.filter((child) => child.parentId === pageId).map((child) => <Link key={child.id} className="page-link-block" href={`/pages/${child.id}`}><FileText size={15} /> {child.title || "Untitled"}</Link>)}
      </nav> : null}
    </div>
  );
}
