/**
 * How Ensemble introduces itself to a remote MCP server's authorization server.
 *
 * One public OAuth client for every person: no client secret, PKCE on every
 * sign-in, redirect back to hub-api. When the API is reachable over https the
 * client is identified by a Client ID Metadata Document served from
 * MCP_CLIENT_METADATA_PATH; otherwise (desktop, localhost) it registers itself
 * with Dynamic Client Registration.
 */
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

export const MCP_CALLBACK_PATH = "/api/mcp-connections/callback";
export const MCP_CLIENT_METADATA_PATH = "/api/mcp-client-metadata.json";

/** Unauthenticated routes. Listed in src/lib/auth-public.ts as well; the MCP test checks they agree. */
export const MCP_PUBLIC_PATHS: readonly string[] = [MCP_CALLBACK_PATH, MCP_CLIENT_METADATA_PATH];

export const MCP_CLIENT_NAME = "Ensemble";
export const MCP_CLIENT_URI = "https://ensemblework.com";

export function publicApiUrl(): string {
  return (process.env.HUB_API_PUBLIC_URL?.trim() || `http://localhost:${process.env.HUB_API_PORT?.trim() || 4000}`).replace(/\/+$/, "");
}

export function mcpRedirectUrl(): string {
  return `${publicApiUrl()}${MCP_CALLBACK_PATH}`;
}

/** The CIMD client_id, only when the API has a public https address an authorization server can fetch. */
export function mcpClientMetadataUrl(): string | undefined {
  const base = publicApiUrl();
  try {
    const url = new URL(base);
    if (url.protocol !== "https:") return undefined;
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost")) return undefined;
  } catch {
    return undefined;
  }
  return `${base}${MCP_CLIENT_METADATA_PATH}`;
}

export function mcpClientMetadata(): OAuthClientMetadata {
  return {
    client_name: MCP_CLIENT_NAME,
    client_uri: MCP_CLIENT_URI,
    redirect_uris: [mcpRedirectUrl()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** The JSON served at MCP_CLIENT_METADATA_PATH. client_id must equal the URL it is served from. */
export function mcpClientMetadataDocument(): Record<string, unknown> {
  return {
    client_id: mcpClientMetadataUrl() ?? `${publicApiUrl()}${MCP_CLIENT_METADATA_PATH}`,
    ...mcpClientMetadata(),
  };
}

export const DEFAULT_RETURN_TO = "/settings?tab=connections";

/** A relative Hub path, or the default. Never an absolute or protocol-relative URL. */
export function safeReturnTo(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!value || value.length > 400) return DEFAULT_RETURN_TO;
  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_RETURN_TO;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return DEFAULT_RETURN_TO;
  return value;
}

/** `${HUB_WEB_ORIGIN}${returnTo}` with query parameters added before any #hash. */
export function hubReturnUrl(returnTo: string, params: Record<string, string>): string {
  const [base, hash] = safeReturnTo(returnTo).split("#");
  const joiner = base!.includes("?") ? "&" : "?";
  const origin = (process.env.HUB_WEB_ORIGIN?.trim() || "http://localhost:3000").replace(/\/+$/, "");
  return `${origin}${base}${joiner}${new URLSearchParams(params)}${hash ? `#${hash}` : ""}`;
}
