"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Orbit, CheckSquare, FileText, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_PAGE, type PageDocument, type PageMention } from "@ensemble/shared-types";
import { ApiError, api, currentLink, currentShare, withLink, withShare } from "@/lib/api";
import { quickAssignTask } from "@/lib/quick-assign";
import { useEntities } from "@/lib/entities";
import { blockEditor, warmPeek } from "@/lib/warm";
import { mentionHref } from "../editor/editor-commands";
import { useToast } from "../toast";
import { PageLoadFailure, inTrash } from "./page-load";
import { TrashedPage } from "./trashed-page";
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
import { usePageSave, type PageEvent } from "./page-save";
import { KeptEdits } from "./kept-edits";

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
  /** Opened from a share link: no board or delete actions, and read-only unless it may be edited. `gone`: the owner stopped sharing it while it was open. */
  shared?: { role: "view" | "edit"; link?: boolean; gone?: boolean };
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
  const [epoch, setEpoch] = useState(0);
  const titleSave = useRef<Promise<unknown> | null>(null);
  // The share (or none) this page was opened under. Its saves, the last one on leaving too, go there.
  const openedAs = useRef(currentShare());
  const openedLink = useRef(currentLink());
  const loaded = Boolean(page.data);
  const access = useSpaceAccess();
  // "gone": the share was removed; "view": you may still open it but no longer edit it.
  const [lost, setLost] = useState<"gone" | "view" | null>(null);
  const gone = Boolean(shared?.gone) || lost === "gone";
  const locked = gone || lost === "view";
  const canEdit = !locked && (shared ? shared.role === "edit" : access.canEdit);
  const others = onResource(usePresence(), "page", pageId);
  const watching = Boolean(shared) || others.length > 0;
  const watchingRef = useRef(watching);
  watchingRef.current = watching;
  const focusMode = usePageFocus();
  const saver = usePageSave({
    load: async () => {
      const fresh = await withLink(openedLink.current, () => withShare(openedAs.current, () => api.standalonePage(pageId)));
      client.setQueryData(["standalone-page", pageId], fresh);
      return { revision: fresh.revision, content: fresh.content ?? EMPTY_PAGE };
    },
    save: async (revision, content) => {
      const saved = await withLink(openedLink.current, () => withShare(openedAs.current, () => api.saveStandalonePage(pageId, { revision, content })));
      return { revision: saved.revision, content: saved.content ?? content };
    },
    matches: (event: PageEvent) => (event.id ?? event.pageId) === pageId,
    live: others.length > 0,
    frozen: locked,
    onError: (message) => toast(message, { tone: "error" }),
    onKept: () => toast("You and someone else changed the same words at once. Both versions are on the page."),
    onLost: (error) => setLost(error.code === "SHARE_GONE" ? "gone" : "view"),
  });
  const { flush, edit } = saver;

  const initialDoc = useMemo(() => {
    if (!page.data) return null;
    const doc = page.data.content ?? EMPTY_PAGE;
    saver.adopt({ revision: page.data.revision, content: doc });
    return doc;
    // The editor owns the document after the first load; others' saves are merged into it in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, loaded, epoch]);
  // A refetch (after the live stream reconnects, say) can bring a newer version than the editor has.
  const offer = saver.offer;
  useEffect(() => {
    if (page.data) offer({ revision: page.data.revision, content: page.data.content ?? EMPTY_PAGE });
  }, [page.data, offer]);

  const rename = useMutation({
    mutationFn: (title: string) => api.renamePage(pageId, title),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["pages"] });
      void client.invalidateQueries({ queryKey: ["standalone-page", pageId] });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });

  // A page in Trash answers 404. Its own queries (the page, its comments) stay as they are
  // while the route changes, so nothing refetches it, and are dropped once this page unmounts.
  const trashed = useRef<Set<string> | null>(null);
  const leaveTrashed = (ids: Iterable<string>) => {
    const removed = new Set([pageId, ...ids]);
    trashed.current = removed;
    const about = (key: readonly unknown[]) => key.some((part) => typeof part === "string" && removed.has(part));
    setLeaving(true);
    void client.cancelQueries({ predicate: (query) => about(query.queryKey) });
    void client.invalidateQueries({ predicate: (query) => !about(query.queryKey) });
    router.push("/pages");
  };
  useEffect(() => () => {
    const removed = trashed.current;
    if (removed) client.removeQueries({ predicate: (query) => query.queryKey.some((part) => typeof part === "string" && removed.has(part)) });
  }, [client]);

  const remove = useMutation({
    // Nothing typed after the last save may reach a page that is going to Trash.
    onMutate: () => setLeaving(true),
    mutationFn: async () => {
      if (titleSave.current) await titleSave.current;
      if (!(await flush())) throw new Error("Save the page before moving it to Trash.");
      return api.deletePage(pageId);
    },
    onSuccess: () => {
      toast("Page moved to Trash.", { action: { label: "Undo", run: () => { void api.undo().then(() => { void client.invalidateQueries(); router.push(`/pages/${pageId}`); }).catch((error: Error) => toast(error.message, { tone: "error" })); } } });
      leaveTrashed([]);
    },
    onError: (error: Error) => {
      setLeaving(false);
      toast(error.message, { tone: "error" });
    },
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

  const flushForBulk = useRef<(ids: string[]) => void>(() => undefined);
  flushForBulk.current = (ids) => {
    setLeaving(true);
    void (async () => {
      if (titleSave.current) await titleSave.current;
      if (!(await flush())) throw new Error("Save the page before moving these pages to Trash.");
      await api.deletePages(ids);
      toast("Pages moved to Trash. One Undo restores them all.", { action: { label: "Undo", run: () => { void api.undo().then(() => client.invalidateQueries()); } } });
      leaveTrashed(ids);
    })().catch((error: Error) => {
      setLeaving(false);
      toast(error.message, { tone: "error" });
    });
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
    mutationFn: async (quick: boolean = false) => {
      if (isPageEnsembleBusy("page", pageId)) throw new Error("Wait for Ensemble to finish before adding this page to the board.");
      saver.cancel();
      if (titleSave.current) await titleSave.current;
      if (!(await flush())) throw new Error("Save the page before adding it to the board.");
      const result = await api.convertPage("page", pageId, saver.revision.current);
      return { ...result, quick };
    },
    onSuccess: async (result) => {
      void client.invalidateQueries();
      let needsOptions = false;
      if (result.quick) {
        try { const run = await quickAssignTask(result.id); toast(`Assigned with ${run.profile}.`, { tone: "ok" }); }
        catch (error) { needsOptions = true; toast((error as Error).message, { tone: "error" }); }
        void client.invalidateQueries();
      }
      router.push(`/tasks/${result.id}${needsOptions ? "?assign=1" : ""}`);
    },
    onError: (error: Error) => {
      setLeaving(false);
      if (saver.pending.current) saver.schedule();
      toast(error.message, { tone: "error" });
    },
  });

  const onChange = useCallback(
    (doc: PageDocument) => {
      edit(doc);
      if (watchingRef.current) announceTyping((typing) => api.sendPresence({ tabId: tabId(), typing }));
    },
    [edit],
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
    if (!shared && inTrash(page.error)) return <TrashedPage pageId={pageId} onRestored={() => void page.refetch()} />;
    const missing = page.error instanceof ApiError && page.error.status === 404;
    return <PageLoadFailure missing={missing} links={!shared} error={page.error} retrying={page.isFetching} onRetry={() => void page.refetch()} />;
  }

  const record = page.data;
  const source = record.sourceFile ?? null;
  const pageNow = () => ({ title: record.title || "Untitled", doc: saver.latest.current ?? record.content ?? EMPTY_PAGE });
  const exportExtra = exportBackItems(source, pageNow);
  const saveState = saver.state;
  const unsaved = saveState === "dirty" || saveState === "error";
  const saveText =
    locked && unsaved ? "Not saved" : saveState === "saved" ? "All changes saved" : saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved changes" : "Could not save. Retry on the next edit.";
  return (
    <div
      ref={focusMode.layer}
      tabIndex={focusMode.active ? -1 : undefined}
      className={focusMode.active ? PAGE_FOCUS_CLASS : "mx-auto w-full max-w-[900px] px-4 pb-24 pt-6 sm:px-16 sm:pt-10"}
      inert={leaving}
      data-page-focus={focusMode.active ? "true" : undefined}
    >
      {focusMode.active ? <PageFocusBar status={saveText} error={saveState === "error"} onExit={focusMode.exit} /> : null}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-[12.5px] text-muted">
        <span>
          {shared?.link
            ? gone
              ? "Public link · turned off"
              : canEdit
                ? "Public link · anyone with it can edit"
                : "Public link · view only"
            : shared
              ? gone
                ? "Not shared with you anymore"
                : canEdit
                ? "Shared with you · can edit"
                : "Shared with you · view only"
              : canEdit
                ? "Pages"
                : "Pages · view only"}
        </span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <PagePeople kind="page" id={pageId} />
          {shared || !canEdit ? (
            <>
              <PageFocusButton onEnter={focusMode.enter} />
              <ExportMenu load={async () => pageDoc(await api.standalonePage(pageId).catch(() => record))} extra={exportExtra} />
            </>
          ) : (
            <>
              <button type="button" className="btn-ghost" disabled={convert.isPending} aria-label="Add to board" title="Add to board" onClick={() => convert.mutate(false)}>
                <CheckSquare size={13} /> <span className="max-sm:hidden">Add to board</span>
              </button>
              <button type="button" className="btn-ghost text-accent" disabled={convert.isPending} aria-label="Quick assign" title="Add to the board and use your default run profile" onClick={() => convert.mutate(true)}><Orbit size={13} /> <span className="max-sm:hidden">Quick assign</span></button>
              <button type="button" className="icon-btn" title="Delete" aria-label="Delete page" disabled={remove.isPending} onClick={() => remove.mutate()}>
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
      {locked && unsaved ? (
        <KeptEdits
          message={gone ? "This page isn't shared with you anymore, so your last changes weren't saved. They're still on screen." : "You can't edit this page anymore, so your last changes weren't saved. They're still on screen."}
          title={record.title}
          read={() => saver.latest.current}
          ownCopy={Boolean(shared && !shared.link)}
        />
      ) : saver.stuck ? (
        <KeptEdits
          message="Someone else saved a version of this page that can't be combined with yours. Your text is still here and isn't saved."
          title={record.title}
          read={() => saver.latest.current}
          ownCopy={false}
          onTheirs={() => {
            saver.discard();
            void page.refetch().then(() => setEpoch((value) => value + 1));
          }}
        />
      ) : null}
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
            control={saver.control}
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
