import { env } from "../config.js";
import { corsPolicy, type CorsPolicy } from "./cors-origin.js";

let policy: CorsPolicy | undefined;

/**
 * This process's CORS policy: desktop mode and the allowlist, worked out
 * once, on first use, and then shared. `startHub` hands it to @fastify/cors,
 * and every hijacked streaming response reads the same object, so the two
 * cannot disagree. `desktop/main.ts` sets ENSEMBLE_DESKTOP before hub-api loads.
 */
export function hubCorsPolicy(): CorsPolicy {
  policy ??= corsPolicy(env.HUB_WEB_ORIGIN);
  return policy;
}
