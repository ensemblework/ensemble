import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHarness, type HttpHarness } from "../test/http.js";
import { mcpRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

const originalFetch = globalThis.fetch;
mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (String(input) === "https://docs.ensemblework.com/search-index.json") {
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json({
      version: 1,
      pages: [{
        title: "Context Bridge",
        path: "/context_bridge/",
        sections: [{ heading: "Three ways to reach it", url: "https://docs.ensemblework.com/context_bridge/#1-three-ways-to-reach-it", text: "Editors use the Ensemble CLI, the hosted URL, or a source build." }],
      }],
    });
  }
  return originalFetch(input, init);
});

const originalEnv = { ...process.env };
process.env.NODE_ENV = "test";
process.env.HUB_WEB_ORIGIN = "http://hub.example.test";

const harness: HttpHarness = await createHttpHarness();
const owner = await harness.asUser("mcp-owner@example.test");
const other = await harness.asUser("mcp-other@example.test");
const bridge = await harness.asToken(owner, "bridge");
const full = await harness.asToken(owner, "full");
const device = await harness.asToken(owner, "device");
const covered = new Map<string, Set<RouteCheck>>();

await harness.prisma.task.create({ data: { userId: owner.id, title: "MCP owner task", status: "todo", todayFocus: "keep" } });
await harness.prisma.task.create({ data: { userId: other.id, title: "MCP other task", status: "todo", todayFocus: "keep" } });
await harness.app.listen({ host: "127.0.0.1", port: 0 });

const address = harness.app.server.address();
assert.ok(address && typeof address === "object");
const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;

after(async () => {
  try {
    for (const [route, checks] of Object.entries(mcpRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted MCP coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness.close();
    mock.restoreAll();
    process.env = originalEnv;
  }
});

function track(route: string, check: RouteCheck): void {
  const checks = covered.get(route) ?? new Set<RouteCheck>();
  checks.add(check);
  covered.set(route, checks);
}

function textOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content
    .map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "hub-api-mcp-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

test("bridge token initializes, lists tools, and reads only the caller's data", async () => {
  const client = await connect(bridge.token);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("ensemble_brief"));
    assert.ok(names.includes("ensemble_tasks"));

    const tasks = await client.callTool({ name: "ensemble_tasks", arguments: { limit: 10 } });
    const text = textOf(tasks);
    assert.equal(tasks.isError, undefined);
    assert.match(text, /MCP owner task/);
    assert.doesNotMatch(text, /MCP other task/);
    track("POST /mcp", "happy-path");
    track("POST /mcp", "isolation");
  } finally {
    await client.close();
  }
});

test("full tokens are accepted by hosted MCP", async () => {
  const client = await connect(full.token);
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "ensemble_today"));
  } finally {
    await client.close();
  }
});

test("hosted documentation lookup accepts a read-only key without widening its grants", async () => {
  const client = await connect(bridge.token);
  try {
    const listed = (await client.listTools()).tools;
    assert.equal(listed.find(({ name }) => name === "ensemble_docs")?.annotations?.readOnlyHint, true);
    assert.equal(listed.some(({ name }) => name === "ensemble_create_task"), false);
    const known = await client.callTool({ name: "ensemble_docs", arguments: { query: "Three ways", limit: 1 } });
    assert.notEqual(known.isError, true, textOf(known));
    assert.match(textOf(known), /"found": true/);
    assert.match(textOf(known), /context_bridge\/#1-three-ways-to-reach-it/);
    track("GET /api/bridge/docs", "happy-path");
    const unknown = await client.callTool({ name: "ensemble_docs", arguments: { query: "zzzzquasar" } });
    assert.match(textOf(unknown), /"found": false/);
    assert.match(textOf(unknown), /No published documentation/);
    const invalid = await harness.app.inject({ method: "GET", url: "/api/bridge/docs?q=...", headers: { authorization: `Bearer ${bridge.token}` } });
    assert.equal(invalid.statusCode, 400);
    track("GET /api/bridge/docs", "invalid-input");
    for (const [method, headers, status] of [
      ["GET", {}, 401],
      ["GET", { authorization: `Bearer ${device.token}` }, 403],
      ["POST", { authorization: `Bearer ${bridge.token}` }, 405],
    ] as const) {
      const response = await harness.app.inject({ method, url: "/api/bridge/docs?q=Three", headers });
      assert.equal(response.statusCode, status);
    }
  } finally {
    await client.close();
  }
});

test("hosted MCP rejects missing bearer, cookie-only, and device tokens", async () => {
  const noToken = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.headers.get("www-authenticate"), 'Bearer realm="Ensemble"');

  const cookieOnly = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner.cookie },
    body: "{}",
  });
  assert.equal(cookieOnly.status, 401);
  assert.equal(cookieOnly.headers.get("www-authenticate"), 'Bearer realm="Ensemble"');

  const deviceToken = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${device.token}` },
    body: "{}",
  });
  assert.equal(deviceToken.status, 403);
});

test("GET and DELETE /mcp are 405 with Allow: POST for bearer callers", async () => {
  for (const method of ["GET", "DELETE"] as const) {
    const response = await fetch(mcpUrl, { method, headers: { authorization: `Bearer ${bridge.token}` } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    track(`${method} /mcp`, "invalid-input");
  }
});
