import type { ConnectorCatalogEntry } from "@ensemble/shared-types";
import { API, ApiError, del, get, patch, post, put } from "./api";

/** One sync source a connector feeds (settings.connections key). */
export type ConnectorSourceState = { enabled: boolean; lastSyncAt: string | null; lastError: string | null };

export type ConnectorMcpState = {
  status: "pending" | "connected" | "error" | "disabled";
  toolCount: number;
  lastError: string | null;
};

/** What hub-api knows about one connector for the signed-in person. */
export type ConnectorState = {
  connected: boolean;
  account: string | null;
  /** False when nothing can connect it here: no browser sign-in set up on this server and no token, MCP or file path. */
  appReady: boolean;
  /** Browser sign-in (OAuth) is set up on this server. */
  oauthReady?: boolean;
  /** Products switched on whose access the person has not approved yet. */
  needsConsent?: string[];
  products: Record<string, boolean>;
  sources: Record<string, ConnectorSourceState>;
  mcp?: ConnectorMcpState;
};

export type CatalogEntry = ConnectorCatalogEntry & { state: ConnectorState };

export type McpTool = { name: string; title?: string | null; description?: string | null; readOnly: boolean };

export type McpConnection = {
  id: string;
  /** Catalog entry id, or null for a custom server added by URL. */
  serverId: string | null;
  name: string;
  url: string;
  status: "pending" | "connected" | "error" | "disabled";
  toolCount: number;
  tools: McpTool[];
  disabledTools: string[];
  lastError: string | null;
  updatedAt: string;
};

/** PUT /api/connectors/:id/products answers with the new state, or a sign-in URL when a product needs more access. */
export type ProductsResult = ConnectorState | { reconnect: true; url: string; needs?: string[]; state?: ConnectorState };

export const CONNECTOR_QUERY = {
  catalog: ["connector-catalog"] as const,
  mcp: ["mcp-connections"] as const,
};

const encode = encodeURIComponent;

export const connectorsApi = {
  catalog: () => get<{ entries: CatalogEntry[] }>("/api/connectors/catalog"),
  start: (provider: string, options: { products?: string[]; returnTo: string }) => {
    const query = new URLSearchParams();
    if (options.products?.length) query.set("products", options.products.join(","));
    query.set("returnTo", options.returnTo);
    return get<{ url: string }>(`/api/connectors/${encode(provider)}/start?${query}`);
  },
  setProducts: (id: string, products: Record<string, boolean>, returnTo?: string) =>
    put<ProductsResult>(`/api/connectors/${encode(id)}/products`, { products, ...(returnTo ? { returnTo } : {}) }),
  /** Every provider sends `token`; Atlassian adds `email` and `site`, Trello adds `key`. */
  connectToken: (provider: string, fields: Record<string, string>) =>
    post<{ ok: boolean; account: string }>(`/api/connectors/${encode(provider)}/token`, fields),
  disconnect: (provider: string, deleteData: boolean) => del<{ ok: boolean; revoked?: boolean; deleted?: number } | undefined>(`/api/connectors/${encode(provider)}${deleteData ? "?deleteData=1" : ""}`),
  syncSource: (id: string) => post<{ ok: boolean; message: string; proposed?: number }>(`/api/connections/${encode(id)}/sync`),
  syncAll: () => post<{ results: Array<{ id: string; ok: boolean; message: string }>; message?: string }>("/api/fetch"),

  mcpConnections: () => get<{ connections: McpConnection[] }>("/api/mcp-connections"),
  addMcp: (input: McpConnectInput) => postMcp(input),
  refreshMcpTools: (id: string) => post<unknown>(`/api/mcp-connections/${encode(id)}/refresh-tools`),
  setMcpDisabledTools: (id: string, disabledTools: string[]) => patch<unknown>(`/api/mcp-connections/${encode(id)}`, { disabledTools }),
  removeMcp: (id: string) => del<void>(`/api/mcp-connections/${encode(id)}`),
};

export type McpConnectInput = ({ serverId: string } | { url: string; name: string }) & {
  /** Where the MCP sign-in callback sends the person back. */
  returnTo?: string;
  /** A personal access token or API key, sent as a bearer token. */
  token?: string;
  /** A pre-registered OAuth client, for servers that do not let apps register themselves. */
  clientId?: string;
  clientSecret?: string;
};

export type McpConnectResult = { id: string; authorizeUrl?: string | null; status: McpConnection["status"] };

/** MCP connect failures hub-api names, so the form can ask for what is missing. */
export type McpErrorCode = "MCP_URL_REFUSED" | "MCP_TOKEN_REQUIRED" | "MCP_PKCE_UNSUPPORTED" | "MCP_TOKEN_REFUSED" | (string & {});

export class McpConnectError extends ApiError {
  constructor(
    message: string,
    status: number,
    readonly code: McpErrorCode | null,
  ) {
    super(message, status);
  }
}

/** The shared `request` drops the error code, and this form needs it. */
async function postMcp(input: McpConnectInput): Promise<McpConnectResult> {
  let response: Response;
  try {
    response = await fetch(`${API}/api/mcp-connections`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new ApiError("Ensemble can't reach its server right now.", 0);
  }
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const message = typeof body.error === "string" && body.error.trim() ? body.error.trim() : response.statusText || "Could not connect.";
    throw new McpConnectError(message, response.status, typeof body.code === "string" ? body.code : null);
  }
  return body as unknown as McpConnectResult;
}

export function mcpErrorCode(error: unknown): McpErrorCode | null {
  return error instanceof McpConnectError ? error.code : null;
}

export function needsReconnect(result: ProductsResult): result is { reconnect: true; url: string; needs?: string[]; state?: ConnectorState } {
  return typeof result === "object" && result !== null && "reconnect" in result && result.reconnect === true && typeof result.url === "string";
}
