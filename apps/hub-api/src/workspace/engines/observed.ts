/**
 * What an engine reports it ran with: the observed part of a run's settings (requested, resolved,
 * observed; node/settings.ts). Each adapter puts what its agent itself says on the `engine` event
 * (`observed`: the model it started on, the thinking level its session reports, fast mode) and the
 * context window it used on `engine_context` (`size` in tokens, and `context` when the model's windows
 * are known). Nothing is inferred from what was asked: a field the agent does not report stays out.
 * The computer sends the result with its progress and complete (`ObservedSettings` in
 * remote/contract.ts); the server keeps it on the job and reads the job's own events for runs it ran.
 */
import type { ObservedSettings } from "../../remote/contract.js";
import { redactText } from "../../lib/redact.js";

export type { ObservedSettings };

/** A window used is the long one when it is at least this share of the model's long window. */
const LONG_SHARE = 0.95;

const str = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The window a run used, as the model's own tier: the long one, the standard one, or not known. */
export function windowTier(size: number | null | undefined, windows: { standard?: number | null; long?: number | null }): "default" | "long_context" | undefined {
  if (typeof size !== "number" || size <= 0) return undefined;
  if (windows.long && size >= windows.long * LONG_SHARE) return "long_context";
  if (windows.long || windows.standard) return "default";
  return undefined;
}

/** Only the fields the engine reported, cleaned. */
export function cleanObserved(value: unknown): ObservedSettings {
  const row = record(value);
  const tokens = typeof row.contextTokens === "number" && Number.isInteger(row.contextTokens) && row.contextTokens > 0 && row.contextTokens <= 100_000_000 ? row.contextTokens : undefined;
  const model = str(row.model, 200);
  const effort = str(row.effort, 40);
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(row.context === "default" || row.context === "long_context" ? { context: row.context } : {}),
    ...(tokens ? { contextTokens: tokens } : {}),
    ...(typeof row.fast === "boolean" ? { fast: row.fast } : {}),
  };
}

/** Field by field, the first that reported it. */
export function mergeObserved(...parts: Array<ObservedSettings | null | undefined>): ObservedSettings {
  const out: ObservedSettings = {};
  for (const part of parts) {
    const clean = cleanObserved(part);
    for (const key of Object.keys(clean) as Array<keyof ObservedSettings>) if (out[key] === undefined) (out as Record<string, unknown>)[key] = clean[key];
  }
  return out;
}

/**
 * The observed settings in a run's events, oldest first: the newest `engine` event (its `observed`, or
 * for runtimes before it only the model, which the agent itself reported) and the newest
 * `engine_context` (the window used).
 */
export function observedFromEvents(events: ReadonlyArray<{ kind: string; data: unknown }>): ObservedSettings {
  const engine = [...events].reverse().find((event) => event.kind === "engine");
  const window = [...events].reverse().find((event) => event.kind === "engine_context");
  const started = record(engine?.data);
  const fromEngine = "observed" in started ? cleanObserved(started.observed) : cleanObserved({ model: started.model });
  const used = record(window?.data);
  return mergeObserved(fromEngine, cleanObserved({ contextTokens: used.size, context: used.context }));
}

/** The same report: nothing new to send. */
export function sameObserved(a: ObservedSettings | null | undefined, b: ObservedSettings | null | undefined): boolean {
  const sorted = (value: ObservedSettings | null | undefined) => JSON.stringify(Object.entries(cleanObserved(value)).sort(([x], [y]) => x.localeCompare(y)));
  return sorted(a) === sorted(b);
}

/** Whether anything was reported. */
export function anyObserved(value: ObservedSettings | null | undefined): boolean {
  return Object.keys(cleanObserved(value)).length > 0;
}

/**
 * The job update for what a computer reported on progress or complete (`observed_settings`), redacted
 * again as every text a computer sends; nothing when it reported nothing.
 */
export function observedUpdate(value: ObservedSettings | null | undefined): { observedSettings?: ObservedSettings } {
  const clean = cleanObserved(value);
  if (!Object.keys(clean).length) return {};
  return { observedSettings: { ...clean, ...(clean.model ? { model: redactText(clean.model).slice(0, 200) } : {}), ...(clean.effort ? { effort: redactText(clean.effort).slice(0, 40) } : {}) } };
}
