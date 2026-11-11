"use client";

import { useEffect, useMemo, useState } from "react";

export const CHAPTER_TRANSITION = 650;

/** An eased beat for a demonstration, held before and after its allotted time. */
export function demoBeat(ms: number, start: number, end: number): number {
  const t = Math.max(0, Math.min(1, (ms - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

/**
 * The scene's single clock. Time runs on animation-frame timestamps: a resumed clock starts at the
 * next frame it is read on, so every reader in a frame (the scene and the pointer) gets the same value.
 */
export type SceneClock = { read: (now?: number) => number };
export function createSceneClock(duration: number, start = 0) {
  let base = Math.max(0, Math.min(duration, start));
  let since: number | null = null;
  let pending = false;
  let latest = 0;
  const read = (now?: number) => {
    if (now !== undefined) {
      latest = now;
      if (pending) { since = now; pending = false; }
    }
    return since === null ? base : Math.min(duration, base + Math.max(0, latest - since));
  };
  return {
    read,
    play() { if (since === null) pending = true; },
    /** Holds the time of the last frame read, which is what was on screen. */
    pause() { base = read(); since = null; pending = false; },
  };
}

export function useScenePlayback(chapter: string, duration: number, reduced: boolean, transitioning: boolean) {
  const [ms, setMs] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [replay, setReplay] = useState(0);
  // A new chapter or a restart gets a new clock in the same render, so no frame mixes chapters.
  const clock = useMemo(() => createSceneClock(duration, reduced ? duration : 0), [chapter, duration, reduced, replay]);
  useEffect(() => {
    setMs(clock.read());
    setPlaying(!reduced);
  }, [clock, reduced]);
  useEffect(() => {
    if (!playing || reduced || transitioning) return;
    let frame = 0;
    let painted = -1;
    const tick = (now: number) => {
      const elapsed = clock.read(now);
      const next = Math.floor(elapsed / 32) * 32;
      if (next !== painted || elapsed === duration) { painted = next; setMs(elapsed); }
      if (elapsed < duration) frame = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    const visibility = () => {
      if (document.hidden) { clock.pause(); cancelAnimationFrame(frame); }
      else { clock.play(); frame = requestAnimationFrame(tick); }
    };
    if (!document.hidden) clock.play();
    frame = requestAnimationFrame(tick);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
      clock.pause();
      setMs(clock.read());
    };
  }, [clock, duration, playing, reduced, transitioning]);
  const restart = () => setReplay((value) => value + 1);
  return { ms: reduced ? duration : ms, playing, clock: clock as SceneClock, restart, toggle: () => ms >= duration ? restart() : setPlaying((value) => !value) };
}
