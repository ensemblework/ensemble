/**
 * Runaway detection for Ensemble's own loop (docs/11, Turn limits): it ends a stuck turn where no step
 * cap does. A call made again with the same input that returns the same result changed nothing. Such
 * a repeat gets one nudge at `nudge` and ends the turn at `stop`, and so does a round of two to four
 * calls gone through again with the same results. A run of `failedSteps` steps in which every call
 * failed ends it too. Only progress starts the counts again: a call that can change something (not
 * read-only) that succeeded and returned what it had not returned before in this turn. Looking again
 * at something that changed (a status being polled) is never a repeat. The turn then answers from what
 * it has.
 */
import { createHash } from "node:crypto";

export type RunawayVerdict =
  | { kind: "nudge"; tool: string; times: number; round: number }
  | { kind: "stop"; why: "repeat" | "failing"; tool: string | null; times: number; round: number }
  | null;

export interface RunawayLimits {
  nudge: number;
  stop: number;
  failedSteps: number;
}

/** One call of a step, after it ran. */
export interface SettledCall {
  name: string;
  input: string;
  state: string | undefined;
  /** What the model was told the call returned (`resultDigest`). */
  digest: string;
  /** It only looks (registry.ts `readsOnly`), so it is never progress. */
  readOnly: boolean;
}

/** The longest round of different calls that counts as going round in a loop. */
const MAX_ROUND = 4;

type Repeat = { tool: string; times: number; round: number };

export class RunawayGuard {
  /** Each call with its result since the last progress, and how often it came. */
  private readonly repeats = new Map<string, number>();
  /** The same, in order, for rounds. */
  private trail: string[] = [];
  /** Every call with its result in this turn: one that comes again is not progress. */
  private readonly seen = new Map<string, string>();
  private failing = 0;
  private nudged = false;

  constructor(private readonly limits: RunawayLimits) {}

  /** The calls of one step, in the model's order. */
  step(calls: readonly SettledCall[]): RunawayVerdict {
    let most: Repeat | null = null;
    for (const call of calls) {
      const key = `${call.name}\u0000${canonical(call.input)}\u0000${call.digest}`;
      if (!call.readOnly && call.state === "ok" && !this.seen.has(key)) {
        this.repeats.clear();
        this.trail = [];
        this.nudged = false;
        most = null;
      }
      this.seen.set(key, call.name);
      const times = (this.repeats.get(key) ?? 0) + 1;
      this.repeats.set(key, times);
      this.trail.push(key);
      if (!most || times > most.times) most = { tool: call.name, times, round: 1 };
    }
    const round = this.round();
    if (round && (!most || round.times >= most.times)) most = round;
    if (calls.length) this.failing = calls.every((call) => call.state === "failed") ? this.failing + 1 : 0;
    if (most && most.times >= this.limits.stop) return { kind: "stop", why: "repeat", ...most };
    if (this.failing >= this.limits.failedSteps) return { kind: "stop", why: "failing", tool: null, times: this.failing, round: 1 };
    if (most && most.times >= this.limits.nudge && !this.nudged) {
      this.nudged = true;
      return { kind: "nudge", ...most };
    }
    return null;
  }

  /** The last two to four calls, when the calls just before them were the same ones with the same results: how many times over. */
  private round(): Repeat | null {
    let best: Repeat | null = null;
    for (let size = 2; size <= MAX_ROUND && size * 2 <= this.trail.length; size += 1) {
      const last = this.trail.slice(-size);
      if (new Set(last).size < 2) continue;
      let times = 1;
      for (let start = this.trail.length - size * 2; start >= 0; start -= size) {
        if (!last.every((key, index) => this.trail[start + index] === key)) break;
        times += 1;
      }
      if (times > 1 && (!best || times > best.times)) best = { tool: [...new Set(last.map((key) => this.seen.get(key)!))].join(", "), times, round: size };
    }
    return best;
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

// Made anew by every call, so never a change: record ids, times, durations, kept output names.
const GENERATED = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|\b\d+(?:\.\d+)?\s?(?:ms|s)\b|\bout_\d+\b/gi;
const TIMING = /^(?:ms|ts|timestamp|seconds|took)$|^(?:duration|elapsed)|(?:Ms|Seconds|At)$/;

/** What a call returned, as the model was told it, in a few characters. */
export function resultDigest(result: unknown): string {
  const text =
    typeof result === "string"
      ? result.replace(GENERATED, "#")
      : (JSON.stringify(result, (key, value: unknown) => (typeof value === "string" ? value.replace(GENERATED, "#") : typeof value === "number" && TIMING.test(key) ? 0 : value)) ?? "");
  return createHash("sha256").update(text).digest("base64url").slice(0, 16);
}

export function repeatNudge(verdict: { tool: string; times: number; round: number }): string {
  return verdict.round > 1
    ? `You have gone round the same ${verdict.round} calls (${verdict.tool}) ${verdict.times} times and they returned the same results each time, so nothing changed. Do not go round again: take a different approach, or answer the person from what you already have.`
    : `You have called ${verdict.tool} with the same input ${verdict.times} times and it returned the same result each time, so nothing changed. Do not call it that way again: take a different approach, or answer the person from what you already have.`;
}

/** The system line for the forced answer that ends a stuck turn. */
export function runawayFinal(why: "repeat" | "failing", failedSteps: number): string {
  return why === "repeat"
    ? "You kept repeating the same calls and they kept returning the same results, so no more tools run in this turn. Answer the person now from what you already have: say what you did, what you found, and what you could not finish."
    : `Every tool call in the last ${failedSteps} steps failed, so no more tools run in this turn. Answer the person now from what you already have: say what you did, what did not work, and what you could not finish.`;
}

/** The answer when the model gives none after the turn was stopped: what ended it and what it did. */
export function runawayReply(why: "repeat" | "failing", done: readonly string[]): string {
  const reason = why === "repeat" ? "I stopped because I kept repeating the same step without progress." : "I stopped because every step I tried kept failing.";
  return done.length ? `${reason} What I did: ${done.join("; ")}.` : `${reason} Nothing was changed.`;
}

/** The system line for the answer at a checkpoint: the turn pauses and asks whether to go on. */
export function checkpointFinal(steps: number): string {
  return `You have worked for ${steps} steps in this turn, so it pauses here and no more tools run now. Answer the person now: say what you did, what you found, and what is left. They say whether you go on.`;
}

/** The line that ends a paused turn, with what it did when the model said nothing. */
export function pausedReply(steps: number, text: string, done: readonly string[]): string {
  const ask = `I paused after ${steps} steps. Say continue to go on.`;
  if (text.trim()) return `${text.trim()}\n\n${ask}`;
  return done.length ? `${ask} What I did: ${done.join("; ")}.` : ask;
}
