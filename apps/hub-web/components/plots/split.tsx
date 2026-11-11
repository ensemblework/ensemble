"use client";

import { useCallback, useState, type RefObject } from "react";
import { perFrame } from "@/lib/motion/drag";

/** The code side of a Plots split: never under a quarter of the room, never over 60%. */
export const SPLIT_MIN = 0.25;
export const SPLIT_MAX = 0.6;

export const clampSplit = (value: number, min = SPLIT_MIN, max = SPLIT_MAX) => Math.min(max, Math.max(min, value));

function read(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  const stored = raw === null || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(stored) ? clampSplit(stored) : fallback;
}

/** A width kept as a share of its container, in this browser. */
export function useSplit(key: string, fallback: number): [number, (value: number, keep?: boolean) => void, number] {
  const [value, setValue] = useState(() => read(key, fallback));
  const set = useCallback(
    (next: number, keep = true) => {
      const clamped = clampSplit(next);
      setValue(clamped);
      if (keep) {
        try {
          window.localStorage.setItem(key, String(Math.round(clamped * 1000) / 1000));
        } catch {
          /* private mode: the width lasts for this visit */
        }
      }
    },
    [key],
  );
  return [value, set, fallback];
}

/**
 * The edge between two panes. `side` is where the measured pane sits: "right" grows as the edge moves left.
 * Drag, arrows (Shift for bigger steps), Home/End, and a double-click resets.
 */
export function SplitHandle({
  container,
  value,
  fallback,
  side,
  label,
  onChange,
  className = "",
}: {
  container: RefObject<HTMLElement | null>;
  value: number;
  fallback: number;
  side: "left" | "right";
  label: string;
  onChange: (value: number, keep?: boolean) => void;
  className?: string;
}) {
  const [active, setActive] = useState(false);
  const share = (clientX: number) => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return value;
    return side === "right" ? (rect.right - clientX) / rect.width : (clientX - rect.left) / rect.width;
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={Math.round(SPLIT_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_MAX * 100)}
      aria-valuenow={Math.round(value * 100)}
      aria-valuetext={`${Math.round(value * 100)}% of the width`}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      data-active={active || undefined}
      data-plot-split
      className={`pl-split ${className}`}
      onDoubleClick={() => onChange(fallback)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 0.05 : 0.02;
        const grow = side === "right" ? -1 : 1;
        let next: number | null = null;
        if (event.key === "ArrowLeft") next = value + step * -grow;
        else if (event.key === "ArrowRight") next = value + step * grow;
        else if (event.key === "Home") next = SPLIT_MIN;
        else if (event.key === "End") next = SPLIT_MAX;
        if (next === null) return;
        event.preventDefault();
        onChange(next);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        setActive(true);
        document.documentElement.dataset.splitting = "1";
        // The panes render at most once a frame, however often the pointer reports.
        const resize = perFrame((clientX: number) => onChange(share(clientX), false));
        const move = (ev: PointerEvent) => resize(ev.clientX);
        const up = (ev: PointerEvent) => {
          resize.cancel();
          onChange(share(ev.clientX));
          setActive(false);
          delete document.documentElement.dataset.splitting;
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      }}
    />
  );
}
