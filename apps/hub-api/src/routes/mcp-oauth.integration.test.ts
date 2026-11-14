import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import { mcpOAuthRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

const originalEnv = { ...process.env };
process.env.NODE_ENV = "test";
process.env.HUB_WEB_ORIGIN = "http://hub.example.test";
process.env.HUB_API_PUBLIC_URL = "https://api.example.test";
process.env.ENSEMBLE_RATE_CLI_APPROVE_LIMIT = "0";

const metadata = new Map<string, Response>();
const covered = new Map<string, Set<RouteCheck>>();
let metadataCalls = 0;
const harness = await createHttpHarness({
  onResponse: (request, reply) => {
    const route = `${request.method} ${request.routeOptions.url}`;
    if (!mcpOAuthRouteCoverage[route]) return;
    if (reply.statusCode >= 200 && reply.statusCode < 400) track(route, "happy-path");
    else if (reply.statusCode >= 400 && reply.statusCode < 500) track(route, "invalid-input");
  },
  mcpOAuth: {
    metadataLookup: async hostname => hostname.startsWith("private.") ? ["127.0.0.1"] : ["8.8.8.8"],
    metadataFetch: async (url, init) => {
      metadataCalls++;
      const headers = new Headers(init?.headers);
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.has("cookie"), false);
      const response = metadata.get(String(url));
      assert.ok(response, `Unexpected client metadata request: ${String(url)}`);
      return response.clone();
    },
  },
});
const owner = await harness.asUser("mcp-oauth-owner@example.test");
const other = await harness.asUser("mcp-oauth-other@example.test");
const { secretHash, MCP_OAUTH_SCOPES } = await import("../mcp-oauth/protocol.js");
const resource = "https://api.example.test/mcp";
const callback = "https://client.example.test/oauth/callback";
const origin = process.env.HUB_WEB_ORIGIN;

after(async () => {
  try {
    for (const [route, checks] of Object.entries(mcpOAuthRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted MCP OAuth coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness.close();
    process.env = originalEnv;
  }
});

function track(route: string, check: RouteCheck): void {
  const checks = covered.get(route) ?? new Set<RouteCheck>();
  checks.add(check);
  covered.set(route, checks);
}

type Registered = { client_id: string; client_secret?: string; token_endpoint_auth_method: string };
type Pending = { client: Registered; request: string; verifier: string; callback: string };
type Tokens = { access_token: string; refresh_token: string; scope: string; expires_in: number };
type Consent = { csrf: string; spaces: Array<{ id: string; name: string }>; canWrite: boolean; canUseApps: boolean };

async function register(method = "none", redirects = [callback], refreshMode = "rotate"): Promise<Registered> {
  const reply = await harness.app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: "Example Agent", redirect_uris: redirects, token_endpoint_auth_method: method, ensemble_refresh_token_mode: refreshMode } });
  assert.equal(reply.statusCode, 201, reply.body);
  assert.equal(reply.headers["cache-control"], "no-store");
  return reply.json<Registered>();
}

async function begin(input?: Registered, scopes: readonly string[] = MCP_OAUTH_SCOPES, redirect = callback): Promise<Pending> {
  const client = input ?? await register();
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirect, response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    scope: scopes.join(" "), resource, state: "preserve-this-state",
  });
  const response = await harness.app.inject({ method: "GET", url: `/oauth/authorize?${query}` });
  assert.equal(response.statusCode, 302, response.body);
  const id = new URL(String(response.headers.location)).searchParams.get("request");
  assert.ok(id);
  return { client, request: id, verifier, callback: redirect };
}

async function consent(pending: Pending, user = owner): Promise<Consent> {
  const response = await user.inject({ method: "GET", url: `/api/mcp-oauth/consent?request=${encodeURIComponent(pending.request)}` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Consent>();
}

async function approve(pending: Pending, options: { user?: HttpUser; canWrite?: boolean; canUseApps?: boolean; spaceId?: string } = {}): Promise<string> {
  const user = options.user ?? owner;
  const info = await consent(pending, user);
  const response = await user.inject({
    method: "POST", url: "/api/mcp-oauth/consent", headers: { origin },
    payload: { request: pending.request, csrf: info.csrf, decision: "allow", canWrite: options.canWrite ?? true, canUseApps: options.canUseApps ?? true, spaceId: options.spaceId ?? user.id },
  });
  assert.equal(response.statusCode, 200, response.body);
  const redirect = new URL(response.json<{ redirect: string }>().redirect);
  assert.equal(redirect.searchParams.get("state"), "preserve-this-state");
  assert.equal(redirect.searchParams.get("iss"), "https://api.example.test");
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  return code;
}

function clientParameters(client: Registered): { params: Record<string, string>; headers: Record<string, string> } {
  if (client.token_endpoint_auth_method === "client_secret_basic") {
    return { params: {}, headers: { authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}` } };
  }
  return { params: { client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) }, headers: {} };
}

async function token(client: Registered, input: Record<string, string>, endpoint = "/oauth/token") {
  const auth = clientParameters(client);
  return harness.app.inject({
    method: "POST", url: endpoint, headers: { "content-type": "application/x-www-form-urlencoded", ...auth.headers },
    payload: new URLSearchParams({ ...auth.params, ...input }).toString(),
  });
}

async function connect(options: { client?: Registered; canWrite?: boolean; canUseApps?: boolean; spaceId?: string; user?: HttpUser } = {}): Promise<{ pending: Pending; tokens: Tokens }> {
  const pending = await begin(options.client);
  const code = await approve(pending, options);
  const response = await token(pending.client, { grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: pending.callback, resource });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  return { pending, tokens: response.json<Tokens>() };
}

const bearer = (access: string) => ({ authorization: `Bearer ${access}` });

test("OpenAI domain verification returns only the configured plaintext proof without inheriting credentials", async () => {
  const { env } = await import("../config.js");
  const original = env.OPENAI_APPS_CHALLENGE;
  try {
    env.OPENAI_APPS_CHALLENGE = undefined;
    const absent = await harness.app.inject({ method: "GET", url: "/.well-known/openai-apps-challenge" });
    assert.equal(absent.statusCode, 404);
    env.OPENAI_APPS_CHALLENGE = "openai-domain-proof-for-test";
    const reply = await harness.app.inject({
      method: "GET", url: "/.well-known/openai-apps-challenge",
      headers: { authorization: "Bearer not-a-valid-key", "x-ensemble-space": other.id },
    });
    assert.equal(reply.statusCode, 200);
    assert.equal(reply.body, env.OPENAI_APPS_CHALLENGE);
    assert.equal(reply.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(reply.headers["cache-control"], "no-store");
  } finally {
    env.OPENAI_APPS_CHALLENGE = original;
  }
});

test("discovery is public and advertises the resource, PKCE, CIMD and DCR without inheriting a key", async () => {
  const legacy = await harness.asToken(owner, "bridge");
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const reply = await harness.app.inject({ method: "GET", url: path, headers: { ...bearer(legacy.token), "x-ensemble-space": other.id } });
    assert.equal(reply.statusCode, 200, reply.body);
    assert.equal(reply.json<{ resource: string }>().resource, resource);
  }
  const issuer = await harness.app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
  assert.equal(issuer.statusCode, 200);
  assert.deepEqual(issuer.json().code_challenge_methods_supported, ["S256"]);
  assert.equal(issuer.json().client_id_metadata_document_supported, true);
  assert.equal(issuer.json().registration_endpoint, "https://api.example.test/oauth/register");
  assert.equal(issuer.json().grant_types_supported.includes("client_credentials"), false);
});

test("consent requires the signed-in browser, matching origin and CSRF, and is bound to the first account", async () => {
  const pending = await begin();
  const legacy = await harness.asToken(owner, "full");
  const unsigned = await harness.app.inject({ method: "GET", url: `/api/mcp-oauth/consent?request=${pending.request}` });
  assert.equal(unsigned.statusCode, 401);
  const withKey = await legacy.inject({ method: "GET", url: `/api/mcp-oauth/consent?request=${pending.request}` });
  assert.equal(withKey.statusCode, 403);
  const info = await consent(pending);
  assert.equal((await consent(pending)).csrf, info.csrf);
  assert.equal((await other.inject({ method: "GET", url: `/api/mcp-oauth/consent?request=${pending.request}` })).statusCode, 404);
  track("GET /api/mcp-oauth/consent", "isolation");
  const payload = { request: pending.request, csrf: info.csrf, decision: "allow", spaceId: owner.id };
  assert.equal((await owner.inject({ method: "POST", url: "/api/mcp-oauth/consent", payload })).statusCode, 403);
  assert.equal((await owner.inject({ method: "POST", url: "/api/mcp-oauth/consent", headers: { origin: "https://evil.example.test" }, payload })).statusCode, 403);
  assert.equal((await owner.inject({ method: "POST", url: "/api/mcp-oauth/consent", headers: { origin }, payload: { ...payload, csrf: randomBytes(32).toString("hex") } })).statusCode, 403);
  const code = await approve(pending, { canWrite: false, canUseApps: false });
  assert.ok(code);
  assert.equal((await owner.inject({ method: "POST", url: "/api/mcp-oauth/consent", headers: { origin }, payload })).statusCode, 400);
});

test("denying returns the original state and issuer without creating credentials", async () => {
  const pending = await begin();
  const info = await consent(pending);
  const response = await owner.inject({
    method: "POST", url: "/api/mcp-oauth/consent", headers: { origin },
    payload: { request: pending.request, csrf: info.csrf, decision: "deny" },
  });
  assert.equal(response.statusCode, 200);
  const redirect = new URL(response.json().redirect);
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(redirect.searchParams.get("state"), "preserve-this-state");
  assert.equal(redirect.searchParams.has("code"), false);
  assert.equal(await harness.prisma.mcpOAuthGrant.count({ where: { clientId: pending.client.client_id } }), 0);
});

test("authorization never redirects to an unregistered URI and reports errors to a validated callback", async () => {
  const client = await register();
  const base = { client_id: client.client_id, redirect_uri: callback, response_type: "token", state: "safe-state" };
  const wrong = await harness.app.inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: "https://evil.example.test/callback" })}` });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.headers.location, undefined);
  const known = await harness.app.inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams(base)}` });
  assert.equal(known.statusCode, 302);
  const redirect = new URL(String(known.headers.location));
  assert.equal(redirect.origin, new URL(callback).origin);
  assert.equal(redirect.searchParams.get("error"), "unsupported_response_type");
  assert.equal(redirect.searchParams.get("state"), "safe-state");
});

test("PKCE, client, redirect and resource are checked before a single-use code is consumed", async () => {
  const pending = await begin();
  const code = await approve(pending);
  const body = { grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: callback, resource };
  for (const [client, change] of [
    [pending.client, { code_verifier: randomBytes(32).toString("base64url") }],
    [pending.client, { redirect_uri: "https://evil.example.test/callback" }],
    [pending.client, { resource: "https://other.example.test/mcp" }],
    [await register(), {}],
  ] as Array<[Registered, Record<string, string>]>) {
    assert.equal((await token(client, { ...body, ...change })).statusCode, 400);
  }
  const replies = await Promise.all([token(pending.client, body), token(pending.client, body)]);
  assert.deepEqual(replies.map(reply => reply.statusCode).sort(), [200, 400]);
  assert.equal(await harness.prisma.mcpOAuthGrant.count({ where: { clientId: pending.client.client_id } }), 1);
});

test("read-only consent stays read-only, isolates accounts, and stores no plaintext credentials", async () => {
  const { tokens } = await connect({ canWrite: false, canUseApps: false });
  await harness.prisma.task.create({ data: { userId: owner.id, title: "OAuth owner task", status: "todo" } });
  await harness.prisma.task.create({ data: { userId: other.id, title: "OAuth other task", status: "todo" } });
  const read = await harness.app.inject({ method: "GET", url: "/api/bridge/tasks", headers: bearer(tokens.access_token) });
  assert.equal(read.statusCode, 200, read.body);
  assert.match(read.body, /OAuth owner task/);
  assert.doesNotMatch(read.body, /OAuth other task/);
  assert.equal((await harness.app.inject({ method: "POST", url: "/api/bridge/write/tasks", headers: bearer(tokens.access_token), payload: { title: "Not allowed" } })).statusCode, 403);
  assert.equal((await harness.app.inject({ method: "POST", url: "/api/connect/token", headers: bearer(tokens.access_token), payload: {} })).statusCode, 403);
  const apps = await harness.app.inject({ method: "GET", url: "/api/bridge/apps", headers: bearer(tokens.access_token) });
  assert.equal(apps.json().allowed, false);
  const row = await harness.prisma.apiToken.findUniqueOrThrow({ where: { tokenHash: secretHash(tokens.access_token) } });
  assert.ok(row.expiresAt);
  assert.ok(row.oauthGrantId);
  assert.equal(JSON.stringify(row).includes(tokens.access_token), false);
  assert.equal(JSON.stringify(await harness.prisma.mcpOAuthRefreshToken.findMany({ where: { grantId: row.oauthGrantId } })).includes(tokens.refresh_token), false);
});

test("an OAuth connection selects an owned default space, reaches other owned spaces and refuses shared or foreign ones", async () => {
  const own = await harness.prisma.user.create({ data: { ownerId: owner.id, email: `oauth-space-${randomBytes(6).toString("hex")}@spaces.ensemble.invalid`, spaceName: "Owned OAuth space" } });
  const shared = await harness.prisma.user.create({ data: { ownerId: other.id, email: `oauth-shared-${randomBytes(6).toString("hex")}@spaces.ensemble.invalid`, spaceName: "Shared OAuth space" } });
  await harness.prisma.spaceMember.create({ data: { spaceId: shared.id, accountId: owner.id, role: "editor", addedBy: other.id } });
  const { tokens } = await connect({ spaceId: own.id });
  const profile = await harness.app.inject({ method: "GET", url: "/api/bridge/whoami", headers: bearer(tokens.access_token) });
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().defaultSpace.id, own.id);
  const atHome = await harness.app.inject({ method: "GET", url: "/api/bridge/tasks", headers: { ...bearer(tokens.access_token), "x-ensemble-space": owner.id } });
  assert.equal(atHome.statusCode, 200);
  assert.equal((await harness.app.inject({ method: "GET", url: "/api/bridge/tasks", headers: { ...bearer(tokens.access_token), "x-ensemble-space": shared.id } })).statusCode, 403);
  assert.equal((await harness.app.inject({ method: "GET", url: "/api/bridge/tasks", headers: { ...bearer(tokens.access_token), "x-ensemble-space": other.id } })).statusCode, 404);
  await harness.prisma.user.update({ where: { id: own.id }, data: { ownerId: other.id } });
  assert.equal((await harness.app.inject({ method: "GET", url: "/api/bridge/tasks", headers: bearer(tokens.access_token) })).statusCode, 401);
});

test("consent cannot add unrequested grants or use a foreign space", async () => {
  const pending = await begin(await register(), ["ensemble:read"]);
  const info = await consent(pending);
  for (const extra of [{ canWrite: true, spaceId: owner.id }, { canUseApps: true, spaceId: owner.id }, { spaceId: other.id }]) {
    const response = await owner.inject({ method: "POST", url: "/api/mcp-oauth/consent", headers: { origin }, payload: { request: pending.request, csrf: info.csrf, decision: "allow", ...extra } });
    assert.ok(response.statusCode === 400 || response.statusCode === 403, response.body);
  }
});

test("refresh rotates credentials, preserves narrowing and revokes the entire family on replay", async () => {
  const { pending, tokens } = await connect();
  const narrowed = await token(pending.client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource, scope: "ensemble:read offline_access" });
  assert.equal(narrowed.statusCode, 200, narrowed.body);
  const next = narrowed.json<Tokens>();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.equal(next.scope, "ensemble:read offline_access");
  const widening = await token(pending.client, { grant_type: "refresh_token", refresh_token: next.refresh_token, resource, scope: MCP_OAUTH_SCOPES.join(" ") });
  assert.equal(widening.statusCode, 400);
  const again = await token(pending.client, { grant_type: "refresh_token", refresh_token: next.refresh_token, resource });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json<Tokens>().scope, next.scope);
  const replay = await token(pending.client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource });
  assert.equal(replay.statusCode, 400);
  for (const access of [tokens.access_token, next.access_token, again.json<Tokens>().access_token]) {
    assert.equal((await harness.app.inject({ method: "GET", url: "/api/bridge/tasks", headers: bearer(access) })).statusCode, 401);
  }
});

test("simultaneous refresh cannot leave live credentials after replay is detected", async () => {
  const { pending, tokens } = await connect();
  const replies = await Promise.all([
    token(pending.client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource }),
    token(pending.client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource }),
  ]);
  assert.deepEqual(replies.map(reply => reply.statusCode).sort(), [200, 400]);
  const issued = replies.find(reply => reply.statusCode === 200)!.json<Tokens>();
  assert.equal((await harness.app.inject({ method: "GET", url: "/api/bridge/tasks", headers: bearer(issued.access_token) })).statusCode, 401);
});

test("foreign clients cannot refresh or revoke another app's connection", async () => {
  const { pending, tokens } = await connect();
  const foreign = await register();
  assert.equal((await token(foreign, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource })).statusCode, 400);
  assert.equal((await token(foreign, { token: tokens.access_token }, "/oauth/revoke")).statusCode, 200);
  assert.equal((await harness.app.inject({ method: "GET", url: "/api/bridge/tasks", headers: bearer(tokens.access_token) })).statusCode, 200);
  track("POST /oauth/revoke", "isolation");
  assert.equal((await token(pending.client, { token: tokens.refresh_token }, "/oauth/revoke")).statusCode, 200);
  assert.equal((await harness.app.inject({ method: "GET", url: "/api/bridge/tasks", headers: bearer(tokens.access_token) })).statusCode, 401);
});

test("signed-in connection management is private and disconnect invalidates access and refresh tokens", async () => {
  const { pending, tokens } = await connect();
  const listed = await owner.inject({ method: "GET", url: "/api/mcp-oauth/connections" });
  assert.equal(listed.statusCode, 200);
  const connections = listed.json<{ csrf: string; connections: Array<{ id: string; name: string }> }>();
  const row = await harness.prisma.apiToken.findUniqueOrThrow({ where: { tokenHash: secretHash(tokens.access_token) } });
  assert.ok(row.oauthGrantId);
  const path = `/api/mcp-oauth/connections/${row.oauthGrantId}`;
  const foreign = (await other.inject({ method: "GET", url: "/api/mcp-oauth/connections" })).json();
  assert.equal(foreign.connections.some((connection: { id: string }) => connection.id === row.oauthGrantId), false);
  track("GET /api/mcp-oauth/connections", "isolation");
  assert.equal((await other.inject({ method: "DELETE", url: path, headers: { origin }, payload: { csrf: foreign.csrf } })).statusCode, 404);
  track("DELETE /api/mcp-oauth/connections/:id", "isolation");
  const removed = await owner.inject({ method: "DELETE", url: path, headers: { origin }, payload: { csrf: connections.csrf } });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal((await harness.app.inject({ method: "GET", url: "/api/bridge/tasks", headers: bearer(tokens.access_token) })).statusCode, 401);
  assert.equal((await token(pending.client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource })).statusCode, 400);
});

test("confidential DCR clients use their declared method, with hashed secrets and PKCE", async () => {
  for (const method of ["client_secret_basic", "client_secret_post"]) {
    const client = await register(method);
    assert.ok(client.client_secret);
    const stored = await harness.prisma.mcpOAuthClient.findUniqueOrThrow({ where: { id: client.client_id } });
    assert.notEqual(stored.secretHash, client.client_secret);
    const pending = await begin(client);
    const code = await approve(pending);
    const body = { grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: callback, resource };
    assert.equal((await token({ ...client, client_secret: "wrong-client-secret" }, body)).statusCode, 401);
    assert.equal((await token(client, body)).statusCode, 200);
  }
});

test("CIMD validates the document identity, safely fetches without credentials and supports the public-client method intersection", async () => {
  const id = "https://agent.example.test/client.json";
  metadata.set(id, Response.json({
    client_id: id, client_name: "Metadata Agent", redirect_uris: [callback],
    token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    ensemble_refresh_token_mode: "persistent",
  }, { headers: { "cache-control": "max-age=300" } }));
  const client: Registered = { client_id: id, token_endpoint_auth_method: "none" };
  const before = metadataCalls;
  const connected = await connect({ client });
  assert.ok(connected.tokens.access_token);
  const refreshed = await token(client, { grant_type: "refresh_token", refresh_token: connected.tokens.refresh_token, resource });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.notEqual(refreshed.json<Tokens>().refresh_token, connected.tokens.refresh_token);
  await begin(client);
  assert.equal(metadataCalls - before, 1);
  for (const [url, document] of [
    ["https://bad-id.example.test/client.json", { client_id: "https://different.example.test/client.json", client_name: "Bad", redirect_uris: [callback] }],
    ["https://bad-method.example.test/client.json", { client_id: "https://bad-method.example.test/client.json", client_name: "Bad", redirect_uris: [callback], token_endpoint_auth_method: "private_key_jwt" }],
  ] as const) {
    metadata.set(url, Response.json(document));
    const query = new URLSearchParams({ client_id: url, redirect_uri: callback, response_type: "code", code_challenge: randomBytes(32).toString("base64url"), code_challenge_method: "S256" });
    assert.equal((await harness.app.inject({ method: "GET", url: `/oauth/authorize?${query}` })).statusCode, 401);
  }
});

test("CIMD refuses private addresses, redirects and oversized metadata", { timeout: 10_000 }, async () => {
  const before = metadataCalls;
  for (const id of ["https://127.0.0.1/client.json", "https://private.example.test/client.json"]) {
    const query = new URLSearchParams({ client_id: id, redirect_uri: callback, response_type: "code", code_challenge: randomBytes(32).toString("base64url"), code_challenge_method: "S256" });
    assert.equal((await harness.app.inject({ method: "GET", url: `/oauth/authorize?${query}` })).statusCode, 401);
  }
  assert.equal(metadataCalls, before);
  for (const [id, response] of [
    ["https://redirect.example.test/client.json", new Response(null, { status: 302, headers: { location: "https://private.example.test/client.json" } })],
    ["https://large.example.test/client.json", Response.json({ data: "x".repeat(33 * 1024) })],
  ] as const) {
    metadata.set(id, response);
    const query = new URLSearchParams({ client_id: id, redirect_uri: callback, response_type: "code", code_challenge: randomBytes(32).toString("base64url"), code_challenge_method: "S256" });
    assert.equal((await harness.app.inject({ method: "GET", url: `/oauth/authorize?${query}` })).statusCode, 400);
  }
});

test("loopback callback matching varies only the port, and expired access still leaves legacy keys working", async () => {
  const loopback = "http://127.0.0.1:54321/callback";
  const client = await register("none", ["http://127.0.0.1/callback"]);
  const pending = await begin(client, MCP_OAUTH_SCOPES, loopback);
  const code = await approve(pending);
  const response = await token(client, { grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: loopback, resource });
  assert.equal(response.statusCode, 200, response.body);
  const tokens = response.json<Tokens>();
  await harness.prisma.apiToken.update({ where: { tokenHash: secretHash(tokens.access_token) }, data: { expiresAt: new Date(0) } });
  assert.equal((await harness.app.inject({ method: "POST", url: "/mcp", headers: bearer(tokens.access_token), payload: {} })).statusCode, 401);
  const legacy = await harness.asToken(owner, "bridge");
  assert.equal((await legacy.inject({ method: "GET", url: "/api/bridge/tasks" })).statusCode, 200);
  const invalid = await register("none", ["http://127.0.0.1/other"]);
  const bad = await harness.app.inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams({ client_id: invalid.client_id, redirect_uri: loopback, response_type: "code", code_challenge: randomBytes(32).toString("base64url"), code_challenge_method: "S256" })}` });
  assert.equal(bad.statusCode, 400);
});

test("duplicate form parameters and machine-to-machine grants are explicitly rejected", async () => {
  const client = await register();
  const duplicate = await harness.app.inject({ method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `client_id=${client.client_id}&client_id=other&grant_type=authorization_code` });
  assert.equal(duplicate.statusCode, 400);
  assert.equal((await token(client, { grant_type: "client_credentials" })).statusCode, 400);
});

test("the MCP SDK discovers, registers, consents, exchanges PKCE and uses the named tool catalog end to end", async () => {
  const routedFetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, "https://api.example.test");
    if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE" && request.method !== "HEAD") throw new Error("Unexpected SDK method.");
    const body = await request.text();
    const reply = await harness.app.inject({
      method: request.method, url: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers),
      ...(body ? { payload: body } : {}),
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(reply.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, String(value));
    }
    return new Response(reply.statusCode === 204 ? null : reply.body, { status: reply.statusCode, headers });
  };
  let information: OAuthClientInformationMixed | undefined;
  let saved: OAuthTokens | undefined;
  let verifier = "";
  let code = "";
  const provider: OAuthClientProvider = {
    redirectUrl: callback,
    clientMetadata: { client_name: "SDK Agent", redirect_uris: [callback], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: MCP_OAUTH_SCOPES.join(" ") },
    state: () => "preserve-this-state",
    clientInformation: () => information,
    saveClientInformation: value => { information = value; },
    tokens: () => saved,
    saveTokens: value => { saved = value; },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => verifier,
    redirectToAuthorization: async url => {
      const reply = await routedFetch(url);
      assert.equal(reply.status, 302);
      const id = new URL(reply.headers.get("location")!).searchParams.get("request");
      assert.ok(id && information);
      code = await approve({
        request: id, verifier, callback,
        client: { client_id: information.client_id, token_endpoint_auth_method: provider.clientMetadata.token_endpoint_auth_method ?? "none" },
      }, { canWrite: false, canUseApps: false });
    },
  };
  assert.equal(await auth(provider, { serverUrl: resource, fetchFn: routedFetch }), "REDIRECT");
  assert.ok(code && verifier);
  assert.equal(await auth(provider, { serverUrl: resource, authorizationCode: code, fetchFn: routedFetch }), "AUTHORIZED");
  assert.ok(saved);
  const client = new Client({ name: "sdk-oauth-roundtrip", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider, fetch: routedFetch }));
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.some(tool => tool.name === "ensemble_act"), false);
    assert.ok(tools.some(tool => tool.name === "ensemble_action_list_tasks"));
    const answer = await client.callTool({ name: "ensemble_action_list_tasks", arguments: {} });
    assert.notEqual(answer.isError, true, JSON.stringify(answer));
    assert.doesNotMatch(JSON.stringify(answer), /OAuth other task/);
  } finally {
    await client.close();
  }
});

test("OAuth access keys stay out of manual key lists and self-logout revokes their refresh family", async () => {
  const { pending, tokens } = await connect();
  const key = await harness.prisma.apiToken.findUniqueOrThrow({ where: { tokenHash: secretHash(tokens.access_token) } });
  for (const path of ["/api/tokens", "/api/connect/bridge"]) {
    const response = await owner.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ tokens: Array<{ id: string }> }>().tokens.some(row => row.id === key.id), false);
  }
  const logout = await harness.app.inject({ method: "POST", url: "/api/cli/logout", headers: bearer(tokens.access_token) });
  assert.equal(logout.statusCode, 204);
  assert.equal((await token(pending.client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource })).statusCode, 400);
});

test("persistent linking is confidential-only, keeps the refresh credential stable and never restores narrowed permissions", async () => {
  const publicAttempt = await harness.app.inject({
    method: "POST", url: "/oauth/register",
    payload: { client_name: "Public Agent", redirect_uris: [callback], token_endpoint_auth_method: "none", ensemble_refresh_token_mode: "persistent" },
  });
  assert.equal(publicAttempt.statusCode, 400);
  const client = await register("client_secret_post", [callback], "persistent");
  const { tokens } = await connect({ client });
  const narrow = await token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource, scope: "ensemble:read offline_access" });
  assert.equal(narrow.statusCode, 200, narrow.body);
  assert.equal(narrow.json<Tokens>().refresh_token, tokens.refresh_token);
  const again = await token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json<Tokens>().refresh_token, tokens.refresh_token);
  assert.equal(again.json<Tokens>().scope, "ensemble:read offline_access");
  const widen = await token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource, scope: MCP_OAUTH_SCOPES.join(" ") });
  assert.equal(widen.statusCode, 400);
  const withoutSecret = await harness.app.inject({
    method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ client_id: client.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token }).toString(),
  });
  assert.equal(withoutSecret.statusCode, 401);
  await token(client, { token: tokens.refresh_token }, "/oauth/revoke");
  assert.equal((await token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).statusCode, 400);
  assert.equal((await harness.app.inject({ method: "GET", url: "/api/bridge/tasks", headers: bearer(tokens.access_token) })).statusCode, 401);
});

test("persistent refresh serializes narrowing, extends valid linking and cannot revive an expired or consumed credential", async () => {
  const client = await register("client_secret_basic", [callback], "persistent");
  const { tokens } = await connect({ client });
  await harness.prisma.mcpOAuthRefreshToken.update({
    where: { tokenHash: secretHash(tokens.refresh_token) }, data: { expiresAt: new Date(Date.now() + 60_000) },
  });
  const replies = await Promise.all([
    token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, scope: "ensemble:read offline_access" }),
    token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
  ]);
  for (const reply of replies) {
    assert.equal(reply.statusCode, 200, reply.body);
    assert.equal(reply.json<Tokens>().refresh_token, tokens.refresh_token);
  }
  const again = await token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json<Tokens>().scope, "ensemble:read offline_access");
  const stored = await harness.prisma.mcpOAuthRefreshToken.findUniqueOrThrow({ where: { tokenHash: secretHash(tokens.refresh_token) } });
  assert.ok(stored.expiresAt.getTime() > Date.now() + 29 * 86_400_000);
  const stop = await token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, scope: "ensemble:read" });
  assert.equal(stop.statusCode, 200, stop.body);
  assert.equal(stop.json<{ refresh_token?: string }>().refresh_token, undefined);
  assert.equal((await token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).statusCode, 400);

  const expired = await connect({ client });
  await harness.prisma.mcpOAuthRefreshToken.update({
    where: { tokenHash: secretHash(expired.tokens.refresh_token) }, data: { expiresAt: new Date(0) },
  });
  assert.equal((await token(client, { grant_type: "refresh_token", refresh_token: expired.tokens.refresh_token })).statusCode, 400);
});
