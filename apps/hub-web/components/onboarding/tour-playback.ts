"use client";

import { useEffect, useRef, useState } from "react";

export const SCENE_DURATION = 12_000;
export const CHAPTER_TRANSITION = 650;

/** An eased beat for a demonstration, held before and after its allotted time. */
export function demoBeat(ms: number, start: number, end: number): number {
  const t = Math.max(0, Math.min(1, (ms - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

export function useScenePlayback(chapter: string, reduced: boolean, transitioning: boolean) {
  const [ms, setMs] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [replay, setReplay] = useState(0);
  const elapsed = useRef(0);
  useEffect(() => {
    elapsed.current = reduced ? SCENE_DURATION : 0;
    setMs(elapsed.current);
    setPlaying(!reduced);
  }, [chapter, reduced, replay]);
  useEffect(() => {
    if (!playing || reduced || transitioning) return;
    let frame = 0;
    let last = window.performance.now();
    let painted = -1;
    const tick = (now: number) => {
      if (!document.hidden) elapsed.current = Math.min(SCENE_DURATION, elapsed.current + Math.max(0, Math.min(100, now - last)));
      last = now;
      const next = Math.floor(elapsed.current / 80) * 80;
      if (next !== painted || elapsed.current === SCENE_DURATION) { painted = next; setMs(elapsed.current); }
      if (elapsed.current < SCENE_DURATION) frame = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [chapter, playing, reduced, transitioning, replay]);
  const restart = () => setReplay((value) => value + 1);
  return { ms: reduced ? SCENE_DURATION : ms, playing, restart, toggle: () => ms >= SCENE_DURATION ? restart() : setPlaying((value) => !value) };
}
