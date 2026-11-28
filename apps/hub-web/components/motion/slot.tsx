"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";
import { AgentActivityMark } from "./agent-activity-mark";
import { LocalSpinner } from "./loading";

export function ThinkingStatus({ real, active }: { real: string; active: boolean }) {
  return (
    <span className="m-think" role="status">
      <AgentActivityMark kind={active ? "weave" : null} />
      {active ? <span className="m-think-text">{real}</span> : null}
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
  return <span data-motion-slot={slot} data-state={state} data-motion-loading={shown ? "1" : "0"} aria-hidden><LocalSpinner size={size} active={active} /></span>;
}

export function TrayDot({ state }: { state: "idle" | "working" | "syncing" | "needs" | "paused" | "done" | "error" | "offline" }) {
  return <AgentActivityMark size="pill" kind={state === "working" ? "infinity" : null} rest />;
}
