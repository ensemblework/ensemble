/**
 * The SDK's OAuthClientProvider, backed by one McpConnection row.
 *
 * "connect" starts a sign-in: discovery, client registration (CIMD or DCR),
 * PKCE, and an authorization URL that the route hands to the browser.
 * "callback" exchanges the code. "background" only refreshes; if the server
 * wants a new sign-in it throws McpReconnectRequired instead of redirecting.
 */
import { randomBytes } from "node:crypto";
import type { McpConnection, PrismaClient } from "@prisma/client";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { encrypt } from "../../lib/secrets.js";
import { mcpClientMetadata, mcpClientMetadataUrl, mcpRedirectUrl } from "./config.js";
import { expiresAtFrom, readCodeVerifier, readEnvelope, readTokens, sealJson, type McpClientEnvelope } from "./store.js";

export const STATE_TTL_MS = 10 * 60 * 1000;

export type ProviderMode = "connect" | "callback" | "background";

/** The server needs a fresh sign-in; a background call cannot open a browser. */
export class McpReconnectRequired extends Error {
  constructor(message = "The server asked for a new sign-in.") {
    super(message);
    this.name = "McpReconnectRequired";
  }
}

/** The authorization server cannot be used safely (no PKCE S256). */
export class McpAuthUnsupported extends Error {
  readonly expose = true;
  readonly statusCode = 400;
  constructor(
    message: string,
    readonly code: "MCP_PKCE_UNSUPPORTED" | "MCP_TOKEN_REQUIRED",
  ) {
    super(message);
    this.name = "McpAuthUnsupported";
  }
}

export function assertPkceS256(metadata: AuthorizationServerMetadata | undefined, name: string): void {
  if (!metadata) {
    throw new McpAuthUnsupported(
      `${name} does not publish OAuth sign-in details Ensemble can use. If it offers a personal access token or API key, paste that instead.`,
      "MCP_TOKEN_REQUIRED",
    );
  }
  const methods = metadata.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes("S256")) {
    throw new McpAuthUnsupported(
      `${name} does not advertise the secure sign-in method Ensemble requires (PKCE with S256), so Ensemble will not sign in to it. If ${name} offers a personal access token, paste it instead.`,
      "MCP_PKCE_UNSUPPORTED",
    );
  }
}

type Db = Pick<PrismaClient, "mcpConnection">;

export class RowOAuthProvider implements OAuthClientProvider {
  /** Set when connect mode produced a sign-in link. */
  authorizationUrl: URL | undefined;
  private envelope: McpClientEnvelope;
  private current: OAuthTokens | undefined;
  private verifier: string | undefined;
  private pendingState: string | undefined;

  constructor(
    private readonly db: Db,
    private row: McpConnection,
    private readonly mode: ProviderMode,
    private readonly options: { returnTo?: string; now?: () => number } = {},
  ) {
    this.envelope = readEnvelope(row);
    this.current = readTokens(row);
    this.verifier = readCodeVerifier(row);
  }

  get redirectUrl(): string {
    return mcpRedirectUrl();
  }

  get clientMetadataUrl(): string | undefined {
    return mcpClientMetadataUrl();
  }

  /**
   * Public client by default. Some authorization servers only take confidential
   * clients (no "none" in token_endpoint_auth_methods_supported); register those
   * with a secret, which is stored encrypted like the tokens.
   */
  get clientMetadata(): OAuthClientMetadata {
    const base = mcpClientMetadata();
    const supported = this.envelope.discovery?.authorizationServerMetadata?.token_endpoint_auth_methods_supported;
    if (Array.isArray(supported) && supported.length && !supported.includes("none")) {
      return { ...base, token_endpoint_auth_method: supported.includes("client_secret_basic") ? "client_secret_basic" : "client_secret_post" };
    }
    return base;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async persist(data: Parameters<Db["mcpConnection"]["update"]>[0]["data"]): Promise<void> {
    this.row = await this.db.mcpConnection.update({ where: { id: this.row.id }, data });
  }

  private sealEnvelope(): string {
    return sealJson({ ...this.envelope, auth: "oauth" });
  }

  state(): string {
    this.pendingState = randomBytes(32).toString("base64url");
    return this.pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.envelope.client;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.envelope = { ...this.envelope, auth: "oauth", client: info };
    await this.persist({ clientInfo: this.sealEnvelope() });
  }

  tokens(): OAuthTokens | undefined {
    return this.current;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.current = tokens;
    await this.persist({ tokens: sealJson(tokens), expiresAt: expiresAtFrom(tokens, this.now()) });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new McpReconnectRequired("The sign-in expired. Connect again.");
    return this.verifier;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (this.mode !== "connect") throw new McpReconnectRequired();
    const state = url.searchParams.get("state") ?? this.pendingState;
    if (!state || !this.verifier) throw new Error("The sign-in link could not be prepared.");
    this.authorizationUrl = url;
    await this.persist({
      status: "pending",
      oauthState: state,
      stateExpiresAt: new Date(this.now() + STATE_TTL_MS),
      codeVerifier: encrypt(this.verifier),
      returnTo: this.options.returnTo ?? this.row.returnTo,
    });
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") {
      delete this.envelope.client;
      delete this.envelope.preRegistered;
    }
    if (scope === "all" || scope === "discovery") delete this.envelope.discovery;
    if (scope === "all" || scope === "tokens") this.current = undefined;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    await this.persist({
      clientInfo: this.sealEnvelope(),
      ...(scope === "all" || scope === "tokens" ? { tokens: null, expiresAt: null } : {}),
      ...(scope === "all" || scope === "verifier" ? { codeVerifier: null } : {}),
    });
    // Only a sign-in in progress can start over; anything else needs the person.
    if (this.mode !== "connect") throw new McpReconnectRequired();
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    if (this.mode === "connect") assertPkceS256(state.authorizationServerMetadata, this.row.name);
    this.envelope = { ...this.envelope, auth: "oauth", discovery: state };
    await this.persist({ clientInfo: this.sealEnvelope() });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.envelope.discovery;
  }

  get connection(): McpConnection {
    return this.row;
  }
}
