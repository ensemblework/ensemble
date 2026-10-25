/**
 * Which thinking levels ("reasoning effort") a model takes, so the settings offer exactly those
 * and the value Ensemble sends is the one the provider's API reads. Order of trust:
 *
 * 1. What the provider publishes per model in its own model list, kept with the catalog
 *    (`ModelMeta.efforts`): Anthropic's `capabilities.effort` and Copilot's
 *    `capabilities.supports.reasoning_effort`.
 * 2. The provider's documentation for the model family (checked 13 Oct 2026): OpenAI's model
 *    pages, Gemini's OpenAI-compatibility table, Anthropic's effort table, OpenRouter's
 *    `reasoning.effort`, Ollama's gpt-oss levels.
 * 3. A model the table does not know uses its own default; no effort parameter is sent.
 */

import { INCLUDED_PROVIDER, includedModel } from "./included.js";

export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

/** What a provider's model list said about one model. */
export type ModelMeta = {
  /** Levels the provider lists for the model, in its own words. */
  efforts?: string[];
  /** OpenRouter: the model takes its `reasoning` parameter. */
  reasoning?: boolean;
};

export type ModelEfforts = {
  /** The levels to offer, lowest first. Empty: the model has no thinking setting. */
  levels: EffortLevel[];
  /** What the model uses when no level is sent, where the provider documents it. */
  fallback: EffortLevel | null;
  /** provider: its own model list. documented: its docs for the family. unknown: a model the docs here do not cover. none: no setting. */
  source: "provider" | "documented" | "unknown" | "none";
};

const isLevel = (value: string): value is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(value);

/** Lowest first, known names only, no repeats. */
export function orderLevels(values: readonly string[]): EffortLevel[] {
  const wanted = new Set(values.map((value) => value.trim().toLowerCase()));
  return EFFORT_LEVELS.filter((level) => wanted.has(level));
}

const NONE: ModelEfforts = { levels: [], fallback: null, source: "none" };
const doc = (levels: EffortLevel[], fallback: EffortLevel | null = null): ModelEfforts => ({ levels, fallback, source: "documented" });
const unknown = (_levels: EffortLevel[]): ModelEfforts => ({ levels: [], fallback: null, source: "unknown" });

const ALL: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

function anthropic(model: string): ModelEfforts {
  const id = model.toLowerCase().replace(/\./g, "-");
  if (/^claude-(opus-5-5|haiku-5-5)/.test(id)) return doc(ALL, "medium");
  if (/^claude-(fable|mythos|opus-5|opus-4-8|opus-4-7|sonnet-5)/.test(id)) return doc(ALL, "high");
  if (/^claude-(opus-4-6|sonnet-4-6)/.test(id)) return doc(["low", "medium", "high", "max"], "high");
  if (/^claude-opus-4-5/.test(id)) return doc(["low", "medium", "high"], "high");
  if (/^claude-/.test(id)) return NONE;
  return unknown(ALL);
}

function openai(model: string): ModelEfforts {
  const id = model.toLowerCase();
  if (/-chat|^gpt-4|^gpt-3|^chatgpt|audio|realtime|transcribe|tts|image|embedding|search/.test(id)) return NONE;
  if (/^gpt-6-luna/.test(id)) return doc(["none", "low", "medium", "high", "xhigh", "max"], "medium");
  if (/^gpt-6/.test(id)) return doc(["low", "medium", "high", "xhigh", "max"], "medium");
  if (/^gpt-5\.[56]/.test(id)) return doc(["none", "low", "medium", "high", "xhigh"], "medium");
  if (/^gpt-5\.[234]/.test(id)) return doc(["none", "low", "medium", "high", "xhigh"], "none");
  if (/^gpt-5\.1/.test(id)) return doc(["none", "low", "medium", "high"], "none");
  if (/^gpt-5(?![.\d])/.test(id)) return doc(["minimal", "low", "medium", "high"], "medium");
  if (/^o[134](-|$)/.test(id)) return doc(["low", "medium", "high"], "medium");
  return unknown(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
}

function google(model: string): ModelEfforts {
  const id = model.toLowerCase();
  if (!id.startsWith("gemini-")) return NONE;
  // Gemini's OpenAI-compatible endpoint maps these to thinking levels. On Pro, "minimal" is the same as "low", so it is not offered.
  if (/^gemini-2\.5-pro/.test(id)) return doc(["low", "medium", "high"]);
  if (/^gemini-2\.5/.test(id)) return doc(["none", "low", "medium", "high"]);
  if (/^gemini-[3-9]/.test(id)) return /-pro/.test(id) ? doc(["low", "medium", "high"], "high") : doc(["minimal", "low", "medium", "high"], "high");
  return NONE;
}

/** Included models offer Low, Medium and High at most; Auto leaves the model on its own default. */
function included(model: string): ModelEfforts {
  const found = includedModel(model);
  return found?.efforts.length ? doc([...found.efforts], found.autoEffort) : NONE;
}

/**
 * The thinking levels a model takes. `meta` is what the provider's own model list said, and wins
 * when it lists levels. A Copilot model the list says nothing about has no setting.
 */
export function modelEfforts(provider: string, model: string, meta?: ModelMeta | null): ModelEfforts {
  if (!model) return NONE;
  if (provider === INCLUDED_PROVIDER) return included(model);
  if (Array.isArray(meta?.efforts)) {
    const levels = orderLevels(meta.efforts);
    const documented = provider === "anthropic" ? anthropic(model).fallback : null;
    return levels.length ? { levels, fallback: documented && levels.includes(documented) ? documented : null, source: "provider" } : NONE;
  }
  switch (provider) {
    case "anthropic":
      return anthropic(model);
    case "openai":
      return openai(model);
    case "google":
      return google(model);
    case "openrouter":
      return meta?.reasoning ? doc(["none", "minimal", "low", "medium", "high", "xhigh"]) : meta?.reasoning === false ? NONE : unknown(["none", "minimal", "low", "medium", "high", "xhigh"]);
    case "ollama":
      return /gpt-oss/i.test(model) ? doc(["low", "medium", "high"], "medium") : NONE;
    default:
      return NONE;
  }
}

/** "Low, Medium and High" */
export function effortList(levels: readonly EffortLevel[]): string {
  const names = levels.map((level) => EFFORT_LABEL[level]);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export type EffortCheck = { ok: true; send: EffortLevel | null } | { ok: false; message: string };

/**
 * What to send for a chosen level: the level itself, nothing (no level chosen, or the model has no
 * thinking setting), or a refusal that says which levels the model takes. Never a different level.
 */
export function checkEffort(provider: string, model: string, effort: string | null | undefined, meta?: ModelMeta | null): EffortCheck {
  if (!effort || effort === "default") return { ok: true, send: null };
  const known = modelEfforts(provider, model, meta);
  if (!known.levels.length) return { ok: true, send: null };
  const value = effort.toLowerCase();
  if (known.source === "unknown") return isLevel(value) ? { ok: true, send: value } : { ok: false, message: `“${effort}” is not a thinking level.` };
  if (isLevel(value) && known.levels.includes(value)) return { ok: true, send: value };
  const label = isLevel(value) ? EFFORT_LABEL[value] : effort;
  return { ok: false, message: `${model} does not take thinking “${label}”. It takes ${effortList(known.levels)}. Change it in Settings → Models.` };
}
