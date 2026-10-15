"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Orbit, CheckSquare, FileText, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_PAGE, type PageMention } from "@ensemble/shared-types";
import { ApiError, api, currentLink, currentShare } from "@/lib/api";
import { quickAssignTask } from "@/lib/quick-assign";
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
import { collabStatusText, useCollab } from "./use-collab";
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
  const titleSave = useRef<Promise<unknown> | null>(null);
  // The share (or none) this page was opened under. Its saves, the last one on leaving too, go there.
  const openedAs = useRef(currentShare());
  const openedLink = useRef(currentLink());
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
  const sync = useCollab({
    kind: "page",
    id: pageId,
    share: openedAs.current,
    link: openedLink.current,
    live: others.length > 0,
    frozen: locked,
    onLost: (error) => setLost(error.code === "SHARE_GONE" ? "gone" : "view"),
    onError: (message) => toast(message, { tone: "error" }),
    onRestored: () => toast("Changes you made before were not saved yet. They are back on the page and saving now."),
  });
  const { flush } = sync;
  // The editor opens on the live document; everyone's changes arrive in it as they are typed.
  const initialDoc = sync.joined?.doc ?? null;

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
      if (titleSave.current) await titleSave.current;
      if (!(await flush())) throw new Error("Save the page before adding it to the board.");
      const result = await api.convertPage("page", pageId, sync.revision());
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
      toast(error.message, { tone: "error" });
    },
  });

  const onChange = useCallback(() => {
    if (watchingRef.current) announceTyping((typing) => api.sendPresence({ tabId: tabId(), typing }));
  }, []);

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
  const pageNow = () => ({ title: record.title || "Untitled", doc: sync.latest() ?? record.content ?? EMPTY_PAGE });
  const exportExtra = exportBackItems(source, pageNow);
  const saveState = sync.status;
  const unsaved = saveState !== "saved";
  const saveText = collabStatusText(saveState, locked);
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
        <div className="flex items-center gap-2">
          <PagePeople kind="page" id={pageId} />
          {shared || !canEdit ? (
            <>
              <PageFocusButton onEnter={focusMode.enter} />
              <ExportMenu load={async () => pageDoc(await api.standalonePage(pageId).catch(() => record))} extra={exportExtra} />
            </>
          ) : (
            <>
              <button type="button" className="btn-ghost" disabled={convert.isPending} onClick={() => convert.mutate(false)}>
                <CheckSquare size={13} /> Add to board
              </button>
              <button type="button" className="btn-ghost text-accent" disabled={convert.isPending} title="Add to the board and use your default run profile" onClick={() => convert.mutate(true)}><Orbit size={13} /> Quick assign</button>
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
          read={sync.latest}
          ownCopy={Boolean(shared && !shared.link)}
        />
      ) : null}
      <div className="mt-4" data-focus-keep>
        {sync.failure ? (
          <PageLoadFailure missing={sync.failure.status === 404} onRetry={() => window.location.reload()} />
        ) : initialDoc && Editor ? (
          <Editor
            key={pageId}
            initial={initialDoc}
            entities={entities.get}
            onChange={onChange}
            onMentionClick={onMentionClick}
            page={{ kind: "page", id: pageId }}
            editable={!leaving && canEdit}
            collab={sync.binding}
          />
        ) : (
          <div className="skeleton mt-4 h-64 w-full" />
        )}
      </div>

      {!shared && family.data?.pages.some((child) => child.parentId === pageId) ? <nav aria-label="Nested pages" className="mt-6 space-y-1 border-t border-line pt-4">
        <p className="mb-2 text-[12px] font-medium text-muted">Nested pages</p>
        {family.data.pages.filter((child) => child.parentId === pageId).map((child) => <Link key={child.id} className="page-link-block" href={`/pages/${child.id}`}><FileText size={15} /> {child.title || "Untitled"}</Link>)}
      </nav> : null}
    </div>
  );
}
