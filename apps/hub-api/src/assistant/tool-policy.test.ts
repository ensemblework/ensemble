/**
 * Switching connected-app tools off for one caller (tool-policy.ts): the same answer for listing,
 * prompts, resolution and calls, across built-in suites, apps Ensemble searches and remote MCP servers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "../runtime/test-env.js";
import { DEFAULT_SETTINGS, type Settings } from "@ensemble/shared-types";
import { appToolsFor, appsPrompt, resolveTool, switchedOffForCaller, type AppGrant } from "./apps.js";
import { loadConnections } from "./connections.js";
import { buildMcpTools } from "./mcp-tools.js";
import { searchItems } from "../connectors/items/index.js";
import { appItemToolsForUser } from "./tools/app-items.js";
import { toolCatalog } from "./tool-catalog.js";
import { appKeyForProvider } from "./tool-policy.js";
import { appKeyForSource } from "./source-guard.js";
import { getTool } from "./registry.js";
import { repeatAssignment } from "../workspace/repeat.js";
import type { AnyHubTool, ToolContext } from "./types.js";

const GOOGLE: AppGrant = { provider: "google", account: "mira@fieldnote.example", scopes: [] };
const MICROSOFT: AppGrant = { provider: "microsoft", account: "mira@fieldnote.example", scopes: [] };
const GITHUB: AppGrant = { provider: "github", account: "mira", scopes: ["repo"] };
const NOTION: AppGrant = { provider: "notion", account: "Fieldnote", scopes: [] };

const server = (serverId: string, name: string, tools: string[], extra: Record<string, unknown> = {}) => ({
  id: `conn-${serverId}`,
  userId: "user-mira",
  serverId,
  name,
  status: "connected",
  clientInfo: null,
  lastError: null,
  tools: tools.map((tool) => ({ name: tool, description: `${tool} in ${name}.`, inputSchema: { type: "object" }, annotations: { readOnlyHint: tool.startsWith("get") } })),
  disabledTools: [] as string[],
  ...extra,
});

const ACME = server("custom-acme1", "Acme deploys", ["get_status", "deploy"]);

function ctx(grants: AppGrant[], toolsOff?: string[], servers = [ACME], settings: Settings = DEFAULT_SETTINGS): ToolContext {
  const prisma = {
    authToken: { findMany: async () => grants.map((grant) => ({ ...grant, meta: {} })), findUnique: async () => null },
    mcpConnection: { findMany: async ({ where }: { where?: { status?: string } } = {}) => servers.filter((row) => !where?.status || row.status === where.status) },
  };
  return { app: { log: { error() {} } } as never, prisma: prisma as never, userId: "user-mira", actor: "agent", settings, ...(toolsOff ? { toolsOff } : {}) };
}

const names = (tools: readonly AnyHubTool[]) => new Set(tools.map((tool) => tool.name));
const GOOGLE_KEY = appKeyForProvider("google");
const MICROSOFT_KEY = appKeyForProvider("microsoft");

test("a session that switches off Google and Microsoft keeps GitHub, Notion and the custom server", async () => {
  const all = names(await appToolsFor(ctx([GOOGLE, MICROSOFT, GITHUB, NOTION])));
  assert.ok(all.has("gmail_search") && all.has("outlook_search_mail") && all.has("apps_search") && [...all].some((name) => name.startsWith("mcp_")));

  const narrowed = ctx([GOOGLE, MICROSOFT, GITHUB, NOTION], [GOOGLE_KEY, MICROSOFT_KEY]);
  const left = names(await appToolsFor(narrowed));
  assert.equal([...left].some((name) => /^(gmail|calendar|drive|docs|sheets|slides|outlook|teams|onedrive|word|excel|powerpoint)_/.test(name)), false);
  assert.ok(left.has("apps_search"), "GitHub and Notion stay searchable");
  assert.ok([...left].some((name) => name.startsWith("mcp_") && name.endsWith("get_status")), "the custom server stays");

  // Not reachable by name either, and the refusal can say why.
  assert.equal(await resolveTool(narrowed, "gmail_search"), undefined);
  assert.equal(await switchedOffForCaller(narrowed, "gmail_search"), true);
  assert.ok(await resolveTool(narrowed, [...left].find((name) => name.endsWith("get_status"))!));
});

test("one tool can be switched off without its app, and a new session has everything", async () => {
  const one = names(await appToolsFor(ctx([GOOGLE], [`${GOOGLE_KEY}/gmail_search`])));
  assert.equal(one.has("gmail_search"), false);
  assert.ok(one.has("gmail_read") && one.has("calendar_list_events"));
  const fresh = names(await appToolsFor(ctx([GOOGLE], [])));
  assert.ok(fresh.has("gmail_search"));
});

test("a server's switched-off tools leave before the caps, and the server can go as a whole", () => {
  const many = server("custom-big", "Big", Array.from({ length: 45 }, (_, index) => `tool_${index}`));
  const capped = buildMcpTools([many as never]);
  assert.equal(capped.some((tool) => tool.mcp.toolName === "tool_44"), false, "past the per-server cap");
  const off = new Set(Array.from({ length: 10 }, (_, index) => `mcp:custom-big/tool_${index}`));
  const freed = buildMcpTools([many as never], { off });
  assert.equal(freed.some((tool) => tool.mcp.toolName === "tool_0"), false);
  assert.ok(freed.some((tool) => tool.mcp.toolName === "tool_44"), "room freed by the switched-off tools");
  assert.equal(buildMcpTools([many as never], { off: new Set(["mcp:custom-big"]) }).length, 0);
});

test("a search across apps never reaches a switched-off app, and a comment on its item is refused", async () => {
  const search = (await appItemToolsForUser(ctx([GITHUB, NOTION], ["notion"]))).find((tool) => tool.name === "apps_search")!;
  assert.ok(search.input.safeParse({ query: "roadmap", app: "github" }).success);
  assert.equal(search.input.safeParse({ query: "roadmap", app: "notion" }).success, false, "notion is not offered");
  const onlyRead = names(await appItemToolsForUser(ctx([GITHUB], ["github/apps_search"])));
  assert.equal(onlyRead.has("apps_search"), false);
  assert.ok(onlyRead.has("apps_read"));
  assert.equal((await appItemToolsForUser(ctx([GITHUB, NOTION], ["github", "notion"]))).length, 0);
  await assert.rejects(searchItems("user-mira", { source: "notion", q: "roadmap", only: ["github"] }), /switched off/);
});

test("the model is told only the names of switched-off apps, never their tools", async () => {
  const narrowed = ctx([GOOGLE, GITHUB], [GOOGLE_KEY]);
  const connections = await loadConnections(narrowed, await appToolsFor(narrowed));
  assert.equal(connections.connected.some((row) => row.id === GOOGLE_KEY), false);
  assert.deepEqual(connections.switchedOff, ["Google Workspace"]);
  const prompt = appsPrompt(connections, DEFAULT_SETTINGS);
  assert.match(prompt, /Switched off here by the person: Google Workspace/);
  assert.doesNotMatch(prompt, /gmail_/);
  const none = ctx([GOOGLE], [GOOGLE_KEY], []);
  assert.match(appsPrompt(await loadConnections(none, []), DEFAULT_SETTINGS), /^No connected app is on here\./);
});

test("the Tools catalog groups each app with its tools and says what the connection rules out", async () => {
  const pending = server("custom-wip1", "Work in progress", ["get_thing"], { status: "pending" });
  const settings: Settings = { ...DEFAULT_SETTINGS, assistant: { ...DEFAULT_SETTINGS.assistant, connectedAppWrites: false } };
  const { apps } = await toolCatalog(ctx([GOOGLE, GITHUB], undefined, [ACME, pending], settings));
  const google = apps.find((row) => row.key === GOOGLE_KEY)!;
  assert.equal(google.name, "Google Workspace");
  assert.equal(google.tools.find((tool) => tool.name === "gmail_search")?.title, "Search");
  assert.match(google.tools.find((tool) => tool.name === "calendar_create_event")?.blocked ?? "", /Changes in apps are off/);
  assert.ok(apps.find((row) => row.key === "github")?.tools.some((tool) => tool.name === "apps_search"));
  assert.equal(apps.find((row) => row.key === "mcp:custom-acme1")?.tools.length, 2);
  assert.equal(apps.find((row) => row.key === "mcp:custom-wip1")?.blocked, "Sign-in not finished");
});

test("Ensemble's own tools that read an app by name refuse it when it is switched off, wherever they run", async () => {
  const save = getTool("hub_save_app_item_as_page")!;
  const off = { ...ctx([NOTION], ["notion"]) };
  await assert.rejects(save.run(off, save.input.parse({ source: "notion", kind: "page", id: "abc" }) as never), /Notion is switched off here/);
  const meetings = getTool("hub_import_meeting_notes")!;
  await assert.rejects(Promise.resolve().then(() => meetings.preview!({ ...ctx([], [appKeyForSource("fireflies")!]) }, meetings.input.parse({ source: "fireflies", since: "2026-11-01T00:00:00.000Z" }) as never)), /switched off here/);
  assert.equal(appKeyForSource("jira"), appKeyForProvider("atlassian"));
  assert.equal(appKeyForSource("csv"), null, "a CSV is not a connected app");
});

test("a run that resumes, runs again or follows feedback keeps the apps its run switched off", () => {
  const old = {
    id: "5f1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f", taskId: "6a1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f", kind: "code", provider: "claude-code", model: "", reasoningEffort: null,
    instructions: "Fix the build", deviceId: "7b1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f", folderLabel: "site", externalRoot: null, repoPath: null, repoUrl: null, continueFromJobId: null,
    branchMode: "as-is", branch: null, delivery: "push", askBeforePublish: false, useCredentials: false, executionMode: "direct", networkAccess: true, markDone: false,
    unattended: false, accessMode: "auto", maxMinutes: 30, maxToolCalls: 100, maxTurns: 20, context: { toolsOff: ["google_workspace", "github/apps_search"] },
  };
  assert.deepEqual(repeatAssignment(old as never).toolsOff, ["google_workspace", "github/apps_search"]);
  assert.equal(repeatAssignment({ ...old, context: {} } as never).toolsOff, undefined);
});
