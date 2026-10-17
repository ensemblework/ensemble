import { DEFAULT_SETTINGS, INCLUDED_PROVIDER, type Settings } from "@ensemble/shared-types";
import type { Prisma, PrismaClient } from "@prisma/client";
import { isHosted } from "../lib/hosted-access.js";
import { includedConfig } from "./config.js";

type Tier = "easy" | "medium" | "high" | "max";
const TIERS: Tier[] = ["easy", "medium", "high", "max"];

const sameTier = (a: Settings["models"][Tier], b: Settings["models"][Tier]) => a.provider === b.provider && a.model === b.model && a.effort === b.effort;

/**
 * On a hosted server with included models, a tier still on the shipped Gemini default reads as an
 * included model, unless the account saved a Google key of its own: hosted people have no Gemini
 * key by default, so the shipped default could not answer for them.
 */
export async function withIncludedDefaults(db: PrismaClient | Prisma.TransactionClient, account: string, settings: Settings): Promise<Settings> {
  if (!isHosted()) return settings;
  const config = includedConfig();
  if (!config) return settings;
  const untouched = TIERS.filter((tier) => sameTier(settings.models[tier], DEFAULT_SETTINGS.models[tier]));
  if (!untouched.length) return settings;
  if (await db.modelCredential.findUnique({ where: { userId_provider: { userId: account, provider: "google" } }, select: { userId: true } })) return settings;
  const everyday = config.models.find((model) => model.role === "everyday") ?? config.models[0]!;
  const stepUp = config.models.find((model) => model.role === "step-up") ?? everyday;
  const chosen: Record<Tier, Settings["models"][Tier]> = {
    easy: { provider: INCLUDED_PROVIDER, model: everyday.id, effort: "default" },
    medium: { provider: INCLUDED_PROVIDER, model: everyday.id, effort: "default" },
    high: { provider: INCLUDED_PROVIDER, model: stepUp.id, effort: "default" },
    max: { provider: INCLUDED_PROVIDER, model: stepUp.id, effort: stepUp.efforts.includes("high") ? "high" : "default" },
  };
  const models = { ...settings.models };
  for (const tier of untouched) models[tier] = chosen[tier];
  return { ...settings, models };
}
