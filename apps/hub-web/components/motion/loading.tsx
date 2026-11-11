"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";
import { MOTION_SHOW_DELAY_MS } from "@/lib/motion/delay";

/** Ordinary request feedback. Keep branded motion for actual model/agent work. */
export function LocalSpinner({ size = 16, active = true, delay = MOTION_SHOW_DELAY_MS }: { size?: number; active?: boolean; delay?: number }) {
  const shown = useDelayedFlag(active, delay);
  const pixels = Math.max(14, size);
  if (!active) return null;
  return <span className="m-local-spinner-slot" style={{ width: pixels, height: pixels }} data-motion-slot="control.spinner" data-visible={shown ? "1" : "0"} data-state={shown ? "running" : "pending"} data-motion-loading={shown ? "1" : "0"} aria-hidden><span className="m-local-spinner" /></span>;
}

/** Local, unknown-duration work in a fixed content region. */
export function LoadingLine({ active, label }: { active: boolean; label: string }) {
  const shown = useDelayedFlag(active);
  if (!active) return null;
  return <div className="m-loading-line" data-visible={shown ? "1" : "0"} role="status" aria-label={label}><span aria-hidden /></div>;
}
