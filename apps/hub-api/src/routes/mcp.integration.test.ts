import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHarness, type HttpHarness } from "../test/http.js";
import { mcpRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

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
