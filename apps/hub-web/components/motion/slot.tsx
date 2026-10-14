"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { createContext, useContext } from "react";
import type { MotionTheme } from "@ensemble/shared-types";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";
import { BrandMorph } from "./brand-morph";

export type MotionContextValue = { theme: MotionTheme; reduce: boolean };

const MotionContext = createContext<MotionContextValue>({ theme: "expressive", reduce: false });

export function MotionContextProvider({ value, children }: { value: MotionContextValue; children: React.ReactNode }) {
  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export function useMotion(): MotionContextValue {
  return useContext(MotionContext);
}

export function ThinkingStatus({ real, active, art = true }: { real: string | null; active: boolean; art?: boolean }) {
  const shown = useDelayedFlag(active);
  if (!shown) return null;
  const text = real ?? "Working…";
  return (
    <span className="m-think" data-motion-slot="agent.thinking" data-state={real ? "status" : "thinking"} data-motion-loading="1">
      {art ? <ThinkingArt /> : null}
      <span className="m-think-text" aria-hidden>
        {text}
      </span>
      <span className="sr-only" aria-live="polite">
        {text}
      </span>
    </span>
  );
}

/** The assistant’s active infinity weave. */
function ThinkingArt() {
  return (
    <span className="m-think-art" aria-hidden>
      <BrandMorph size={16} state="loop" />
    </span>
  );
}

export function FetchGlyph({
  active,
  slot = "fetch.refresh",
  size = 14,
}: {
  active: boolean;
  slot?: "fetch.refresh" | "connector.sync";
  size?: number;
}) {
  const shown = useDelayedFlag(active);
  const state = shown ? (slot === "connector.sync" ? "syncing" : "fetching") : "done";
  return <span data-motion-slot={slot} data-state={state} data-motion-loading={shown ? "1" : "0"} aria-hidden><BrandMorph size={size} kind="beacon" state={shown ? "loop" : "idle"} /></span>;
}

export function RunMark({ state }: { state: "queued" | "running" | "done" }) {
  return <span data-motion-slot="run.progress" data-state={state} aria-hidden><BrandMorph size={20} kind="relay" state={state === "running" ? "loop" : "idle"} loader={state === "running"} /></span>;
}

export function TrayDot({ state }: { state: "idle" | "working" | "syncing" | "needs" | "paused" | "done" | "error" | "offline" }) {
  return <span data-motion-slot="native.tray" data-state={state} aria-hidden><BrandMorph size={18} kind="beacon" state={state === "working" || state === "syncing" ? "loop" : "idle"} /></span>;
}
