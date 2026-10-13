"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { PageDocument, PageMention } from "@ensemble/shared-types";
import { api, type MeetingSessionRecord } from "@/lib/api";
import { useEntities } from "@/lib/entities";
import { meetingDoc } from "@/lib/export/items";
import { blockEditor, warmPeek } from "@/lib/warm";
import { textToDoc } from "../editor/doc";
import { mentionHref } from "../editor/editor-commands";
import { ExportMenu } from "../export-menu";
import { ShareButton } from "../sharing/share-dialog";
import { confirmAction } from "../ask-dialog";
import { useToast } from "../toast";

/** The page editor's props this field uses. Tests pass a stand-in; the app loads the block editor. */
export type NotesEditor = ComponentType<{
  initial: PageDocument;
  entities: ReturnType<typeof useEntities>["get"];
  onChange: (doc: PageDocument) => void;
  onMentionClick?: (mention: PageMention) => void;
  placeholder?: string;
  editable?: boolean;
  page?: { kind: string; id: string };
  comments?: boolean;
  remote?: { doc: PageDocument; stamp: number } | null;
}>;

function useNotesEditor(given?: NotesEditor): NotesEditor | null {
  const [Editor, setEditor] = useState<NotesEditor | null>(() => given ?? (blockEditor as NotesEditor | null));
  useEffect(() => {
    if (Editor) return;
    let live = true;
    void warmPeek().then(() => {
      if (live && blockEditor) setEditor(() => blockEditor as NotesEditor);
    });
    return () => {
      live = false;
    };
  }, [Editor]);
  return Editor;
}

const docOf = (session: MeetingSessionRecord): PageDocument => session.content ?? textToDoc(session.notes);

type Draft = { title: string; content: PageDocument };
// Retain an unsuccessful draft across SPA navigation; only an authorized session renders it.
const drafts = new Map<string, Draft>();
const writes = new Map<string, Promise<unknown>>();

/** An editor can reopen while the previous instance is still saving. */
function saveInOrder<T>(id: string, save: () => Promise<T>): Promise<T> {
  const previous = writes.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(save);
  writes.set(id, next);
  void next.finally(() => { if (writes.get(id) === next) writes.delete(id); }).catch(() => undefined);
  return next;
}

/**
 * A meeting's title and notes. The notes are a page (the block editor): `/` for blocks, `@` to
 * mention, `@ensemble` to ask in place. No comments. Saves go in order, 600 ms after typing stops.
 */
export function MeetingNotesFields({ session, onRemoved, editor }: { session: MeetingSessionRecord; onRemoved: () => void; editor?: NotesEditor }) {
  const client = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const entities = useEntities();
  const Editor = useNotesEditor(editor);
  const [draft, setDraft] = useState<Draft>(() => drafts.get(session.id) ?? { title: session.title, content: docOf(session) });
  const [initial] = useState(() => draft.content);
  const known = useRef(JSON.stringify(session.content ?? null));
  const [remote, setRemote] = useState<{ doc: PageDocument; stamp: number } | null>(null);
  const latest = useRef(draft);
  const pending = useRef(drafts.has(session.id));
  const saving = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState(pending.current ? "Unsaved changes" : "Edits save automatically");
  const [failed, setFailed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const savedTitle = useRef(session.title);

  const flush = async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    if (saving.current) { if (!(await saving.current)) return false; return flush(); }
    if (!pending.current) return true;
    const submitted = latest.current;
    const snapshot = { ...submitted, title: submitted.title.trim() || savedTitle.current };
    pending.current = false;
    if (mounted.current) { setStatus("Saving…"); setFailed(false); }
    const work = (async () => {
      try {
        const result = await saveInOrder(session.id, () => api.updateMeeting(session.id, snapshot));
        savedTitle.current = result.session.title;
        known.current = JSON.stringify(result.session.content ?? null);
        client.setQueryData<Awaited<ReturnType<typeof api.meetingSession>>>(["meeting-session", session.id], (cached) => cached ? { ...cached, session: result.session } : cached);
        if (drafts.get(session.id) === submitted) drafts.delete(session.id);
        if (mounted.current) setStatus(pending.current ? "Unsaved changes" : "Saved");
        void client.invalidateQueries({ queryKey: ["meeting-sessions"] });
        return true;
      } catch (error) {
        pending.current = true;
        if (!drafts.has(session.id)) drafts.set(session.id, latest.current);
        if (mounted.current) { setStatus(`Not saved: ${(error as Error).message}`); setFailed(true); }
        else toast("Meeting notes were not saved. Reopen the meeting to retry.", { tone: "error" });
        return false;
      }
    })();
    saving.current = work;
    const ok = await work;
    saving.current = null;
    return ok && (pending.current ? flush() : true);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const edit = (next: Draft) => {
    latest.current = next;
    drafts.set(session.id, next);
    pending.current = true;
    setDraft(next);
    setStatus("Unsaved changes");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flushRef.current(); }, 600);
  };

  useEffect(() => {
    mounted.current = true;
    if (pending.current) void flushRef.current();
    const leave = (event: BeforeUnloadEvent) => {
      if (!pending.current && !saving.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", leave);
    return () => {
      mounted.current = false;
      window.removeEventListener("beforeunload", leave);
      if (timer.current) clearTimeout(timer.current);
      void flushRef.current();
    };
  }, []);

  // Notes changed elsewhere (the assistant, another tab) show here when nothing is waiting to save.
  useEffect(() => {
    const incoming = JSON.stringify(session.content ?? null);
    if (incoming === known.current || pending.current || saving.current || !session.content) return;
    known.current = incoming;
    latest.current = { ...latest.current, content: session.content };
    setRemote({ doc: session.content, stamp: Date.now() });
  }, [session.content]);

  const onMentionClick = useCallback((mention: PageMention) => {
    const href = mentionHref(mention);
    if (href) router.push(href);
  }, [router]);

  const remove = async () => {
    if (removing) return;
    if (!(await flushRef.current())) return;
    if (!(await confirmAction({ title: "Delete meeting notes?", body: "Move these notes to Trash? You can restore them until the retention period expires.", confirm: "Move to Trash", danger: true }))) return;
    setRemoving(true);
    try {
      await api.deleteMeeting(session.id);
      drafts.delete(session.id);
      void client.invalidateQueries();
      toast("Meeting notes moved to Trash.", { action: { label: "Undo", run: () => {
        void api.restoreDeleted({ kind: "meeting", id: session.id }).then(() => { void client.invalidateQueries(); }).catch((error: Error) => toast(error.message, { tone: "error" }));
      } } });
      onRemoved();
    } catch (error) { toast((error as Error).message, { tone: "error" }); }
    finally { setRemoving(false); }
  };

  return <>
    <div className="flex flex-wrap items-center gap-2">
      <input aria-label="Meeting title" maxLength={200} value={draft.title} className="field min-w-0 flex-1 text-[18px] font-semibold"
        onChange={(event) => edit({ ...latest.current, title: event.target.value })}
        onBlur={() => {
          if (!latest.current.title.trim()) { edit({ ...latest.current, title: savedTitle.current }); toast("A title is required. The previous title was restored."); }
          void flushRef.current();
        }} />
      <ExportMenu load={() => meetingDoc({ ...session, title: latest.current.title, content: latest.current.content })} />
      <ShareButton target={{ kind: "meeting", resourceId: session.id, title: draft.title }} />
      <button type="button" className="btn" disabled={removing} onClick={() => void remove()}>Delete notes</button>
    </div>
    <p className="mt-1 text-[12px] text-muted">Type your notes below. Microphone recording is not available yet.</p>
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]" role="status">
      <span className={failed ? "text-danger" : "text-muted"}>{status}</span>
      {failed ? <button type="button" className="btn" onClick={() => void flushRef.current()}>Retry save</button> : null}
    </div>
    <div className="meeting-notes-page mt-3" data-testid="meeting-notes" onBlur={() => { void flushRef.current(); }}>
      {Editor ? (
        <Editor
          initial={initial}
          entities={entities.get}
          onChange={(content) => edit({ ...latest.current, content })}
          onMentionClick={onMentionClick}
          placeholder="Type your notes. / for blocks, @ to mention, @ensemble to ask…"
          page={{ kind: "meeting", id: session.id }}
          comments={false}
          remote={remote}
        />
      ) : <div className="skeleton h-40 w-full" />}
    </div>
  </>;
}
