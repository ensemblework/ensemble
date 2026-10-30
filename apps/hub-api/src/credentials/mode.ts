/**
 * Which saved secrets a coding-agent run here may have (B12, docs/35 §8.7). A run that names secrets
 * (an Ensemble Node run, a run profile that lists some) gets only those. A run that names none gets
 * every environment secret in `all` mode (compatibility mode, the default, as before) and none in
 * `named` mode, which the owner turns on with `ensemble secrets mode named`.
 */
import { secretScopeOf, type SecretScope } from "../lib/run-secrets.js";
import { loadSettings } from "../remote/store.js";

export type SecretsMode = "all" | "named";

export function secretsMode(): SecretsMode {
  return loadSettings().secretsMode;
}

/** The scope a run gets from its job's context under this computer's mode. */
export function runSecretScope(context: unknown, mode: SecretsMode = secretsMode()): SecretScope {
  const scope = secretScopeOf(context);
  return scope === "all" && mode === "named" ? [] : scope;
}
