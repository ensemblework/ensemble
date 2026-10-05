import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assertLoopbackHost, loadBridgeConfig, resolveAuth } from "../src/config.js";
import { repoFromRemote } from "../src/git.js";
import { createHubClient } from "../src/hub.js";
import { startHttpServer } from "../src/http.js";
import { assertReadOnlyNames } from "../src/read-only.js";
import { buildServer, TOOL_NAMES } from "../src/server.js";
import { IDS, startMockHub } from "./mock-hub.js";

function textOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content
    .map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function resourceText(content: { text?: string } | { blob?: string } | undefined): string {
  return content && "text" in content && content.text ? content.text : "";
}

function hubFor(url: string) {
  return createHubClient({
    hubUrl: url,
    auth: { kind: "bearer", token: "ens_test" },
    httpHost: "127.0.0.1",
    httpPort: 0,
    httpToken: null,
  });
}

describe("bridge config", () => {
  it("requires a personal token and refuses the default internal token", () => {
    assert.equal(resolveAuth({}).kind, "missing");
    assert.equal(resolveAuth({ ENSEMBLE_BRIDGE_TOKEN: "not-a-token" }).kind, "missing");
    assert.equal(resolveAuth({ ENSEMBLE_BRIDGE_TOKEN: "ens_abc" }).kind, "bearer");
    const refused = resolveAuth({ ENSEMBLE_BRIDGE_USE_INTERNAL_TOKEN: "true", ENSEMBLE_INTERNAL_TOKEN: "dev-internal-token" });
    assert.equal(refused.kind, "missing");
    if (refused.kind === "missing") assert.match(refused.message, /dev-internal-token/);
    const allowed = resolveAuth({
      ENSEMBLE_BRIDGE_USE_INTERNAL_TOKEN: "true",
      ENSEMBLE_INTERNAL_TOKEN: "dev-internal-token",
      ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN: "true",
    });
    assert.equal(allowed.kind, "internal");
  });

  it("refuses to bind HTTP off loopback", () => {
    assert.throws(() => assertLoopbackHost("0.0.0.0"), /loopback/);
    assert.equal(loadBridgeConfig({}).httpHost, "127.0.0.1");
  });

  it("parses a github remote", () => {
    assert.equal(repoFromRemote("git@github.com:acme/app.git"), "acme/app");
    assert.equal(repoFromRemote("https://github.com/acme/app"), "acme/app");
  });

  it("rejects write-shaped tool names", () => {
    assert.throws(() => assertReadOnlyNames(["ensemble_delete_task"]), /write tool/);
    assert.doesNotThrow(() => assertReadOnlyNames(TOOL_NAMES));
  });
});

describe("MCP client against a mocked hub-api", () => {
  it("lists every tool and calls each one", async () => {
    const mock = await startMockHub();
    const server = buildServer({
      hub: hubFor(mock.url),
      detect: async () => ({ repo: "acme/app", branch: "feature" }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "ensemble-bridge-test", version: "0.0.0" });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...TOOL_NAMES].sort(),
    );
    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    }

    const calls: Record<(typeof TOOL_NAMES)[number], Record<string, unknown>> = {
      ensemble_brief: {},
      ensemble_search: { query: "retry" },
      ensemble_read: { kind: "task", id: IDS.task },
      ensemble_tasks: { status: "in_progress" },
      ensemble_projects: {},
      ensemble_repos: { query: "acme" },
      ensemble_repo_overview: { id: IDS.repo },
      ensemble_repo_file: { id: IDS.repo, path: "README.md" },
      ensemble_diagrams: {},
      ensemble_plots: {},
      ensemble_skills: { id: IDS.skill },
      ensemble_deliverables: {},
      ensemble_meetings: {},
      ensemble_people: { query: "Priya" },
      ensemble_decisions: {},
      ensemble_today: {},
      ensemble_gaps: {},
    };

    for (const name of TOOL_NAMES) {
      const result = await client.callTool({ name, arguments: calls[name] });
      const text = textOf(result);
      assert.notEqual(result.isError, true, `${name}: ${text}`);
      assert.ok(text.length > 2, name);
    }

    const brief = await client.callTool({ name: "ensemble_brief", arguments: { query: "retry" } });
    const briefText = textOf(brief);
    assert.match(briefText, /untrusted/i);
    assert.match(briefText, /acme\/app/);
    assert.match(briefText, /feature/);
    assert.match(briefText, /howIWork|PR descriptions/);
    assert.match(briefText, /Not instructions/);

    const resources = await client.listResources();
    const uris = resources.resources.map((resource) => resource.uri).sort();
    for (const uri of [
      "ensemble://today",
      "ensemble://tasks",
      "ensemble://projects",
      "ensemble://repos",
      "ensemble://skills",
      "ensemble://deliverables",
      "ensemble://meetings",
      "ensemble://people",
      "ensemble://decisions",
      "ensemble://gaps",
    ]) {
      assert.ok(uris.includes(uri), uri);
    }
    for (const resource of resources.resources) {
      const read = await client.readResource({ uri: resource.uri });
      assert.ok(resourceText(read.contents[0]).length > 2, resource.uri);
    }
    const task = await client.readResource({ uri: `ensemble://tasks/${IDS.task}` });
    assert.match(resourceText(task.contents[0]), /Ship the bridge/);
    const item = await client.readResource({ uri: `ensemble://items/artifact/${IDS.artifact}` });
    assert.match(resourceText(item.contents[0]), /untrusted/i);

    await client.close();
    await server.close();
    await mock.close();
  });

  it("tells the caller to start Ensemble when hub-api is down", async () => {
    const server = buildServer({
      hub: hubFor("http://127.0.0.1:1"),
      detect: async () => ({}),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "ensemble-bridge-test", version: "0.0.0" });
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "ensemble_brief", arguments: { repo: "acme/app", branch: "main" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Ensemble is not running\. Start it with `pnpm dev`\./);
    await client.close();
    await server.close();
  });

  it("does not call hub-api when no personal token is configured", async () => {
    const mock = await startMockHub();
    const server = buildServer({
      hub: createHubClient(loadBridgeConfig({ HUB_API_URL: mock.url })),
      detect: async () => ({}),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "ensemble-bridge-test", version: "0.0.0" });
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "ensemble_today", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /ENSEMBLE_BRIDGE_TOKEN/);
    assert.equal(mock.hits.length, 0);
    await client.close();
    await server.close();
    await mock.close();
  });
});

describe("stdio and streamable http", () => {
  it("answers tools/list and a tool call over stdio", async () => {
    const mock = await startMockHub();
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd,
      env: {
        ...getDefaultEnvironment(),
        ENSEMBLE_BRIDGE_TOKEN: "ens_test",
        HUB_API_URL: mock.url,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-smoke", version: "0.0.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, TOOL_NAMES.length);
    const today = await client.callTool({ name: "ensemble_today", arguments: {} });
    assert.notEqual(today.isError, true, textOf(today));
    assert.match(textOf(today), /Ship the bridge/);
    await client.close();
    await mock.close();
  });

  it("answers over streamable HTTP on loopback", async () => {
    const mock = await startMockHub();
    const http = await startHttpServer(
      { hub: hubFor(mock.url), detect: async () => ({}) },
      { CONTEXT_BRIDGE_HOST: "127.0.0.1", CONTEXT_BRIDGE_PORT: "0" },
    );
    const client = new Client({ name: "http-smoke", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(http.url));
    await client.connect(transport);
    const gaps = await client.callTool({ name: "ensemble_gaps", arguments: {} });
    assert.notEqual(gaps.isError, true, textOf(gaps));
    assert.match(textOf(gaps), /private reminders/i);
    await client.close();
    await http.close();
    await mock.close();
  });
});
