"use client";

import { useCallback, useEffect, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { usePersistentState } from "@/lib/prefs";

import { PANEL_PHONE_MAX, PANEL_EDGES, panelBounds, clampPanelSize, defaultPanelSize, readPanelSize, draggedPanelSize, type PanelSize, type PanelEdge } from "@ensemble/brand/assistant";
export { PANEL_PHONE_MAX, PANEL_EDGES, PANEL_DEFAULT, PANEL_MIN, PANEL_MARGIN, panelBounds, clampPanelSize, defaultPanelSize, readPanelSize, draggedPanelSize, type PanelSize, type PanelEdge } from "@ensemble/brand/assistant";
type Viewport = PanelSize;
export const PANEL_SIZE_KEY = "ensemble.assistant.size";
const STEP = 16;

function currentViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * The floating assistant's size: dragged from its left edge, top edge or top-left corner, saved in
 * this browser, and fitted to the window again whenever the window changes. `active` is false while
 * the panel is expanded. Dragging writes the panel's style directly and saves once on release, so
 * the conversation does not re-render on every pointer move.
 */
export function usePanelSize(panel: RefObject<HTMLElement | null>, active: boolean) {
  const [saved, setSaved] = usePersistentState<PanelSize | null>(PANEL_SIZE_KEY, null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [dragging, setDragging] = useState<PanelEdge | null>(null);

  useEffect(() => {
    const update = () => setViewport(currentViewport());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const enabled = active && viewport !== null && viewport.width > PANEL_PHONE_MAX;
  const stored = readPanelSize(saved);
  const size = enabled && stored ? clampPanelSize(stored, viewport) : null;
  const shown = enabled ? (size ?? defaultPanelSize(viewport)) : null;
  const style: CSSProperties | undefined = size ? { width: size.width, height: size.height } : undefined;

  const reset = useCallback(() => setSaved(null), [setSaved]);

  const onPointerDown = (edge: PanelEdge) => (event: ReactPointerEvent<HTMLElement>) => {
    const element = panel.current;
    if (event.button !== 0 || !element) return;
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    const start = { width: rect.width, height: rect.height };
    const x0 = event.clientX;
    const y0 = event.clientY;
    let last: PanelSize | null = null;
    setDragging(edge);
    document.body.dataset.assistantResizing = edge;
    const move = (next: PointerEvent) => {
      last = draggedPanelSize(start, edge, next.clientX - x0, next.clientY - y0, currentViewport());
      element.style.width = `${last.width}px`;
      element.style.height = `${last.height}px`;
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      delete document.body.dataset.assistantResizing;
      setDragging(null);
      if (last) setSaved(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const onKeyDown = (edge: Exclude<PanelEdge, "corner">) => (event: KeyboardEvent<HTMLElement>) => {
    if (!shown || !viewport) return;
    if (event.key === "Home") {
      event.preventDefault();
      reset();
      return;
    }
    const grow =
      edge === "left"
        ? event.key === "ArrowLeft" ? STEP : event.key === "ArrowRight" ? -STEP : 0
        : event.key === "ArrowUp" ? STEP : event.key === "ArrowDown" ? -STEP : 0;
    if (!grow) return;
    event.preventDefault();
    setSaved(clampPanelSize({ width: shown.width + (edge === "left" ? grow : 0), height: shown.height + (edge === "top" ? grow : 0) }, viewport));
  };

  /** Props for one handle. The corner is for the pointer only; the two edges carry the keyboard. */
  const handleProps = (edge: PanelEdge) => {
    const bounds = viewport ? panelBounds(viewport) : null;
    const common = {
      className: "assistant-resize",
      "data-edge": edge,
      "data-active": dragging === edge || undefined,
      onPointerDown: onPointerDown(edge),
      onDoubleClick: reset,
    };
    if (edge === "corner") return { ...common, "aria-hidden": true };
    const width = edge === "left";
    return {
      ...common,
      role: "separator",
      tabIndex: 0,
      "aria-label": width ? "Resize the assistant's width" : "Resize the assistant's height",
      "aria-orientation": width ? ("vertical" as const) : ("horizontal" as const),
      "aria-valuenow": shown ? (width ? shown.width : shown.height) : undefined,
      "aria-valuemin": bounds ? (width ? bounds.min.width : bounds.min.height) : undefined,
      "aria-valuemax": bounds ? (width ? bounds.max.width : bounds.max.height) : undefined,
      title: "Drag to resize. Double-click to reset.",
      onKeyDown: onKeyDown(edge),
    };
  };

  return { enabled, style, size: shown, dragging, reset, handleProps };
}
