/**
 * Included AI on this server: which Azure AI Foundry resource holds the four deployments, which of
 * them people may use, and the two monthly limits. The operator sets these in /etc/ensemble.env;
 * agent-runtime reads the same variables (ensemble_agent/included.py).
 */
import { DEFAULT_MONTHLY_CREDITS, INCLUDED_DEFAULT_MAX_OUTPUT_TOKENS, INCLUDED_MODELS, type IncludedModel } from "@ensemble/shared-types";

/** Internal only: what one credit is worth. People never see dollars. */
export const CREDITS_PER_USD = 1000;
export const DEFAULT_TOTAL_MONTHLY_USD = 180;

export type IncludedConfig = {
  resource: string;
  apiKey: string;
  models: IncludedModel[];
  monthlyCredits: number;
  totalMonthlyUsd: number;
  /** max_tokens / max_output_tokens on every included call. */
  maxOutputTokens: number;
};

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function outputCap(env: NodeJS.ProcessEnv): number {
  const value = positive(env, "ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS", INCLUDED_DEFAULT_MAX_OUTPUT_TOKENS);
  if (!Number.isSafeInteger(value) || value > 128_000) throw new Error("ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS must be a whole number up to 128000.");
  return value;
}

/**
 * Null when included AI is not set up, is switched off (ENSEMBLE_INCLUDED_MODELS=off), or is set up
 * wrongly: a typo in /etc/ensemble.env turns included AI off and is logged, it does not take the
 * Models settings down with it.
 */
export function includedConfig(env: NodeJS.ProcessEnv = process.env): IncludedConfig | null {
  try {
    return parseIncludedConfig(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!reported.has(message)) {
      reported.add(message);
      console.error(`Included AI is off: ${message}`);
    }
    return null;
  }
}

const reported = new Set<string>();

/** The same, throwing on a wrong value. */
export function parseIncludedConfig(env: NodeJS.ProcessEnv = process.env): IncludedConfig | null {
  const resource = (env.AZURE_FOUNDRY_RESOURCE ?? "").trim();
  const apiKey = (env.AZURE_FOUNDRY_API_KEY ?? "").trim();
  const listed = (env.ENSEMBLE_INCLUDED_MODELS ?? "").trim();
  if (!resource || !apiKey || listed.toLowerCase() === "off") return null;
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/i.test(resource)) throw new Error("AZURE_FOUNDRY_RESOURCE is the resource name, such as ensemble-ai, not a URL.");
  const wanted = listed ? new Set(listed.split(",").map((id) => id.trim()).filter(Boolean)) : null;
  if (wanted) {
    const unknown = [...wanted].filter((id) => !INCLUDED_MODELS.some((model) => model.id === id));
    if (unknown.length) throw new Error(`ENSEMBLE_INCLUDED_MODELS names models Ensemble does not include: ${unknown.join(", ")}.`);
  }
  const models = INCLUDED_MODELS.filter((model) => !wanted || wanted.has(model.id));
  if (!models.length) return null;
  return {
    resource,
    apiKey,
    models,
    monthlyCredits: positive(env, "ENSEMBLE_INCLUDED_MONTHLY_CREDITS", DEFAULT_MONTHLY_CREDITS),
    totalMonthlyUsd: positive(env, "ENSEMBLE_INCLUDED_TOTAL_MONTHLY_USD", DEFAULT_TOTAL_MONTHLY_USD),
    maxOutputTokens: outputCap(env),
  };
}

export function includedModelOn(id: string, env: NodeJS.ProcessEnv = process.env): IncludedModel | null {
  return includedConfig(env)?.models.find((model) => model.id === id) ?? null;
}

/** Foundry's Anthropic Messages endpoint. */
export function anthropicBase(resource: string): string {
  return `https://${resource}.services.ai.azure.com/anthropic`;
}

/** The OpenAI v1 endpoint (no api-version) on the host a model is documented at. */
export function openaiBase(resource: string, host: IncludedModel["host"] = "openai"): string {
  return host === "services" ? `https://${resource}.services.ai.azure.com/openai/v1` : `https://${resource}.openai.azure.com/openai/v1`;
}
