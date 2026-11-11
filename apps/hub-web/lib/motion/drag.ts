/**
 * Shared pieces for pointer drags and resizes: pointer work at most once per frame, the reduced-motion
 * check, and FLIP (measure, change, then play each element from where it was) for what a drop moved.
 */

/** The settle after a drop or a reorder: short, ease-out, no overshoot. */
export const SETTLE_MS = 220;
export const SETTLE_EASE = "cubic-bezier(0.2, 0, 0, 1)";

/** The OS setting, or the app's own (`data-reduce-motion="true"` on <html>, set by lib/prefs.ts). */
export function motionReduced(doc: Document | undefined = typeof document === "undefined" ? undefined : document): boolean {
  if (!doc) return true;
  if (doc.documentElement.dataset.reduceMotion === "true") return true;
  const view = doc.defaultView;
  return Boolean(view && typeof view.matchMedia === "function" && view.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

export type PerFrame<A extends unknown[]> = ((...args: A) => void) & { cancel: () => void; flush: () => void };

/**
 * Calls `fn` at most once per animation frame, with the latest arguments. A mouse can report several moves a
 * frame; hit testing and state for each of them is work nobody sees. `flush` runs a pending call now (on
 * release), `cancel` drops it.
 */
export function perFrame<A extends unknown[]>(
  fn: (...args: A) => void,
  schedule: (run: () => void) => number = (run) => requestAnimationFrame(run),
  unschedule: (id: number) => void = (id) => cancelAnimationFrame(id),
): PerFrame<A> {
  let frame = 0;
  let pending: A | null = null;
  const run = () => {
    frame = 0;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const call = ((...args: A) => {
    pending = args;
    if (!frame) frame = schedule(run);
  }) as PerFrame<A>;
  call.cancel = () => {
    if (frame) unschedule(frame);
    frame = 0;
    pending = null;
  };
  call.flush = () => {
    if (frame) unschedule(frame);
    run();
  };
  return call;
}

export type Box = { left: number; top: number; width: number; height: number };

/** Each keyed element's box now (viewport coordinates). Elements without a key are skipped. */
export function measureBoxes(elements: Iterable<HTMLElement>, key: (element: HTMLElement) => string | null | undefined): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const element of elements) {
    const id = key(element);
    if (!id) continue;
    const rect = element.getBoundingClientRect();
    boxes.set(id, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  }
  return boxes;
}

/** The offset a FLIP starts from (where it was, relative to where it is), or null when the move is too small to show. */
export function flipOffset(before: Box, after: Box, threshold = 1): { x: number; y: number } | null {
  const x = before.left - after.left;
  const y = before.top - after.top;
  return Math.abs(x) < threshold && Math.abs(y) < threshold ? null : { x, y };
}

/**
 * Plays every keyed element that moved from its box in `before` to where it is now, with transform only.
 * Size changes are not animated: the element takes its new size at once and glides into its new place.
 */
export function playFlip(
  elements: Iterable<HTMLElement>,
  key: (element: HTMLElement) => string | null | undefined,
  before: Map<string, Box>,
  options: { duration?: number; easing?: string; reduced?: boolean } = {},
): Animation[] {
  if (options.reduced ?? motionReduced()) return [];
  const played: Animation[] = [];
  for (const element of elements) {
    const id = key(element);
    const was = id ? before.get(id) : undefined;
    if (!was || typeof element.animate !== "function") continue;
    const rect = element.getBoundingClientRect();
    const offset = flipOffset(was, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    if (!offset) continue;
    played.push(
      element.animate([{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }, { transform: "translate3d(0, 0, 0)" }], {
        duration: options.duration ?? SETTLE_MS,
        easing: options.easing ?? SETTLE_EASE,
      }),
    );
  }
  return played;
}
