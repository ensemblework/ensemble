"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_PAGE, type PageDocument } from "@ensemble/shared-types";
import { ApiError, SHARE_GONE_EVENT } from "@/lib/api";
import { mergeDocs, sameDoc } from "@ensemble/shared-types/page-merge";
import type { EditorControl } from "../editor/replace-doc";

export type SaveState = "saved" | "saving" | "dirty" | "error";
export type PageVersion = { revision: number; content: PageDocument };
/** The `page` event's data (routes/pages.ts, routes/tasks.ts, assistant tools…). */
export type PageEvent = { id?: string; pageId?: string; taskId?: string; action?: string; revision?: number };

const QUIET_MS = 700;
/** While someone else is on the page, typing without a pause still saves this often. */
const LIVE_MS = 1500;
/** Saves that lose the race to someone else's are merged and sent again this many times. */
const RETRIES = 3;

/** The share or link the page was opened through is gone, or you may no longer edit it. */
export function lostAccess(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.code === "SHARE_GONE" || error.status === 403);
}

/**
 * Saving a block-editor page together with whoever else has it open. Saves are debounced and
 * strictly one at a time. Each save names the revision it was edited from; when someone saved
 * first (409), or their save arrives over the event stream while you have unsaved typing,
 * their version is merged into yours in place (`page-merge.ts` in shared-types) and the merge is saved.
 * Your text is never thrown away: when a merge cannot be made, or the page can no longer be
 * saved, it stays in the editor and `stuck`/`onLost` let the page offer a copy.
 */
export function usePageSave(options: {
  load: () => Promise<PageVersion>;
  save: (revision: number, content: PageDocument) => Promise<PageVersion>;
  /** Whether a `page` event is about this page. */
  matches: (event: PageEvent) => boolean;
  /** Someone else is on the page. */
  live: boolean;
  /** No more saves (the share is gone); what is unsaved stays in the editor. */
  frozen: boolean;
  onError: (message: string) => void;
  /** Someone else changed the same words: both versions were kept. */
  onKept: () => void;
  onLost: (error: ApiError) => void;
}) {
  const [state, setState] = useState<SaveState>("saved");
  const [stuck, setStuckState] = useState(false);
  const stuckNow = useRef(false);
  const setStuck = useCallback((value: boolean) => {
    stuckNow.current = value;
    setStuckState(value);
  }, []);
  const control = useRef<EditorControl | null>(null);
  const revision = useRef(0);
  const base = useRef<PageDocument>(EMPTY_PAGE);
  const pending = useRef<PageDocument | null>(null);
  // What the editor holds now, saved or not.
  const latest = useRef<PageDocument | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const dirtySince = useRef(0);
  const saving = useRef(false);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const stopped = useRef(options.frozen);
  const props = useRef(options);
  props.current = options;
  useEffect(() => {
    if (!options.frozen) return;
    stopped.current = true;
    window.clearTimeout(timer.current);
  }, [options.frozen]);

  const lose = useCallback((error: ApiError) => {
    stopped.current = true;
    window.clearTimeout(timer.current);
    props.current.onLost(error);
    window.dispatchEvent(new CustomEvent(SHARE_GONE_EVENT));
  }, []);

  /** The version the editor was loaded from. */
  const adopt = useCallback((version: PageVersion) => {
    revision.current = version.revision;
    base.current = version.content;
    latest.current = version.content;
  }, []);

  /**
   * Takes in what others saved since our revision (`given`, or read now): as it is when nothing
   * here is unsaved, merged with it otherwise.
   */
  const pull = useCallback(async (given?: PageVersion): Promise<boolean> => {
    let fresh: PageVersion;
    try {
      fresh = given ?? (await props.current.load());
    } catch (error) {
      if (lostAccess(error)) lose(error);
      return false;
    }
    if (fresh.revision <= revision.current) return true;
    const editor = control.current;
    if (!editor) return true;
    if (!pending.current) {
      if (!editor.replace(fresh.content)) {
        setStuck(true);
        return false;
      }
      adopt(fresh);
      return true;
    }
    const mine = editor.read();
    let merged = mergeDocs(base.current, mine, fresh.content);
    if (!editor.accepts(merged.doc)) merged = mergeDocs(base.current, mine, fresh.content, { deep: false });
    if (!editor.replace(merged.doc)) {
      setStuck(true);
      return false;
    }
    revision.current = fresh.revision;
    base.current = fresh.content;
    latest.current = merged.doc;
    pending.current = sameDoc(merged.doc, fresh.content) ? null : merged.doc;
    if (merged.kept) props.current.onKept();
    return true;
  }, [adopt, lose, setStuck]);

  const push = useCallback(async (): Promise<boolean> => {
    for (let tries = 0; ; tries += 1) {
      if (stopped.current) return false;
      const doc = pending.current;
      if (!doc) return true;
      pending.current = null;
      setState("saving");
      saving.current = true;
      try {
        const saved = await props.current.save(revision.current, doc);
        revision.current = saved.revision;
        base.current = saved.content;
        setStuck(false);
        setState(pending.current ? "dirty" : "saved");
        return true;
      } catch (error) {
        pending.current ??= doc;
        if (error instanceof ApiError && error.status === 409) {
          if (tries < RETRIES && (await pull())) continue;
          setState("error");
          if (!stopped.current && !stuckNow.current) props.current.onError("Someone else is saving this page at the same moment. Your text is still here and saves with your next edit.");
          return false;
        }
        setState("error");
        if (lostAccess(error)) lose(error);
        else props.current.onError((error as Error).message);
        return false;
      } finally {
        saving.current = false;
      }
    }
  }, [lose, pull]);

  const serial = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(work);
    chain.current = run.catch(() => undefined);
    return run;
  }, []);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    return serial(push);
  }, [serial, push]);

  /** Merges in what others saved, then saves the merge. */
  const take = useCallback(
    (given?: PageVersion) =>
      serial(async () => {
        if (stopped.current) return;
        if ((await pull(given)) && pending.current) {
          setState("dirty");
          await push();
        }
      }),
    [serial, pull, push],
  );
  /** Someone else saved: take it in now rather than at our next save. */
  const sync = useCallback(() => take(), [take]);
  /** A version read some other way (a refetch after the stream reconnected); older ones are ignored. */
  const offer = useCallback(
    (version: PageVersion) => {
      if (version.revision > revision.current) void take(version);
    },
    [take],
  );

  const edit = useCallback(
    (doc: PageDocument) => {
      if (!pending.current) dirtySince.current = Date.now();
      pending.current = doc;
      latest.current = doc;
      if (stopped.current) return;
      setState("dirty");
      window.clearTimeout(timer.current);
      const wait = props.current.live ? Math.max(0, Math.min(QUIET_MS, dirtySince.current + LIVE_MS - Date.now())) : QUIET_MS;
      timer.current = window.setTimeout(() => void flush(), wait);
    },
    [flush],
  );

  useEffect(() => {
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<PageEvent | null>).detail;
      if (!detail || !props.current.matches(detail)) return;
      if (detail.action && detail.action !== "save") return;
      // Our own save comes back with the revision we hold, or the next one while its answer is on
      // the way. Someone else's save in between makes ours fail with 409, which merges too.
      if (typeof detail.revision === "number" && detail.revision <= revision.current + (saving.current ? 1 : 0)) return;
      void sync();
    };
    window.addEventListener("ensemble:page", onSaved);
    return () => window.removeEventListener("ensemble:page", onSaved);
  }, [sync]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  return {
    state,
    /** A merge could not be made; your text is in the editor, unsaved. */
    stuck,
    control,
    revision,
    pending,
    latest,
    adopt,
    offer,
    edit,
    flush,
    /** Saves soon, as if you had just typed. */
    schedule: () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), QUIET_MS);
    },
    cancel: () => window.clearTimeout(timer.current),
    /** Drops what is unsaved here, before reloading the page from the server. */
    discard: () => {
      window.clearTimeout(timer.current);
      pending.current = null;
      setStuck(false);
      setState("saved");
    },
  };
}
