/**
 * Which chat model a node talks with. Default: the included gpt-5-mini (credits shared with the
 * Hub and the CLI), else another included everyday model, else the owner's own medium tier.
 */
import { INCLUDED_PROVIDER, includedModelName, type IncludedModel, type Settings } from "@ensemble/shared-types";
import { includedConfig, includedModelOn } from "../included/config.js";
import { ModelChoiceError, providerForModel } from "../lib/model-choice.js";

export const NODE_DEFAULT_MODEL = "gpt-5-mini";

export type ChatModel = { provider: string; model: string };

export function defaultChatModel(settings: Pick<Settings, "models">): ChatModel | null {
  const included = includedConfig();
  if (included) {
    const pick = included.models.find((row) => row.id === NODE_DEFAULT_MODEL) ?? included.models.find((row) => row.role === "everyday") ?? included.models[0];
    if (pick) return { provider: INCLUDED_PROVIDER, model: pick.id };
  }
  const tier = settings.models.medium;
  return tier?.model ? { provider: tier.provider, model: tier.model } : null;
}

export function chatModelFor(node: { provider: string | null; model: string | null }, settings: Pick<Settings, "models">): ChatModel | { error: string } {
  if (node.model) {
    if (!node.provider || node.provider === INCLUDED_PROVIDER) {
      if (includedModelOn(node.model)) return { provider: INCLUDED_PROVIDER, model: node.model };
    } else {
      try {
        return { provider: providerForModel(settings, node.model, node.provider), model: node.model };
      } catch (error) {
        if (error instanceof ModelChoiceError) return { error: error.message };
        throw error;
      }
    }
  }
  return defaultChatModel(settings) ?? { error: "No chat model is available. Included AI is off on this server and no model is set in Ensemble → Settings → Models." };
}

export type NodeModelOption = {
  provider: string;
  model: string;
  /** Name and version, as the Hub shows it: "GPT-6 Luna (2026-09-22)". */
  label: string;
  vendor: string;
  role: IncludedModel["role"];
  /** A typical turn's credits relative to the catalog's 1× model, as on the Hub's cost badge. */
  relativeCost: number;
  default: boolean;
};

/**
 * The models the Node web app offers: exactly the included models this server offers
 * (ENSEMBLE_INCLUDED_MODELS), so the Hub, the CLI and Node list the same ones.
 */
export function nodeModelOptions(): NodeModelOption[] {
  const included = includedConfig();
  if (!included) return [];
  const fallback = included.models.find((row) => row.id === NODE_DEFAULT_MODEL) ?? included.models.find((row) => row.role === "everyday") ?? included.models[0];
  return included.models.map((row) => ({
    provider: INCLUDED_PROVIDER,
    model: row.id,
    label: includedModelName(row.id),
    vendor: row.vendor,
    role: row.role,
    relativeCost: row.relativeCost,
    default: row.id === fallback?.id,
  }));
}
