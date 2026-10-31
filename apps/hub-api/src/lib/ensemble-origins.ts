/**
 * Ensemble's own web app: the Hub, Ensemble Node's site and the API, in production and testing, plus
 * the Hub and Node origins this server is configured with (HUB_WEB_ORIGIN, ENSEMBLE_NODE_WEB_ORIGIN).
 * A node and its agent runs already act in Ensemble as their owner through Ensemble's tools, so a
 * node's browser never opens these to sign in (docs/35 §8.16). A configured origin on this computer's
 * own addresses (http://localhost:3000 in development) is left out: it is often an app being built.
 */
import { isIP } from "node:net";

const HOSTS = new Set([
  "app.ensemblework.com",
  "test.ensemblework.com",
  "api.ensemblework.com",
  "api-test.ensemblework.com",
  "node.ensemblework.com",
  "node-test.ensemblework.com",
]);

function loopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (isIP(bare) === 4) return bare.startsWith("127.");
  return bare === "::1";
}

/** The configured Hub and Node origins that are not this computer's own. */
function configured(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const raw of [env.HUB_WEB_ORIGIN, env.ENSEMBLE_NODE_WEB_ORIGIN]) {
    try {
      const url = new URL((raw ?? "").trim());
      if ((url.protocol === "https:" || url.protocol === "http:") && !loopback(url.hostname)) out.push(url.origin);
    } catch {
      // unset or not an origin
    }
  }
  return out;
}

/** The Ensemble web app origin `text` opens (a URL, or a bare host as a store is named), or null. */
export function ensembleAppOrigin(text: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = text.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (HOSTS.has(host)) return `https://${host}`;
  return configured(env).find((origin) => new URL(origin).host === url.host) ?? null;
}

/** What a node is told when it tries to open Ensemble itself. */
export const ENSEMBLE_IN_BROWSER =
  "Use your Ensemble tools: you already act in Ensemble as your owner, signed in. Boards: hub_list_boards, hub_read_board, hub_move_to_board; tasks: hub_list_tasks, hub_update_task; pages: hub_read_page; anything else: hub_how_to. Never ask your owner to sign in to Ensemble. To test Ensemble's web app itself, give that work to an agent session.";
