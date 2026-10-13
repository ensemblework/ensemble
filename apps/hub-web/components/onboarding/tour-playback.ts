"use client";

import { useEffect, useRef, useState } from "react";

export const CHAPTER_TRANSITION = 650;

/** An eased beat for a demonstration, held before and after its allotted time. */
export function demoBeat(ms: number, start: number, end: number): number {
  const t = Math.max(0, Math.min(1, (ms - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

export function useScenePlayback(chapter: string, duration: number, reduced: boolean, transitioning: boolean) {
  const [ms, setMs] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [replay, setReplay] = useState(0);
  const elapsed = useRef(0);
  useEffect(() => {
    elapsed.current = reduced ? duration : 0;
    setMs(elapsed.current);
    setPlaying(!reduced);
  }, [chapter, duration, reduced, replay]);
  useEffect(() => {
    if (!playing || reduced || transitioning) return;
    let frame = 0;
    let last = window.performance.now();
    let painted = -1;
    const tick = (now: number) => {
      if (!document.hidden) elapsed.current = Math.min(duration, elapsed.current + Math.max(0, Math.min(100, now - last)));
      last = now;
      const next = Math.floor(elapsed.current / 32) * 32;
      if (next !== painted || elapsed.current === duration) { painted = next; setMs(elapsed.current); }
      if (elapsed.current < duration) frame = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [chapter, duration, playing, reduced, transitioning, replay]);
  const restart = () => setReplay((value) => value + 1);
  return { ms: reduced ? duration : ms, playing, restart, toggle: () => ms >= duration ? restart() : setPlaying((value) => !value) };
}
