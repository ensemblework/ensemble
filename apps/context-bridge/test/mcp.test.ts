import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { ACTION_TOOL_NAMES, APP_TOOL_NAMES, buildServer, buildServerForKey, TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/server.js";
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

describe("task updates through the bridge", () => {
  it("offers the write tools only to a key that may update tasks, and sends them as writes", async () => {
    const readOnly = await startMockHub();
    const writer = await startMockHub({ canWrite: true });
    try {
      const connect = async (server: Awaited<ReturnType<typeof buildServerForKey>>) => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: "ensemble-bridge-test", version: "0.0.0" });
        await client.connect(clientTransport);
        return client;
      };
      const plain = await connect(await buildServerForKey({ hub: hubFor(readOnly.url) }));
      const names = (await plain.listTools()).tools.map((tool) => tool.name);
      for (const name of WRITE_TOOL_NAMES) assert.ok(!names.includes(name), name);

      const client = await connect(await buildServerForKey({ hub: hubFor(writer.url) }));
      const tools = (await client.listTools()).tools;
      for (const name of WRITE_TOOL_NAMES) {
        const tool = tools.find((row) => row.name === name);
        assert.ok(tool, name);
        assert.equal(tool.annotations?.readOnlyHint, false, name);
        assert.equal(tool.annotations?.destructiveHint, false, name);
      }
      const updated = await client.callTool({ name: "ensemble_update_task", arguments: { task: `ensemble://task/${IDS.task}`, status: "in_progress", note: "Started on the retry helper." } });
      assert.notEqual(updated.isError, true, textOf(updated));
      const created = await client.callTool({ name: "ensemble_create_task", arguments: { title: "Document the retry helper", from: `ensemble://task/${IDS.task}` } });
      assert.notEqual(created.isError, true, textOf(created));
      assert.deepEqual(writer.writes.map((row) => [row.method, row.path]), [
        ["PATCH", `/api/bridge/write/tasks/${encodeURIComponent(`ensemble://task/${IDS.task}`)}`],
        ["POST", "/api/bridge/write/tasks"],
      ]);
      assert.deepEqual(writer.writes[0]!.body, { status: "in_progress", note: "Started on the retry helper." });
    } finally {
      await readOnly.close();
      await writer.close();
    }
  });
});

describe("actions, files and apps through the bridge", () => {
  const connect = async (server: Awaited<ReturnType<typeof buildServerForKey>>) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "ensemble-bridge-test", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  };

  it("runs actions, uploads a local file by path, and offers apps only to a key with apps allowed", async () => {
    const writer = await startMockHub({ canWrite: true, canUseApps: true });
    const dir = await mkdtemp(join(tmpdir(), "ensemble-upload-"));
    try {
      await writeFile(join(dir, "deck.pdf"), Buffer.from("%PDF-1.4 tiny"));
      const client = await connect(await buildServerForKey({ hub: hubFor(writer.url) }));
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of [...ACTION_TOOL_NAMES, ...APP_TOOL_NAMES, ...WRITE_TOOL_NAMES]) assert.ok(names.includes(name), name);
      const apps = (await client.listTools()).tools.find((tool) => tool.name === "ensemble_apps");
      assert.match(apps?.description ?? "", /Connected now: Notion, GitHub/);

      const listed = await client.callTool({ name: "ensemble_actions", arguments: {} });
      assert.match(textOf(listed), /"description": "Make a page\."/, "a short list gives each action's first sentence");
      const acted = await client.callTool({ name: "ensemble_act", arguments: { action: "hub_create_page", input: { title: "Notes" } } });
      assert.notEqual(acted.isError, true, textOf(acted));
      const uploaded = await client.callTool({ name: "ensemble_upload_file", arguments: { path: join(dir, "deck.pdf"), attachTo: `ensemble://task/${IDS.task}` } });
      assert.notEqual(uploaded.isError, true, textOf(uploaded));
      const called = await client.callTool({ name: "ensemble_app_call", arguments: { tool: "apps_search", input: { query: "roadmap" } } });
      assert.notEqual(called.isError, true, textOf(called));
      assert.deepEqual(writer.writes.map((row) => row.path), ["/api/bridge/act/hub_create_page", "/api/bridge/write/files", "/api/bridge/act/apps_search"]);
      assert.deepEqual(writer.writes[0]!.body, { input: { title: "Notes" } });
      const file = writer.writes[1]!.body as { filename: string; dataBase64: string; attachTo: string };
      assert.equal(file.filename, "deck.pdf");
      assert.equal(Buffer.from(file.dataBase64, "base64").toString(), "%PDF-1.4 tiny");
      assert.equal(file.attachTo, `ensemble://task/${IDS.task}`);

      // Ensemble on the web cannot read the editor's disk.
      const hosted = await connect(buildServer({ hub: hubFor(writer.url), canWrite: true, localFiles: false }));
      const refused = await hosted.callTool({ name: "ensemble_upload_file", arguments: { path: join(dir, "deck.pdf") } });
      assert.equal(refused.isError, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await writer.close();
    }
    const plain = await startMockHub({ canWrite: true });
    try {
      const names = (await (await connect(await buildServerForKey({ hub: hubFor(plain.url) }))).listTools()).tools.map((tool) => tool.name);
      for (const name of APP_TOOL_NAMES) assert.ok(!names.includes(name), name);
    } finally {
      await plain.close();
    }
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
      [...TOOL_NAMES, ...ACTION_TOOL_NAMES].sort(),
    );
    for (const tool of listed.tools) {
      if (tool.name === "ensemble_act") continue;
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    }

    const calls: Record<(typeof TOOL_NAMES)[number], Record<string, unknown>> = {
      ensemble_brief: {},
      ensemble_context: { item: `ensemble://task/${IDS.task}` },
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
    assert.equal(listed.tools.length, TOOL_NAMES.length + ACTION_TOOL_NAMES.length);
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
