import { loadBridgeConfig, type BridgeAuth, type BridgeConfig } from "./config.js";

export class HubError extends Error {
  constructor(
    message: string,
    readonly code: "down" | "auth" | "http" | "config",
  ) {
    super(message);
  }
}

export type HubQuery = Record<string, string | number | undefined>;

export interface HubClient {
  get(path: string, query?: HubQuery): Promise<unknown>;
  /** Writes are only under /api/bridge/write/ and /api/bridge/act/ (docs/CONTEXT_BRIDGE.md §5). */
  post?(path: string, body: unknown): Promise<unknown>;
  patch?(path: string, body: unknown): Promise<unknown>;
}

function headersFor(auth: BridgeAuth): Record<string, string> {
  if (auth.kind === "missing") return {};
  if (auth.kind === "bearer") return { authorization: `Bearer ${auth.token}` };
  return { "x-ensemble-internal": auth.token, "x-ensemble-user": auth.userId };
}

export function createHubClient(config: BridgeConfig = loadBridgeConfig()): HubClient {
  async function send(method: "GET" | "POST" | "PATCH", path: string, query?: HubQuery, body?: unknown): Promise<unknown> {
    if (config.auth.kind === "missing") throw new HubError(config.auth.message, "config");
    const url = new URL(path, `${config.hubUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headersFor(config.auth),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // An action (a meeting read by a model, a connected app, a file) can take a while; a read cannot.
        signal: AbortSignal.timeout(method === "GET" ? 15_000 : 180_000),
      });
    } catch {
      // Connection refused, DNS, or timeout. An empty brief would look like "no context".
      const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(config.hubUrl);
      throw new HubError(
        local
          ? "Ensemble is not running. Start it with `pnpm dev`."
          : `Ensemble could not be reached at ${config.hubUrl}. Check your connection, or run \`ensemble doctor\`.`,
        "down",
      );
    }
    if (!response.ok) {
      let message = response.statusText;
      try {
        const payload = (await response.json()) as { error?: unknown };
        if (typeof payload.error === "string") message = payload.error;
      } catch {
        /* body was not JSON */
      }
      if (response.status === 401 || response.status === 403) throw new HubError(message, "auth");
      throw new HubError(`Ensemble hub-api returned ${response.status}: ${message}`, "http");
    }
    return response.json() as Promise<unknown>;
  }
  return {
    get: (path, query) => send("GET", path, query),
    post: (path, body) => send("POST", path, undefined, body),
    patch: (path, body) => send("PATCH", path, undefined, body),
  };
}
