"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageDocument } from "@ensemble/shared-types";
import { ApiError, SHARE_GONE_EVENT, SIGNED_OUT_EVENT, api, withLink, withShare } from "@/lib/api";
import { LIVE_REOPENED_EVENT, PAGE_STEPS_EVENT } from "@/lib/events";
import { CollabSession, type CollabBatch, type CollabBinding, type CollabJoin, type CollabStatus, type Draft, type DraftStore } from "../editor/collab";

/** The share or link the page was opened through is gone, or you may no longer edit it. */
export function lostAccess(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.code === "SHARE_GONE" || error.status === 403);
}

/**
 * Typing the server has not written back yet, kept in this tab (`sessionStorage`), one entry per
 * page and editor (`ensemble.draft:<kind>:<id>:<client id>`), so a reload or signing in again
 * puts it back. The client id starts with the account's id: a draft is only taken over by the
 * same account, and only from an editor that is gone (`CollabTab` in `editor/collab.ts`).
 */
export function tabDrafts(kind: "page" | "task", id: string): DraftStore {
  const prefix = `ensemble.draft:${kind}:${id}:`;
  return {
    key: `${kind}:${id}`,
    read() {
      const out: Draft[] = [];
      try {
        for (let at = 0; at < sessionStorage.length; at += 1) {
          const key = sessionStorage.key(at);
          if (!key?.startsWith(prefix)) continue;
          try {
            const draft = JSON.parse(sessionStorage.getItem(key) ?? "null") as Draft | null;
            if (draft && typeof draft.clientID === "string") out.push(draft);
          } catch {
            // Not a draft.
          }
        }
      } catch {
        // Storage blocked: no drafts.
      }
      return out;
    },
    write(draft) {
      try {
        sessionStorage.setItem(`${prefix}${draft.clientID}`, JSON.stringify(draft));
        return true;
      } catch {
        // Storage full or blocked: the typing is still in the editor and being retried.
        return false;
      }
    },
    clear(clientID) {
      try {
        sessionStorage.removeItem(`${prefix}${clientID}`);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

/** Joining has not worked for this long: the page says it is still connecting. */
const STALLED_MS = 10_000;

/** The `page` event a write-back publishes (pages/collab.ts in hub-api). */
type SavedEvent = { id?: string; taskId?: string; by?: string; epoch?: string; saved?: number };

/**
 * Live co-editing of one page or task page (docs/29 §5). Joins the server's live document, and
 * gives the block editor what it needs to send and receive steps (`binding`). Steps from others
 * arrive over the event stream, and so does the version the server has written back; after the
 * stream drops, coming back online, or returning to the tab, the steps missed are fetched.
 * Typing not yet written back is kept as a draft in this tab and put back the next time the page
 * opens in it (after signing in again, say).
 */
export function useCollab(options: {
  kind: "page" | "task";
  id: string;
  /** False while the page itself is not open (loading, in Trash, missing): nothing is joined. */
  enabled?: boolean;
  /** The share or public link the page was opened through. Its requests, the last one on leaving too, go there. */
  share: string | null;
  link: string | null;
  /** Someone else is on the page: steps go out sooner. */
  live: boolean;
  /** No more sending (the share is gone); what is typed stays on screen. */
  frozen: boolean;
  onLost: (error: ApiError) => void;
  onError: (message: string) => void;
  /** Typing from before a reload or sign-in was put back on the page. */
  onRestored: () => void;
}) {
  const props = useRef(options);
  props.current = options;
  const [state, setState] = useState<{ session: CollabSession; joined: CollabJoin } | null>(null);
  const [status, setStatus] = useState<CollabStatus>("saved");
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [stalled, setStalled] = useState(false);
  const { kind, id } = options;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    const { share, link } = props.current;
    const scoped = <T,>(work: () => Promise<T>) => withLink(link, () => withShare(share, work));
    const session = new CollabSession({
      transport: {
        join: (joinOptions) => scoped(() => api.collabJoin(kind, id, joinOptions)),
        since: (epoch, version) => scoped(() => api.collabSince(kind, id, epoch, version)),
        send: (body) => scoped(() => api.collabSend(kind, id, body)),
      },
      live: () => props.current.live,
      // Public links are rate limited per address (`ENSEMBLE_RATE_LINK_WRITE_LIMIT`, 120 a minute).
      delays: link ? { live: 1000, alone: 1000 } : undefined,
      drafts: tabDrafts(kind, id),
      onStatus: setStatus,
      onLost: (error) => {
        if (!(error instanceof ApiError)) return;
        props.current.onLost(error);
        if (error.code === "SHARE_GONE") window.dispatchEvent(new CustomEvent(SHARE_GONE_EVENT));
      },
      onError: (message) => props.current.onError(message),
      onRestored: () => props.current.onRestored(),
    });
    let alive = true;
    let retry: number | undefined;
    const stall = window.setTimeout(() => {
      if (alive) setStalled(true);
    }, STALLED_MS);
    setFailure(null);
    setStalled(false);
    const join = (attempt: number) => {
      session
        .join()
        .then((joined) => {
          if (!alive) return;
          window.clearTimeout(stall);
          setStalled(false);
          setState({ session, joined });
        })
        .catch((error: unknown) => {
          if (!alive) return;
          if (lostAccess(error)) return props.current.onLost(error);
          // A 404 here, for a page that loaded, can be an API that does not have live editing yet.
          if (error instanceof ApiError && error.status > 0 && error.status < 500 && error.status !== 404) return setFailure(error);
          if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) setStatus("offline");
          retry = window.setTimeout(() => join(attempt + 1), Math.min(30_000, 1000 * 2 ** attempt));
        });
    };
    join(0);
    const onSteps = (event: Event) => {
      const batch = (event as CustomEvent<(CollabBatch & { kind?: string; id?: string }) | null>).detail;
      if (batch?.kind === kind && batch.id === id) session.receive(batch);
    };
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<SavedEvent | null>).detail;
      if (detail?.by !== "collab" || !detail.epoch || typeof detail.saved !== "number") return;
      if ((kind === "page" ? detail.id : detail.taskId) === id) session.noteSaved(detail.epoch, detail.saved);
    };
    const catchUp = () => void session.catchUp();
    const onVisible = () => {
      if (document.visibilityState === "visible") void session.catchUp();
    };
    const online = () => session.retryNow();
    const keep = () => session.keepDraft();
    window.addEventListener(PAGE_STEPS_EVENT, onSteps);
    window.addEventListener("ensemble:page", onSaved);
    window.addEventListener(LIVE_REOPENED_EVENT, catchUp);
    window.addEventListener("online", online);
    window.addEventListener("offline", keep);
    window.addEventListener(SIGNED_OUT_EVENT, keep);
    window.addEventListener("pagehide", keep);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(retry);
      window.clearTimeout(stall);
      window.removeEventListener(PAGE_STEPS_EVENT, onSteps);
      window.removeEventListener("ensemble:page", onSaved);
      window.removeEventListener(LIVE_REOPENED_EVENT, catchUp);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", keep);
      window.removeEventListener(SIGNED_OUT_EVENT, keep);
      window.removeEventListener("pagehide", keep);
      document.removeEventListener("visibilitychange", onVisible);
      session.close();
      setState(null);
    };
  }, [kind, id, enabled]);

  useEffect(() => {
    if (options.frozen) state?.session.freeze();
  }, [options.frozen, state]);

  // Closing the tab or the browser while typing is not yet stored asks first: the draft lives in
  // this tab's storage, which closing it throws away (a reload keeps it).
  useEffect(() => {
    if (!state || status === "saved") return;
    const leave = (event: BeforeUnloadEvent) => {
      state.session.keepDraft();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [state, status]);

  const binding = useMemo<CollabBinding | null>(
    () => (state ? { version: state.joined.version, clientID: state.session.clientID, attach: (editor) => state.session.attach(editor) } : null),
    [state],
  );
  const session = state?.session ?? null;
  return {
    /** The live document to open the editor with, once joined. */
    joined: state?.joined ?? null,
    /** Joining was refused for good. */
    failure,
    /** Joining has not worked for a while (offline, or an API without live editing yet). */
    stalled,
    status,
    binding,
    /** What the editor holds now, saved or not. */
    latest: useCallback((): PageDocument | null => session?.latest() ?? null, [session]),
    /** Waits until everything typed is written back; false when it cannot be now. */
    flush: useCallback(() => (session ? session.flush() : Promise.resolve(true)), [session]),
    /** The stored revision after the last flush (for converting the page). */
    revision: useCallback(() => session?.revision ?? 0, [session]),
  };
}

/** The status line under a page title. */
export function collabStatusText(status: CollabStatus, locked: boolean): string {
  if (locked && status !== "saved") return "Not saved";
  switch (status) {
    case "saved":
      return "All changes saved";
    case "saving":
      return "Saving…";
    case "offline":
      return "Offline — your changes will sync when you're back";
    case "lost":
      return "Not saved";
    default:
      return "Could not save. Retrying…";
  }
}
