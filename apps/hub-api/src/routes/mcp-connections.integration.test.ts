import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { mcpConnectionRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

const originalEnv = { ...process.env };
process.env.NODE_ENV = "test";
process.env.HUB_WEB_ORIGIN = "http://hub.example.test";
process.env.HUB_API_PUBLIC_URL = "http://localhost:4000";
process.env.ENSEMBLE_SECRET_KEY ??= Buffer.alloc(32, 11).toString("base64");

/* ------------------------------------------------------------------ */
/* A fictional vendor: Fieldnote Docs, with OAuth, a PAT server and an  */
/* open server, all on one in-process HTTP server.                     */
/* ------------------------------------------------------------------ */

const mock = {
  registrations: [] as Array<Record<string, unknown>>,
  codes: new Map<string, { challenge: string; resource: string | null; clientId: string; redirectUri: string }>(),
  access: new Set<string>(),
  refresh: new Set<string>(),
  tokenRequests: [] as Array<Record<string, string>>,
  revoked: [] as string[],
  calls: [] as Array<{ path: string; name: string; args: unknown }>,
  counter: 0,
};

const OAUTH_PATHS: Record<string, string> = { "/mcp": "", "/mcp2": "", "/cimd/mcp": "/cimd-as", "/nopkce/mcp": "/nopkce-as" };
const PAT = "pat-fieldnote-123";

function tools(page: 1 | 2) {
  return page === 1
    ? [
        { name: "search", title: "Search docs", description: "Find Fieldnote docs.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } },
        { name: "create page", description: "Create a doc.", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
      ]
    : [{ name: "delete_page", description: "Delete a doc.", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { destructiveHint: true } }];
}

function mcpServer(path: string): Server {
  const server = new Server({ name: "fieldnote-docs", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    request.params?.cursor === "page-2" ? { tools: tools(2) } : { tools: tools(1), nextCursor: "page-2" },
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    mock.calls.push({ path, name: request.params.name, args: request.params.arguments });
    if (request.params.name === "search") {
      return { content: [{ type: "text", text: `Found: Launch plan for ${String(request.params.arguments?.query)}` }], structuredContent: { hits: 1 } };
    }
    return { content: [{ type: "text", text: "No such doc." }], isError: true };
  });
  return server;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function issue(): { access_token: string; refresh_token: string; token_type: string; expires_in: number } {
  mock.counter += 1;
  const tokens = { access_token: `at-${mock.counter}`, refresh_token: `rt-${mock.counter}`, token_type: "Bearer", expires_in: 3600 };
  mock.access.add(tokens.access_token);
  mock.refresh.add(tokens.refresh_token);
  return tokens;
}

const vendor = createServer(async (request, response) => {
  const origin = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}`;
  const url = new URL(request.url ?? "/", origin);
  const path = url.pathname;
  try {
    if (request.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
      const resourcePath = path.slice("/.well-known/oauth-protected-resource".length);
      if (!(resourcePath in OAUTH_PATHS)) return json(response, 404, {});
      return json(response, 200, { resource: `${origin}${resourcePath}`, authorization_servers: [`${origin}${OAUTH_PATHS[resourcePath]}`], scopes_supported: ["docs:read", "docs:write"] });
    }
    if (request.method === "GET" && path.startsWith("/.well-known/oauth-authorization-server")) {
      const asPath = path.slice("/.well-known/oauth-authorization-server".length);
      if (!["", "/cimd-as", "/nopkce-as"].includes(asPath)) return json(response, 404, {});
      return json(response, 200, {
        issuer: `${origin}${asPath}`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        revocation_endpoint: `${origin}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        ...(asPath === "/nopkce-as" ? {} : { code_challenge_methods_supported: ["S256"] }),
        ...(asPath === "/cimd-as" ? { client_id_metadata_document_supported: true } : {}),
      });
    }
    if (request.method === "POST" && path === "/register") {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      mock.registrations.push(body);
      return json(response, 201, { ...body, client_id: `client-${mock.registrations.length}` });
    }
    if (request.method === "POST" && path === "/token") {
      const form = Object.fromEntries(new URLSearchParams(await readBody(request)));
      mock.tokenRequests.push(form);
      if (form.grant_type === "authorization_code") {
        const grant = mock.codes.get(form.code ?? "");
        const challenge = createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
        if (!grant || grant.challenge !== challenge || grant.resource !== form.resource || grant.clientId !== form.client_id || grant.redirectUri !== form.redirect_uri) {
          return json(response, 400, { error: "invalid_grant", error_description: "Code, verifier, resource or client did not match." });
        }
        mock.codes.delete(form.code!);
        return json(response, 200, issue());
      }
      if (form.grant_type === "refresh_token" && mock.refresh.has(form.refresh_token ?? "") && form.resource?.startsWith(origin)) {
        mock.refresh.delete(form.refresh_token!);
        return json(response, 200, issue());
      }
      return json(response, 400, { error: "invalid_grant" });
    }
    if (request.method === "POST" && path === "/revoke") {
      mock.revoked.push(new URLSearchParams(await readBody(request)).get("token") ?? "");
      response.writeHead(200).end();
      return;
    }
    const known = path in OAUTH_PATHS || path === "/pat/mcp" || path === "/open/mcp";
    if (!known) return json(response, 404, { error: "not found" });
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const bearer = request.headers.authorization?.replace(/^Bearer /, "");
    if (path in OAUTH_PATHS && !(bearer && mock.access.has(bearer))) {
      return json(response, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${path}"` });
    }
    if (path === "/pat/mcp" && bearer !== PAT) return json(response, 401, { error: "invalid_token" }, { "www-authenticate": "Bearer" });
    const body = JSON.parse(await readBody(request)) as unknown;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = mcpServer(path);
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    if (!response.headersSent) json(response, 500, { error: String(error) });
  }
});
await new Promise<void>((resolve) => vendor.listen(0, "127.0.0.1", resolve));
const VENDOR = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}`;

/* ------------------------------------------------------------------ */

const harness: HttpHarness = await createHttpHarness();
const owner = await harness.asUser("mira.chen@fieldnote.example");
const other = await harness.asUser("rafael@fieldnote.example");
const { mcpToolsForUser, resolveMcpTool } = await import("../assistant/mcp-tools.js");
const { callMcpTool, setMcpDepsForTests } = await import("../connectors/mcp/manager.js");
const { readTokens } = await import("../connectors/mcp/store.js");
const covered = new Map<string, Set<RouteCheck>>();

after(async () => {
  try {
    for (const [route, checks] of Object.entries(mcpConnectionRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted MCP connection coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness.close();
    await new Promise<void>((resolve) => vendor.close(() => resolve()));
    process.env = originalEnv;
  }
});

function track(route: string, check: RouteCheck): void {
  const checks = covered.get(route) ?? new Set<RouteCheck>();
  checks.add(check);
  covered.set(route, checks);
}

async function connectOAuth(user: HttpUser, path: string, name: string) {
  const started = await user.inject({ method: "POST", url: "/api/mcp-connections", payload: { url: `${VENDOR}${path}`, name, returnTo: "/settings?tab=connections#mcp" } });
  assert.equal(started.statusCode, 200, started.body);
  const body = started.json() as { id: string; status: string; authorizeUrl?: string };
  assert.equal(body.status, "pending");
  assert.ok(body.authorizeUrl);
  return { id: body.id, authorizeUrl: new URL(body.authorizeUrl) };
}

function approve(authorizeUrl: URL, code: string): void {
  mock.codes.set(code, {
    challenge: authorizeUrl.searchParams.get("code_challenge")!,
    resource: authorizeUrl.searchParams.get("resource"),
    clientId: authorizeUrl.searchParams.get("client_id")!,
    redirectUri: authorizeUrl.searchParams.get("redirect_uri")!,
  });
}

let oauthId = "";

test("OAuth: discovery, dynamic registration, PKCE S256 and resource on the authorize URL", async () => {
  const registrationsBefore = mock.registrations.length;
  const { id, authorizeUrl } = await connectOAuth(owner, "/mcp", "Fieldnote Docs");
  oauthId = id;
  assert.equal(`${authorizeUrl.origin}${authorizeUrl.pathname}`, `${VENDOR}/authorize`);
  assert.equal(authorizeUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorizeUrl.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authorizeUrl.searchParams.get("resource"), `${VENDOR}/mcp`);
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "http://localhost:4000/api/mcp-connections/callback");
  assert.equal(authorizeUrl.searchParams.get("scope"), "docs:read docs:write");
  assert.ok((authorizeUrl.searchParams.get("state") ?? "").length >= 40);
  assert.equal(mock.registrations.length, registrationsBefore + 1);
  const registration = mock.registrations.at(-1)!;
  assert.deepEqual(registration.redirect_uris, ["http://localhost:4000/api/mcp-connections/callback"]);
  assert.deepEqual(registration.grant_types, ["authorization_code", "refresh_token"]);
  assert.equal(registration.token_endpoint_auth_method, "none");
  assert.equal(registration.client_name, "Ensemble");
  assert.equal(authorizeUrl.searchParams.get("client_id"), `client-${mock.registrations.length}`);

  const row = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, "pending");
  assert.equal(row.oauthState, authorizeUrl.searchParams.get("state"));
  assert.ok(row.codeVerifier?.startsWith("v1:"));
  assert.ok(row.clientInfo?.startsWith("v1:"));
  assert.ok(row.stateExpiresAt && row.stateExpiresAt.getTime() > Date.now() + 9 * 60_000);
  track("POST /api/mcp-connections", "happy-path");
});

test("OAuth callback exchanges the code with the verifier and resource, caches every page of tools, and redirects", async () => {
  const pending = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: oauthId } });
  const started = await connectOAuth(owner, "/mcp", "Fieldnote Docs");
  assert.equal(started.id, pending.id, "reconnecting the same URL reuses the row");
  assert.equal(mock.registrations.at(-1)!.client_name, "Ensemble");
  const registrations = mock.registrations.length;
  approve(started.authorizeUrl, "code-1");
  const state = started.authorizeUrl.searchParams.get("state")!;

  const back = await harness.app.inject({ method: "GET", url: `/api/mcp-connections/callback?code=code-1&state=${encodeURIComponent(state)}` });
  assert.equal(back.statusCode, 302, back.body);
  const location = new URL(back.headers.location as string);
  assert.equal(location.origin, "http://hub.example.test");
  assert.equal(location.pathname, "/settings");
  assert.equal(location.searchParams.get("tab"), "connections");
  assert.equal(location.searchParams.get("mcp"), "connected");
  assert.equal(location.hash, "#mcp");
  assert.equal(mock.registrations.length, registrations, "the registered client is reused");
  const exchange = mock.tokenRequests.at(-1)!;
  assert.equal(exchange.grant_type, "authorization_code");
  assert.equal(exchange.resource, `${VENDOR}/mcp`);

  const row = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: oauthId } });
  assert.equal(row.status, "connected");
  assert.equal(row.oauthState, null);
  assert.equal(row.codeVerifier, null);
  assert.ok(row.tokens?.startsWith("v1:"));
  assert.doesNotMatch(row.tokens ?? "", /at-|rt-/);
  assert.ok(row.expiresAt);

  const list = await owner.inject({ method: "GET", url: "/api/mcp-connections" });
  assert.equal(list.statusCode, 200);
  const connection = (list.json().connections as Array<Record<string, unknown>>).find((item) => item.id === oauthId)!;
  assert.equal(connection.status, "connected");
  assert.equal(connection.toolCount, 3);
  assert.equal(connection.auth, "oauth");
  assert.deepEqual(
    (connection.tools as Array<{ name: string; readOnly: boolean }>).map((tool) => [tool.name, tool.readOnly]),
    [["search", true], ["create page", false], ["delete_page", false]],
  );
  assert.equal(JSON.stringify(connection).includes("at-"), false);
  track("GET /api/mcp-connections/callback", "happy-path");
  track("GET /api/mcp-connections", "happy-path");

  const replay = await harness.app.inject({ method: "GET", url: `/api/mcp-connections/callback?code=code-1&state=${encodeURIComponent(state)}` });
  assert.equal(replay.statusCode, 302);
  assert.equal(new URL(replay.headers.location as string).searchParams.get("mcp"), "error");
  track("GET /api/mcp-connections/callback", "invalid-input");
});

test("assistant tools: names, read/write classification, preview and a real call", async () => {
  const tools = await mcpToolsForUser(harness.prisma, owner.id);
  const names = tools.map((tool) => tool.name);
  assert.equal(names.length, 3);
  for (const name of names) assert.match(name, /^mcp_fieldnote_do_[0-9a-f]{4}_[a-zA-Z0-9_-]+$/);
  assert.ok(names.every((name) => name.length <= 64));
  const search = tools.find((tool) => tool.mcp.toolName === "search")!;
  const create = tools.find((tool) => tool.mcp.toolName === "create page")!;
  const remove = tools.find((tool) => tool.mcp.toolName === "delete_page")!;
  assert.deepEqual([search.isWrite, create.isWrite, remove.isWrite], [false, true, true]);
  assert.deepEqual([search.risk, create.risk, remove.risk], ["low", "medium", "high"]);
  assert.equal(search.area, "apps");
  assert.match(search.description, /^Fieldnote Docs: Search docs\. Find Fieldnote docs\./);
  assert.equal(create.preview!({} as never, { title: "Launch plan" }), 'Fieldnote Docs: create page with { title: "Launch plan" }');

  const ctx = { prisma: harness.prisma, userId: owner.id, actor: "agent", settings: {} } as never;
  const result = await search.run(ctx, search.input.parse({ query: "Q4" }));
  assert.equal(result.summary, "Fieldnote Docs: Search docs");
  assert.deepEqual(result.data, { text: "Found: Launch plan for Q4", structured: { hits: 1 } });
  await assert.rejects(() => remove.run(ctx, { id: "missing" }), /Fieldnote Docs returned an error: No such doc/);
  await assert.rejects(() => search.run({ prisma: harness.prisma, userId: other.id } as never, { query: "x" }), /another account/);

  assert.equal((await resolveMcpTool(harness.prisma, owner.id, create.name))?.mcp.toolName, "create page");
  assert.equal(await resolveMcpTool(harness.prisma, other.id, create.name), undefined);
  assert.equal(await resolveMcpTool(harness.prisma, owner.id, "hub_create_tasks"), undefined);
});

test("a 401 refreshes the token once and retries; expired tokens refresh before the call", async () => {
  const before = readTokens(await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: oauthId } }))!;
  mock.access.delete(before.access_token);
  const refreshes = () => mock.tokenRequests.filter((form) => form.grant_type === "refresh_token").length;
  const startRefreshes = refreshes();
  const output = await callMcpTool(harness.prisma, owner.id, oauthId, "search", { query: "retry" });
  assert.equal(output.text, "Found: Launch plan for retry");
  assert.equal(refreshes(), startRefreshes + 1);
  const after401 = readTokens(await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: oauthId } }))!;
  assert.notEqual(after401.access_token, before.access_token);
  assert.equal(mock.tokenRequests.at(-1)!.resource, `${VENDOR}/mcp`);

  await harness.prisma.mcpConnection.update({ where: { id: oauthId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
  await callMcpTool(harness.prisma, owner.id, oauthId, "search", { query: "early" });
  assert.equal(refreshes(), startRefreshes + 2);
  const refreshed = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: oauthId } });
  assert.ok(refreshed.expiresAt!.getTime() > Date.now());
});

test("refresh-tools re-lists, PATCH switches tools and the connection off, other people get 404", async () => {
  const refreshed = await owner.inject({ method: "POST", url: `/api/mcp-connections/${oauthId}/refresh-tools` });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.equal(refreshed.json().connection.toolCount, 3);
  track("POST /api/mcp-connections/:id/refresh-tools", "happy-path");

  const patched = await owner.inject({ method: "PATCH", url: `/api/mcp-connections/${oauthId}`, payload: { disabledTools: ["delete_page", "delete_page"] } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.deepEqual(patched.json().connection.disabledTools, ["delete_page"]);
  assert.equal((await mcpToolsForUser(harness.prisma, owner.id)).length, 2);
  const off = await owner.inject({ method: "PATCH", url: `/api/mcp-connections/${oauthId}`, payload: { status: "disabled" } });
  assert.equal(off.json().connection.status, "disabled");
  assert.equal((await mcpToolsForUser(harness.prisma, owner.id)).length, 0);
  const on = await owner.inject({ method: "PATCH", url: `/api/mcp-connections/${oauthId}`, payload: { status: "connected" } });
  assert.equal(on.json().connection.status, "connected");
  track("PATCH /api/mcp-connections/:id", "happy-path");

  for (const [method, url, payload] of [
    ["POST", `/api/mcp-connections/${oauthId}/refresh-tools`, undefined],
    ["PATCH", `/api/mcp-connections/${oauthId}`, { status: "disabled" }],
    ["DELETE", `/api/mcp-connections/${oauthId}`, undefined],
  ] as const) {
    const response = await other.inject({ method, url, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 404, `${method} ${url}: ${response.body}`);
  }
  const theirs = await other.inject({ method: "GET", url: "/api/mcp-connections" });
  assert.deepEqual(theirs.json().connections, []);
  assert.equal((await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: oauthId } })).status, "connected");
  track("GET /api/mcp-connections", "isolation");
  track("POST /api/mcp-connections/:id/refresh-tools", "isolation");
  track("PATCH /api/mcp-connections/:id", "isolation");
  track("DELETE /api/mcp-connections/:id", "isolation");

  const missing = "00000000-0000-4000-8000-000000000123";
  for (const [method, url, payload] of [
    ["POST", `/api/mcp-connections/${missing}/refresh-tools`, undefined],
    ["PATCH", `/api/mcp-connections/${missing}`, { status: "disabled" }],
    ["DELETE", `/api/mcp-connections/${missing}`, undefined],
  ] as const) {
    const response = await owner.inject({ method, url, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 404, `${method} ${url}: ${response.body}`);
  }
  track("POST /api/mcp-connections/:id/refresh-tools", "unknown-id");
  track("PATCH /api/mcp-connections/:id", "unknown-id");
  track("DELETE /api/mcp-connections/:id", "unknown-id");

  for (const payload of [{}, { status: "error" }, { disabledTools: "search" }, { surprise: true }]) {
    const response = await owner.inject({ method: "PATCH", url: `/api/mcp-connections/${oauthId}`, payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal((await owner.inject({ method: "PATCH", url: "/api/mcp-connections/not-a-uuid", payload: { status: "disabled" } })).statusCode, 400);
  track("PATCH /api/mcp-connections/:id", "invalid-input");
});

test("a refused refresh marks the connection for reconnect and drops its tools", async () => {
  const row = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: oauthId } });
  const tokens = readTokens(row)!;
  mock.access.delete(tokens.access_token);
  mock.refresh.delete(tokens.refresh_token!);
  await assert.rejects(
    () => callMcpTool(harness.prisma, owner.id, oauthId, "search", { query: "x" }),
    (error: unknown) => (error as { code?: string }).code === "MCP_RECONNECT" && /Reconnect Fieldnote Docs/.test((error as Error).message),
  );
  const broken = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: oauthId } });
  assert.equal(broken.status, "error");
  assert.match(broken.lastError ?? "", /Reconnect Fieldnote Docs/);
  assert.equal((await mcpToolsForUser(harness.prisma, owner.id)).length, 0);
});

test("callback state expires after 10 minutes and vendor errors are shown plainly", async () => {
  const late = await connectOAuth(owner, "/mcp2", "Fieldnote Wiki");
  await harness.prisma.mcpConnection.update({ where: { id: late.id }, data: { stateExpiresAt: new Date(Date.now() - 1_000) } });
  approve(late.authorizeUrl, "code-late");
  const expired = await harness.app.inject({ method: "GET", url: `/api/mcp-connections/callback?code=code-late&state=${late.authorizeUrl.searchParams.get("state")}` });
  assert.equal(expired.statusCode, 302);
  const location = new URL(expired.headers.location as string);
  assert.equal(location.searchParams.get("mcp"), "error");
  assert.match(location.searchParams.get("mcpError") ?? "", /10 minutes/);
  assert.equal(location.hash, "#mcp");
  const row = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: late.id } });
  assert.equal(row.status, "error");
  assert.equal(row.oauthState, null);
  assert.ok(mock.codes.has("code-late"), "an expired state never reaches the token endpoint");

  const denied = await connectOAuth(owner, "/mcp2", "Fieldnote Wiki");
  const refused = await harness.app.inject({
    method: "GET",
    url: `/api/mcp-connections/callback?${new URLSearchParams({ error: "access_denied", error_description: "Your site admin has not allowed api.ensemblework.com.", state: denied.authorizeUrl.searchParams.get("state")! })}`,
  });
  const refusedAt = new URL(refused.headers.location as string);
  assert.equal(refusedAt.searchParams.get("mcp"), "error");
  assert.match(refusedAt.searchParams.get("mcpError") ?? "", /site admin has not allowed api\.ensemblework\.com/);
  assert.match((await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: denied.id } })).lastError ?? "", /site admin/);

  const unknown = await harness.app.inject({ method: "GET", url: "/api/mcp-connections/callback?code=x&state=never-issued" });
  assert.equal(new URL(unknown.headers.location as string).pathname, "/settings");
  assert.equal(new URL(unknown.headers.location as string).searchParams.get("mcp"), "error");
});

test("hosted: the callback only finishes in a browser signed in as the person who started it", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const attempt = async (code: string) => {
    const started = await connectOAuth(owner, "/mcp2", "Fieldnote Wiki");
    approve(started.authorizeUrl, code);
    return { id: started.id, url: `/api/mcp-connections/callback?code=${code}&state=${encodeURIComponent(started.authorizeUrl.searchParams.get("state")!)}` };
  };
  /** Only the callback runs hosted: starting a connection to the http vendor on 127.0.0.1 is refused there. */
  const hostedCallback = async (send: (request: { method: "GET"; url: string }) => Promise<{ headers: Record<string, unknown>; statusCode: number }>, url: string) => {
    process.env.NODE_ENV = "production";
    try {
      return await send({ method: "GET", url });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  };
  setMcpDepsForTests({ hosted: false });
  try {
    const first = await attempt("code-no-session");
    const anonymous = await hostedCallback((request) => harness.app.inject(request), first.url);
    assert.equal(anonymous.statusCode, 302);
    const anonymousAt = new URL(anonymous.headers.location as string);
    assert.equal(anonymousAt.searchParams.get("mcp"), "error");
    assert.match(anonymousAt.searchParams.get("mcpError") ?? "", /Sign in to Ensemble in this browser/);
    assert.equal(anonymousAt.searchParams.get("server"), null);
    let row = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(row.tokens, null);
    assert.equal(row.status, "error");
    assert.ok(mock.codes.has("code-no-session"), "the code was never exchanged");

    const second = await attempt("code-mismatch");
    const wrongAccount = await hostedCallback((request) => other.inject(request), second.url);
    const wrongAt = new URL(wrongAccount.headers.location as string);
    assert.equal(wrongAt.searchParams.get("mcp"), "error");
    assert.match(wrongAt.searchParams.get("mcpError") ?? "", /different Ensemble account/);
    assert.equal(wrongAt.pathname, "/settings");
    row = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: second.id } });
    assert.equal(row.tokens, null);
    assert.equal(row.userId, owner.id);
    assert.ok(mock.codes.has("code-mismatch"), "the code was never exchanged");
    assert.equal(await harness.prisma.mcpConnection.count({ where: { userId: other.id } }), 0);
    const replay = await hostedCallback((request) => owner.inject(request), second.url);
    assert.equal(new URL(replay.headers.location as string).searchParams.get("mcp"), "error", "a refused state cannot be reused");

    const third = await attempt("code-owner");
    const own = await hostedCallback((request) => owner.inject(request), third.url);
    const ownAt = new URL(own.headers.location as string);
    assert.equal(ownAt.searchParams.get("mcp"), "connected", ownAt.searchParams.get("mcpError") ?? "");
    row = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: third.id } });
    assert.equal(row.status, "connected");
    assert.ok(row.tokens?.startsWith("v1:"));
    assert.equal(mock.codes.has("code-owner"), false);
  } finally {
    setMcpDepsForTests(null);
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test("CIMD: an https API uses its metadata document URL as client_id and skips registration", async () => {
  const metadata = await harness.app.inject({ method: "GET", url: "/api/mcp-client-metadata.json" });
  assert.equal(metadata.statusCode, 200);
  assert.equal(metadata.json().client_name, "Ensemble");
  track("GET /api/mcp-client-metadata.json", "happy-path");
  process.env.HUB_API_PUBLIC_URL = "https://api.fieldnote.example";
  try {
    const registrations = mock.registrations.length;
    const { authorizeUrl } = await connectOAuth(owner, "/cimd/mcp", "Fieldnote CIMD");
    assert.equal(authorizeUrl.searchParams.get("client_id"), "https://api.fieldnote.example/api/mcp-client-metadata.json");
    assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "https://api.fieldnote.example/api/mcp-connections/callback");
    assert.equal(mock.registrations.length, registrations);
    const doc = (await harness.app.inject({ method: "GET", url: "/api/mcp-client-metadata.json" })).json();
    assert.equal(doc.client_id, authorizeUrl.searchParams.get("client_id"));
  } finally {
    process.env.HUB_API_PUBLIC_URL = "http://localhost:4000";
  }
});

test("servers without PKCE S256 are refused before any redirect", async () => {
  const response = await owner.inject({ method: "POST", url: "/api/mcp-connections", payload: { url: `${VENDOR}/nopkce/mcp`, name: "Old Vendor" } });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().code, "MCP_PKCE_UNSUPPORTED");
  assert.equal(await harness.prisma.mcpConnection.count({ where: { userId: owner.id, name: "Old Vendor" } }), 0);
});

test("bearer tokens: stored encrypted, sent as Authorization, refused tokens leave nothing behind", async () => {
  const wrong = await owner.inject({ method: "POST", url: "/api/mcp-connections", payload: { url: `${VENDOR}/pat/mcp`, name: "Fieldnote PAT", token: "pat-wrong-0000" } });
  assert.equal(wrong.statusCode, 400, wrong.body);
  assert.equal(wrong.json().code, "MCP_TOKEN_REFUSED");
  assert.equal(await harness.prisma.mcpConnection.count({ where: { userId: owner.id, name: "Fieldnote PAT" } }), 0);

  const created = await owner.inject({ method: "POST", url: "/api/mcp-connections", payload: { url: `${VENDOR}/pat/mcp`, name: "Fieldnote PAT", token: PAT } });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().status, "connected");
  assert.equal(created.json().authorizeUrl, undefined);
  const row = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: created.json().id } });
  assert.ok(row.tokens?.startsWith("v1:"));
  assert.equal(row.tokens?.includes(PAT), false);
  assert.equal(row.clientInfo?.includes("bearer"), false);
  const output = await callMcpTool(harness.prisma, owner.id, row.id, "search", { query: "pat" });
  assert.equal(output.text, "Found: Launch plan for pat");
  assert.equal(mock.calls.at(-1)!.path, "/pat/mcp");

  const open = await owner.inject({ method: "POST", url: "/api/mcp-connections", payload: { url: `${VENDOR}/open/mcp`, name: "Fieldnote Public" } });
  assert.equal(open.statusCode, 200, open.body);
  assert.equal(open.json().status, "connected");
  const listed = (await owner.inject({ method: "GET", url: "/api/mcp-connections" })).json().connections as Array<{ name: string; auth: string }>;
  assert.equal(listed.find((item) => item.name === "Fieldnote PAT")?.auth, "bearer");
  assert.equal(listed.find((item) => item.name === "Fieldnote Public")?.auth, "none");
});

test("custom URLs are checked; bad bodies and unknown catalog servers are 400", async () => {
  for (const payload of [
    { url: "http://mcp.fieldnote.example/mcp" },
    { url: "ftp://mcp.fieldnote.example/mcp" },
    { url: "https://user:pw@mcp.fieldnote.example/mcp" },
    { serverId: "not-a-server" },
    { serverId: "figma" },
    { serverId: "notion", url: `${VENDOR}/mcp` },
    {},
    { url: `${VENDOR}/mcp`, clientSecret: "secret-only" },
  ]) {
    const response = await owner.inject({ method: "POST", url: "/api/mcp-connections", payload });
    assert.equal(response.statusCode, 400, `${JSON.stringify(payload)}: ${response.body}`);
  }
  track("POST /api/mcp-connections", "invalid-input");
});

test("hosted: unverified people are refused and private or plain-http servers are rejected", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const verified = await harness.asUser("lee@fieldnote.example");
  await harness.prisma.user.update({ where: { id: verified.id }, data: { emailVerifiedAt: new Date() } });
  process.env.NODE_ENV = "production";
  try {
    for (const [method, url] of [["GET", "/api/mcp-connections"], ["POST", "/api/mcp-connections"]] as const) {
      const denied = await other.inject({ method, url, ...(method === "POST" ? { payload: { url: "https://mcp.fieldnote.example/mcp" } } : {}) });
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(denied.json().code, "EMAIL_UNVERIFIED");
      track(`${method} ${url}`, "hosted-verification");
    }
    for (const url of [`${VENDOR}/mcp`, "https://127.0.0.1/mcp", "https://169.254.169.254/latest", "https://[::1]/mcp", "https://10.2.3.4/mcp"]) {
      const response = await verified.inject({ method: "POST", url: "/api/mcp-connections", payload: { url } });
      assert.equal(response.statusCode, 400, `${url}: ${response.body}`);
      assert.equal(response.json().code, "MCP_URL_REFUSED");
    }
    assert.equal(await harness.prisma.mcpConnection.count({ where: { userId: verified.id } }), 0);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test("DELETE revokes the tokens at the vendor and removes the connection", async () => {
  const fresh = await connectOAuth(owner, "/mcp", "Fieldnote Docs");
  approve(fresh.authorizeUrl, "code-2");
  const back = await harness.app.inject({ method: "GET", url: `/api/mcp-connections/callback?code=code-2&state=${fresh.authorizeUrl.searchParams.get("state")}` });
  assert.equal(new URL(back.headers.location as string).searchParams.get("mcp"), "connected");
  const tokens = readTokens(await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: fresh.id } }))!;
  const removed = await owner.inject({ method: "DELETE", url: `/api/mcp-connections/${fresh.id}` });
  assert.equal(removed.statusCode, 204, removed.body);
  assert.ok(mock.revoked.includes(tokens.refresh_token!));
  assert.ok(mock.revoked.includes(tokens.access_token));
  assert.equal(await harness.prisma.mcpConnection.count({ where: { id: fresh.id } }), 0);
  const ledger = await harness.prisma.auditLedger.findMany({ where: { userId: owner.id, action: { startsWith: "mcp." } }, select: { action: true } });
  assert.ok(ledger.some((entry) => entry.action === "mcp.connect"));
  assert.ok(ledger.some((entry) => entry.action === "mcp.disconnect"));
  track("DELETE /api/mcp-connections/:id", "happy-path");
});
