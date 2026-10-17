import { INCLUDED_PROVIDER } from "@ensemble/shared-types";
import { includedConfig } from "./config.js";

/**
 * The included models as one more provider in GET /api/models. The list is the operator's
 * deployments (ENSEMBLE_INCLUDED_MODELS), not a live fetch, and carries no key or price.
 */
export function includedCatalogEntry(): Record<string, unknown> | null {
  const config = includedConfig();
  if (!config) return null;
  const models = config.models.map((model) => model.id);
  const everyday = config.models.find((model) => model.role === "everyday") ?? config.models[0];
  return {
    provider: INCLUDED_PROVIDER,
    available: true,
    source: "included",
    models,
    meta: Object.fromEntries(config.models.map((model) => [model.id, { efforts: [...model.efforts] }])),
    chat: true,
    cheapest: everyday?.id ?? null,
    error: null,
    notes: {},
  };
}
