"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Mark } from "../mark";
import { usePersistentState } from "@/lib/prefs";

export type LauncherSpot = { edge: "bottom" | "right"; t: number };
export type LauncherBounds = { width: number; height: number; top: number };

export const LAUNCHER_SIZE = 44;
const MARGIN = 16;
const DRAG_THRESHOLD = 4;
export const DEFAULT_LAUNCHER_SPOT: LauncherSpot = { edge: "bottom", t: 1 };

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1);

export function normalizeSpot(value: unknown): LauncherSpot {
  const spot = value as Partial<LauncherSpot> | null;
  if (!spot || (spot.edge !== "bottom" && spot.edge !== "right")) return DEFAULT_LAUNCHER_SPOT;
  return { edge: spot.edge, t: clamp01(Number(spot.t)) };
}

/**
 * Where the launcher sits inside the work area. The area starts below the top bar,
 * so the button can never cover the bar or the sidebar, and a stored spot is a
 * fraction along an edge, so it survives any window size.
 */
export function launcherPosition(spot: LauncherSpot, bounds: LauncherBounds): { x: number; y: number } {
  const minX = MARGIN;
  const maxX = Math.max(minX, bounds.width - LAUNCHER_SIZE - MARGIN);
  const minY = bounds.top + MARGIN;
  const maxY = Math.max(minY, bounds.height - LAUNCHER_SIZE - MARGIN);
  if (spot.edge === "right") return { x: maxX, y: Math.round(minY + spot.t * (maxY - minY)) };
  return { x: Math.round(minX + spot.t * (maxX - minX)), y: maxY };
}

/** The nearest allowed spot to a pointer: along the bottom edge or along the right edge. */
export function snapLauncher(point: { x: number; y: number }, bounds: LauncherBounds): LauncherSpot {
  const half = LAUNCHER_SIZE / 2;
  const minX = MARGIN;
  const maxX = Math.max(minX, bounds.width - LAUNCHER_SIZE - MARGIN);
  const minY = bounds.top + MARGIN;
  const maxY = Math.max(minY, bounds.height - LAUNCHER_SIZE - MARGIN);
  const toBottom = Math.abs(maxY + half - point.y);
  const toRight = Math.abs(maxX + half - point.x);
  if (toRight < toBottom) return { edge: "right", t: clamp01(maxY === minY ? 1 : (point.y - half - minY) / (maxY - minY)) };
  return { edge: "bottom", t: clamp01(maxX === minX ? 1 : (point.x - half - minX) / (maxX - minX)) };
}

export function AskLauncher({ onOpen, title }: { onOpen: () => void; title: string }) {
  const [stored, setStored] = usePersistentState<LauncherSpot>("ensemble.assistant.launcher", DEFAULT_LAUNCHER_SPOT);
  const spot = normalizeSpot(stored);
  const ref = useRef<HTMLButtonElement>(null);
  const [bounds, setBounds] = useState<LauncherBounds | null>(null);
  const [live, setLive] = useState<LauncherSpot | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean; pointer: number } | null>(null);

  const measure = useCallback(() => {
    const area = ref.current?.parentElement;
    if (!area) return;
    const main = area.querySelector("main");
    const top = main ? main.getBoundingClientRect().top - area.getBoundingClientRect().top : 0;
    setBounds({ width: area.clientWidth, height: area.clientHeight, top: Math.max(0, top) });
  }, []);

  useLayoutEffect(() => {
    measure();
    const area = ref.current?.parentElement;
    if (!area || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    const main = area.querySelector("main");
    if (main) observer.observe(main);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const pointFor = (event: { clientX: number; clientY: number }) => {
    const area = ref.current?.parentElement?.getBoundingClientRect();
    return { x: event.clientX - (area?.left ?? 0), y: event.clientY - (area?.top ?? 0) };
  };

  const nudge = (edge: LauncherSpot["edge"], delta: number) => {
    const current = spot.edge === edge ? spot.t : 1;
    setStored({ edge, t: clamp01(current + delta) });
  };

  const shown = live ?? spot;
  const position = bounds ? launcherPosition(shown, bounds) : null;
  return (
    <button
      ref={ref}
      type="button"
      className="ask-launcher"
      data-ask-launcher={shown.edge}
      data-dragging={live ? "1" : undefined}
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
      <Mark />
    </button>
  );
}
