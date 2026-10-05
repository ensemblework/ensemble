"use client";

import { useEffect, useState } from "react";
import type { MotionTheme } from "@ensemble/shared-types";
import framesFile from "./terminal-frames.json";
import { useMotion } from "./slot";

export type TerminalState = "working" | "idle" | "done" | "error";

type FrameSpec = { frames: string[]; ms: number[]; loop: boolean; tone: string; still: string };

const frames = framesFile as unknown as {
  sets: Record<string, Record<string, Record<string, FrameSpec>>>;
};

export function terminalSpec(theme: MotionTheme, state: TerminalState, set = "glyph"): FrameSpec {
  const group = frames.sets[set] ?? frames.sets.glyph;
  const style = group?.[theme] ?? group?.expressive;
  return style?.[state] ?? style?.working ?? { frames: ["·"], ms: [80], loop: false, tone: "muted", still: "·" };
}

/** One character per frame. The cell is 1ch, so a missing glyph cannot shift the line. */
export function TerminalMark({ state, label }: { state: TerminalState; label?: string }) {
  const { theme, reduce } = useMotion();
  const spec = terminalSpec(theme, state);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
    if (reduce) return;
    let i = 0;
    let timer = 0;
    let live = true;
    const step = () => {
      const wait = spec.ms[Math.min(i, spec.ms.length - 1)] ?? 80;
      timer = window.setTimeout(() => {
        if (!live) return;
        if (!spec.loop && i >= spec.frames.length - 1) return;
        i = spec.loop ? (i + 1) % spec.frames.length : Math.min(i + 1, spec.frames.length - 1);
        setIndex(i);
        step();
      }, wait);
    };
    step();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [spec, reduce]);
  const glyph = reduce ? spec.still : (spec.frames[index] ?? spec.still);
  return (
    <span className="inline-flex items-center">
      <span className="tw tw-text" data-motion-slot="terminal.working" data-state={state} data-tone={spec.tone} aria-hidden>
        {glyph}
      </span>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

/** 14 px SVG for hosts where a text frame would not sit in the line. */
export function TerminalSvg({ state }: { state: TerminalState }) {
  return (
    <span className="tw tw-svg" data-motion-slot="terminal.working" data-state={state} aria-hidden>
      <svg viewBox="0 0 14 14">
        <g className="u">
          <path className="o oL" pathLength="1" d="M3 2.5V7.5A4 4 0 0 0 7 11.5" />
          <path className="o oR" pathLength="1" d="M7 11.5A4 4 0 0 0 11 7.5V2.5" />
          <path className="i" pathLength="1" d="M5.5 2.5V7.5A1.5 1.5 0 0 0 8.5 7.5V2.5" />
        </g>
        <path className="run" pathLength="1" d="M3 2.5V7.5A4 4 0 0 0 11 7.5V2.5" />
        <path className="ck" pathLength="1" d="M3.3 7.4L5.9 10L10.7 4.4" />
        <g className="dd">
          <circle className="y" cx="4.5" cy="7" r="1.7" />
          <circle className="a" cx="9.5" cy="7" r="1.7" />
        </g>
      </svg>
    </span>
  );
}
