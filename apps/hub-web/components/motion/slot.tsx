"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { createContext, useContext, useEffect, useState } from "react";
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

const VERBS = [
  "Harmonizing",
  "Weaving context",
  "Finding the thread",
  "Syncing up",
  "Tuning in",
  "Braiding",
  "Composing",
  "Counterpointing",
  "Keeping time",
  "Stitching it together",
  "Cross-referencing",
  "Conducting",
  "Humming along",
  "Falling in step",
  "Resolving the chord",
  "Listening in",
  "Threading the needle",
  "Rehearsing",
  "Riffing",
  "Warming up",
];

function verbInterval(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--m-dur-loop");
  const ms = Number.parseFloat(raw);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms / 2;
}

/** Playful verbs are a fallback. Real server text replaces them and is the only live region. */
export function ThinkingStatus({ real, active, art = true }: { real: string | null; active: boolean; art?: boolean }) {
  const shown = useDelayedFlag(active);
  const [index, setIndex] = useState(0);
  const { reduce } = useMotion();
  useEffect(() => {
    if (real || reduce || !shown) return;
    const ms = verbInterval();
    if (ms <= 0) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % VERBS.length), ms);
    return () => window.clearInterval(timer);
  }, [real, reduce, shown]);
  if (!shown) return null;
  const text = real ?? `${VERBS[index]}…`;
  return (
    <span className="m-think" data-motion-slot="agent.thinking" data-state={real ? "status" : "thinking"} data-motion-loading="1">
      {art ? <ThinkingArt /> : null}
      <span className="m-think-text" aria-hidden>
        {text}
      </span>
      <span className="sr-only" aria-live="polite">
        {real ?? ""}
      </span>
    </span>
  );
}

/** Agent working, in every motion style. The round-1 glyph stays for non-working poses. */
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
  return (
    <span className={shown ? "m-fetch m-loop" : "m-fetch"} data-motion-slot={slot} data-state={state} data-motion-loading={shown ? "1" : "0"} aria-hidden>
      <svg width={size} height={size} viewBox="0 0 16 16">
        <path className="a" d="M13.5 8a5.5 5.5 0 0 1-9.2 4.1" />
        <path className="b" d="M2.5 8a5.5 5.5 0 0 1 9.2-4.1" />
        <path className="a" d="M11.2 3.2h2.2V1" />
        <path className="b" d="M4.8 12.8H2.6V15" />
      </svg>
    </span>
  );
}

export function RunMark({ state }: { state: "queued" | "running" | "done" }) {
  const shown = useDelayedFlag(state === "running" || state === "queued");
  if (!shown && state !== "done") return null;
  return (
    <span className="m-run" data-motion-slot="run.progress" data-state={state} aria-hidden>
      <span className="m-run-bar">
        <i className={state === "running" ? "m-loop" : undefined} />
      </span>
    </span>
  );
}

export function TrayDot({ state }: { state: "idle" | "working" | "syncing" | "needs" | "paused" | "done" | "error" | "offline" }) {
  const live = state === "working" || state === "syncing" || state === "needs";
  return <span className={live ? "m-tray m-loop" : "m-tray"} data-motion-slot="native.tray" data-state={state} aria-hidden />;
}
