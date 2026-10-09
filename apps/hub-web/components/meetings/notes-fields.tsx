"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type MeetingSessionRecord } from "@/lib/api";
import { meetingDoc } from "@/lib/export/items";
import { ExportMenu } from "../export-menu";
import { ShareButton } from "../sharing/share-dialog";
import { confirmAction } from "../ask-dialog";
import { useToast } from "../toast";

type Draft = { title: string; notes: string };
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

export function MeetingNotesFields({ session, onRemoved }: { session: MeetingSessionRecord; onRemoved: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => drafts.get(session.id) ?? { title: session.title, notes: session.notes });
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
      <ExportMenu load={() => meetingDoc({ ...session, ...latest.current })} />
      <ShareButton target={{ kind: "meeting", resourceId: session.id, title: draft.title }} />
      <button type="button" className="btn" disabled={removing} onClick={() => void remove()}>Delete notes</button>
    </div>
    <p className="mt-1 text-[12px] text-muted">Type your notes below. Microphone recording is not available yet.</p>
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]" role="status">
      <span className={failed ? "text-danger" : "text-muted"}>{status}</span>
      {failed ? <button type="button" className="btn" onClick={() => void flushRef.current()}>Retry save</button> : null}
    </div>
    <label className="mt-3 block">
      <span className="text-[12px] font-medium text-muted">Notes</span>
      <textarea value={draft.notes} maxLength={100_000} rows={8} className="field mt-1 w-full"
        onChange={(event) => edit({ ...latest.current, notes: event.target.value })} onBlur={() => { void flushRef.current(); }} />
    </label>
  </>;
}
