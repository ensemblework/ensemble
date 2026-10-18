/**
 * Connected apps as the assistant sees them, against an in-memory database: a Vercel token
 * account is named in the prompt and reached with apps_search, hub_list_connections lists every
 * connection without a secret, apps_search keeps its slot beside many MCP tools, and a guest in a
 * shared space sees none of the owner's connections. Vendors and the model are mocked.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { DEFAULT_SETTINGS, type AssistantStreamFrame, type Settings } from "@ensemble/shared-types";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";
import type { ToolContext } from "./types.js";

const h = await createHttpHarness();
// After the harness: these modules load the database client.
const { saveAccount } = await import("../connectors/accounts.js");
const { setItemFetchForTests } = await import("../connectors/items/index.js");
const { sealJson } = await import("../connectors/mcp/store.js");
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { runInScope } = await import("../sharing/context.js");
const { runAssistantTurn } = await import("./agent.js");
const { MAX_APP_TOOLS, appToolsFor, toolsForTurn } = await import("./apps.js");
const { loadConnections } = await import("./connections.js");
const { getTool } = await import("./registry.js");
after(() => h.close());

const VERCEL_TOKEN = "vercel_secret_token_0123456789abcdef";
const NOTION_TOKEN = "notion_secret_access_token_987";
const ACCOUNT = "shaaka127001-8910";
const settings: Settings = { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata" };

const context = (user: HttpUser): ToolContext => ({ app: h.app, prisma: h.prisma, userId: user.id, actor: "agent", settings });

async function run(user: HttpUser, name: string, input: unknown) {
  const tool = getTool(name)!;
  assert.ok(tool, name);
  return tool.run(context(user), tool.input.parse(input));
}

async function owner(): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name: "Mira Chen", emailVerifiedAt: new Date() } });
  await saveAccount(user.id, "vercel", { accessToken: VERCEL_TOKEN, account: ACCOUNT, meta: { username: ACCOUNT } });
  return user;
}

function tools(count: number, prefix: string) {
  return Array.from({ length: count }, (_unused, index) => ({ name: `${prefix}_${index}`, description: `${prefix} tool ${index}`, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }));
}

async function server(userId: string, serverId: string, name: string, data: { auth: string; status?: string; count?: number; token?: string; lastError?: string }) {
  await h.prisma.mcpConnection.create({
    data: {
      userId,
      serverId,
      name,
      url: `https://mcp.${serverId}.example.test/mcp`,
      status: data.status ?? "connected",
      clientInfo: sealJson({ auth: data.auth }),
      tokens: data.token ? sealJson({ access_token: data.token, token_type: "Bearer" }) : null,
      tools: tools(data.count ?? 3, serverId.replace(/[^a-z]/g, "")) as never,
      lastError: data.lastError ?? null,
    },
  });
}

const fetched: string[] = [];
setItemFetchForTests((async (input: string | URL | Request) => {
  const url = String(input);
  fetched.push(url);
  if (url.startsWith("https://api.vercel.com/v10/projects")) {
    return new Response(JSON.stringify({ projects: [{ id: "prj_fieldnote01", name: "fieldnote-site", framework: "nextjs", updatedAt: Date.parse("2026-10-17T10:00:00Z"), latestDeployments: [{ readyState: "READY" }] }] }), { status: 200 });
  }
  if (url.startsWith("https://api.vercel.com/v6/deployments")) return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
  return new Response(JSON.stringify({ error: { message: `unmocked ${url}` } }), { status: 599 });
}) as typeof fetch);

afterEach(() => {
  setAskRuntimeStreamForTests(null);
  fetched.length = 0;
});
after(() => setItemFetchForTests(null));

function script(calls: Array<{ name: string; arguments: Record<string, unknown> }>, answer: string) {
  const asked: Array<{ tools: string[]; system: string; messages: Array<{ role?: string; content?: unknown }> }> = [];
  let step = 0;
  setAskRuntimeStreamForTests(async (args) => {
    const messages = args.messages as Array<{ role?: string; content?: unknown }>;
    asked.push({ tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name), system: String(messages[0]?.content ?? ""), messages });
    step += 1;
    const turn: RuntimeTurn = {
      text: step === 1 && calls.length ? "" : answer,
      toolCalls: step === 1 ? calls.map((call, index) => ({ id: `call-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })) : [],
      model: "test-model",
      credits: 0,
      tokensIn: 10,
      tokensOut: 5,
      reasoning: "",
      raw: {},
      finishReason: "stop",
      cutOff: false,
    };
    if (turn.text) args.onDelta?.(turn.text);
    return turn;
  });
  return asked;
}

const MESSAGE = "can you see that Vercel is connected? can you list the projects on Vercel?";

test("a saved Vercel token is named in the prompt, and asking for Vercel projects offers and runs apps_search", async () => {
  const mira = await owner();
  const asked = script([{ name: "apps_search", arguments: { query: "projects", app: "vercel" } }], "Yes: fieldnote-site.");
  const frames: AssistantStreamFrame[] = [];
  const result = await runAssistantTurn({ app: h.app, userId: mira.id, conversationId: "conv-vercel", message: MESSAGE, settings, model: "test-model", emit: (frame) => frames.push(frame) });

  const first = asked[0]!;
  for (const name of ["apps_search", "apps_read", "hub_list_connections"]) assert.ok(first.tools.includes(name), `${name} is offered`);
  assert.match(first.system, /Connected apps in this space \(the complete list\):\n- Vercel \(token, as shaaka127001-8910\): deployments and projects via apps_search\/apps_read app "vercel"\./);
  assert.match(first.system, /## Playbook: Connected apps and bringing data in/, "naming a connected app loads the apps playbook");
  assert.match(first.system, /If they name an app that is not in this list, it is not connected in this space/);
  assert.doesNotMatch(JSON.stringify(asked), new RegExp(VERCEL_TOKEN), "the token never reaches the model");

  const call = result.toolCalls[0]!;
  assert.equal(call.name, "apps_search");
  assert.equal(call.state, "ok", call.error);
  assert.match(JSON.stringify(asked[1]!.messages.find((message) => message.role === "tool")?.content), /fieldnote-site/);
  assert.equal(fetched.length, 1, fetched.join("\n"));
  assert.match(fetched[0]!, /^https:\/\/api\.vercel\.com\/v10\/projects\?limit=10$/, "\"projects\" lists projects instead of searching for the word");
  assert.equal(result.content, "Yes: fieldnote-site.");
});

test("a query that only asks for a listing searches with an empty query, and a kind it names becomes the kind", async () => {
  const { listingRequest } = await import("./tools/app-items.js");
  assert.deepEqual(listingRequest("projects", ["vercel"]), { kind: "project" });
  assert.deepEqual(listingRequest("all my Vercel deployments", ["vercel"]), { kind: "deployment" });
  assert.deepEqual(listingRequest("recent pull requests", []), { kind: "pull_request" });
  assert.deepEqual(listingRequest("projects and deployments", ["vercel"]), {});
  assert.deepEqual(listingRequest("*", []), {});
  assert.deepEqual(listingRequest("", []), {});
  assert.equal(listingRequest("budget projects", []), null, "a word to look for keeps the search");
  assert.equal(listingRequest("ENG-42", []), null);
});

test("hub_list_connections lists each app with how it is connected and its account, and never a secret", async () => {
  const mira = await owner();
  await server(mira.id, "huggingface", "Hugging Face", { auth: "none", count: 4 });
  await server(mira.id, "notion", "Notion", { auth: "oauth", token: NOTION_TOKEN, count: 2 });
  await server(mira.id, "sentry", "Sentry", { auth: "oauth", status: "error", lastError: "Sentry sign-in has expired." });

  const listed = await run(mira, "hub_list_connections", {});
  const data = listed.data as { connections: Array<Record<string, unknown>>; notWorking?: Array<Record<string, unknown>> };
  const text = JSON.stringify(listed);
  assert.doesNotMatch(text, new RegExp(`${VERCEL_TOKEN}|${NOTION_TOKEN}`), "no token in the result");
  assert.equal(listed.summary, "3 apps connected in this space: Notion, Hugging Face and Vercel.");
  const vercel = data.connections.find((row) => row.app === "Vercel")!;
  assert.deepEqual(vercel.connected, ["token"]);
  assert.equal(vercel.account, ACCOUNT);
  assert.deepEqual(vercel.tools, ["apps_search", "apps_read"]);
  const hf = data.connections.find((row) => row.app === "Hugging Face")!;
  assert.deepEqual(hf.connected, ["MCP without sign-in, so public data only"]);
  assert.equal(hf.publicDataOnly, true);
  assert.deepEqual(hf.tools, ["mcp_huggingface_*"]);
  assert.deepEqual(data.connections.find((row) => row.app === "Notion")!.connected, ["MCP sign-in"]);
  assert.deepEqual(data.notWorking, [{ app: "Sentry", status: "not working", message: "Sentry sign-in has expired." }]);

  const one = await run(mira, "hub_list_connections", { app: "vercel" });
  assert.equal((one.data as { connections: unknown[] }).connections.length, 1);
  assert.equal((await run(mira, "hub_list_connections", { app: "Asana" })).summary, "Asana is not connected in this space. It can be connected in Settings → Connections.");

  const surface = await run(mira, "hub_read_surface", { path: "/settings?tab=connections" });
  assert.match(JSON.stringify(surface.data), /"app":"Vercel".*"account":"shaaka127001-8910"/);

  const prompt = (await loadConnections(context(mira), await appToolsFor(context(mira)))).connected.map((row) => row.name);
  assert.deepEqual(prompt, ["Notion", "Hugging Face", "Vercel"]);
});

test("apps_search and apps_read keep their place when MCP tools fill the app-tool cap", async () => {
  const mira = await owner();
  for (const id of ["linear", "sentry", "stripe"]) await server(mira.id, id, id, { auth: "oauth", token: `${id}-secret`, count: 40 });
  const offered = await appToolsFor(context(mira));
  const names = offered.map((tool) => tool.name);
  assert.ok(names.includes("apps_search") && names.includes("apps_read"), names.slice(0, 5).join(", "));
  assert.equal(offered.length, MAX_APP_TOOLS);
  assert.equal(names.filter((name) => name.startsWith("mcp_")).length, MAX_APP_TOOLS - 2);
  assert.ok(names.indexOf("apps_search") < names.findIndex((name) => name.startsWith("mcp_")), "item tools come before MCP tools");
  const connections = await loadConnections(context(mira), offered);
  assert.match(connections.connected.find((row) => row.id === "linear")!.uses.join(" "), /of its 40 own tools are offered this turn: mcp_linear_\*/);
});

test("a guest in a shared space sees none of the owner's connections", async () => {
  const mira = await owner();
  await server(mira.id, "huggingface", "Hugging Face", { auth: "none" });
  const sam = await h.asUser();
  await runInScope({ spaceId: mira.id, accountId: sam.id, access: { kind: "member", role: "editor", ownerId: mira.id } }, async () => {
    assert.deepEqual(await loadConnections(context(mira), []), { connected: [], broken: [] });
    const listed = await run(mira, "hub_list_connections", {});
    assert.deepEqual((listed.data as { connections: unknown[] }).connections, []);
    assert.match(listed.summary, /belong to this space's owner and stay private/);
    const offered = await toolsForTurn(context(mira));
    assert.equal(offered.some((tool) => tool.area === "apps"), false, "no app tools for a guest");
    assert.ok(offered.some((tool) => tool.name === "hub_list_connections"));

    const asked = script([], "Those apps are private to Mira.");
    await runAssistantTurn({ app: h.app, userId: mira.id, conversationId: "conv-guest", message: MESSAGE, settings, model: "test-model", emit: () => undefined });
    assert.doesNotMatch(asked[0]!.system, /shaaka127001|Hugging Face|- Vercel/, "the owner's connections are not in a guest's prompt");
    assert.match(asked[0]!.system, /connected apps, reminders and settings are private/);
    assert.equal(asked[0]!.tools.some((name) => name.startsWith("apps_") || name.startsWith("mcp_")), false);
  });
});
