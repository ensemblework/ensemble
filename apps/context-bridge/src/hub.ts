import { loadBridgeConfig, rediscover, type BridgeAuth, type BridgeConfig } from "./config.js";

export class HubError extends Error {
  constructor(
    message: string,
    readonly code: "down" | "auth" | "http" | "config",
  ) {
    super(message);
  }
}

export type HubQuery = Record<string, string | number | undefined>;

export interface HubCallOptions {
  /** The space the call acts in, by id: sent as `x-ensemble-space` (docs/CONTEXT_BRIDGE.md §4). */
  space?: string;
  /** A large answer (a file): wait for it as long as for an action. */
  large?: boolean;
}

/** A file's bytes as hub-api served them. */
export interface HubDownload {
  bytes: Uint8Array;
  mediaType: string | null;
}

export interface HubClient {
  get(path: string, query?: HubQuery, options?: HubCallOptions): Promise<unknown>;
  /** Writes are only under /api/bridge/write/ and /api/bridge/act/ (docs/CONTEXT_BRIDGE.md §5). */
  post?(path: string, body: unknown, options?: HubCallOptions): Promise<unknown>;
  patch?(path: string, body: unknown, options?: HubCallOptions): Promise<unknown>;
  /** A GET that answers with a file rather than JSON (a file's original). */
  download?(path: string, options?: HubCallOptions): Promise<HubDownload>;
}

export const SPACE_HEADER = "x-ensemble-space";

function headersFor(auth: BridgeAuth): Record<string, string> {
  if (auth.kind === "missing") return {};
  if (auth.kind === "bearer") return { authorization: `Bearer ${auth.token}` };
  return { "x-ensemble-internal": auth.token, "x-ensemble-user": auth.userId };
}

export function createHubClient(initial: BridgeConfig = loadBridgeConfig()): HubClient {
  let config = initial;
  async function send(method: "GET" | "POST" | "PATCH", path: string, query?: HubQuery, body?: unknown, options?: HubCallOptions & { raw?: boolean }): Promise<Response> {
    if (config.discovered) {
      const current = rediscover();
      if (current) config = { ...config, hubUrl: current.hubUrl, auth: { kind: "bearer", token: current.token } };
    }
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
          accept: options?.raw ? "*/*" : "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(options?.space ? { [SPACE_HEADER]: options.space } : {}),
          ...headersFor(config.auth),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // An action (a meeting read by a model, a connected app, a file) can take a while; a read cannot.
        signal: AbortSignal.timeout(method === "GET" && !options?.raw && !options?.large ? 15_000 : 180_000),
      });
    } catch {
      // Connection refused, DNS, or timeout. An empty brief would look like "no context".
      const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(config.hubUrl);
      throw new HubError(
        config.discovered
          ? "The Ensemble app is not running on this computer. Open it, then try again."
          : local
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
    return response;
  }
  const json = async (response: Promise<Response>) => (await response).json() as Promise<unknown>;
  return {
    get: (path, query, options) => json(send("GET", path, query, undefined, options)),
    post: (path, body, options) => json(send("POST", path, undefined, body, options)),
    patch: (path, body, options) => json(send("PATCH", path, undefined, body, options)),
    download: async (path, options) => {
      const response = await send("GET", path, undefined, undefined, { ...options, raw: true });
      return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType: response.headers.get("content-type") };
    },
  };
}
