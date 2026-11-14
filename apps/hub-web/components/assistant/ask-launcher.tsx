"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrandMorph } from "../motion/brand-morph";
import { usePersistentState } from "@/lib/prefs";

import { LAUNCHER_SIZE, DEFAULT_LAUNCHER_SPOT, normalizeSpot, launcherPosition, snapLauncher, type LauncherSpot, type LauncherBounds } from "@ensemble/brand/assistant";
export { LAUNCHER_SIZE, DEFAULT_LAUNCHER_SPOT, normalizeSpot, launcherPosition, snapLauncher, type LauncherSpot, type EdgeSpot, type LauncherBounds } from "@ensemble/brand/assistant";
export const LAUNCHER_FLOOR_EVENT = "ensemble:launcher-floor";
const DRAG_THRESHOLD = 4;
const clamp01 = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;

/**
 * `hidden` keeps it mounted while the chat or a task is open, so it reappears where it was
 * instead of being measured again from the corner. It shows once both the work area and the
 * stored spot are known, and only a keyboard nudge animates it.
 */
export function AskLauncher({ onOpen, title, hidden = false, working = false }: { onOpen: () => void; title: string; hidden?: boolean; working?: boolean }) {
  const [stored, setStored, loaded] = usePersistentState<LauncherSpot>("ensemble.assistant.launcher", DEFAULT_LAUNCHER_SPOT);
  const [nudged, setNudged] = useState(false);
  const spot = normalizeSpot(stored);
  const ref = useRef<HTMLButtonElement>(null);
  const [bounds, setBounds] = useState<LauncherBounds | null>(null);
  const [live, setLive] = useState<LauncherSpot | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean; pointer: number } | null>(null);

  const measure = useCallback(() => {
    // The work area is the main column: after the sidebar (and a docked Pages panel), below the top bar,
    // and above a bar pinned to its bottom (Code's status bar).
    const main = document.getElementById("main-content");
    const rect = main?.getBoundingClientRect();
    const floor = main?.querySelector<HTMLElement>("[data-launcher-floor]")?.getBoundingClientRect();
    const bottom = rect && floor && floor.height > 0 && floor.top > rect.top + LAUNCHER_SIZE * 2 ? Math.min(rect.bottom, floor.top) : rect?.bottom;
    if (rect && bottom && rect.width > LAUNCHER_SIZE * 2 && rect.height > LAUNCHER_SIZE * 2) setBounds({ left: rect.left, top: rect.top, width: rect.right, height: bottom });
    else setBounds({ left: 0, width: window.innerWidth, height: window.innerHeight, top: 0 });
  }, []);

  useLayoutEffect(() => {
    measure();
    const area = ref.current?.parentElement;
    if (!area || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    const main = document.getElementById("main-content");
    if (main) observer.observe(main);
    window.addEventListener(LAUNCHER_FLOOR_EVENT, measure);
    return () => {
      observer.disconnect();
      window.removeEventListener(LAUNCHER_FLOOR_EVENT, measure);
    };
  }, [measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const pointFor = (event: { clientX: number; clientY: number }) => {
    return { x: event.clientX, y: event.clientY };
  };

  const nudge = (edge: LauncherSpot["edge"], delta: number) => {
    if (!bounds) return;
    const current = normalizeSpot(spot);
    setNudged(true);
    if (current.edge === edge) setStored({ edge, t: clamp01(current.t + delta) });
    // Arrows across the corner move it onto the other edge.
    else if (edge === "right" && delta < 0 && current.edge === "bottom" && current.t >= 0.999) setStored({ edge: "right", t: 1 + delta });
    else if (edge === "bottom" && delta < 0 && current.edge === "right" && current.t >= 0.999) setStored({ edge: "bottom", t: 1 + delta });

  };

  useEffect(() => {
    if (!nudged) return;
    const timer = window.setTimeout(() => setNudged(false), 240);
    return () => window.clearTimeout(timer);
  }, [nudged, stored]);

  // Hidden, the area can change size (a task opened beside it); measure again before it shows.
  useLayoutEffect(() => {
    if (!hidden) measure();
  }, [hidden, measure]);

  const shown = live ?? spot;
  const position = bounds && loaded ? launcherPosition(shown, bounds) : null;
  if (typeof document === "undefined" || !loaded || !bounds) return null;
  return createPortal(
    <button
      data-assistant-surface
      ref={ref}
      type="button"
      className="ask-launcher"
      hidden={hidden}
      data-ask-launcher={hidden ? undefined : normalizeSpot(shown).edge}
      data-dragging={live ? "1" : undefined}
      data-nudged={nudged ? "1" : undefined}
      aria-label="Ask Ensemble"
      aria-expanded={false}
      title={title}
      style={position ? { transform: `translate(${position.x}px, ${position.y}px)` } : { visibility: "hidden" }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX, y: event.clientY, moved: false, pointer: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointer !== event.pointerId || !bounds) return;
        if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD) return;
        start.moved = true;
        setLive(snapLauncher(pointFor(event), bounds));
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        // Only a press that started here opens it: not a right-click, and not a drag released over it.
        if (!start || start.pointer !== event.pointerId) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (start.moved && bounds) {
          setStored(snapLauncher(pointFor(event), bounds));
          setLive(null);
          return;
        }
        setLive(null);
        onOpen();
      }}
      onPointerCancel={() => {
        drag.current = null;
        setLive(null);
      }}
      onClick={(event) => {
        // Pointer clicks open from pointerup; this handles Enter and Space.
        if (event.detail === 0) onOpen();
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 0.2 : 0.05;
        if (event.key === "ArrowLeft") nudge("bottom", -step);
        else if (event.key === "ArrowRight") nudge("bottom", step);
        else if (event.key === "ArrowUp") nudge("right", -step);
        else if (event.key === "ArrowDown") nudge("right", step);
        else return;
        event.preventDefault();
      }}
    >
      <BrandMorph size={32} kind="beacon" state={working ? "loop" : "idle"} />
    </button>, document.body
  );
}
