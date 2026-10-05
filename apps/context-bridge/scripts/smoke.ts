/**
 * Inspector-equivalent smoke test.
 * Spawns the built bridge over stdio and over streamable HTTP, against a
 * mocked hub-api, and checks tools/list plus one call on each transport.
 * The MCP Inspector GUI is not required.
 */
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHubClient } from "../src/hub.js";
import { startHttpServer } from "../src/http.js";
import { TOOL_NAMES } from "../src/server.js";
import { startMockHub } from "../test/mock-hub.js";

function textOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content
    .map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const mock = await startMockHub();
const hub = createHubClient({
  hubUrl: mock.url,
  auth: { kind: "bearer", token: "ens_test" },
  httpHost: "127.0.0.1",
  httpPort: 0,
  httpToken: null,
});

const stdio = new StdioClientTransport({
  command: process.execPath,
  args: [dist],
  env: { ...getDefaultEnvironment(), ENSEMBLE_BRIDGE_TOKEN: "ens_test", HUB_API_URL: mock.url },
  stderr: "pipe",
});
const stdioClient = new Client({ name: "bridge-smoke", version: "0.0.0" });
await stdioClient.connect(stdio);
const tools = await stdioClient.listTools();
if (tools.tools.length !== TOOL_NAMES.length) {
  throw new Error(`expected ${TOOL_NAMES.length} tools, got ${tools.tools.map((tool) => tool.name).join(", ")}`);
}
const brief = await stdioClient.callTool({ name: "ensemble_brief", arguments: { repo: "acme/app", branch: "feature" } });
if (brief.isError || !/untrusted/i.test(textOf(brief))) {
  throw new Error(`stdio ensemble_brief failed: ${textOf(brief)}`);
}
await stdioClient.close();

const http = await startHttpServer({ hub, detect: async () => ({}) }, { CONTEXT_BRIDGE_HOST: "127.0.0.1", CONTEXT_BRIDGE_PORT: "0" });
const httpClient = new Client({ name: "bridge-smoke-http", version: "0.0.0" });
await httpClient.connect(new StreamableHTTPClientTransport(new URL(http.url)));
const today = await httpClient.callTool({ name: "ensemble_today", arguments: {} });
if (today.isError || !/Ship the bridge/.test(textOf(today))) {
  throw new Error(`http ensemble_today failed: ${textOf(today)}`);
}
const resources = await httpClient.listResources();
if (resources.resources.length < 10) throw new Error(`expected resources, got ${resources.resources.length}`);
await httpClient.close();
await http.close();
await mock.close();

console.error(`MCP smoke OK: ${tools.tools.length} tools over stdio, streamable HTTP, ${resources.resources.length} resources.`);
