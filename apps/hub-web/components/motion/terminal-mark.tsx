"use client";
import { LocalSpinner } from "./loading";
export type TerminalState = "working" | "idle" | "done" | "error";

export function TerminalMark({ state, label }: { state: TerminalState; label?: string }) {
  return <span className="inline-flex items-center" data-motion-slot="terminal.working" data-state={state}>
    <LocalSpinner size={16} active={state === "working"} />
    {label ? <span className="sr-only">{label}</span> : null}
  </span>;
}
export const TerminalSvg = TerminalMark;
