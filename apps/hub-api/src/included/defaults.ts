import { INCLUDED_PROVIDER, type Settings } from "@ensemble/shared-types";
import type { Prisma, PrismaClient } from "@prisma/client";
import { isHosted, operatorEmail } from "../lib/hosted-access.js";
import { includedConfig } from "./config.js";

type Tier = "easy" | "medium" | "high" | "max";
const TIERS: Tier[] = ["easy", "medium", "high", "max"];

/** Providers that answer only with a key. Ollama is the operator's own server when hosted. */
const KEYED = new Set(["google", "openai", "anthropic", "mistral", "kimi", "qwen", "openrouter", "copilot", "ollama"]);

/**
 * The same answer as canUseHostCredentials, read through `db`: settings are loaded inside the
 * account's lock transaction, and a query on another connection there could wait on it.
 */
async function operator(db: PrismaClient | Prisma.TransactionClient, account: string): Promise<boolean> {
  const row = await db.user.findUnique({ where: { id: account }, select: { email: true, emailVerifiedAt: true, owner: { select: { email: true, emailVerifiedAt: true } } } });
  const who = row?.owner ?? row;
  return Boolean(who?.emailVerifiedAt) && operatorEmail(who!.email);
}

/**
 * On a hosted server with included models, a tier whose provider has no key this account can use
 * reads as an included model: hosted people have no server keys, so that tier could not answer.
 * A tier on the account's own key, its AI plan (claude-code, codex…) or Cursor is never changed.
 * The shipped Gemini default is such a tier for everyone without a Google key.
 */
export async function withIncludedDefaults(db: PrismaClient | Prisma.TransactionClient, account: string, settings: Settings): Promise<Settings> {
  if (!isHosted()) return settings;
  const config = includedConfig();
  if (!config) return settings;
  const keyed = TIERS.filter((tier) => KEYED.has(settings.models[tier].provider));
  if (!keyed.length) return settings;
  const saved = new Set(
    (await db.modelCredential.findMany({ where: { userId: account, provider: { in: [...KEYED] } }, select: { provider: true } })).map((row) => row.provider),
  );
  const missing = keyed.filter((tier) => !saved.has(settings.models[tier].provider));
  if (!missing.length) return settings;
  let unusable = missing;
  if (await operator(db, account)) {
    const { hasEnvKey } = await import("../runtime/credentials.js");
    unusable = missing.filter((tier) => settings.models[tier].provider !== "ollama" && !hasEnvKey(settings.models[tier].provider));
  }
  if (!unusable.length) return settings;
  const everyday = config.models.find((model) => model.role === "everyday") ?? config.models[0]!;
  const stepUp = config.models.find((model) => model.role === "step-up") ?? everyday;
  const chosen: Record<Tier, Settings["models"][Tier]> = {
    easy: { provider: INCLUDED_PROVIDER, model: everyday.id, effort: "default" },
    medium: { provider: INCLUDED_PROVIDER, model: everyday.id, effort: "default" },
    high: { provider: INCLUDED_PROVIDER, model: stepUp.id, effort: "default" },
    max: { provider: INCLUDED_PROVIDER, model: stepUp.id, effort: stepUp.efforts.includes("high") ? "high" : "default" },
  };
  const models = { ...settings.models };
  for (const tier of unusable) models[tier] = chosen[tier];
  return { ...settings, models };
}
