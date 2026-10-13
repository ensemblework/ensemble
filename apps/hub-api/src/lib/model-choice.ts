/**
 * The provider for a model the person picked. A model id does not name its provider: Copilot
 * serves gpt-4.1 and claude-sonnet, OpenRouter serves everything. So a pick comes with its
 * provider; without one it must match a tier's model, or have an unmistakable vendor prefix
 * (gemini-, claude-…); anything else is refused with what to do. Never a tier's provider paired
 * with another model: that is how a Copilot model once went to Gemini.
 */
import type { Settings } from "@ensemble/shared-types";
import { knownProvider } from "../runtime/payload.js";

const TIERS = ["easy", "medium", "high", "max"] as const;

export class ModelChoiceError extends Error {
  readonly statusCode = 400;
  readonly code = "MODEL_PROVIDER_UNKNOWN";
}

export function providerForModel(settings: Pick<Settings, "models">, model: string, provider?: string | null): string {
  const named = provider?.trim();
  if (named) return named;
  const name = model.trim();
  const fromTiers = [...new Set(TIERS.map((tier) => settings.models[tier]).filter((row) => row?.model === name).map((row) => row.provider))];
  if (fromTiers.length === 1) return fromTiers[0]!;
  if (!fromTiers.length) {
    const known = knownProvider(name);
    if (known) return known;
  }
  throw new ModelChoiceError(
    fromTiers.length > 1
      ? `${name} is set for more than one provider. Pick it with its provider (provider::model).`
      : `Say which provider runs ${name}: pick it from a provider's list in Settings → Models, or write provider::model.`,
  );
}
