"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { PageDocument, PageMention } from "@ensemble/shared-types";
import { api, type ProjectDetail } from "@/lib/api";
import { useEntities } from "@/lib/entities";
import { blockEditor, warmPeek } from "@/lib/warm";
import { textToDoc } from "../editor/doc";
import { mentionHref } from "../editor/editor-commands";
import type { NotesEditor } from "../meetings/notes-fields";
import { useToast } from "../toast";

// A body that failed to save survives in-app navigation until it saves.
const drafts = new Map<string, PageDocument>();
const writes = new Map<string, Promise<unknown>>();

function saveInOrder<T>(id: string, save: () => Promise<T>): Promise<T> {
  const previous = writes.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(save);
  writes.set(id, next);
  void next.finally(() => { if (writes.get(id) === next) writes.delete(id); }).catch(() => undefined);
  return next;
}

/**
 * The project's page: the same block editor as pages and meeting notes (`/` for blocks, `@` to
 * mention). Saves go in order, 600 ms after typing stops; older plain-text notes open as its first paragraphs.
 */
export function ProjectBody({ project, editable }: { project: ProjectDetail; editable: boolean }) {
  const client = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const entities = useEntities();
  const [Editor, setEditor] = useState<NotesEditor | null>(() => blockEditor as NotesEditor | null);
  useEffect(() => {
    if (Editor) return;
    let live = true;
    void warmPeek().then(() => { if (live && blockEditor) setEditor(() => blockEditor as NotesEditor); });
    return () => { live = false; };
  }, [Editor]);
  const id = project.id;
  const [initial] = useState<PageDocument>(() => drafts.get(id) ?? project.content ?? textToDoc(project.notes));
  const known = useRef(JSON.stringify(project.content ?? null));
  const [remote, setRemote] = useState<{ doc: PageDocument; stamp: number } | null>(null);
  const latest = useRef(initial);
  const pending = useRef(drafts.has(id));
  const saving = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<"idle" | "unsaved" | "saving" | "saved" | "failed">(pending.current ? "unsaved" : "idle");

  const flush = async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    if (saving.current) { if (!(await saving.current)) return false; return flush(); }
    if (!pending.current) return true;
    const submitted = latest.current;
    pending.current = false;
    if (mounted.current) setStatus("saving");
    const work = (async () => {
      try {
        await saveInOrder(id, () => api.patchProject(id, { content: submitted }));
        known.current = JSON.stringify(submitted);
        if (drafts.get(id) === submitted) drafts.delete(id);
        client.setQueryData<ProjectDetail>(["project", id], (cached) => cached ? { ...cached, content: submitted } : cached);
        if (mounted.current) setStatus(pending.current ? "unsaved" : "saved");
        return true;
      } catch (error) {
        pending.current = true;
        drafts.set(id, latest.current);
        if (mounted.current) setStatus("failed");
        else toast(`The project page was not saved: ${(error as Error).message}`, { tone: "error" });
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

  // Changed elsewhere (the assistant, another tab): shown here when nothing is waiting to save.
  useEffect(() => {
    const incoming = JSON.stringify(project.content ?? null);
    if (incoming === known.current || pending.current || saving.current || !project.content) return;
    known.current = incoming;
    latest.current = project.content;
    setRemote({ doc: project.content, stamp: Date.now() });
  }, [project.content]);

  const onMentionClick = useCallback((mention: PageMention) => {
    const href = mentionHref(mention);
    if (href) router.push(href);
  }, [router]);

  const label = status === "saving" ? "Saving…" : status === "unsaved" ? "Unsaved" : status === "saved" ? "Saved" : status === "failed" ? "Not saved" : "";
  return (
    <section className="project-body relative" aria-label="Project page" onBlur={() => { void flushRef.current(); }}>
      {label ? <span className={`project-save ${status === "failed" ? "text-danger" : "text-faint"}`} role="status">{label}{status === "failed" ? <button type="button" className="ml-2 underline" onClick={() => void flushRef.current()}>Retry</button> : null}</span> : null}
      {Editor ? (
        <Editor
          initial={initial}
          entities={entities.get}
          editable={editable}
          onChange={(content) => {
            latest.current = content;
            drafts.set(id, content);
            pending.current = true;
            setStatus("unsaved");
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => { void flushRef.current(); }, 600);
          }}
          onMentionClick={onMentionClick}
          placeholder="Write the plan, goals, links… / for blocks, @ to mention"
          page={{ kind: "project", id }}
          comments={false}
          remote={remote}
        />
      ) : <div className="skeleton h-24 w-full" />}
    </section>
  );
}
