"use client";

import { useState } from "react";
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, setSidebarWidth } from "@/lib/sidebar-rail";

/** The sidebar's right edge: drag to resize (184 to 360 px), double-click for the default. Arrow keys work too. */
export function SidebarResize() {
  const [active, setActive] = useState(false);
  const current = () => {
    const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"));
    return Number.isFinite(value) ? value : SIDEBAR_WIDTH_DEFAULT;
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      className="sidebar-resize"
      data-active={active || undefined}
      onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT, true)}
      onKeyDown={(event) => {
        const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
        if (!step) return;
        event.preventDefault();
        setSidebarWidth(current() + step, true);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const start = current();
        const x0 = event.clientX;
        let last = start;
        setActive(true);
        document.body.dataset.sidebarResizing = "1";
        const move = (next: PointerEvent) => {
          last = setSidebarWidth(start + next.clientX - x0);
        };
        const end = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", end);
          window.removeEventListener("pointercancel", end);
          delete document.body.dataset.sidebarResizing;
          setActive(false);
          setSidebarWidth(last, true);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
      }}
    />
  );
}
