"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrandMorph } from "../motion/brand-morph";
import { usePersistentState } from "@/lib/prefs";

/** `free` was an earlier anywhere-on-screen spot; it is read as the nearer of the two edges. */
export type LauncherSpot = { edge: "bottom" | "right"; t: number } | { edge: "free"; x: number; y: number };
/** The work area in window coordinates: `left` and `top` are where the sidebar and the top bar end, `width` and `height` its right and bottom edges. */
export type EdgeSpot = { edge: "bottom" | "right"; t: number };
export type LauncherBounds = { width: number; height: number; top: number; left?: number };

export const LAUNCHER_SIZE = 44;
const MARGIN = 16;
/** A bar at the foot of the work area (marked `data-launcher-floor`) appeared or went: measure again. */
export const LAUNCHER_FLOOR_EVENT = "ensemble:launcher-floor";
const DRAG_THRESHOLD = 4;
export const DEFAULT_LAUNCHER_SPOT: EdgeSpot = { edge: "bottom", t: 1 };

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1);

export function normalizeSpot(value: unknown): EdgeSpot {
  const spot = value as Partial<LauncherSpot> | null;
  if (spot?.edge === "free") {
    const x = clamp01(Number(spot.x));
    const y = clamp01(Number(spot.y));
    return 1 - x < 1 - y ? { edge: "right", t: y } : { edge: "bottom", t: x };
  }
  if (!spot || (spot.edge !== "bottom" && spot.edge !== "right")) return DEFAULT_LAUNCHER_SPOT;
  return { edge: spot.edge, t: clamp01(Number(spot.t)) };
}

/**
 * Where the launcher sits: along the bottom or the right edge of the work area, which starts after the
 * sidebar and below the top bar, so the button never covers either. A stored spot is a fraction along its
 * edge, so it survives any window size.
 */
export function launcherPosition(spot: LauncherSpot, bounds: LauncherBounds): { x: number; y: number } {
  spot = normalizeSpot(spot);
  const minX = (bounds.left ?? 0) + MARGIN;
  const maxX = Math.max(minX, bounds.width - LAUNCHER_SIZE - MARGIN);
  const minY = bounds.top + MARGIN;
  const maxY = Math.max(minY, bounds.height - LAUNCHER_SIZE - MARGIN);
  if (spot.edge === "right") return { x: maxX, y: Math.round(minY + spot.t * (maxY - minY)) };
  return { x: Math.round(minX + spot.t * (maxX - minX)), y: maxY };
}

/** The nearest allowed spot to a pointer: on the bottom edge or the right edge, whichever is closer. */
export function snapLauncher(point: { x: number; y: number }, bounds: LauncherBounds): LauncherSpot {
  const half = LAUNCHER_SIZE / 2;
  const minX = (bounds.left ?? 0) + MARGIN;
  const maxX = Math.max(minX, bounds.width - LAUNCHER_SIZE - MARGIN);
  const minY = bounds.top + MARGIN;
  const maxY = Math.max(minY, bounds.height - LAUNCHER_SIZE - MARGIN);
  const x = point.x - half;
  const y = point.y - half;
  if (maxX - x < maxY - y) return { edge: "right", t: clamp01((y - minY) / Math.max(1, maxY - minY)) };
  return { edge: "bottom", t: clamp01((x - minX) / Math.max(1, maxX - minX)) };
}

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
