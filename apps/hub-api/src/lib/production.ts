import { crossOriginCookieProblem } from "@ensemble/shared-types/cookie-site";

/**
 * Production boot checks shared by hub-api. agent-runtime keeps the same
 * token and auth-bypass rules in ensemble_agent/production.py.
 *
 * Dev (NODE_ENV other than production) is not checked.
 */

export const DEFAULT_INTERNAL_TOKEN = "dev-internal-token";

/** Placeholder values from examples and docs. Compared case-insensitively. */
export const EXAMPLE_INTERNAL_TOKENS = [
  "dev-internal-token",
  "change-me",
  "changeme",
  "change_me",
  "replace-me",
  "replaceme",
  "replace_me",
  "example",
  "example-token",
  "example-internal-token",
  "your-internal-token",
  "your-token-here",
  "todo",
  "secret",
  "password",
] as const;

const NAMED_BYPASS = [
  "ENSEMBLE_DEV_AUTH_BYPASS",
  "ENSEMBLE_DEV_LOGIN",
  "ENSEMBLE_AUTH_BYPASS",
  "ENSEMBLE_DISABLE_AUTH",
  "ENSEMBLE_SKIP_AUTH",
  "ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN",
] as const;

const BYPASS_NAME = /(^|_)(AUTH_BYPASS|DEV_LOGIN|DISABLE_AUTH|SKIP_AUTH)($|_)/i;

export type ProductionSurface = "hub" | "agent";

export function isInsecureInternalToken(value: string | undefined): boolean {
  const token = value?.trim().toLowerCase() ?? "";
  if (!token) return true;
  return (EXAMPLE_INTERNAL_TOKENS as readonly string[]).includes(token);
}

export function truthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function bypassNames(env: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>();
  for (const name of NAMED_BYPASS) {
    if (truthyFlag(env[name])) names.add(name);
  }
  for (const name of Object.keys(env)) {
    if (BYPASS_NAME.test(name) && truthyFlag(env[name])) names.add(name);
  }
  return [...names];
}

export function productionProblems(env: NodeJS.ProcessEnv, surface: ProductionSurface = "hub"): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  const rawToken = env.ENSEMBLE_INTERNAL_TOKEN?.trim() ?? "";
  if (isInsecureInternalToken(rawToken)) {
    const shown = rawToken || DEFAULT_INTERNAL_TOKEN;
    const kind = !rawToken || shown.toLowerCase() === DEFAULT_INTERNAL_TOKEN ? "default" : "example";
    problems.push(
      `ENSEMBLE_INTERNAL_TOKEN is the ${kind} value "${shown}". Set a private value (openssl rand -hex 32) before starting in production.`,
    );
  }
  for (const name of bypassNames(env)) {
    problems.push(`${name} is on. Turn it off before starting in production.`);
  }
  if (surface === "hub") {
    if (truthyFlag(env.ENSEMBLE_DEV_TOOLS)) {
      problems.push("ENSEMBLE_DEV_TOOLS is on. The desk switcher and developer routes stay off in production. Unset it before starting.");
    }
    const origin = (env.HUB_WEB_ORIGIN ?? "http://localhost:3000").trim();
    let https = false;
    try {
      https = origin !== "*" && new URL(origin).protocol === "https:";
    } catch {
      https = false;
    }
    if (!https) {
      problems.push(
        `HUB_WEB_ORIGIN must be the public https origin in production (got "${origin}"). Credentialed CORS allows only that origin.`,
      );
    }
    const cookie = crossOriginCookieProblem({
      webOrigin: origin,
      apiOrigin: env.HUB_API_PUBLIC_URL,
      cookieDomain: env.ENSEMBLE_COOKIE_DOMAIN,
    });
    if (cookie) problems.push(cookie);
  }
  return problems;
}

export function formatProductionProblems(problems: string[]): string {
  return ["Refusing to start in production:", ...problems.map((line) => `- ${line}`)].join("\n");
}

export function assertProductionSafe(env: NodeJS.ProcessEnv, surface: ProductionSurface = "hub"): void {
  const problems = productionProblems(env, surface);
  if (problems.length === 0) return;
  throw new Error(formatProductionProblems(problems));
}
