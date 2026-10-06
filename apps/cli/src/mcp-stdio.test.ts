import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function startMockHub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.headers.authorization !== "Bearer ens_test") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Sign in to Ensemble first." }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Read only." }));
      return;
    }
    if (url.pathname === "/api/bridge/today") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ date: "2026-10-06", focus: [{ title: "Ship CLI" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

test("built CLI serves MCP tools over stdio", async () => {
  const dist = fileURLToPath(new URL("../dist/ensemble.mjs", import.meta.url));
  assert.ok(existsSync(dist), "dist/ensemble.mjs is missing; the test script builds it first");
  const mock = await startMockHub();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [dist, "mcp", "--api", mock.url],
    env: { ...getDefaultEnvironment(), ENSEMBLE_TOKEN: "ens_test" },
    stderr: "pipe",
  });
  const client = new Client({ name: "ensemble-cli-test", version: "0.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "ensemble_today"));
  await client.close();
  await mock.close();
});
