import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isHosted } from "../lib/hosted-access.js";
import { publicApiUrl } from "../lib/public-api.js";
import { MCP_OAUTH_SCOPES } from "@ensemble/shared-types";

export { MCP_OAUTH_SCOPES };
export const MCP_ACCESS_MS = 60 * 60 * 1000;
export const MCP_REFRESH_MS = 30 * 86_400_000;
export const MCP_CONSENT_MS = 10 * 60 * 1000;

export class McpOAuthError extends Error {
  readonly expose = true;
  redirectTo?: string;
  constructor(readonly oauthError: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = "McpOAuthError";
  }
}

export function oauthIssuer(): string {
  const value = new URL(publicApiUrl());
  const loopback = isLoopback(value);
  if (value.username || value.password || value.search || value.hash || value.pathname !== "/" ||
    (value.protocol !== "https:" && (isHosted() || value.protocol !== "http:" || !loopback))) {
    throw new McpOAuthError("server_error", "MCP OAuth requires HUB_API_PUBLIC_URL to be a public HTTPS origin, or a local HTTP origin in development.", 503);
  }
  return value.origin;
}

export const oauthResource = (): string => `${oauthIssuer()}/mcp`;

export function resourceOf(value?: string): string {
  const resource = oauthResource();
  if (value !== undefined && value !== resource) {
    throw new McpOAuthError("invalid_target", "Use this Ensemble server's /mcp URL as the OAuth resource.");
  }
  return resource;
}

export function scopesOf(value?: string): string[] {
  const scopes = [...new Set((value ?? MCP_OAUTH_SCOPES.join(" ")).split(" ").filter(Boolean))];
  if (!scopes.includes("ensemble:read") || scopes.some(scope => !MCP_OAUTH_SCOPES.some(known => known === scope))) {
    throw new McpOAuthError("invalid_scope", `Include ensemble:read and use only ${MCP_OAUTH_SCOPES.join(", ")}.`);
  }
  return scopes;
}

export function opaqueSecret(kind: "client" | "request" | "csrf" | "code" | "refresh"): string {
  return `ens_oauth_${kind}_${randomBytes(32).toString("base64url")}`;
}

export const secretHash = (value: string): string => createHash("sha256").update(value).digest("hex");

export const consentCsrf = (session: string, purpose: string): string =>
  `ens_oauth_csrf_${createHmac("sha256", session).update(purpose).digest("base64url")}`;

export function hashMatches(value: string, expected: string): boolean {
  const left = Buffer.from(secretHash(value), "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
}

export function validRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url)));
  } catch {
    return false;
  }
}

export function redirectMatches(wanted: string, registered: readonly string[]): boolean {
  if (!validRedirect(wanted)) return false;
  if (registered.includes(wanted)) return true;
  const url = new URL(wanted);
  if (url.protocol !== "http:" || !isLoopback(url)) return false;
  return registered.some(value => {
    const allowed = new URL(value);
    return allowed.protocol === url.protocol && allowed.hostname === url.hostname &&
      allowed.pathname === url.pathname && allowed.search === url.search;
  });
}

const clientName = z.string().trim().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/, "Use a single-line app name.");
const redirectUri = z.string().min(1).max(2048).refine(validRedirect, "Use an HTTPS redirect, or an HTTP loopback callback without credentials or fragments.");
export const clientMetadataSchema = z.object({
  client_name: clientName,
  redirect_uris: z.array(redirectUri).min(1).max(32),
  token_endpoint_auth_method: z.enum(["none", "client_secret_basic", "client_secret_post"]).default("none"),
  ensemble_refresh_token_mode: z.enum(["rotate", "persistent"]).default("rotate"),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
  response_types: z.array(z.literal("code")).optional(),
});

export const authorizationSchema = z.object({
  client_id: z.string().min(1).max(2048),
  redirect_uri: redirectUri,
  response_type: z.literal("code"),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Supply a PKCE S256 challenge."),
  code_challenge_method: z.literal("S256"),
  scope: z.string().max(300).optional(),
  resource: z.string().max(2048).optional(),
  state: z.string().max(2048).optional(),
});

export function authorizationResponse(redirect: string, state: string | null, values: Record<string, string>): string {
  const url = new URL(redirect);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set("iss", oauthIssuer());
  return url.href;
}

export function protectedMetadata() {
  return {
    resource: oauthResource(),
    authorization_servers: [oauthIssuer()],
    bearer_methods_supported: ["header"],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    resource_name: "Ensemble",
    resource_documentation: "https://docs.ensemblework.com/context_bridge/",
    resource_policy_uri: "https://ensemblework.com/privacy",
  };
}

export function authorizationMetadata() {
  const issuer = oauthIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

export const mcpBearerChallenge = (): string =>
  `Bearer realm="Ensemble", resource_metadata="${oauthIssuer()}/.well-known/oauth-protected-resource/mcp"`;

export function formParameters(value: string): Record<string, string> {
  const params = new URLSearchParams(value);
  const result: Record<string, string> = {};
  for (const [key, entry] of params) {
    if (Object.hasOwn(result, key)) throw new McpOAuthError("invalid_request", `The ${key} parameter must appear only once.`);
    result[key] = entry;
  }
  return result;
}

export function basicCredentials(value?: string): { clientId: string; secret: string } | null {
  if (!value) return null;
  if (!value.startsWith("Basic ")) throw new McpOAuthError("invalid_client", "Use the registered app's token endpoint authentication method.", 401);
  const encoded = value.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new McpOAuthError("invalid_client", "The client credentials are not valid.", 401);
  const text = Buffer.from(encoded, "base64").toString("utf8");
  const separator = text.indexOf(":");
  if (separator < 1) throw new McpOAuthError("invalid_client", "The client credentials are not valid.", 401);
  try {
    return { clientId: decodeURIComponent(text.slice(0, separator).replace(/\+/g, " ")), secret: decodeURIComponent(text.slice(separator + 1).replace(/\+/g, " ")) };
  } catch {
    throw new McpOAuthError("invalid_client", "The client credentials are not valid.", 401);
  }
}
