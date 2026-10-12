"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../ui";

export type Box = { width: number; height: number };

const NEXT = new Set(["ArrowRight", "ArrowDown", " ", "PageDown", "Enter", "n", "N"]);
const PREVIOUS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"]);
/** The controls and the cursor hide after this long without the mouse moving. */
const IDLE_MS = 2000;

function useViewport(): Box {
  const [box, setBox] = useState<Box>(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const measure = () => setBox({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return box;
}

const control = "grid h-8 w-8 place-items-center rounded-md text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-35 disabled:hover:bg-transparent";

/**
 * A slideshow over the whole screen: one slide or page at a time, fitted and letterboxed on
 * black. `render` draws item `index` to fit `box`; the items either side are drawn hidden, so
 * the next one is ready when it is asked for. `onMove` hears every move, so the viewer behind
 * opens at the same place afterwards. Esc is the full-screen mode's own (lib/fullscreen.ts).
 */
export function Presenter({
  layer,
  label,
  noun,
  count,
  start,
  onMove,
  onExit,
  onToggleNative,
  render,
}: {
  layer: (node: HTMLElement | null) => void;
  label: string;
  noun: "slide" | "page";
  count: number;
  start: number;
  onMove: (index: number) => void;
  onExit: () => void;
  onToggleNative: () => void;
  render: (index: number, box: Box) => ReactNode;
}) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(count - 1, start)));
  const [awake, setAwake] = useState(true);
  const timer = useRef(0);
  const box = useViewport();
  const go = useCallback((next: number) => setIndex(Math.max(0, Math.min(count - 1, next))), [count]);

  const wake = useCallback(() => {
    setAwake(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAwake(false), IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(timer.current);
  }, [wake]);

  useEffect(() => onMove(index), [index, onMove]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.key === "Escape" || event.key === "Tab") return;
      // A focused button in the controls keeps Enter and Space.
      if ((event.key === "Enter" || event.key === " ") && (event.target as HTMLElement | null)?.closest?.("button")) return;
      // Every other key stops here, so the app's typed shortcuts (N then P) never run behind the slideshow.
      event.stopPropagation();
      if (event.key === " " && event.shiftKey) setIndex((value) => Math.max(0, value - 1));
      else if (NEXT.has(event.key)) setIndex((value) => Math.min(count - 1, value + 1));
      else if (PREVIOUS.has(event.key)) setIndex((value) => Math.max(0, value - 1));
      else if (event.key === "Home") setIndex(0);
      else if (event.key === "End") setIndex(count - 1);
      else if (event.key === "f" || event.key === "F") onToggleNative();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [count, onToggleNative]);

  const onClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("[data-present-controls]")) return;
    go(event.clientX < window.innerWidth / 3 ? index - 1 : index + 1);
  };

  const shown = [index - 1, index, index + 1].filter((item) => item >= 0 && item < count);
  return createPortal(
    <div
      ref={layer}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className={cx("fixed inset-0 z-[100] select-none overflow-hidden bg-black outline-none", !awake && "cursor-none")}
      onPointerMove={wake}
      onPointerDown={wake}
      onClick={onClick}
      // Keys inside the portal would otherwise reach the viewer's own key handler through React.
      // Esc goes on to the full-screen mode's listener on window.
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
      data-presenter
    >
      {shown.map((item) => (
        <div
          key={item}
          className={cx("absolute inset-0 flex items-center justify-center transition-opacity duration-200", item === index ? "opacity-100" : "pointer-events-none opacity-0")}
          aria-hidden={item === index ? undefined : true}
          data-present-item={item}
          data-current={item === index ? "true" : undefined}
        >
          {render(item, box)}
        </div>
      ))}
      <div
        data-present-controls
        className={cx(
          "absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg bg-black/75 px-1 py-1 text-[13px] text-white/90 shadow-pop transition-opacity duration-200",
          awake ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <button type="button" className={control} aria-label={`Previous ${noun}`} title={`Previous ${noun}`} disabled={index === 0} onClick={() => go(index - 1)}>
          <ChevronLeft size={16} />
        </button>
        <span className="min-w-[4.5rem] px-1 text-center tabular-nums" aria-live="polite">
          {index + 1} / {count}
        </span>
        <button type="button" className={control} aria-label={`Next ${noun}`} title={`Next ${noun}`} disabled={index >= count - 1} onClick={() => go(index + 1)}>
          <ChevronRight size={16} />
        </button>
        <span className="mx-1 h-4 w-px bg-white/25" aria-hidden />
        <button type="button" className={control} aria-label="Stop presenting" title="Stop presenting (Esc)" onClick={onExit}>
          <X size={16} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
