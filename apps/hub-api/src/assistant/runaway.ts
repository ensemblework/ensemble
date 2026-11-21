/**
 * Runaway detection for Ensemble's own loop (docs/11, Turn limits), which ends a stuck turn where no
 * step cap does. A call made again with the same input, with nothing changed in between, gets one
 * nudge at `nudge` repeats and ends the turn at `stop`; so does a run of `failedSteps` steps in which
 * every call failed. The turn then answers from what it has.
 */
export type RunawayVerdict = { kind: "nudge"; tool: string; times: number } | { kind: "stop"; why: "repeat" | "failing"; tool: string | null; times: number } | null;

export interface RunawayLimits {
  nudge: number;
  stop: number;
  failedSteps: number;
}

/** One call of a step, after it ran. `acts`: it may change something (anything but a parallel-safe read). */
export interface SettledCall {
  name: string;
  input: string;
  state: string | undefined;
  acts: boolean;
}

export class RunawayGuard {
  private readonly repeats = new Map<string, number>();
  private failing = 0;
  private nudged = false;

  constructor(private readonly limits: RunawayLimits) {}

  /** The calls of one step, in the model's order. */
  step(calls: readonly SettledCall[]): RunawayVerdict {
    let most: { tool: string; times: number } | null = null;
    for (const call of calls) {
      const key = `${call.name}\u0000${canonical(call.input)}`;
      const times = (this.repeats.get(key) ?? 0) + 1;
      this.repeats.set(key, times);
      if (!most || times > most.times) most = { tool: call.name, times };
      // Something changed: looking at anything again is not a repeat any more.
      if (call.acts && call.state === "ok") for (const other of [...this.repeats.keys()]) if (other !== key) this.repeats.delete(other);
    }
    if (calls.length) this.failing = calls.every((call) => call.state === "failed") ? this.failing + 1 : 0;
    if (most && most.times >= this.limits.stop) return { kind: "stop", why: "repeat", tool: most.tool, times: most.times };
    if (this.failing >= this.limits.failedSteps) return { kind: "stop", why: "failing", tool: null, times: this.failing };
    if (most && most.times >= this.limits.nudge && !this.nudged) {
      this.nudged = true;
      return { kind: "nudge", tool: most.tool, times: most.times };
    }
    return null;
  }
}

/** The same input written another way (key order, spacing) is the same call. */
function canonical(input: string): string {
  try {
    return JSON.stringify(sorted(JSON.parse(input || "{}")));
  } catch {
    return input.trim();
  }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
}

export function repeatNudge(tool: string, times: number): string {
  return `You have called ${tool} with the same input ${times} times and nothing changed in between. Do not call it that way again: take a different approach, or answer the person from what you already have.`;
}

/** The system line for the forced answer that ends a stuck turn. */
export function runawayFinal(why: "repeat" | "failing", failedSteps: number): string {
  return why === "repeat"
    ? "You kept repeating the same call without anything changing, so no more tools run in this turn. Answer the person now from what you already have: say what you did, what you found, and what you could not finish."
    : `Every tool call in the last ${failedSteps} steps failed, so no more tools run in this turn. Answer the person now from what you already have: say what you did, what did not work, and what you could not finish.`;
}

/** The answer when the model gives none after the turn was stopped: what ended it and what it did. */
export function runawayReply(why: "repeat" | "failing", done: readonly string[]): string {
  const reason = why === "repeat" ? "I stopped because I kept repeating the same step without progress." : "I stopped because every step I tried kept failing.";
  return done.length ? `${reason} What I did: ${done.join("; ")}.` : `${reason} Nothing was changed.`;
}
