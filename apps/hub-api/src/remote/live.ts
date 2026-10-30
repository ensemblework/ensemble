/**
 * The live view of a run's browser tab (docs/25 §10.1, docs/35 §8.16): the broker hands each small
 * frame to its operation's `onLiveFrame`; for a run from the web, the remote loop sends it on to
 * Ensemble on the web (`ROUTES.liveFrame`) under the hosted job and its lease. A run started here
 * has no one watching on the web, so its tabs get no live view.
 */
import type { LiveFrame } from "../browser/broker.js";

type Sink = (localJobId: string, frame: LiveFrame) => boolean;
let sink: Sink | null = null;

/** Set by the remote loop while it is connected; null when it is not. */
export function setLiveSink(next: Sink | null): void {
  sink = next;
}

/** The live view for a local job's browser tools, or undefined when nothing on the web would show it. */
export function liveFrameFor(localJobId: string): ((frame: LiveFrame) => void) | undefined {
  if (!sink) return undefined;
  return (frame) => {
    sink?.(localJobId, frame);
  };
}
