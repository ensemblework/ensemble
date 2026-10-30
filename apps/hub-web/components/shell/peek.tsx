"use client";

import { track } from "@/lib/telemetry";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  PAGE_WIDTH_DEFAULT,
  markPageWidthWrite,
  pageWidthWriteIsFresh,
  readPageWidth,
  writePageWidth,
  clampPageWidth,
  PAGE_WIDTH_MIN,
  PAGE_WIDTH_MAX,
} from "@/lib/page-width";
import { usePersistentState } from "@/lib/prefs";

/** `page`: a standalone page, as on custom boards. */
export type PeekKind = "task" | "deliverable" | "project" | "page";
type PeekMode = "side" | "page";

type PeekState = {
  peekId: string | null;
  kind: PeekKind;
  open: (id: string, kind?: PeekKind) => void;
  close: () => void;
  fullscreen: boolean;
  setFullscreen: (value: boolean) => void;
  mode: PeekMode;
  setMode: (mode: PeekMode) => void;
};

const PeekContext = createContext<PeekState>({
  peekId: null,
  kind: "task",
  open: () => {},
  close: () => {},
  fullscreen: false,
  setFullscreen: () => {},
  mode: "side",
  setMode: () => {},
});

export const usePeek = () => useContext(PeekContext);

function asKind(value: string | null): PeekKind {
  if (value === "deliverable" || value === "project" || value === "task" || value === "page") return value;
  return "task";
}

/**
 * Pages open as a side peek over whatever you were looking at.
 * The width is one number for every page kind, painted from this browser and saved on the account.
 */
export function PeekProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const peekId = params.get("peek");
  const kind = asKind(params.get("kind"));
  const [fullscreen, setFullscreen] = usePersistentState("ensemble.peek.fullscreen", false);
  const [mode, setMode] = usePersistentState<PeekMode>("ensemble.peek.mode", "side");
  const peeked = useRef<string | null>(null);
  useEffect(() => {
    if (peekId && peekId !== peeked.current) track("peek.open", { kind, mode });
    peeked.current = peekId;
  }, [peekId, kind, mode]);

  const withPeek = useCallback(
    (id: string | null, nextKind: PeekKind = "task") => {
      const next = new URLSearchParams(params.toString());
      if (id) {
        next.set("peek", id);
        if (nextKind === "task") next.delete("kind");
        else next.set("kind", nextKind);
      } else {
        next.delete("peek");
        next.delete("kind");
      }
      const query = next.toString();
      return `${pathname}${query ? `?${query}` : ""}`;
    },
    [params, pathname],
  );

  // Set while the event that opened a page is still being handled: that click must not also close it (see below).
  const opening = useRef(false);
  const open = useCallback(
    (id: string, nextKind: PeekKind = "task") => {
      opening.current = true;
      window.setTimeout(() => { opening.current = false; }, 0);
      if (mode === "page" && nextKind === "task") router.push(`/tasks/${id}`);
      else if (mode === "page" && nextKind === "project") router.push(`/projects/${id}`);
      else if (mode === "page" && nextKind === "page") router.push(`/pages/${id}`);
      else router.push(withPeek(id, nextKind), { scroll: false });
    },
    [mode, router, withPeek],
  );
  const close = useCallback(() => router.push(withPeek(null), { scroll: false }), [router, withPeek]);

  // Like Notion: a plain click on the page beside the peek closes it. Not a drag or a text selection,
  // not in menus or dialogs, and not the click that opened another page (a card, a row).
  useEffect(() => {
    if (!peekId || fullscreen) return;
    const outside = (target: EventTarget | null) => {
      const element = target instanceof Element ? target : null;
      return Boolean(element?.closest("#main-content") && !element.closest(".task-peek, [data-peek-keep], [role=dialog], [role=menu], [role=listbox], [data-modal-layer]"));
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => { down = event.button === 0 && outside(event.target) ? { x: event.clientX, y: event.clientY } : null; };
    const onClick = (event: MouseEvent) => {
      const start = down;
      down = null;
      if (!start || !outside(event.target) || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      if (opening.current || window.getSelection()?.toString()) return;
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    // Bubble phase on the document: React's own click handlers (which may open another page) run first.
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("click", onClick);
    };
  }, [peekId, fullscreen, close]);

  useEffect(() => {
    if (!peekId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement;
      // A title field saves when it loses focus, so Esc there keeps the edit and closes the panel.
      if (!event.defaultPrevented && target.closest("[data-peek-escape]") && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        target.blur();
        close();
        return;
      }
      if (!target.closest(".ProseMirror, input, textarea, [role=dialog]")) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peekId, close]);

  return (
    <PeekContext.Provider value={{ peekId, kind, open, close, fullscreen, setFullscreen, mode, setMode }}>
      {children}
    </PeekContext.Provider>
  );
}

let saveTimer: number | null = null;

/**
 * Drag updates a CSS variable on the document, not React state, so the open page
 * does not reconcile on every pointer move. The committed percent is global.
 */
export function useResizablePeek(container: React.RefObject<HTMLDivElement | null>) {
  const client = useQueryClient();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const [width, setWidth] = useState(PAGE_WIDTH_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    const local = readPageWidth();
    setWidth(writePageWidth(local));
  }, []);

  useEffect(() => {
    const remote = shell.data?.pageWidth;
    if (typeof remote !== "number" || pageWidthWriteIsFresh()) return;
    setWidth(writePageWidth(remote));
  }, [shell.data?.pageWidth]);

  const commit = useCallback(
    (value: number) => {
      const next = writePageWidth(value);
      setWidth(next);
      markPageWidthWrite();
      if (saveTimer != null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void api.saveSettings({ pageWidth: next }).then((result) => {
          client.setQueryData(["shell"], (current: { pageWidth?: number } | undefined) =>
            current ? { ...current, pageWidth: result.settings.pageWidth } : current,
          );
        });
      }, 400);
    },
    [client],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    const apply = (clientX: number) => {
      const percent = clampPageWidth(((rect.right - clientX) / rect.width) * 100);
      document.documentElement.style.setProperty("--page-width", `${percent}%`);
      handle.setAttribute("aria-valuenow", String(percent));
      handle.dataset.pageWidth = String(percent);
      widthRef.current = percent;
    };
    const move = (moveEvent: PointerEvent) => apply(moveEvent.clientX);
    const up = (upEvent: PointerEvent) => {
      if (handle.hasPointerCapture(upEvent.pointerId)) handle.releasePointerCapture(upEvent.pointerId);
      setDragging(false);
      commit(widthRef.current);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
    event.preventDefault();
    const next =
      event.key === "Home" ? PAGE_WIDTH_DEFAULT : clampPageWidth(widthRef.current + (event.key === "ArrowLeft" ? 2 : -2));
    event.currentTarget.dataset.pageWidth = String(next);
    commit(next);
  };

  const reset = () => commit(PAGE_WIDTH_DEFAULT);

  return { width, dragging, onPointerDown, onKeyDown, reset, min: PAGE_WIDTH_MIN, max: PAGE_WIDTH_MAX };
}
