"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { SHORTCUTS, eventMatchesChord, formatBinding } from "@ensemble/shared-types";
import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect } from "react";
import { useFullscreen, type Fullscreen } from "@/lib/fullscreen";
import { isApplePlatform } from "@/lib/platform";

const BINDING = SHORTCUTS.find((binding) => binding.id === "page-focus");

/**
 * The page's outer element in focus mode: a scrolling layer over the app. globals.css
 * `.page-focus` keeps only the children marked `data-focus-keep` (the bar, the title and the
 * body) and centres them at a reading width.
 */
export const PAGE_FOCUS_CLASS = "page-focus fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-bg px-5 pb-24 outline-none sm:px-10";

/**
 * Focus mode for a document page: its title and body alone on the whole screen. The editor
 * stays mounted, so it keeps its cursor, undo history and read-only state. Esc leaves once
 * open menus have had it; Alt+Shift+Z (`page-focus` in shared-types shortcuts.ts) toggles it.
 * `shortcut: false` where the page sits in a side peek and focus mode is not offered.
 */
export function usePageFocus(shortcut = true): Fullscreen {
  const screen = useFullscreen({ focus: '.ProseMirror[contenteditable="true"]' });
  const { active, enter, exit } = screen;
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (event: KeyboardEvent) => {
      const apple = isApplePlatform();
      const chord = BINDING && (apple ? BINDING.mac : BINDING.other);
      if (event.defaultPrevented || !chord || !eventMatchesChord(event, chord, apple)) return;
      event.preventDefault();
      if (active) exit();
      else enter();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut, active, enter, exit]);
  return screen;
}

export function PageFocusButton({ onEnter }: { onEnter: (button: HTMLElement) => void }) {
  const chord = BINDING ? formatBinding(BINDING, isApplePlatform()) : "";
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label="Focus mode"
      title={`Focus mode: just the page, on the whole screen${chord ? ` (${chord})` : ""}`}
      onClick={(event) => onEnter(event.currentTarget)}
      data-page-focus-button
    >
      <Maximize2 size={15} />
    </button>
  );
}

/** The one line focus mode keeps above the title: whether the page is saved, and the way out. */
export function PageFocusBar({ status, error, onExit }: { status?: string; error?: boolean; onExit: () => void }) {
  return (
    <div data-focus-keep className="sticky top-0 z-10 flex h-12 items-center justify-end gap-3 bg-bg text-[12px] text-muted">
      {status ? <span className={error ? "text-danger" : undefined}>{status}</span> : null}
      <button type="button" className="btn-ghost" onClick={onExit} title="Leave focus mode (Esc)">
        <Minimize2 size={13} aria-hidden /> Exit focus mode
      </button>
    </div>
  );
}
