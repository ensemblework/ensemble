/**
 * The numbers Ensemble's own model loop runs with (docs/11, Turn limits), in one versioned config: step
 * budgets by model class, how much of a tool result the model sees in place, history and context
 * sizes, runaway detection and the waits before a failed model call is asked again.
 *
 * Tuning without a release: `ENSEMBLE_LOOP_CONFIG` holds a JSON object with only the fields to change,
 * or the path of a file with one (read again at most once a minute). An invalid override is ignored
 * (the defaults apply) and logged. Each turn's metric records the version and hash it ran with.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { INCLUDED_PROVIDER } from "@ensemble/shared-types";

/** Who pays for the model: Ensemble (`included`), the owner's own API key (`key`), or a model on their machine (`local`). */
export type ModelClass = "included" | "key" | "local";

const stepCap = (value: number | null, min = 2) => z.number().int().min(min).max(100_000).nullable().default(value);
const chars = (value: number) => z.number().int().min(2_000).max(200_000).default(value);
const tokens = (value: number) => z.number().int().min(1_000).max(10_000_000).default(value);
const count = (value: number) => z.number().int().min(2).max(1_000).default(value);

export const LoopConfig = z.object({
  /** Change it with every change of the defaults; recorded on each turn. */
  version: z.string().max(40).default("2026-11-21.1"),
  /**
   * Model requests in one turn, the last a tools-off answer. Null: no cap; runaway detection ends a
   * stuck turn instead. Included models are Ensemble's cost; an owner caps their own with a number.
   */
  steps: z
    .object({
      included: stepCap(24),
      /** Ensemble Code on an included model: it reads files and follows runs. */
      includedCode: stepCap(24, 16),
      key: stepCap(null),
      local: stepCap(null),
    })
    .default({}),
  /** Characters of one tool result the model sees in place; the whole of a longer one waits for read_tool_output. */
  inlineChars: z.object({ included: chars(8_000), key: chars(16_000), local: chars(8_000) }).default({}),
  /** Long output a turn keeps for read_tool_output, in characters; past it the oldest goes. */
  keptOutputChars: z.number().int().min(100_000).max(64_000_000).default(4_000_000),
  /** Earlier messages sent with a turn, newest first, until this many estimated tokens. */
  historyTokens: z.object({ included: tokens(8_000), key: tokens(24_000), local: tokens(4_000) }).default({}),
  /** Rows read to fill the history. */
  historyRows: z.number().int().min(2).max(2_000).default(200),
  /** The model's context window in tokens, when the model is not listed in `models`. */
  contextTokens: z
    .object({
      included: tokens(128_000),
      key: tokens(128_000),
      local: tokens(32_000),
      models: z.record(z.string(), z.number().int().min(1_000).max(10_000_000)).default({}),
    })
    .default({}),
  /** Share of the window past which older parts of a turn are shortened (compaction). */
  compactAt: z.number().min(0.1).max(0.95).default(0.6),
  /** Replies of the model at the end of a turn that compaction never touches. */
  keepExchanges: count(8),
  runaway: z
    .object({
      /** The same call with the same input, nothing changed in between: a nudge at `nudge`, the turn ends at `stop`. */
      nudge: count(3),
      stop: count(5),
      /** Steps in a row in which every call failed. */
      failedSteps: count(8),
    })
    .default({})
    .refine((value) => value.stop > value.nudge, "runaway.stop must be more than runaway.nudge."),
  /** Waits before a model call that failed for a passing reason (a rate limit, a server error, a dropped stream) is asked again. */
  retryDelaysMs: z.array(z.number().int().min(0).max(300_000)).max(5).default([5_000, 20_000]),
  /** Read-only calls of one step that run at the same time. */
  parallelReads: z.number().int().min(1).max(32).default(6),
});
export type LoopConfig = z.infer<typeof LoopConfig>;

export const DEFAULT_LOOP_CONFIG: LoopConfig = LoopConfig.parse({});

export function loopConfigHash(config: LoopConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12);
}

let cached: { raw: string; at: number; config: LoopConfig } | null = null;
let warned = "";

/** The config this process runs turns with: the override when it is set and valid, else the defaults. */
export function activeLoopConfig(log?: { warn: (data: unknown, message: string) => void }): LoopConfig {
  const raw = process.env.ENSEMBLE_LOOP_CONFIG?.trim() ?? "";
  if (!raw) return DEFAULT_LOOP_CONFIG;
  const inline = raw.startsWith("{");
  if (cached && cached.raw === raw && (inline || Date.now() - cached.at < 60_000)) return cached.config;
  let config = DEFAULT_LOOP_CONFIG;
  try {
    const parsed = LoopConfig.safeParse(JSON.parse(inline ? raw : readFileSync(raw, "utf8")));
    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    config = parsed.data;
    warned = "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (warned !== message) log?.warn({ err: message }, "ENSEMBLE_LOOP_CONFIG ignored; the loop uses its defaults");
    warned = message;
  }
  cached = { raw, at: Date.now(), config };
  return config;
}

export function modelClassOf(provider: string | null | undefined): ModelClass {
  if (provider === INCLUDED_PROVIDER) return "included";
  if (provider === "ollama") return "local";
  return "key";
}

/** What one turn may use, resolved from the config for its model. */
export interface TurnLimits {
  modelClass: ModelClass;
  /** Model requests; Infinity when the class has no cap. */
  steps: number;
  inlineChars: number;
  historyTokens: number;
  contextTokens: number;
}

export function turnLimits(config: LoopConfig, provider: string | null | undefined, model: string, code = false): TurnLimits {
  const modelClass = modelClassOf(provider);
  const cap = modelClass === "included" ? (code ? config.steps.includedCode : config.steps.included) : config.steps[modelClass];
  return {
    modelClass,
    steps: cap ?? Number.POSITIVE_INFINITY,
    inlineChars: config.inlineChars[modelClass],
    historyTokens: config.historyTokens[modelClass],
    contextTokens: config.contextTokens.models[model] ?? config.contextTokens[modelClass],
  };
}

/** Test seam: forget the cached override. */
export function resetLoopConfigCache(): void {
  cached = null;
  warned = "";
}
