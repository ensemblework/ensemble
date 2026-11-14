import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCatalogServer } from "../src/catalog.js";
import type { HubClient, HubCallOptions } from "../src/hub.js";

type Called = { path: string; input: unknown; options?: HubCallOptions };

async function fixture(write = true, apps = true) {
  const called: Called[] = [];
  const hub: HubClient = {
    get: async (path) => {
      if (path === "/api/bridge/actions") return {
        actions: [
          { name: "hub_list_tasks", group: "tasks", description: "List tasks.", write: false, allowed: true, inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false } },
          { name: "hub_manage_page", group: "pages", description: "Change a page.", write: true, allowed: write, inputSchema: { $id: "https://provider.example.test/manage-page", type: "object", properties: { operation: { type: "string", enum: ["create", "delete"] }, title: { type: "string" } }, required: ["operation", "title"], additionalProperties: false } },
        ],
      };
      if (path === "/api/bridge/apps") return {
        tools: [
          { name: "remote_read", group: "apps", description: "Read an app record.", write: false, allowed: true, inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
          { name: "remote_send", group: "apps", description: "Send a message.", write: true, allowed: write, inputSchema: { type: "object", properties: { space: { type: "string" }, message: { type: "string" } }, required: ["space", "message"], additionalProperties: false } },
          ...["a", "b"].map(end => ({ name: `remote_${"long_tool_name_".repeat(5)}${end}`, group: "apps", description: "Read a remote record.", write: false, allowed: true, inputSchema: { type: "object", properties: {}, additionalProperties: false } })),
        ],
      };
      if (path === "/api/bridge/spaces") return { spaces: [{ id: "home", name: "Home", usable: true }, { id: "side", name: "Side", usable: true }, { id: "shared", name: "Shared", usable: false, refusal: "This key cannot use shared spaces." }] };
      if (path === "/api/bridge/tasks") return { tasks: [{ title: "Catalog task" }] };
      throw new Error(`Unexpected catalog read: ${path}`);
    },
    post: async (path, input, options) => {
      called.push({ path, input, options });
      return { done: true };
    },
  };
  const server = await buildCatalogServer({ hub, canWrite: write, canUseApps: apps, detect: async () => ({}) });
  const client = new Client({ name: "catalog-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, called, close: async () => { await client.close(); await server.close(); } };
}

test("catalog reuses core tools, removes catch-alls, and publishes complete annotations and OAuth schemes", async () => {
  const f = await fixture();
  try {
    const tools = (await f.client.listTools()).tools;
    const names = tools.map(tool => tool.name);
    for (const name of ["ensemble_brief", "ensemble_context", "ensemble_tasks", "ensemble_get_file", "ensemble_spaces", "ensemble_upload_file"]) assert.ok(names.includes(name));
    for (const name of ["ensemble_act", "ensemble_actions", "ensemble_apps", "ensemble_app_call"]) assert.equal(names.includes(name), false);
    assert.equal(new Set(names).size, names.length);
    for (const tool of tools) {
      assert.ok(tool.name.length <= 64, tool.name);
      assert.ok(tool.title, tool.name);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name}.${hint}`);
      }
      assert.ok(tool._meta?.securitySchemes);
    }
    const read = await f.client.callTool({ name: "ensemble_tasks", arguments: { limit: 2 } });
    assert.equal(read.isError, undefined);
    assert.match(JSON.stringify(read), /Catalog task/);
    assert.equal(tools.find(tool => tool.name === "ensemble_docs")?.annotations?.openWorldHint, true);
  } finally {
    await f.close();
  }
});

test("each operation is bound to its action, with real schemas and no arbitrary action dispatch", async () => {
  const f = await fixture();
  try {
    const tools = (await f.client.listTools()).tools;
    const create = tools.find(tool => tool.name.startsWith("ensemble_action_manage_page_create_"));
    const remove = tools.find(tool => tool.name.startsWith("ensemble_action_manage_page_delete_"));
    assert.ok(create && remove);
    const done = await f.client.callTool({ name: create.name, arguments: { title: "A page" } });
    assert.equal(done.isError, undefined);
    assert.deepEqual(f.called.at(-1), { path: "/api/bridge/act/hub_manage_page", input: { input: { title: "A page", operation: "create" } }, options: undefined });
    const wrong = await f.client.callTool({ name: create.name, arguments: { title: "A page", operation: "delete" } });
    assert.equal(wrong.isError, true);
    const invalid = await f.client.callTool({ name: remove.name, arguments: { title: 3 } });
    assert.equal(invalid.isError, true);
    const arbitrary = await f.client.callTool({ name: remove.name, arguments: { title: "A page", action: "hub_delete_everything" } });
    assert.equal(arbitrary.isError, true);
    assert.equal(f.called.length, 1);
    const removed = await f.client.callTool({ name: remove.name, arguments: { title: "A page", operation: "delete" } });
    assert.equal(removed.isError, undefined);
    assert.deepEqual(f.called.at(-1)?.input, { input: { title: "A page", operation: "delete" } });
    const wrongVariant = await f.client.callTool({ name: remove.name, arguments: { title: "A page", operation: "create" } });
    assert.equal(wrongVariant.isError, true);
    assert.equal(f.called.length, 2);
  } finally {
    await f.close();
  }
});

test("a provider's own space argument is preserved while the outer Ensemble space is checked", async () => {
  const f = await fixture();
  try {
    const response = await f.client.callTool({ name: "ensemble_app_remote_send", arguments: { input: { space: "provider-room", message: "Hello" }, space: "Side" } });
    assert.equal(response.isError, undefined);
    assert.deepEqual(f.called.at(-1), {
      path: "/api/bridge/act/remote_send", input: { input: { space: "provider-room", message: "Hello" } }, options: { space: "side" },
    });
    const shared = await f.client.callTool({ name: "ensemble_app_remote_send", arguments: { input: { space: "provider-room", message: "Hello" }, space: "Shared" } });
    assert.equal(shared.isError, true);
    assert.equal(f.called.length, 1);
  } finally {
    await f.close();
  }
});

test("read-only catalog hides writes and app-free grants do not load app tools", async () => {
  const f = await fixture(false, false);
  try {
    const tools = (await f.client.listTools()).tools;
    assert.equal(tools.some(tool => tool.name.startsWith("ensemble_app_")), false);
    assert.equal(tools.some(tool => tool.name.includes("manage_page")), false);
    assert.equal(tools.some(tool => tool.name === "ensemble_upload_file"), false);
    assert.ok(tools.every(tool => tool.annotations?.readOnlyHint === true));
  } finally {
    await f.close();
  }
});
