/**
 * Which chat model a node talks with (docs/35 §5). A node may use any model its owner can: the
 * included models this server offers (credits shared with every Ensemble app), models on the owner's
 * own API keys, and AI plans (Claude Code, Codex, Cursor, Copilot) on a paired computer, which run the
 * turn there. Default: gpt-6.1-sol (else gpt-6-luna, gpt-5-mini or another everyday included model)
 * at low thinking (`node.effort`), else the owner's own medium tier.
 */
import type { PrismaClient } from "@prisma/client";
import {
  ASSISTANT_TURNS_MIN,
  INCLUDED_PROVIDER,
  SUBSCRIPTION_INFO,
  includedModelName,
  isSubscriptionProvider,
  type IncludedModel,
  type Settings,
} from "@ensemble/shared-types";
import { includedConfig, includedModelOn } from "../included/config.js";
import { deviceOnline } from "../devices/constants.js";
import { loadSettings } from "../lib/settings.js";
import { modelCatalog } from "../lib/model-catalog.js";
import { ModelChoiceError, providerForModel } from "../lib/model-choice.js";
import { computerAgents, deviceOwners } from "../subscriptions/turn.js";

/**
 * A node with no model of its own talks with Sol (at low thinking, `turnEffort`): on the planning
 * evaluation (scripts/node-plan-eval.mjs, docs/35 §11) Luna sent planned work straight to one coding
 * run and skipped the checks its owner asked for, so it is not the default (ensemble-node design
 * decision 8). `ENSEMBLE_NODE_MODEL` names another. Luna stays the fast model a conversation turn
 * cut off by a rate limit answers with.
 */
export const NODE_DEFAULT_MODEL = "gpt-6.1-sol";
const NODE_FAST_MODEL = "gpt-6-luna";
const FAST_ORDER = [NODE_FAST_MODEL, "gpt-5-mini"];

function defaultOrder(env: NodeJS.ProcessEnv): string[] {
  const chosen = env.ENSEMBLE_NODE_MODEL?.trim();
  return [...(chosen ? [chosen] : []), NODE_DEFAULT_MODEL, ...FAST_ORDER];
}

function pickIncluded<T extends { id: string; role: string }>(models: readonly T[], order: readonly string[]): T | undefined {
  for (const id of order) {
    const found = models.find((row) => row.id === id);
    if (found) return found;
  }
  return models.find((row) => row.role === "everyday") ?? models[0];
}

export type ChatModel = { provider: string; model: string };

function includedOrTier(settings: Pick<Settings, "models">, order: readonly string[], env: NodeJS.ProcessEnv): ChatModel | null {
  const included = includedConfig(env);
  if (included) {
    const pick = pickIncluded(included.models, order);
    if (pick) return { provider: INCLUDED_PROVIDER, model: pick.id };
  }
  const tier = settings.models.medium;
  return tier?.model ? { provider: tier.provider, model: tier.model } : null;
}

export function defaultChatModel(settings: Pick<Settings, "models">, env: NodeJS.ProcessEnv = process.env): ChatModel | null {
  return includedOrTier(settings, defaultOrder(env), env);
}

/** The fast model a conversation turn answers with when its own model's rate limit cut it off. */
export function fastChatModel(settings: Pick<Settings, "models">, env: NodeJS.ProcessEnv = process.env): ChatModel | null {
  return includedOrTier(settings, FAST_ORDER, env);
}

/**
 * A crew's lead plans the crew's work and reports on it, so unless its owner chose its model it thinks
 * with a stronger one (ensemble-node design decision 2): `ENSEMBLE_NODE_LEAD_MODEL` (default gpt-6.1-sol,
 * when this server includes it; "off" for none) at `ENSEMBLE_NODE_LEAD_EFFORT` (default medium) unless
 * the owner set the node's thinking level. Null: the node's own model applies.
 */
export function leadChatModel(node: { model: string | null; effort: string | null }, env: NodeJS.ProcessEnv = process.env): { pick: ChatModel; effort: string } | null {
  if (node.model) return null;
  const model = (env.ENSEMBLE_NODE_LEAD_MODEL ?? "gpt-6.1-sol").trim();
  if (!model || model === "off" || !includedModelOn(model, env)) return null;
  return { pick: { provider: INCLUDED_PROVIDER, model }, effort: node.effort ?? (env.ENSEMBLE_NODE_LEAD_EFFORT?.trim() || "medium") };
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
  /** Name and version for included models ("GPT-6 Luna (2026-09-22)"), the agent's label for AI plans. */
  label: string;
  /** included: paid from Ensemble credits. keys: the owner's own API key. plans: an AI plan on a paired computer. */
  group: "included" | "keys" | "plans";
  vendor: string;
  role?: IncludedModel["role"];
  /** Included only: a typical turn's credits relative to the catalog's 1× model, as on the Hub's cost badge. */
  relativeCost?: number;
  /** Plans only: the computer the agent was found on. */
  computer?: string;
  default: boolean;
};

/** The included models this server offers (ENSEMBLE_INCLUDED_MODELS): the same list as the Hub and the CLI. */
export function includedOptions(): NodeModelOption[] {
  const included = includedConfig();
  if (!included) return [];
  const fallback = pickIncluded(included.models, defaultOrder(process.env));
  return included.models.map((row) => ({
    provider: INCLUDED_PROVIDER,
    model: row.id,
    label: includedModelName(row.id),
    group: "included" as const,
    vendor: row.vendor,
    role: row.role,
    relativeCost: row.relativeCost,
    default: row.id === fallback?.id,
  }));
}

const MAX_PER_PROVIDER = 40;

/**
 * Every model the owner can give a node, grouped. Own-key lists come from Ensemble's stored model
 * catalog (refreshed weekly, as in Settings → Models); AI plans from the paired computers that are
 * online, signed in and new enough to run assistant turns. `perProvider` caps each provider's list for
 * the picker (OpenRouter lists hundreds); a check of one model looks through all of them.
 */
export async function nodeModelOptions(prisma: PrismaClient, accountId: string, perProvider = MAX_PER_PROVIDER): Promise<{ options: NodeModelOption[]; problems: string[] }> {
  const options = includedOptions();
  const problems: string[] = [];
  const seen = new Set(options.map((row) => `${row.provider}\n${row.model}`));
  const add = (row: NodeModelOption) => {
    const key = `${row.provider}\n${row.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push(row);
  };

  try {
    const settings = await loadSettings(prisma, accountId);
    const catalog = await modelCatalog(accountId, settings.models.ollamaUrl);
    for (const entry of catalog.providers) {
      const provider = String(entry.provider ?? "");
      if (!provider || provider === INCLUDED_PROVIDER || isSubscriptionProvider(provider) || entry.error) continue;
      const models = Array.isArray(entry.models) ? entry.models.map(String).slice(0, perProvider) : [];
      for (const model of models) add({ provider, model, label: model, group: "keys", vendor: provider, default: false });
    }
  } catch {
    problems.push("Your own API keys' model lists could not be read just now.");
  }

  const devices = await prisma.device.findMany({ where: { userId: { in: deviceOwners(accountId) }, revokedAt: null }, orderBy: { lastSeenAt: "desc" } });
  for (const device of devices) {
    if (!deviceOnline(device.lastSeenAt)) continue;
    const caps = computerAgents(device);
    if (caps.turns < ASSISTANT_TURNS_MIN) continue;
    for (const agent of caps.agents) {
      if (agent.signedIn === false) continue;
      for (const model of agent.models.slice(0, perProvider)) {
        add({ provider: agent.id, model: model.id, label: model.label, group: "plans", vendor: SUBSCRIPTION_INFO[agent.id].label, computer: device.name, default: false });
      }
    }
  }
  return { options, problems };
}

/** Why a node may not use this model, or null when it may. */
export async function modelProblem(prisma: PrismaClient, accountId: string, provider: string | null | undefined, model: string | null | undefined): Promise<string | null> {
  if (!model) return null;
  if (!provider || provider === INCLUDED_PROVIDER) {
    return includedModelOn(model) ? null : `“${model}” is not one of the models included with Ensemble on this server.`;
  }
  const { options } = await nodeModelOptions(prisma, accountId, Number.POSITIVE_INFINITY);
  if (options.some((row) => row.provider === provider && row.model === model)) return null;
  return isSubscriptionProvider(provider)
    ? `${SUBSCRIPTION_INFO[provider].label} with “${model}” is not available: open Ensemble on a paired computer where it is signed in.`
    : `“${model}” is not available on your ${provider} key. Check it in Ensemble → Settings → Models.`;
}
