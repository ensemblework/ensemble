"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type KeyboardLock = { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };

function keyboardLock(): KeyboardLock | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
}

/**
 * Asks for the browser's fullscreen on the whole document. False where it is refused: no
 * Fullscreen API (iPhone Safari), a WebView that turns it off, or no click or key behind the
 * request. The whole document rather than one element, so menus, dialogs and toasts that
 * render into document.body still show above a full-screen layer.
 */
export async function requestDocumentFullscreen(): Promise<boolean> {
  const root = document.documentElement;
  if (typeof root.requestFullscreen !== "function" || document.fullscreenEnabled === false) return false;
  try {
    await root.requestFullscreen({ navigationUI: "hide" });
  } catch {
    return false;
  }
  // Chromium only: a short Esc then reaches the page, so an open menu closes first. Holding Esc still leaves.
  keyboardLock()?.lock?.(["Escape"]).catch(() => undefined);
  return true;
}

export async function leaveDocumentFullscreen(): Promise<void> {
  keyboardLock()?.unlock?.();
  if (!document.fullscreenElement || typeof document.exitFullscreen !== "function") return;
  try {
    await document.exitFullscreen();
  } catch {
    // Already left.
  }
}

/** Makes the rest of the page inert and stops it scrolling. Menus, dialogs and toasts opened later stay usable. */
function coverPage(layer: HTMLElement): () => void {
  const covered: HTMLElement[] = [];
  for (let node = layer; node.parentElement && node !== document.body; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert || sibling.hasAttribute("data-assistant-surface")) continue;
      sibling.inert = true;
      covered.push(sibling);
    }
  }
  const overflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  return () => {
    for (const sibling of covered) sibling.inert = false;
    document.body.style.overflow = overflow;
  };
}

export type Fullscreen = {
  /** The layer covers the app, in the browser's fullscreen or not. */
  active: boolean;
  /** Ref for the element that covers the app while the mode is on: a fixed layer, z-index above the app. */
  layer: (node: HTMLElement | null) => void;
  /** Pass the button that was pressed: focus moves into the layer, and back to the button afterwards. */
  enter: (opener?: HTMLElement | null) => void;
  exit: () => void;
  /** Leaves or re-enters the browser's fullscreen and keeps the mode. */
  toggleNative: () => void;
};

/**
 * One full-screen mode for any part of a screen (the Graph, a file, a page). The layer is always
 * a fixed overlay over the app; the browser's fullscreen is asked for as well, to hide its own
 * bars. Where that is refused the overlay alone is the mode, so both look the same. Leaving the
 * browser's fullscreen (Esc, the browser's controls) ends the mode. While it is on, the page
 * behind is inert and does not scroll, and Esc that nothing else handled ends it (`escape: false`
 * when the screen handles Esc itself). `focus` is a selector inside the layer to focus first.
 */
export function useFullscreen({ escape = true, focus }: { escape?: boolean; focus?: string } = {}): Fullscreen {
  const [active, setActive] = useState(false);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const activeRef = useRef(false);
  // The browser's fullscreen that is on was asked for here.
  const owned = useRef(false);
  // Leaving the browser's fullscreen on purpose, staying in the mode.
  const keep = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const moveIn = useRef(false);

  const askNative = useCallback(() => {
    if (document.fullscreenElement) return;
    owned.current = true;
    void requestDocumentFullscreen().then((ok) => {
      if (!ok) owned.current = false;
      else if (!activeRef.current) void leaveDocumentFullscreen();
    });
  }, []);

  const enter = useCallback(
    (from?: HTMLElement | null) => {
      if (activeRef.current) return;
      opener.current = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      moveIn.current = Boolean(from);
      activeRef.current = true;
      setActive(true);
      askNative();
    },
    [askNative],
  );

  const exit = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setActive(false);
    if (!owned.current) return;
    owned.current = false;
    void leaveDocumentFullscreen();
  }, []);

  const toggleNative = useCallback(() => {
    if (!activeRef.current) return;
    if (!document.fullscreenElement) askNative();
    else if (owned.current) {
      keep.current = true;
      void leaveDocumentFullscreen();
    }
  }, [askNative]);

  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement || !owned.current) return;
      owned.current = false;
      keyboardLock()?.unlock?.();
      if (keep.current) {
        keep.current = false;
        return;
      }
      if (!activeRef.current) return;
      activeRef.current = false;
      setActive(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (activeRef.current && owned.current) void leaveDocumentFullscreen();
    };
  }, []);

  useEffect(() => {
    if (!active || !node) return;
    const restore = coverPage(node);
    if (moveIn.current || !node.contains(document.activeElement)) {
      const first = focus ? node.querySelector<HTMLElement>(focus) : null;
      (first ?? node).focus({ preventScroll: true });
    }
    return () => {
      restore();
      // Someone working inside a layer that stays on the page (a page's editor) keeps their place.
      const current = document.activeElement;
      if (node.isConnected && current instanceof HTMLElement && current !== node && node.contains(current)) return;
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, [active, node, focus]);

  useEffect(() => {
    if (!active || !escape) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      exit();
    };
    // A same-origin frame in the layer (a Word preview) keeps its own keys: listen there too.
    const targets: Window[] = [window];
    for (const frame of Array.from(node?.querySelectorAll("iframe") ?? [])) {
      try {
        frame.contentWindow?.addEventListener("keydown", onKey);
        if (frame.contentWindow) targets.push(frame.contentWindow);
      } catch {
        // Another origin's frame.
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      for (const target of targets) {
        try {
          target.removeEventListener("keydown", onKey);
        } catch {
          // The frame went away.
        }
      }
    };
  }, [active, escape, exit, node]);

  return { active, layer: setNode, enter, exit, toggleNative };
}
