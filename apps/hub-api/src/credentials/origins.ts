/**
 * The sites this computer takes encrypted values from (B12, docs/35 §8.7). A sealed box names the site
 * it was typed on; the computer opens it only when that site is Ensemble on the web or Ensemble Node for
 * the server it is paired with, or one the owner added with `ENSEMBLE_SEAL_ORIGINS` (a self-hosted
 * Ensemble, development). It is a check of what the box says, not proof of where it came from: anyone
 * with the public key can make a box. The relay and the expiry carry that part (docs/35 §8.7).
 */
import { TESTING_API, TESTING_APP, TESTING_NODE } from "@ensemble/shared-types";

function origin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The web's sites for the paired API: `api.<domain>` serves `app.` and `node.<domain>`; `api-<name>.<domain>` serves `<name>.` and `node-<name>.<domain>`. */
export function siteOrigins(apiBase: string | null): string[] {
  if (!apiBase) return [];
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return [];
  }
  const base = url.origin;
  if (base === TESTING_API) return [TESTING_APP, TESTING_NODE];
  if (LOOPBACK.has(url.hostname)) return ["http://localhost:3000", "http://localhost:3300", "http://127.0.0.1:3000", "http://127.0.0.1:3300", base];
  const host = url.hostname;
  const plain = /^api\.(.+)$/.exec(host);
  if (plain) return [`${url.protocol}//app.${plain[1]}`, `${url.protocol}//node.${plain[1]}`];
  const named = /^api-([a-z0-9-]+)\.(.+)$/.exec(host);
  if (named) return [`${url.protocol}//${named[1]}.${named[2]}`, `${url.protocol}//node-${named[1]}.${named[2]}`];
  // A server that serves its pages itself.
  return [base];
}

/** Every site this computer takes encrypted values from. */
export function trustedOrigins(apiBase: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.ENSEMBLE_SEAL_ORIGINS ?? "").split(/[\s,]+/).filter(Boolean).map(origin).filter((value): value is string => Boolean(value));
  return [...new Set([...siteOrigins(apiBase), ...extra])];
}
