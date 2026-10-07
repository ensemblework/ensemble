import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { gzipSync } from "node:zlib";
import type { McpConnection } from "@prisma/client";
import { isPublicAuthPath } from "../../lib/auth-public.js";
import { buildMcpTools, fairShare, mcpJsonSchema, mcpToolName, MCP_TOOL_NAME_MAX, MCP_TOOLS_PER_SERVER, MCP_TOOLS_TOTAL, serverSlug, shortArgs } from "../../assistant/mcp-tools.js";
import { DEFAULT_RETURN_TO, MCP_PUBLIC_PATHS, mcpClientMetadataDocument, mcpClientMetadataUrl, safeReturnTo } from "./config.js";
import { classifyMcpError, MAX_RESULT_TEXT_CHARS, normalizeToolResult } from "./manager.js";
import { assertPkceS256, McpAuthUnsupported, McpReconnectRequired } from "./provider.js";
import { providerSafeSchema } from "./schema.js";
import type { McpToolSpec } from "./store.js";
import { assertMcpUrlAllowed, guardedFetch, isPrivateAddress, McpUrlError, parseMcpUrl, pinnedFetch } from "./url-guard.js";

type Row = Pick<McpConnection, "id" | "userId" | "serverId" | "name" | "status" | "tools" | "disabledTools">;

function row(partial: Partial<Omit<Row, "tools">> & { tools: McpToolSpec[] }): Row {
  return {
    id: partial.id ?? "00000000-0000-4000-8000-0000000000aa",
    userId: partial.userId ?? "mira",
    serverId: partial.serverId ?? "notion",
    name: partial.name ?? "Notion",
    status: partial.status ?? "connected",
    tools: partial.tools as unknown as Row["tools"],
    disabledTools: partial.disabledTools ?? [],
  };
}

const publicLookup = async () => ["93.184.216.34"];

test("MCP public paths are the ones the auth gate lets through", () => {
  for (const path of MCP_PUBLIC_PATHS) assert.equal(isPublicAuthPath(path), true, path);
  assert.equal(isPublicAuthPath("/api/mcp-connections"), false);
  assert.equal(isPublicAuthPath("/api/mcp-connections/00000000-0000-4000-8000-000000000001"), false);
});

test("hosted URL guard refuses http, private, link-local and metadata addresses", async () => {
  const hosted = { hosted: true, lookup: publicLookup };
  assert.equal((await assertMcpUrlAllowed("https://mcp.fieldnote.example/mcp", hosted)).href, "https://mcp.fieldnote.example/mcp");
  for (const url of [
    "http://mcp.fieldnote.example/mcp",
    "http://localhost:4000/mcp",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://10.0.0.8/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/mcp",
    "https://[::ffff:a9fe:a9fe]/mcp",
    "https://[fd00::1]/mcp",
    "https://metadata.google.internal/computeMetadata",
    "https://user:pass@mcp.fieldnote.example/mcp",
    "ftp://mcp.fieldnote.example/mcp",
    "not a url",
  ]) {
    await assert.rejects(() => assertMcpUrlAllowed(url, hosted), McpUrlError, url);
  }
  for (const address of ["10.1.2.3", "192.168.1.1", "172.20.0.1", "100.64.0.9", "169.254.169.254", "127.0.0.1"]) {
    await assert.rejects(() => assertMcpUrlAllowed("https://rebind.fieldnote.example/mcp", { hosted: true, lookup: async () => ["93.184.216.34", address] }), McpUrlError, address);
  }
  await assert.rejects(
    () => assertMcpUrlAllowed("https://gone.fieldnote.example/mcp", { hosted: true, lookup: async () => { throw new Error("ENOTFOUND"); } }),
    /did not resolve/,
  );
  assert.equal(isPrivateAddress("2606:4700::1111"), false);
  assert.equal(isPrivateAddress("64:ff9b::a00:1"), true);
});

test("local URL guard allows https anywhere and plain http only on this computer", async () => {
  const local = { hosted: false };
  assert.ok(await assertMcpUrlAllowed("http://127.0.0.1:7000/mcp", local));
  assert.ok(await assertMcpUrlAllowed("http://localhost:7000/mcp", local));
  assert.ok(await assertMcpUrlAllowed("https://10.0.0.8/mcp", local));
  assert.throws(() => parseMcpUrl("http://mcp.fieldnote.example/mcp", local), McpUrlError);
});

test("guarded fetch re-checks every redirect hop and drops Authorization across origins", async () => {
  const seen: Array<{ url: string; auth: string | null; method: string }> = [];
  const fake = async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    seen.push({ url: href, auth: new Headers(init?.headers).get("authorization"), method: init?.method ?? "GET" });
    if (href.endsWith("/start")) return new Response(null, { status: 307, headers: { location: "https://other.fieldnote.example/next" } });
    if (href.endsWith("/next")) return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } });
    return new Response("ok");
  };
  const guarded = guardedFetch({ hosted: true, lookup: publicLookup, fetch: fake });
  await assert.rejects(
    () => guarded("https://mcp.fieldnote.example/start", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }),
    McpUrlError,
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.auth, "Bearer secret");
  assert.equal(seen[1]!.auth, null);
  assert.equal(seen[1]!.method, "POST");
});

test("pinned fetch refuses to connect when the host resolves to a private address", async () => {
  for (const address of ["10.0.0.7", "127.0.0.1", "169.254.169.254", "::1", "fd12::3"]) {
    const fetchPinned = pinnedFetch({ lookup: async () => [address] });
    await assert.rejects(() => fetchPinned("http://mcp.fieldnote.example:9/mcp", { method: "POST", body: "{}" }), McpUrlError, address);
  }
});

test("DNS rebinding: a host that passes the check and then resolves privately is never connected to", async () => {
  let lookups = 0;
  const rebinding = async () => (++lookups === 1 ? ["93.184.216.34"] : ["10.0.0.7"]);
  const guarded = guardedFetch({ hosted: true, lookup: rebinding });
  await assert.rejects(() => guarded("https://rebind.fieldnote.example/mcp", { method: "POST", body: "{}" }), McpUrlError);
  assert.equal(lookups, 2, "the address checked at connect time is the one used");
});

test("pinned fetch connects to the checked address and keeps the URL's Host", async () => {
  const seen: Array<{ host?: string; type?: string; body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ host: request.headers.host, type: request.headers["content-type"], body });
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end(gzipSync(JSON.stringify({ ok: true })));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const lookedUp: string[] = [];
    const fetchPinned = pinnedFetch({
      lookup: async (hostname) => {
        lookedUp.push(hostname);
        return ["127.0.0.1"];
      },
      isBlocked: () => false,
    });
    const response = await fetchPinned(`http://mcp.fieldnote.example:${port}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token" }) });
    assert.ok(response instanceof Response);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(lookedUp, ["mcp.fieldnote.example"]);
    assert.equal(seen[0]!.host, `mcp.fieldnote.example:${port}`);
    assert.match(seen[0]!.type ?? "", /application\/x-www-form-urlencoded/);
    assert.equal(seen[0]!.body, "grant_type=refresh_token");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("PKCE S256 is required before any sign-in starts", () => {
  assert.throws(() => assertPkceS256(undefined, "Fieldnote"), (error: unknown) => error instanceof McpAuthUnsupported && error.code === "MCP_TOKEN_REQUIRED");
  const base = { issuer: "https://as.fieldnote.example", authorization_endpoint: "https://as.fieldnote.example/a", token_endpoint: "https://as.fieldnote.example/t", response_types_supported: ["code"] };
  assert.throws(() => assertPkceS256(base, "Fieldnote"), (error: unknown) => error instanceof McpAuthUnsupported && error.code === "MCP_PKCE_UNSUPPORTED");
  assert.throws(() => assertPkceS256({ ...base, code_challenge_methods_supported: ["plain"] }, "Fieldnote"), McpAuthUnsupported);
  assert.doesNotThrow(() => assertPkceS256({ ...base, code_challenge_methods_supported: ["plain", "S256"] }, "Fieldnote"));
});

test("client metadata document uses its own https URL as client_id and only then offers CIMD", () => {
  const original = process.env.HUB_API_PUBLIC_URL;
  try {
    process.env.HUB_API_PUBLIC_URL = "http://localhost:4000";
    assert.equal(mcpClientMetadataUrl(), undefined);
    process.env.HUB_API_PUBLIC_URL = "https://api.fieldnote.example/";
    const url = mcpClientMetadataUrl();
    assert.equal(url, "https://api.fieldnote.example/api/mcp-client-metadata.json");
    const doc = mcpClientMetadataDocument();
    assert.equal(doc.client_id, url);
    assert.deepEqual(doc.redirect_uris, ["https://api.fieldnote.example/api/mcp-connections/callback"]);
    assert.deepEqual(doc.grant_types, ["authorization_code", "refresh_token"]);
    assert.equal(doc.token_endpoint_auth_method, "none");
    assert.equal(doc.client_name, "Ensemble");
    assert.equal("scope" in doc, false);
  } finally {
    if (original === undefined) delete process.env.HUB_API_PUBLIC_URL;
    else process.env.HUB_API_PUBLIC_URL = original;
  }
});

test("returnTo stays a relative Hub path", () => {
  assert.equal(safeReturnTo("/settings?tab=connections&connector=notion"), "/settings?tab=connections&connector=notion");
  for (const bad of ["https://evil.example/", "//evil.example", "/\\evil.example", "settings", "", undefined, "/x\u0000y"]) {
    assert.equal(safeReturnTo(bad), DEFAULT_RETURN_TO, String(bad));
  }
});

test("tool names are prefixed, sanitized, at most 64 characters and unique", () => {
  assert.equal(mcpToolName("notion", "notion", "notion-search"), "mcp_notion_notion-search");
  const spaced = mcpToolName("notion", "notion", "create page");
  assert.match(spaced, /^mcp_notion_create_page_[0-9a-f]{6}$/);
  const long = mcpToolName("notion", "notion", "x".repeat(90));
  assert.ok(long.length <= MCP_TOOL_NAME_MAX);
  assert.match(long, /^[a-zA-Z0-9_-]+$/);
  assert.notEqual(mcpToolName("notion", "notion", "a.b"), mcpToolName("notion", "notion", "a b"));
  assert.equal(serverSlug({ serverId: "notion", name: "Notion" }), "notion");
  const custom = serverSlug({ serverId: "custom-abc", name: "Fieldnote Docs!" });
  assert.match(custom, /^fieldnote_do_[0-9a-f]{4}$/);
  assert.notEqual(custom, serverSlug({ serverId: "custom-def", name: "Fieldnote Docs!" }));

  const tools = buildMcpTools([
    row({
      tools: [
        { name: "search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } },
        { name: "create page", title: "Create a page", inputSchema: { type: "object" } },
        { name: "create.page", inputSchema: { type: "object" } },
        { name: "delete_page", inputSchema: { type: "object" }, annotations: { destructiveHint: true, readOnlyHint: false } },
        { name: "off", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      ],
      disabledTools: ["off"],
    }),
  ]);
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.length, 4);
  for (const name of names) assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
  const [search, create, , remove] = tools;
  assert.equal(search!.isWrite, false);
  assert.equal(search!.risk, "low");
  assert.equal(search!.area, "apps");
  assert.equal(create!.isWrite, true);
  assert.equal(create!.risk, "medium");
  assert.equal(remove!.isWrite, true);
  assert.equal(remove!.risk, "high");
  assert.match(search!.description, /^Notion: search\./);
  assert.match(create!.description, /^Notion: Create a page\./);
  assert.equal(create!.preview!({} as never, { title: "Launch plan", parent: { id: "p1" } }), 'Notion: Create a page with { title: "Launch plan", parent: {"id":"p1"} }');
  assert.deepEqual(mcpJsonSchema(search!), { type: "object", properties: { query: { type: "string" } }, required: ["query"] });
  assert.throws(() => search!.input.parse({}), /Missing query/);
  assert.deepEqual(search!.input.parse({ query: "roadmap", extra: 1 }), { query: "roadmap", extra: 1 });
  assert.equal(buildMcpTools([row({ status: "disabled", tools: [{ name: "search", inputSchema: {} }] })]).length, 0);
});

test("caps keep each server to 40 tools, all servers to 80, and say what was hidden", () => {
  const many = (prefix: string, count: number): McpToolSpec[] =>
    Array.from({ length: count }, (_, index) => ({ name: `${prefix}${index}`, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }));
  const tools = buildMcpTools([
    row({ id: "a", serverId: "notion", name: "Notion", tools: many("n", 60) }),
    row({ id: "b", serverId: "linear", name: "Linear", tools: many("l", 50) }),
    row({ id: "c", serverId: "sentry", name: "Sentry", tools: many("s", 5) }),
  ]);
  assert.equal(tools.length, MCP_TOOLS_TOTAL);
  const per = (server: string) => tools.filter((tool) => tool.name.startsWith(`mcp_${server}_`)).length;
  assert.equal(per("sentry"), 5);
  assert.ok(per("notion") <= MCP_TOOLS_PER_SERVER);
  assert.ok(per("linear") <= MCP_TOOLS_PER_SERVER);
  assert.match(tools.find((tool) => tool.name === "mcp_notion_n0")!.description, /more Notion tools are hidden/);
  assert.equal(buildMcpTools([row({ tools: many("n", 60) })], { cap: false }).length, 60);
  assert.deepEqual(fairShare([40, 40, 5], 80), [38, 37, 5]);
  assert.deepEqual(fairShare([10, 3], 80), [10, 3]);
});

test("tool schemas are cleaned for model providers", () => {
  const { schema, required, trimmed } = providerSafeSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    anyOf: [{ required: ["a"] }],
    properties: {
      nullable: { type: "string", nullable: true },
      count: { type: "number", minimum: 0, exclusiveMinimum: true },
    },
    required: ["count"],
  });
  assert.equal(trimmed, false);
  assert.deepEqual(required, ["count"]);
  assert.deepEqual(schema, {
    properties: { nullable: { type: ["string", "null"] }, count: { type: "number", exclusiveMinimum: 0 } },
    required: ["count"],
    type: "object",
  });
  const huge = providerSafeSchema({ type: "object", properties: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`p${i}`, { type: "string", description: "x".repeat(100), pattern: "^a+$" }])) });
  assert.equal(huge.trimmed, true);
  assert.ok(JSON.stringify(huge.schema).length <= 12_000);
  assert.equal(providerSafeSchema("nope").schema.type, "object");
});

test("tool results are capped and keep small structured content", () => {
  const long = normalizeToolResult({ content: [{ type: "text", text: "a".repeat(MAX_RESULT_TEXT_CHARS + 50) }, { type: "image", data: "", mimeType: "image/png" }] });
  assert.equal(long.truncated, true);
  assert.ok(long.text.length < MAX_RESULT_TEXT_CHARS + 80);
  const small = normalizeToolResult({ content: [{ type: "text", text: "ok" }], structuredContent: { id: 1 }, isError: false });
  assert.deepEqual(small, { text: "ok", structured: { id: 1 }, isError: false, truncated: false });
  const big = normalizeToolResult({ content: [], structuredContent: { rows: "x".repeat(5000) } });
  assert.equal(big.structured, undefined);
  assert.equal(big.truncated, true);
  assert.equal(normalizeToolResult({ content: [{ type: "text", text: "nope" }], isError: true }).isError, true);
});

test("errors are sorted into reconnect, retry and plain failures", () => {
  assert.equal(classifyMcpError(new McpReconnectRequired()), "auth");
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  assert.equal(classifyMcpError(refused), "network");
  assert.equal(classifyMcpError(Object.assign(new Error("timed out"), { name: "TimeoutError" })), "timeout");
  assert.equal(classifyMcpError(new Error("Something else")), "other");
});

test("short previews never dump whole arguments", () => {
  assert.equal(shortArgs({}), "");
  const text = shortArgs({ body: "x".repeat(500), a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
  assert.ok(text.length < 400);
  assert.match(text, /…/);
});
