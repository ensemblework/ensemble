"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageDocument } from "@ensemble/shared-types";
import { ApiError, SHARE_GONE_EVENT, SIGNED_OUT_EVENT, api, withLink, withShare } from "@/lib/api";
import { LIVE_REOPENED_EVENT, PAGE_STEPS_EVENT } from "@/lib/events";
import { tabId } from "@/lib/presence";
import { CollabSession, type CollabBatch, type CollabBinding, type CollabJoin, type CollabStatus, type Draft, type DraftStore } from "../editor/collab";

/** The share or link the page was opened through is gone, or you may no longer edit it. */
export function lostAccess(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.code === "SHARE_GONE" || error.status === 403);
}

/** Unsent typing kept in this browser, per account and page, until the server has it. */
function browserDrafts(key: string): DraftStore {
  return {
    read() {
      try {
        const text = localStorage.getItem(key);
        return text ? (JSON.parse(text) as Draft) : null;
      } catch {
        return null;
      }
    },
    write(draft) {
      try {
        localStorage.setItem(key, JSON.stringify(draft));
      } catch {
        // Storage full or blocked: the typing is still in the editor and being retried.
      }
    },
    clear() {
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

/**
 * Live co-editing of one page or task page (docs/29 §5). Joins the server's live document, and
 * gives the block editor what it needs to send and receive steps (`binding`). Steps from others
 * arrive over the event stream; after the stream drops, coming back online, or returning to the
 * tab, the steps missed are fetched. Unsent typing is kept as a draft in this browser and put
 * back the next time the page opens (after signing in again, say).
 */
export function useCollab(options: {
  kind: "page" | "task";
  id: string;
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
  const client = useQueryClient();
  const [state, setState] = useState<{ session: CollabSession; joined: CollabJoin } | null>(null);
  const [status, setStatus] = useState<CollabStatus>("saved");
  const [failure, setFailure] = useState<ApiError | null>(null);
  const { kind, id } = options;

  useEffect(() => {
    const { share, link } = props.current;
    const scoped = <T,>(work: () => Promise<T>) => withLink(link, () => withShare(share, work));
    const account = client.getQueryData<{ user?: { id?: string } }>(["shell"])?.user?.id ?? (link ? `link:${link}` : share ? `share:${share}` : "me");
    const session = new CollabSession({
      transport: {
        join: () => scoped(() => api.collabJoin(kind, id)),
        since: (epoch, version) => scoped(() => api.collabSince(kind, id, epoch, version)),
        send: (body) => scoped(() => api.collabSend(kind, id, body)),
      },
      clientID: `${tabId()}-${Math.random().toString(36).slice(2, 8)}`,
      live: () => props.current.live,
      drafts: browserDrafts(`ensemble.draft:${account}:${kind}:${id}`),
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
    const join = (attempt: number) => {
      session
        .join()
        .then((joined) => {
          if (alive) setState({ session, joined });
        })
        .catch((error: unknown) => {
          if (!alive) return;
          if (lostAccess(error)) return props.current.onLost(error);
          // A missing page also fails to load as a page; a 404 here can be an API not yet updated.
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
    const catchUp = () => void session.catchUp();
    const onVisible = () => {
      if (document.visibilityState === "visible") void session.catchUp();
    };
    const online = () => session.retryNow();
    const keep = () => session.keepDraft();
    window.addEventListener(PAGE_STEPS_EVENT, onSteps);
    window.addEventListener(LIVE_REOPENED_EVENT, catchUp);
    window.addEventListener("online", online);
    window.addEventListener(SIGNED_OUT_EVENT, keep);
    window.addEventListener("pagehide", keep);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(retry);
      window.removeEventListener(PAGE_STEPS_EVENT, onSteps);
      window.removeEventListener(LIVE_REOPENED_EVENT, catchUp);
      window.removeEventListener("online", online);
      window.removeEventListener(SIGNED_OUT_EVENT, keep);
      window.removeEventListener("pagehide", keep);
      document.removeEventListener("visibilitychange", onVisible);
      session.close();
    };
  }, [client, kind, id]);

  useEffect(() => {
    if (options.frozen) state?.session.freeze();
  }, [options.frozen, state]);

  const binding = useMemo<CollabBinding | null>(
    () => (state ? { version: state.joined.version, clientID: state.session.clientID, attach: (editor) => state.session.attach(editor) } : null),
    [state],
  );
  const session = state?.session ?? null;
  return {
    /** The live document to open the editor with, once joined. */
    joined: state?.joined ?? null,
    /** Joining was refused for good (the page is gone). */
    failure,
    status,
    binding,
    /** What the editor holds now, saved or not. */
    latest: useCallback((): PageDocument | null => session?.latest() ?? null, [session]),
    /** Waits until everything typed is saved; false when it cannot be now. */
    flush: useCallback(() => (session ? session.flush() : Promise.resolve(false)), [session]),
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
