import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ENSEMBLE_VERSION } from "@ensemble/shared-types";
import { createHttpHarness, type HttpHarness } from "../test/http.js";

process.env.NODE_ENV = "test";
process.env.HUB_WEB_ORIGIN = "http://hub.example.test";
process.env.HUB_API_PUBLIC_URL = "http://localhost:4000";
process.env.ENSEMBLE_SECRET_KEY ??= Buffer.alloc(32, 11).toString("base64");

/* ------------------------------------------------------------------ */
/* Vendors answered in-process through the MCP fetch, so no port is    */
/* needed: Hugging Face (sign-in, token, whoami), Meta's WhatsApp       */
/* sign-in, and catalog servers that answer without an account.         */
/* ------------------------------------------------------------------ */

type Tool = { name: string; description: string; inputSchema: { type: "object" }; annotations?: { readOnlyHint?: boolean } };
const tool = (name: string): Tool => ({ name, description: `${name}.`, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } });
const HF_PUBLIC = [tool("model_search"), tool("dataset_search")];
const HF_ACCOUNT = [...HF_PUBLIC, tool("hf_whoami"), tool("space_search")];
const HF_PAT = "hf_mira_read_token_123";

const vendor = {
  seen: [] as Array<{ method: string; url: string; agent: string | null; bearer: string | null }>,
  hfTokens: new Set<string>([HF_PAT]),
  codes: new Map<string, { challenge: string; clientId: string; redirectUri: string; resource: string | null }>(),
  issued: 0,
  /** What www.facebook.com answers for its authorization server metadata. */
  facebook: "json" as "json" | "html" | "not-json",
  facebookRegistration: "json" as "json" | "html",
  /** Hugging Face's authorization server metadata, to make a sign-in fail. */
  hfMetadata: "json" as "json" | "html",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function page(status = 200): Response {
  return new Response("<!DOCTYPE html><html><head><title>Facebook</title></head><body>Sorry, something went wrong.</body></html>", {
    status,
    headers: { "content-type": 'text/html; charset="utf-8"' },
  });
}

async function mcp(request: Request, tools: Tool[]): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const server = new Server({ name: "fake-vendor", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (call) => ({ content: [{ type: "text", text: `ran ${call.params.name}` }] }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  void server.close();
  return response;
}

function authServer(origin: string, extra: Record<string, unknown> = {}) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    ...extra,
  };
}

async function register(request: Request, prefix: string): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  vendor.issued += 1;
  return json({ ...body, client_id: `${prefix}-client-${vendor.issued}` }, 201);
}

async function huggingface(request: Request, url: URL): Promise<Response> {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
  const path = url.pathname;
  if (path === "/mcp") {
    if (bearer) {
      if (!vendor.hfTokens.has(bearer)) return json({ error: "invalid_token" }, 401, { "www-authenticate": "Bearer" });
      return mcp(request, HF_ACCOUNT);
    }
    if (url.searchParams.has("login")) {
      return json({ error: "invalid_token" }, 401, { "www-authenticate": 'Bearer resource_metadata="https://huggingface.co/.well-known/oauth-protected-resource/mcp"' });
    }
    return mcp(request, HF_PUBLIC);
  }
  if (path === "/.well-known/oauth-protected-resource/mcp") return json({ resource: "https://huggingface.co/mcp", authorization_servers: ["https://huggingface.co"] });
  if (path === "/.well-known/oauth-authorization-server") return vendor.hfMetadata === "html" ? page() : json(authServer("https://huggingface.co"));
  if (path === "/oauth/register" && request.method === "POST") return register(request, "hf");
  if (path === "/oauth/token" && request.method === "POST") {
    const form = new URLSearchParams(await request.text());
    const grant = vendor.codes.get(form.get("code") ?? "");
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (!grant || grant.challenge !== challenge || grant.clientId !== form.get("client_id") || grant.resource !== form.get("resource")) {
      return json({ error: "invalid_grant" }, 400);
    }
    vendor.codes.delete(form.get("code")!);
    const access = `hf_oauth_${vendor.issued}`;
    vendor.hfTokens.add(access);
    return json({ access_token: access, refresh_token: `hf_refresh_${vendor.issued}`, token_type: "Bearer", expires_in: 3600 });
  }
  if (path === "/api/whoami-v2") {
    if (!bearer || !vendor.hfTokens.has(bearer)) return json({ error: "Invalid credentials in Authorization header" }, 401);
    return json({ type: "user", name: "mira-chen", fullname: "Mira Chen", orgs: [] });
  }
  return json({ error: "not found" }, 404);
}

async function facebook(request: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (url.host === "mcp.facebook.com") {
    if (path === "/whatsapp_business_tools") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return json({ error: "invalid_token" }, 401, {
        "www-authenticate": 'Bearer resource_metadata="https://mcp.facebook.com/.well-known/oauth-protected-resource/whatsapp_business_tools"',
      });
    }
    if (path === "/.well-known/oauth-protected-resource/whatsapp_business_tools") {
      return json({ resource: "https://mcp.facebook.com/whatsapp_business_tools", authorization_servers: ["https://www.facebook.com/whatsapp_business_tools"] });
    }
    if (path === "/.well-known/register/whatsapp_business_tools" && request.method === "POST") {
      return vendor.facebookRegistration === "html" ? page(403) : register(request, "meta");
    }
    return json({ error: "not found" }, 404);
  }
  if (path === "/.well-known/oauth-authorization-server/whatsapp_business_tools") {
    // Like www.facebook.com: a client that does not say who it is gets a web page.
    if (vendor.facebook === "html" || !request.headers.get("user-agent")?.startsWith("Ensemble/")) return page();
    if (vendor.facebook === "not-json") return new Response("Sorry, something went wrong.", { status: 200, headers: { "content-type": "application/json" } });
    return json({
      ...authServer("https://www.facebook.com/whatsapp_business_tools"),
      authorization_endpoint: "https://www.facebook.com/whatsapp_business_tools/oauth/authorize",
      registration_endpoint: "https://mcp.facebook.com/.well-known/register/whatsapp_business_tools",
    });
  }
  return page(404);
}

/** fellow.app: answers without an account, but also publishes a sign-in. api.grain.com and mcp.context7.com: no sign-in at all. */
async function anonymous(request: Request, url: URL): Promise<Response> {
  const mcpPaths: Record<string, string> = { "fellow.app": "/mcp", "api.grain.com": "/_/mcp", "mcp.context7.com": "/mcp" };
  if (url.pathname === mcpPaths[url.host]) return mcp(request, [tool("search_notes")]);
  if (url.host === "fellow.app") {
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json({ resource: "https://fellow.app/mcp", authorization_servers: ["https://fellow.app"] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return json(authServer("https://fellow.app"));
    if (url.pathname === "/oauth/register" && request.method === "POST") return register(request, "fellow");
  }
  return json({ error: "not found" }, 404);
}

async function fakeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  vendor.seen.push({ method: request.method, url: url.href, agent: request.headers.get("user-agent"), bearer: request.headers.get("authorization") });
  if (url.host === "huggingface.co") return huggingface(request, url);
  if (url.host === "mcp.facebook.com" || url.host === "www.facebook.com") return facebook(request, url);
  return anonymous(request, url);
}

/* ------------------------------------------------------------------ */

const harness: HttpHarness = await createHttpHarness();
const mira = await harness.asUser("mira.chen@fieldnote.example");
const lena = await harness.asUser("lena.ortiz@fieldnote.example");
const { setMcpDepsForTests, callMcpTool } = await import("../connectors/mcp/manager.js");
const { readEnvelope } = await import("../connectors/mcp/store.js");
setMcpDepsForTests({ hosted: false, fetch: fakeFetch });

after(async () => {
  setMcpDepsForTests(null);
  await harness.close();
});

type Listed = { id: string; serverId: string; url: string; status: string; auth: string; account: string | null; toolCount: number };

async function listed(user = mira): Promise<Listed[]> {
  return (await user.inject({ method: "GET", url: "/api/mcp-connections" })).json().connections as Listed[];
}

async function catalogState(id: string, user = mira) {
  const entries = (await user.inject({ method: "GET", url: "/api/connectors/catalog" })).json().entries as Array<{ id: string; state: { mcp?: Record<string, unknown> } }>;
  return entries.find((entry) => entry.id === id)!.state.mcp;
}

function approve(authorizeUrl: URL, code: string): void {
  vendor.codes.set(code, {
    challenge: authorizeUrl.searchParams.get("code_challenge")!,
    clientId: authorizeUrl.searchParams.get("client_id")!,
    redirectUri: authorizeUrl.searchParams.get("redirect_uri")!,
    resource: authorizeUrl.searchParams.get("resource"),
  });
}

async function quietly<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

test("Hugging Face: Connect never saves an anonymous connection; it starts the sign-in on the ?login address", async () => {
  const started = await mira.inject({ method: "POST", url: "/api/mcp-connections", payload: { serverId: "huggingface", returnTo: "/settings?tab=connections&connector=huggingface" } });
  assert.equal(started.statusCode, 200, started.body);
  const body = started.json() as { id: string; status: string; authorizeUrl?: string };
  assert.equal(body.status, "pending");
  const authorizeUrl = new URL(body.authorizeUrl!);
  assert.equal(`${authorizeUrl.origin}${authorizeUrl.pathname}`, "https://huggingface.co/oauth/authorize");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizeUrl.searchParams.get("resource"), "https://huggingface.co/mcp");
  const row = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: body.id } });
  assert.equal(row.url, "https://huggingface.co/mcp?login");
  assert.equal(row.status, "pending");

  approve(authorizeUrl, "hf-code-1");
  const back = await mira.inject({ method: "GET", url: `/api/mcp-connections/callback?code=hf-code-1&state=${encodeURIComponent(authorizeUrl.searchParams.get("state")!)}` });
  assert.equal(new URL(back.headers.location as string).searchParams.get("mcp"), "connected", back.headers.location as string);

  const connection = (await listed()).find((item) => item.id === body.id)!;
  assert.equal(connection.status, "connected");
  assert.equal(connection.auth, "oauth");
  assert.equal(connection.account, "mira-chen");
  assert.equal(connection.toolCount, HF_ACCOUNT.length);
  assert.deepEqual(await catalogState("huggingface"), { status: "connected", toolCount: HF_ACCOUNT.length, lastError: null, auth: "oauth", account: "mira-chen" });

  // Later calls go to the stored ?login address with the signed-in token.
  const output = await callMcpTool(harness.prisma, mira.id, body.id, "hf_whoami", {});
  assert.equal(output.text, "ran hf_whoami");
  const call = vendor.seen.filter((seen) => seen.url === "https://huggingface.co/mcp?login" && seen.method === "POST").at(-1)!;
  assert.match(call.bearer ?? "", /^Bearer hf_oauth_/);
});

test("Hugging Face: a pasted access token is checked with the server and whoami, and names the account", async () => {
  const wrong = await lena.inject({ method: "POST", url: "/api/mcp-connections", payload: { serverId: "huggingface", token: "hf_not_a_real_token" } });
  assert.equal(wrong.statusCode, 400, wrong.body);
  assert.equal(wrong.json().code, "MCP_TOKEN_REFUSED");
  assert.equal(await harness.prisma.mcpConnection.count({ where: { userId: lena.id, serverId: "huggingface" } }), 0);

  const saved = await lena.inject({ method: "POST", url: "/api/mcp-connections", payload: { serverId: "huggingface", token: HF_PAT } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual({ status: saved.json().status, account: saved.json().account }, { status: "connected", account: "mira-chen" });
  const row = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: saved.json().id } });
  assert.equal(readEnvelope(row).auth, "bearer");
  assert.equal(readEnvelope(row).account, "mira-chen");
  assert.ok(vendor.seen.some((seen) => seen.url === "https://huggingface.co/api/whoami-v2" && seen.bearer === `Bearer ${HF_PAT}`));
  assert.equal((await listed(lena)).find((item) => item.serverId === "huggingface")?.account, "mira-chen");
  await harness.prisma.mcpConnection.delete({ where: { id: row.id } });
});

test("an anonymous Hugging Face connection saved before shows as public only and can be upgraded; a failed sign-in keeps it", async () => {
  const old = await harness.prisma.mcpConnection.create({
    data: {
      userId: lena.id,
      serverId: "huggingface",
      name: "Hugging Face",
      url: "https://huggingface.co/mcp",
      status: "connected",
      clientInfo: (await import("../connectors/mcp/store.js")).sealJson({ auth: "none" }),
      tools: HF_PUBLIC,
    },
  });
  assert.equal((await catalogState("huggingface", lena))?.auth, "none");

  vendor.hfMetadata = "html";
  try {
    const { result: failed } = await quietly(() => lena.inject({ method: "POST", url: "/api/mcp-connections", payload: { serverId: "huggingface" } }));
    assert.equal(failed.statusCode, 502, failed.body);
    assert.equal(failed.json().code, "MCP_BAD_RESPONSE");
  } finally {
    vendor.hfMetadata = "json";
  }
  const kept = await harness.prisma.mcpConnection.findUniqueOrThrow({ where: { id: old.id } });
  assert.deepEqual([kept.status, kept.url, readEnvelope(kept).auth], ["connected", "https://huggingface.co/mcp", "none"]);
  assert.equal((await callMcpTool(harness.prisma, lena.id, old.id, "model_search", {})).text, "ran model_search");

  // The plain address someone pastes is the Hugging Face entry, not a custom server.
  const upgraded = await lena.inject({ method: "POST", url: "/api/mcp-connections", payload: { url: "https://huggingface.co/mcp", token: HF_PAT } });
  assert.equal(upgraded.statusCode, 200, upgraded.body);
  assert.equal(upgraded.json().id, old.id);
  const after = (await listed(lena)).find((item) => item.id === old.id)!;
  assert.deepEqual([after.serverId, after.auth, after.account, after.url], ["huggingface", "bearer", "mira-chen", "https://huggingface.co/mcp?login"]);
});

test("catalog servers that answer without an account: sign-in when they have one, public data only when not, open ones as they are", async () => {
  const fellow = await mira.inject({ method: "POST", url: "/api/mcp-connections", payload: { serverId: "fellow" } });
  assert.equal(fellow.statusCode, 200, fellow.body);
  assert.equal(fellow.json().status, "pending");
  assert.equal(new URL(fellow.json().authorizeUrl).origin, "https://fellow.app");

  const { result: grain, warnings } = await quietly(() => mira.inject({ method: "POST", url: "/api/mcp-connections", payload: { serverId: "grain" } }));
  assert.equal(grain.statusCode, 200, grain.body);
  assert.deepEqual({ status: grain.json().status, publicOnly: grain.json().publicOnly }, { status: "connected", publicOnly: true });
  assert.ok(warnings.some((line) => /Grain answered without an account/.test(line)), warnings.join("\n"));
  assert.deepEqual(await catalogState("grain"), { status: "connected", toolCount: 1, lastError: null, auth: "none", account: null });

  const before = vendor.seen.length;
  const context7 = await mira.inject({ method: "POST", url: "/api/mcp-connections", payload: { serverId: "context7" } });
  assert.equal(context7.statusCode, 200, context7.body);
  assert.equal(context7.json().status, "connected");
  assert.equal(context7.json().publicOnly, undefined);
  assert.equal(vendor.seen.slice(before).filter((seen) => seen.url.includes("/.well-known/")).length, 0, "an open server is not asked for a sign-in");
  assert.equal((await catalogState("context7"))?.auth, "none");
});

test("WhatsApp Business: Ensemble names itself, and a web page from Meta's sign-in is reported plainly", async () => {
  const signedIn = await mira.inject({ method: "POST", url: "/api/mcp-connections", payload: { serverId: "whatsapp" } });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  assert.equal(new URL(signedIn.json().authorizeUrl).host, "www.facebook.com");
  const agents = new Set(vendor.seen.map((seen) => seen.agent));
  assert.deepEqual([...agents], [`Ensemble/${ENSEMBLE_VERSION} (+https://ensemblework.com)`]);
  await harness.prisma.mcpConnection.deleteMany({ where: { userId: mira.id, serverId: "whatsapp" } });

  const cases: Array<[() => void, RegExp, RegExp]> = [
    [() => void (vendor.facebook = "html"), /^WhatsApp Business's sign-in returned a web page instead of data \(www\.facebook\.com\)\./, /https:\/\/www\.facebook\.com\/\.well-known\/oauth-authorization-server\/whatsapp_business_tools/],
    [() => void (vendor.facebook = "not-json"), /^WhatsApp Business's sign-in returned data Ensemble could not read \(www\.facebook\.com\)\./, /www\.facebook\.com/],
    [() => void (vendor.facebookRegistration = "html"), /^WhatsApp Business's sign-in returned a web page instead of data \(mcp\.facebook\.com\)\./, /\/\.well-known\/register\/whatsapp_business_tools/],
  ];
  for (const [arrange, message, logged] of cases) {
    vendor.facebook = "json";
    vendor.facebookRegistration = "json";
    arrange();
    const { result: failed, warnings } = await quietly(() => mira.inject({ method: "POST", url: "/api/mcp-connections", payload: { serverId: "whatsapp" } }));
    assert.equal(failed.statusCode, 502, failed.body);
    assert.equal(failed.json().code, "MCP_BAD_RESPONSE");
    assert.match(failed.json().error, message);
    assert.doesNotMatch(failed.json().error, /DOCTYPE|Unexpected token|is not valid JSON/);
    assert.ok(warnings.some((line) => logged.test(line)), warnings.join("\n"));
    assert.equal(await harness.prisma.mcpConnection.count({ where: { userId: mira.id, serverId: "whatsapp" } }), 0);
  }
  vendor.facebook = "json";
  vendor.facebookRegistration = "json";
});
