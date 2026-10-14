"use client";
import { BrandMorph } from "./brand-morph";
export type TerminalState = "working" | "idle" | "done" | "error";

export function TerminalMark({ state, label }: { state: TerminalState; label?: string }) {
  return <span className="inline-flex items-center" data-motion-slot="terminal.working" data-state={state}>
    <BrandMorph size={16} kind="relay" state={state === "working" ? "loop" : "idle"} />
    {label ? <span className="sr-only">{label}</span> : null}
  </span>;
}
export const TerminalSvg = TerminalMark;
