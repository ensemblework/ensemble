import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { McpOAuthClient, McpOAuthGrant, PrismaClient, Prisma } from "@prisma/client";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { assertMcpUrlAllowed, pinnedFetch, type LookupFn } from "../connectors/mcp/url-guard.js";
import { accountIdOf, newApiToken, readCookie, SESSION_COOKIE } from "../lib/auth.js";
import { appendLedgerInTransaction } from "../lib/ledger.js";
import {
  authorizationResponse, authorizationSchema, basicCredentials, clientMetadataSchema, consentCsrf,
  hashMatches, MCP_ACCESS_MS, MCP_CONSENT_MS, MCP_REFRESH_MS, McpOAuthError,
  opaqueSecret, pkceMatches, redirectMatches, resourceOf, scopesOf, secretHash,
} from "./protocol.js";

export type McpOAuthOptions = { metadataFetch?: FetchLike; metadataLookup?: LookupFn };
type Db = PrismaClient | Prisma.TransactionClient;
const METADATA_MAX_BYTES = 32 * 1024;

function invalidGrant(): McpOAuthError {
  return new McpOAuthError("invalid_grant", "This sign-in or refresh token is expired, already used, or does not match this app. Connect the app again.");
}

function browserSession(request: FastifyRequest): { accountId: string; session: string } {
  const session = readCookie(request, SESSION_COOKIE);
  if (request.authVia !== "session" || !session) {
    throw Object.assign(new Error("Sign in to Ensemble in this browser to approve or manage an app connection."), { statusCode: 403 });
  }
  return { accountId: accountIdOf(request), session };
}

async function ownsSpace(db: Db, accountId: string, spaceId: string): Promise<boolean> {
  const space = await db.user.findUnique({ where: { id: spaceId }, select: { ownerId: true } });
  return Boolean(space && (spaceId === accountId ? space.ownerId === null : space.ownerId === accountId));
}

function cancelMetadata(stream: { cancel(): Promise<void> } | null | undefined, log?: Pick<FastifyBaseLogger, "warn">): void {
  if (stream) void stream.cancel().catch((error: unknown) => log?.warn({ err: error }, "MCP client metadata stream cleanup failed"));
}

async function readMetadata(response: Response, log?: Pick<FastifyBaseLogger, "warn">): Promise<unknown> {
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    cancelMetadata(response.body, log);
    throw new McpOAuthError("invalid_client", "The app's public client metadata must return JSON without a redirect.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new McpOAuthError("invalid_client", "The app's client metadata document is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > METADATA_MAX_BYTES) throw new McpOAuthError("invalid_client", "The app's client metadata exceeds 32 KB. Use a smaller public document.");
      chunks.push(next.value);
    }
  } finally {
    cancelMetadata(reader, log);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new McpOAuthError("invalid_client", "The app's client metadata is not valid JSON.");
  }
}

export async function revokeMcpOAuthGrant(db: Db, id: string, now: Date): Promise<void> {
  await db.mcpOAuthGrant.update({ where: { id }, data: { revokedAt: now } });
  await db.apiToken.updateMany({ where: { oauthGrantId: id, revokedAt: null }, data: { revokedAt: now } });
}

async function issueTokens(db: Db, grant: McpOAuthGrant, scopes: string[], now: Date, appName: string, persistentRefresh?: string) {
  const access = newApiToken();
  await db.apiToken.create({
    data: {
      userId: grant.userId, accountId: grant.accountId, name: appName, scope: "bridge",
      tokenHash: access.hash, prefix: access.prefix, oauthGrantId: grant.id, oauthScopes: scopes,
      canWrite: scopes.includes("ensemble:write"), canUseApps: scopes.includes("ensemble:apps"),
      expiresAt: new Date(now.getTime() + MCP_ACCESS_MS),
    },
  });
  const refresh = scopes.includes("offline_access") ? persistentRefresh ?? opaqueSecret("refresh") : undefined;
  if (refresh && !persistentRefresh) {
    await db.mcpOAuthRefreshToken.create({
      data: { tokenHash: secretHash(refresh), grantId: grant.id, scopes, expiresAt: new Date(now.getTime() + MCP_REFRESH_MS) },
    });
  }
  return { access_token: access.token, token_type: "Bearer", expires_in: MCP_ACCESS_MS / 1000, scope: scopes.join(" "), ...(refresh ? { refresh_token: refresh } : {}) };
}

export class McpOAuthService {
  constructor(private readonly db: PrismaClient, private readonly options: McpOAuthOptions = {}, private readonly log?: Pick<FastifyBaseLogger, "warn">) {}

  async register(input: unknown) {
    const parsed = clientMetadataSchema.safeParse(input);
    if (!parsed.success) {
      throw new McpOAuthError("invalid_client_metadata", parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }
    const metadata = parsed.data;
    if (metadata.ensemble_refresh_token_mode === "persistent" && metadata.token_endpoint_auth_method === "none") {
      throw new McpOAuthError("invalid_client_metadata", "Persistent linking requires a confidential client authenticated with a client secret. Public clients use rotating refresh tokens.");
    }
    const id = `mcp_${randomUUID()}`;
    const secret = metadata.token_endpoint_auth_method === "none" ? null : opaqueSecret("client");
    await this.db.mcpOAuthClient.create({
      data: { id, name: metadata.client_name, redirectUris: [...new Set(metadata.redirect_uris)], authMethod: metadata.token_endpoint_auth_method, refreshMode: metadata.ensemble_refresh_token_mode, secretHash: secret ? secretHash(secret) : null },
    });
    return {
      ...metadata, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000),
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    };
  }

  private async client(id: string): Promise<McpOAuthClient> {
    const stored = await this.db.mcpOAuthClient.findUnique({ where: { id } });
    if (!id.startsWith("https://")) {
      if (!stored) throw new McpOAuthError("invalid_client", "Register this OAuth app before connecting it.", 401);
      return stored;
    }
    if (stored?.metadataExpiresAt && stored.metadataExpiresAt > new Date()) return stored;
    let url: URL;
    try {
      url = new URL(id);
      if (url.href !== id || url.pathname === "/" || url.hash) throw new Error("Invalid client metadata URL.");
    } catch {
      throw new McpOAuthError("invalid_client", "Use the exact HTTPS URL of the app's public client metadata document.", 401);
    }
    const signal = AbortSignal.timeout(5_000);
    const resolve: LookupFn = hostname => {
      if (signal.aborted) return Promise.reject(new Error("Client metadata lookup timed out."));
      const asking = this.options.metadataLookup
        ? this.options.metadataLookup(hostname)
        : lookup(hostname, { all: true, verbatim: true }).then(rows => rows.map(row => row.address));
      return new Promise((resolve, reject) => {
        const aborted = () => reject(new Error("Client metadata lookup timed out."));
        if (signal.aborted) return aborted();
        signal.addEventListener("abort", aborted, { once: true });
        asking.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
      });
    };
    let response: Response;
    try {
      await assertMcpUrlAllowed(url, { hosted: true, lookup: resolve });
      response = await (this.options.metadataFetch ?? pinnedFetch({ lookup: resolve }))(url, {
        method: "GET", headers: { accept: "application/json" }, redirect: "manual", signal,
      });
    } catch (error) {
      this.log?.warn({ err: error }, "MCP OAuth client metadata fetch failed");
      throw new McpOAuthError("invalid_client", "The app's public client metadata could not be reached safely. Retry or register an OAuth client.", 401);
    }
    const raw = await readMetadata(response, this.log);
    const cimd = z.object({
      client_id: z.literal(id),
      client_name: z.string(),
      redirect_uris: z.array(z.string()),
      token_endpoint_auth_method: z.string().optional(),
      token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
    }).safeParse(raw);
    if (!cimd.success) throw new McpOAuthError("invalid_client", "The public client metadata must match its URL and include a name and redirect URIs.", 401);
    const methods = cimd.data.token_endpoint_auth_methods_supported ?? [cimd.data.token_endpoint_auth_method ?? "none"];
    if (!methods.includes("none")) throw new McpOAuthError("invalid_client", "This client metadata must support public-client PKCE authentication (none).", 401);
    const metadata = clientMetadataSchema.safeParse({ ...cimd.data, token_endpoint_auth_method: "none" });
    if (!metadata.success) throw new McpOAuthError("invalid_client", "The app's client metadata contains an invalid name or redirect URI.", 401);
    const cacheControl = response.headers.get("cache-control") ?? "";
    const maxAge = /max-age=(\d+)/i.exec(cacheControl)?.[1];
    const cacheSeconds = /\b(?:no-store|no-cache)\b/i.test(cacheControl) ? 0 : Math.min(Number(maxAge ?? 300), 3600);
    const data = { name: metadata.data.client_name, redirectUris: [...new Set(metadata.data.redirect_uris)], authMethod: "none", refreshMode: "rotate", secretHash: null, metadataExpiresAt: new Date(Date.now() + cacheSeconds * 1000) };
    return this.db.mcpOAuthClient.upsert({ where: { id }, create: { id, ...data }, update: data });
  }

  async authorize(input: unknown): Promise<string> {
    const identity = z.object({
      client_id: z.string().min(1).max(2048),
      redirect_uri: z.string().min(1).max(2048),
      state: z.string().max(2048).optional(),
    }).safeParse(input);
    if (!identity.success) throw new McpOAuthError("invalid_request", "Include a valid client_id and redirect_uri.");
    const client = await this.client(identity.data.client_id);
    if (!redirectMatches(identity.data.redirect_uri, client.redirectUris)) {
      throw new McpOAuthError("invalid_request", "The redirect URI is not registered for this app.");
    }
    const parsed = authorizationSchema.safeParse(input);
    if (!parsed.success) {
      const error = new McpOAuthError(
        parsed.error.issues.some(issue => issue.path[0] === "response_type") ? "unsupported_response_type" : "invalid_request",
        parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
      error.redirectTo = authorizationResponse(identity.data.redirect_uri, identity.data.state ?? null, { error: error.oauthError, error_description: error.message });
      throw error;
    }
    const params = parsed.data;
    let resource: string;
    let scopes: string[];
    try {
      resource = resourceOf(params.resource);
      scopes = scopesOf(params.scope);
    } catch (error) {
      if (!(error instanceof McpOAuthError)) throw error;
      error.redirectTo = authorizationResponse(params.redirect_uri, params.state ?? null, { error: error.oauthError, error_description: error.message });
      throw error;
    }
    const request = opaqueSecret("request");
    await this.db.mcpOAuthRequest.create({
      data: { id: secretHash(request), clientId: client.id, redirectUri: params.redirect_uri, resource, requestedScopes: scopes, state: params.state ?? null, codeChallenge: params.code_challenge, expiresAt: new Date(Date.now() + MCP_CONSENT_MS) },
    });
    return request;
  }

  async consent(request: FastifyRequest, id: string) {
    const browser = browserSession(request);
    const row = await this.db.mcpOAuthRequest.findUnique({ where: { id: secretHash(id) }, include: { client: true } });
    if (!row || row.decision !== "pending" || row.expiresAt <= new Date() || (row.accountId && row.accountId !== browser.accountId)) {
      throw Object.assign(new Error("This sign-in request expired or was already used. Connect the app again."), { statusCode: 404 });
    }
    const csrf = consentCsrf(browser.session, row.id);
    const bound = await this.db.mcpOAuthRequest.updateMany({
      where: { id: row.id, decision: "pending", expiresAt: { gt: new Date() }, OR: [{ accountId: null }, { accountId: browser.accountId }] },
      data: { accountId: browser.accountId, sessionHash: secretHash(browser.session), csrfHash: secretHash(csrf) },
    });
    if (bound.count !== 1) throw Object.assign(new Error("This sign-in request changed. Connect the app again."), { statusCode: 409 });
    const spaces = await this.db.user.findMany({
      where: { OR: [{ id: browser.accountId, ownerId: null }, { ownerId: browser.accountId }] },
      select: { id: true, name: true, spaceName: true, email: true }, orderBy: [{ spacePosition: "asc" }, { createdAt: "asc" }],
    });
    const account = spaces.find(space => space.id === browser.accountId);
    if (!account) throw Object.assign(new Error("Your account is not available. Sign in again before connecting this app."), { statusCode: 401 });
    return {
      csrf, clientName: row.client.name, clientOrigin: new URL(row.redirectUri).origin,
      clientMetadataOrigin: row.clientId.startsWith("https://") ? new URL(row.clientId).origin : null,
      accountEmail: account.email,
      expiresAt: row.expiresAt.toISOString(), canWrite: row.requestedScopes.includes("ensemble:write"),
      canUseApps: row.requestedScopes.includes("ensemble:apps"),
      spaces: spaces.map(space => ({ id: space.id, name: space.spaceName || space.name || "My space" })),
    };
  }

  async decide(request: FastifyRequest, input: { request: string; csrf: string; decision: "allow" | "deny"; spaceId?: string; canWrite?: boolean; canUseApps?: boolean }): Promise<string> {
    const browser = browserSession(request);
    return this.db.$transaction(async tx => {
      const row = await tx.mcpOAuthRequest.findUnique({ where: { id: secretHash(input.request) } });
      if (!row || row.decision !== "pending" || row.expiresAt <= new Date()) throw invalidGrant();
      if (row.accountId !== browser.accountId || row.sessionHash !== secretHash(browser.session) || !row.csrfHash || !hashMatches(input.csrf, row.csrfHash)) {
        throw Object.assign(new Error("Load this sign-in request again in this browser before approving it."), { statusCode: 403 });
      }
      if (input.decision === "deny") {
        const changed = await tx.mcpOAuthRequest.updateMany({ where: { id: row.id, decision: "pending", csrfHash: row.csrfHash, sessionHash: row.sessionHash }, data: { decision: "denied", csrfHash: null } });
        if (changed.count !== 1) throw invalidGrant();
        return authorizationResponse(row.redirectUri, row.state, { error: "access_denied", error_description: "The person did not approve this connection." });
      }
      const spaceId = input.spaceId ?? browser.accountId;
      if (!await ownsSpace(tx, browser.accountId, spaceId)) throw Object.assign(new Error("Choose a space you own. Shared spaces are not available to MCP connections."), { statusCode: 403 });
      if ((input.canWrite && !row.requestedScopes.includes("ensemble:write")) || (input.canUseApps && !row.requestedScopes.includes("ensemble:apps"))) {
        throw new McpOAuthError("invalid_scope", "The app did not request those permissions. Restart the connection with the required scopes.");
      }
      const scopes = row.requestedScopes.filter(scope => (scope !== "ensemble:write" || input.canWrite === true) && (scope !== "ensemble:apps" || input.canUseApps === true));
      const code = opaqueSecret("code");
      const changed = await tx.mcpOAuthRequest.updateMany({
        where: { id: row.id, decision: "pending", csrfHash: row.csrfHash, sessionHash: row.sessionHash },
        data: { decision: "allowed", spaceId, scopes, codeHash: secretHash(code), csrfHash: null },
      });
      if (changed.count !== 1) throw invalidGrant();
      return authorizationResponse(row.redirectUri, row.state, { code });
    });
  }

  private async authenticate(body: Record<string, string>, authorization?: string): Promise<McpOAuthClient> {
    const basic = basicCredentials(authorization);
    if (basic && (body.client_secret !== undefined || (body.client_id !== undefined && body.client_id !== basic.clientId))) {
      throw new McpOAuthError("invalid_client", "Supply one matching client authentication method.", 401);
    }
    const id = basic?.clientId ?? body.client_id;
    const client = id ? await this.db.mcpOAuthClient.findUnique({ where: { id } }) : null;
    if (!client) throw new McpOAuthError("invalid_client", "Register and authorize this app before exchanging tokens.", 401);
    if (!["none", "client_secret_basic", "client_secret_post"].includes(client.authMethod)) {
      throw new McpOAuthError("invalid_client", "The registered app's token authentication method is not supported.", 401);
    }
    if (!["rotate", "persistent"].includes(client.refreshMode) || (client.refreshMode === "persistent" && client.authMethod === "none")) {
      throw new McpOAuthError("invalid_client", "This app's refresh policy is not valid for its authentication method.", 401);
    }
    if (client.authMethod === "none") {
      if (basic || body.client_secret !== undefined) throw new McpOAuthError("invalid_client", "This public app uses client_id and PKCE, not a client secret.", 401);
    } else {
      const supplied = client.authMethod === "client_secret_basic" ? basic?.secret : !basic ? body.client_secret : undefined;
      if (!supplied || !client.secretHash || !hashMatches(supplied, client.secretHash)) {
        throw new McpOAuthError("invalid_client", "The app's client credentials or authentication method do not match.", 401);
      }
    }
    return client;
  }

  async token(body: Record<string, string>, authorization?: string) {
    const client = await this.authenticate(body, authorization);
    if (body.grant_type === "authorization_code") return this.exchangeCode(client, body);
    if (body.grant_type === "refresh_token") return this.refresh(client, body);
    throw new McpOAuthError("unsupported_grant_type", "Use authorization_code with PKCE, or refresh_token. Machine-to-machine grants are not supported.");
  }

  private async exchangeCode(client: McpOAuthClient, body: Record<string, string>) {
    if (!body.code || !body.code_verifier || !body.redirect_uri) throw new McpOAuthError("invalid_request", "Include code, code_verifier and the original redirect_uri.");
    const resource = resourceOf(body.resource);
    return this.db.$transaction(async tx => {
      const now = new Date();
      const row = await tx.mcpOAuthRequest.findUnique({ where: { codeHash: secretHash(body.code!) } });
      if (!row || row.clientId !== client.id || row.decision !== "allowed" || row.expiresAt <= now || row.usedAt ||
        row.redirectUri !== body.redirect_uri || row.resource !== resource || !row.accountId || !row.spaceId ||
        !pkceMatches(body.code_verifier!, row.codeChallenge) || !await ownsSpace(tx, row.accountId, row.spaceId)) throw invalidGrant();
      const claimed = await tx.mcpOAuthRequest.updateMany({ where: { id: row.id, usedAt: null, decision: "allowed", expiresAt: { gt: now } }, data: { usedAt: now } });
      if (claimed.count !== 1) throw invalidGrant();
      const grant = await tx.mcpOAuthGrant.create({ data: { userId: row.spaceId, accountId: row.accountId, clientId: client.id, resource, scopes: row.scopes } });
      await appendLedgerInTransaction(tx, { userId: row.accountId, actor: "me", action: "mcp.oauth.authorize", payload: { app: client.name, scopes: row.scopes } });
      return issueTokens(tx, grant, row.scopes, now, client.name);
    });
  }

  private async refresh(client: McpOAuthClient, body: Record<string, string>) {
    if (!body.refresh_token) throw new McpOAuthError("invalid_request", "Include the current refresh_token.");
    const resource = resourceOf(body.resource);
    const result = await this.db.$transaction(async tx => {
      const now = new Date();
      const row = await tx.mcpOAuthRefreshToken.findUnique({ where: { tokenHash: secretHash(body.refresh_token!) }, include: { grant: true } });
      if (!row || row.grant.clientId !== client.id || row.grant.revokedAt || row.grant.resource !== resource ||
        !await ownsSpace(tx, row.grant.accountId, row.grant.userId)) throw invalidGrant();
      if (row.usedAt) {
        await revokeMcpOAuthGrant(tx, row.grantId, now);
        await appendLedgerInTransaction(tx, { userId: row.grant.accountId, actor: "agent", action: "mcp.oauth.replay", payload: { app: client.name } });
        return { replayed: true as const };
      }
      if (row.expiresAt <= now) throw invalidGrant();
      // Lock the grant so concurrent refreshes preserve narrowed scopes and cannot outlive revocation.
      const locked = await tx.mcpOAuthGrant.updateMany({ where: { id: row.grantId, revokedAt: null }, data: { lastUsedAt: now } });
      if (locked.count !== 1) throw invalidGrant();
      const current = await tx.mcpOAuthRefreshToken.findUnique({ where: { tokenHash: row.tokenHash } });
      if (!current || current.expiresAt <= now) throw invalidGrant();
      if (current.usedAt) {
        await revokeMcpOAuthGrant(tx, row.grantId, now);
        return { replayed: true as const };
      }
      const scopes = body.scope === undefined ? current.scopes : scopesOf(body.scope);
      if (scopes.some(scope => !current.scopes.includes(scope))) throw new McpOAuthError("invalid_scope", "Refresh tokens can retain or reduce permissions, not add them. Connect the app again for more access.");
      if (client.refreshMode === "persistent") {
        await tx.mcpOAuthRefreshToken.update({
          where: { tokenHash: row.tokenHash },
          data: { scopes, expiresAt: new Date(now.getTime() + MCP_REFRESH_MS), ...(scopes.includes("offline_access") ? {} : { usedAt: now }) },
        });
        return { replayed: false as const, tokens: await issueTokens(tx, row.grant, scopes, now, client.name, body.refresh_token) };
      }
      const claimed = await tx.mcpOAuthRefreshToken.updateMany({ where: { tokenHash: row.tokenHash, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (claimed.count !== 1) {
        await revokeMcpOAuthGrant(tx, row.grantId, now);
        return { replayed: true as const };
      }
      return { replayed: false as const, tokens: await issueTokens(tx, row.grant, scopes, now, client.name) };
    });
    if (result.replayed) throw invalidGrant();
    return result.tokens;
  }

  async revoke(body: Record<string, string>, authorization?: string): Promise<void> {
    const client = await this.authenticate(body, authorization);
    if (!body.token || body.token.length > 2048) throw new McpOAuthError("invalid_request", "Include the token to revoke.");
    const hash = secretHash(body.token);
    const refresh = await this.db.mcpOAuthRefreshToken.findUnique({ where: { tokenHash: hash }, include: { grant: true } });
    const access = refresh ? null : await this.db.apiToken.findUnique({ where: { tokenHash: hash }, include: { oauthGrant: true } });
    const grant = refresh?.grant ?? access?.oauthGrant;
    // RFC 7009 does not disclose whether a token exists or belongs to a different client.
    if (!grant || grant.clientId !== client.id || grant.revokedAt) return;
    await this.db.$transaction(tx => revokeMcpOAuthGrant(tx, grant.id, new Date()));
  }

  async connections(request: FastifyRequest) {
    const browser = browserSession(request);
    const grants = await this.db.mcpOAuthGrant.findMany({
      where: { accountId: browser.accountId, revokedAt: null },
      include: { client: { select: { name: true } }, space: { select: { name: true, spaceName: true } } },
      orderBy: { createdAt: "desc" },
    });
    return {
      csrf: consentCsrf(browser.session, "mcp-connections"),
      connections: grants.map(grant => ({
        id: grant.id, name: grant.client.name, space: grant.space.spaceName || grant.space.name || "My space",
        canWrite: grant.scopes.includes("ensemble:write"), canUseApps: grant.scopes.includes("ensemble:apps"),
        createdAt: grant.createdAt.toISOString(), lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
      })),
    };
  }

  async disconnect(request: FastifyRequest, id: string, csrf: string): Promise<void> {
    const browser = browserSession(request);
    if (!hashMatches(csrf, secretHash(consentCsrf(browser.session, "mcp-connections")))) {
      throw Object.assign(new Error("Reload your app connections before disconnecting one."), { statusCode: 403 });
    }
    await this.db.$transaction(async tx => {
      const grant = await tx.mcpOAuthGrant.findFirst({ where: { id, accountId: browser.accountId, revokedAt: null }, include: { client: true } });
      if (!grant) throw Object.assign(new Error("That app connection is not available on your account."), { statusCode: 404 });
      await revokeMcpOAuthGrant(tx, grant.id, new Date());
      await appendLedgerInTransaction(tx, { userId: browser.accountId, actor: "me", action: "mcp.oauth.revoke", payload: { app: grant.client.name } });
    });
  }
}

export async function purgeMcpOAuth(db: PrismaClient, now = new Date()): Promise<void> {
  await db.mcpOAuthRequest.deleteMany({ where: { expiresAt: { lt: now } } });
  await db.mcpOAuthRefreshToken.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - MCP_REFRESH_MS) } } });
  await db.apiToken.deleteMany({ where: { oauthGrantId: { not: null }, expiresAt: { lt: new Date(now.getTime() - MCP_REFRESH_MS) } } });
  await db.mcpOAuthGrant.deleteMany({ where: { revokedAt: { lt: new Date(now.getTime() - MCP_REFRESH_MS) } } });
}
