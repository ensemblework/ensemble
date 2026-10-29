"use client";

import { useState } from "react";
import { readPanelWidth, setPanelWidth, type PanelWidth } from "@/lib/panel-width";

/**
 * A panel's inner edge: drag to resize between the spec's limits, double-click for the default,
 * arrow keys when focused. `edge` is the side of the panel the handle sits on.
 */
export function PanelResize({ spec, edge, label, className }: { spec: PanelWidth; edge: "left" | "right"; label: string; className?: string }) {
  const [active, setActive] = useState(false);
  const [now, setNow] = useState<number | undefined>(undefined);
  const grow = edge === "right" ? 1 : -1;
  // The rendered width, not the variable: before a first resize the CSS default applies.
  const measure = (handle: HTMLElement) => handle.parentElement?.getBoundingClientRect().width || readPanelWidth(spec);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      aria-valuenow={now}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      className={className ?? "panel-resize"}
      data-edge={edge}
      data-active={active || undefined}
      onFocus={(event) => setNow(Math.round(measure(event.currentTarget)))}
      onDoubleClick={() => { setPanelWidth(spec, null); setNow(spec.fallback); }}
      onKeyDown={(event) => {
        const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
        if (!step) return;
        event.preventDefault();
        setNow(setPanelWidth(spec, measure(event.currentTarget) + step * grow, true));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const start = measure(event.currentTarget);
        const x0 = event.clientX;
        let last = start;
        setActive(true);
        document.body.dataset.sidebarResizing = "1";
        const move = (next: PointerEvent) => {
          last = setPanelWidth(spec, start + (next.clientX - x0) * grow);
        };
        const end = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", end);
          window.removeEventListener("pointercancel", end);
          delete document.body.dataset.sidebarResizing;
          setActive(false);
          setNow(setPanelWidth(spec, last, true));
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
      }}
    />
  );
}
