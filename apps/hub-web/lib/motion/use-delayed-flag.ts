"use client";

import { useEffect, useState } from "react";
import { MOTION_MIN_VISIBLE_MS, MOTION_SHOW_DELAY_MS, delayIsShown, initialDelay, stepDelay, type DelaySnapshot } from "./delay";

/** True only after `active` has lasted past the show delay, then for the minimum hold. */
export function useDelayedFlag(active: boolean, delay = MOTION_SHOW_DELAY_MS, minVisible = MOTION_MIN_VISIBLE_MS): boolean {
  const [snapshot, setSnapshot] = useState<DelaySnapshot>(initialDelay);

  useEffect(() => {
    let timer = 0;
    const run = (current: DelaySnapshot, on: boolean) => {
      const next = stepDelay(current, on, Date.now(), delay, minVisible);
      setSnapshot(next.snapshot);
      if (next.wait == null) return;
      timer = window.setTimeout(() => run(next.snapshot, on), next.wait);
    };
    run(snapshot, active);
    return () => window.clearTimeout(timer);
    // snapshot is the input to this step; including it would retrigger the wait loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, delay, minVisible]);

  return delayIsShown(snapshot);
}
