/**
 * One policy for every working or loading state.
 * Show nothing until the work has lasted past the delay, then keep the
 * indicator up long enough that it cannot flash off.
 * Content that was never covered by an indicator is not held.
 */
export const MOTION_SHOW_DELAY_MS = 180;
export const MOTION_MIN_VISIBLE_MS = 300;

export type DelayPhase = "idle" | "waiting" | "visible" | "holding";

export type DelaySnapshot = {
  phase: DelayPhase;
  /** Epoch ms when the indicator became visible, or null. */
  shownAt: number | null;
};

export function initialDelay(): DelaySnapshot {
  return { phase: "idle", shownAt: null };
}

/**
 * Advance the loader policy. `active` is true while the real work is in flight.
 * Returns the next snapshot and how many ms to wait before stepping again
 * (`null` means wait for the next active change).
 */
export function stepDelay(
  snapshot: DelaySnapshot,
  active: boolean,
  now: number,
  delay = MOTION_SHOW_DELAY_MS,
  minVisible = MOTION_MIN_VISIBLE_MS,
): { snapshot: DelaySnapshot; wait: number | null } {
  if (active && (snapshot.phase === "idle" || snapshot.phase === "holding")) {
    if (snapshot.phase === "holding") return { snapshot: { phase: "visible", shownAt: snapshot.shownAt }, wait: null };
    return { snapshot: { phase: "waiting", shownAt: null }, wait: delay };
  }
  if (active && snapshot.phase === "waiting") {
    return { snapshot: { phase: "visible", shownAt: now }, wait: null };
  }
  if (active && snapshot.phase === "visible") {
    return { snapshot, wait: null };
  }
  if (!active && snapshot.phase === "waiting") {
    return { snapshot: initialDelay(), wait: null };
  }
  if (!active && snapshot.phase === "visible") {
    const shownAt = snapshot.shownAt ?? now;
    const remain = Math.max(0, minVisible - (now - shownAt));
    if (remain === 0) return { snapshot: initialDelay(), wait: null };
    return { snapshot: { phase: "holding", shownAt }, wait: remain };
  }
  if (!active && snapshot.phase === "holding") {
    return { snapshot: initialDelay(), wait: null };
  }
  return { snapshot: initialDelay(), wait: null };
}

export function delayIsShown(snapshot: DelaySnapshot): boolean {
  return snapshot.phase === "visible" || snapshot.phase === "holding";
}
