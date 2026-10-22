/**
 * Ensemble Node's web app (docs/35), for example https://node.ensemblework.com, from
 * ENSEMBLE_NODE_WEB_ORIGIN. It is added to the CORS allowlist and is where a provider sign-in
 * started on Node returns. Null when unset or not one exact http(s) origin.
 */
export function nodeWebOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.ENSEMBLE_NODE_WEB_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** True when a browser request comes from Ensemble Node's site (its Origin header is exactly the configured origin). */
export function fromNodeSite(origin: string | string[] | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const node = nodeWebOrigin(env);
  return Boolean(node && typeof origin === "string" && origin === node);
}
