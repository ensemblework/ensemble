import { loadBridgeConfig, type BridgeAuth, type BridgeConfig } from "./config.js";

export class HubError extends Error {
  constructor(
    message: string,
    readonly code: "down" | "auth" | "http" | "config",
  ) {
    super(message);
  }
}

export interface HubClient {
  get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown>;
}

function headersFor(auth: BridgeAuth): Record<string, string> {
  if (auth.kind === "missing") return {};
  if (auth.kind === "bearer") return { authorization: `Bearer ${auth.token}` };
  return { "x-ensemble-internal": auth.token, "x-ensemble-user": auth.userId };
}

export function createHubClient(config: BridgeConfig = loadBridgeConfig()): HubClient {
  return {
    async get(path, query) {
      if (config.auth.kind === "missing") throw new HubError(config.auth.message, "config");
      const url = new URL(path, `${config.hubUrl}/`);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value === undefined || value === "") continue;
        url.searchParams.set(key, String(value));
      }
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json", ...headersFor(config.auth) },
          signal: AbortSignal.timeout(8000),
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
          const body = (await response.json()) as { error?: unknown };
          if (typeof body.error === "string") message = body.error;
        } catch {
          /* body was not JSON */
        }
        if (response.status === 401 || response.status === 403) throw new HubError(message, "auth");
        throw new HubError(`Ensemble hub-api returned ${response.status}: ${message}`, "http");
      }
      return response.json() as Promise<unknown>;
    },
  };
}
