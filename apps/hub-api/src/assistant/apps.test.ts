/**
 * Connected-app tools in the assistant: who is offered what, the Apply rule,
 * the prompt, and a whole turn with a scripted model. No vendor is called and
 * no database is needed.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import "../runtime/test-env.js";
import { DEFAULT_SETTINGS, personaBlock, personaFor, type AssistantStreamFrame, type Settings } from "@ensemble/shared-types";
import type { FastifyInstance } from "fastify";
import { setAskRuntimeStreamForTests, type RuntimeTurn } from "../lib/model-turn.js";
import { holdsAssistantWrite, runAssistantTurn } from "./agent.js";
import {
  MAX_APP_TOOLS,
  appToolsFor,
  appsPrompt,
  gateAppTools,
  registerAppToolSource,
  registerToolResolver,
  resolveTool,
  toolsForTurn,
  writeRefusal,
  type AppGrant,
} from "./apps.js";
import { APP_TOOL_LIST, catalog, chatToolSpecs, getTool } from "./registry.js";
import { ASSISTANT_INSTRUCTIONS, buildSystemPrompt } from "./state.js";
import { setAppTokenResolverForTests } from "./tools/apps-common.js";
import { defineTool, toolOk, type AnyHubTool, type ToolContext } from "./types.js";
import { z } from "zod";

const G = "https://www.googleapis.com/auth/";
const GOOGLE: AppGrant = { provider: "google", account: "mira@fieldnote.example", scopes: [`${G}gmail.readonly`, `${G}calendar.events`, `${G}drive.file`] };
const MICROSOFT: AppGrant = { provider: "microsoft", account: "mira@fieldnote.example", scopes: ["Mail.Read", "Calendars.ReadWrite", "Files.Read"] };

function settings(assistant: Partial<Settings["assistant"]> = {}, extra: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata", ...extra, assistant: { ...DEFAULT_SETTINGS.assistant, ...assistant } };
}

function ctx(value: Settings, grants: AppGrant[] = []): ToolContext {
  const prisma = {
    authToken: {
      findMany: async () => grants,
      findUnique: async ({ where }: { where: { userId_provider: { provider: string } } }) => grants.find((grant) => grant.provider === where.userId_provider.provider) ?? null,
    },
    user: { findUnique: async () => ({ name: "Mira Chen", onboardingRole: "lawyer" }) },
    mcpConnection: { findMany: async () => [] },
  };
  return { app: { log: { error() {} } } as never, prisma: prisma as never, userId: "user-mira", actor: "agent", settings: value };
}

const names = (tools: readonly AnyHubTool[]) => new Set(tools.map((tool) => tool.name));

test("app tools are offered only for connected suites and products that are on", async () => {
  const none = names(await appToolsFor(ctx(settings())));
  assert.equal(none.size, 0, "nothing connected, no app tools");

  const google = names(await appToolsFor(ctx(settings(), [GOOGLE])));
  for (const name of ["gmail_search", "calendar_create_event", "docs_create", "sheets_update_range", "slides_create"]) assert.ok(google.has(name), name);
  assert.equal([...google].some((name) => /^(outlook|teams|onedrive|word|excel|powerpoint)_/.test(name)), false, "Microsoft is not connected");

  const officeOff = settings({}, { connectorProducts: { microsoft_365: { office: false, teams: false } } });
  const both = names(await appToolsFor(ctx(officeOff, [GOOGLE, MICROSOFT])));
  assert.ok(both.has("outlook_calendar_create_event") && both.has("onedrive_search") && both.has("excel_read_range"));
  assert.equal(both.has("teams_list_chats"), false, "Teams switched off");
  assert.equal(both.has("word_create"), false, "Office writing switched off");

  const products = settings({}, { connectorProducts: { google_workspace: { gmail: false }, microsoft_365: { office: true, teams: true } } });
  const toggled = names(await appToolsFor(ctx(products, [GOOGLE, MICROSOFT])));
  assert.equal(toggled.has("gmail_search"), false, "a product switched off is not offered");
  assert.ok(toggled.has("word_create") && toggled.has("teams_read_chat"));
});

test("connectedAppWrites off hides app writes but keeps reads; Hub writes keep their own areas", async () => {
  const off = settings({ connectedAppWrites: false });
  const tools = await toolsForTurn(ctx(off, [GOOGLE]));
  const offered = names(tools);
  assert.ok(offered.has("calendar_list_events") && offered.has("gmail_read"));
  assert.equal(tools.some((tool) => tool.area === "apps" && tool.isWrite), false);
  assert.ok(offered.has("hub_create_tasks"), "Hub writes are not affected");

  const create = APP_TOOL_LIST.find((tool) => tool.name === "calendar_create_event")!;
  assert.equal(writeRefusal(create, off), "Changes in connected apps are turned off in your assistant settings.");
  assert.equal(writeRefusal(create, settings({ allowedWriteAreas: [] })), null, "apps is not one of the Hub areas");
  assert.equal(writeRefusal(getTool("hub_create_tasks")!, settings({ allowedWriteAreas: [] })), "Writes to tasks are disabled in your assistant settings.");
  assert.equal(writeRefusal(APP_TOOL_LIST.find((tool) => tool.name === "gmail_read")!, off), null);
});

test("app writes are held for Apply whatever the write policy says", () => {
  for (const policy of ["immediate", "preview", "needs-me"] as const) {
    assert.equal(holdsAssistantWrite(policy, "calendar_create_event", false, "apps"), true, policy);
    assert.equal(holdsAssistantWrite(policy, "mcp_notion_create_page", true, "apps"), true, policy);
  }
  assert.equal(holdsAssistantWrite("immediate", "hub_create_tasks", false, "tasks"), false);
});

test("other sources add per-person tools, the count is capped, and Apply resolves names through registered resolvers", async () => {
  const extra = defineTool({
    name: "mcp_notion_create_page",
    area: "apps",
    description: "Create a Notion page in the connected workspace (test double).",
    input: z.object({ title: z.string() }),
    isWrite: true,
    risk: "medium",
    run: async () => toolOk("made"),
  });
  const removeSource = registerAppToolSource(async () => [extra, { ...extra, name: "hub_list_tasks" }]);
  const removeResolver = registerToolResolver(async (_ctx, name) => (name === extra.name ? extra : undefined));
  try {
    const offered = names(await appToolsFor(ctx(settings(), [GOOGLE])));
    assert.ok(offered.has("mcp_notion_create_page"));
    assert.equal((await appToolsFor(ctx(settings({ connectedAppWrites: false })))).length, 0);
    // No remote MCP connections: the MCP resolver registered at startup finds nothing and the test resolver answers.
    const reader = { prisma: { mcpConnection: { findMany: async () => [] } } as never, userId: "user-mira" };
    assert.equal(await resolveTool(reader, "mcp_notion_create_page"), extra);
    assert.equal((await resolveTool(reader, "docs_create"))?.name, "docs_create");
    assert.equal((await resolveTool(reader, "hub_create_tasks"))?.name, "hub_create_tasks");
    assert.equal(await resolveTool(reader, "__proto__"), undefined);
  } finally {
    removeSource();
    removeResolver();
  }
  assert.equal(await resolveTool({ prisma: { mcpConnection: { findMany: async () => [] } } as never, userId: "u" }, "mcp_notion_create_page"), undefined);

  const many = Array.from({ length: MAX_APP_TOOLS + 5 }, (_unused, index) => ({ ...APP_TOOL_LIST[0]!, name: `mcp_x_${index}`, isWrite: false }));
  const gated = gateAppTools([getTool("hub_list_tasks")!, ...many], settings());
  assert.equal(gated.filter((tool) => tool.area === "apps").length, MAX_APP_TOOLS);
  assert.equal(gated[0]?.name, "hub_list_tasks");
  assert.ok(catalog().some((info) => info.name === "docs_create" && info.area === "apps" && info.isWrite));
  assert.equal(getTool("docs_create"), undefined, "the static Hub map does not dispatch app tools");
  const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
  const spec = chatToolSpecs([{ ...extra, jsonSchema: schema }])[0]!.function as { parameters: unknown };
  assert.deepEqual(spec.parameters, schema, "a tool's own JSON Schema is sent as-is");
});

test("the prompt describes the situation, the person and the connected apps instead of a role", () => {
  assert.doesNotMatch(ASSISTANT_INSTRUCTIONS, /You are/);
  assert.match(ASSISTANT_INSTRUCTIONS, /^This conversation is inside Ensemble, where the person keeps their tasks, pages, projects, people and the apps they connected\./);
  const tools = [...APP_TOOL_LIST.filter((tool) => tool.app?.provider === "google")];
  const apps = appsPrompt(tools, [GOOGLE], settings());
  assert.match(apps, /Google Workspace is connected as mira@fieldnote.example: Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Google Slides\./);
  assert.match(apps, /Not connected: Microsoft 365\./);
  assert.match(apps, /always waits for Apply/);
  assert.match(appsPrompt(tools.filter((tool) => !tool.isWrite), [GOOGLE], settings({ connectedAppWrites: false })), /switched off/);
  assert.match(appsPrompt([], [], settings()), /Not connected: Google Workspace and Microsoft 365/);

  const state = { proposed: 0, todo: [], inProgress: 0, needsMe: 0, projects: [], people: [], repos: [], skills: [], user: { firstName: "Mira", onboardingRole: "lawyer" } };
  const prompt = buildSystemPrompt(state, undefined, undefined, {
    persona: personaBlock(personaFor("general", "lawyer"), "Mira"),
    apps,
    today: "2026-10-07",
    weekday: "Wednesday",
    timezone: "Asia/Kolkata",
  });
  assert.match(prompt, /^This conversation is inside Ensemble, where Mira keeps their tasks/);
  assert.match(prompt, /When Mira asks for something in the workspace and a tool can do it, call the tool in this turn\./);
  assert.match(prompt, /Mira works as a lawyer; they usually want a clause summarised/);
  assert.match(prompt, /Connected apps:/);
  for (const rule of [/Never invent a person, project, repo, skill or task id/, /Choices:/, /press Apply to create it/, /YYYY-MM-DD/, /Never invent a citation or a source/, /block-diagram skill/]) assert.match(prompt, rule);
  assert.doesNotMatch(prompt, /Act as:|You are Ensemble|This preset changes tone/);

  assert.equal(personaFor("general", "vibe"), "engineer");
  assert.equal(personaFor("general", "Researcher"), "researcher");
  assert.equal(personaFor("teacher", "lawyer"), "teacher", "an explicit Act as wins");
  assert.equal(personaFor("general", "astronaut"), "general");
  assert.equal(personaFor("general", "constructor"), "general");
});

// ── a whole turn ───────────────────────────────────────────────────────────

interface TurnRecord {
  frames: AssistantStreamFrame[];
  asked: Array<{ messages: Array<Record<string, unknown>>; tools: string[] }>;
  fetches: string[];
}

const originalFetch = globalThis.fetch;
let record: TurnRecord;

beforeEach(() => {
  record = { frames: [], asked: [], fetches: [] };
  globalThis.fetch = (async (input: string | URL | Request) => {
    record.fetches.push(String(input));
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  setAppTokenResolverForTests(async (_userId, provider) => ({ token: "tok", account: "mira@fieldnote.example", scopes: provider === "google" ? GOOGLE.scopes : MICROSOFT.scopes }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setAppTokenResolverForTests(null);
  setAskRuntimeStreamForTests(null);
});

function fakeApp(grants: AppGrant[]): FastifyInstance {
  const sets = new Map<string, Set<string>>();
  const empty = () => ({ findMany: async () => [], findFirst: async () => null, findUnique: async () => null, count: async () => 0, create: async () => ({}) });
  const prisma = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "authToken") {
          return { findMany: async () => grants, findUnique: async () => (grants[0] ? { account: grants[0].account } : null) };
        }
        if (prop === "user") return { findUnique: async () => ({ name: "Mira Chen", onboardingRole: "lawyer" }) };
        return empty();
      },
    },
  );
  return {
    prisma,
    redis: {
      get: async () => null,
      set: async () => "OK",
      del: async () => 1,
      mget: async (...keys: string[]) => keys.map(() => null),
      sadd: async (key: string, value: string) => (sets.get(key) ?? sets.set(key, new Set()).get(key)!).add(value).size,
      srem: async () => 1,
      smembers: async (key: string) => [...(sets.get(key) ?? [])],
      expire: async () => 1,
    },
    log: { error() {}, info() {}, warn() {} },
  } as unknown as FastifyInstance;
}

function script(calls: Array<{ name: string; arguments: Record<string, unknown> }>, answer: string): void {
  let step = 0;
  setAskRuntimeStreamForTests(async (args) => {
    record.asked.push({
      messages: args.messages as Array<Record<string, unknown>>,
      tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name),
    });
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
}

async function turn(value: Settings, grants: AppGrant[]) {
  return runAssistantTurn({
    app: fakeApp(grants),
    userId: "user-mira",
    conversationId: "conv-apps",
    message: "Set up a design review with Sam on Wednesday at 3pm",
    settings: value,
    model: "test-model",
    emit: (frame) => record.frames.push(frame),
  });
}

const EVENT = { title: "Design review", start: "2026-10-14T15:00", attendees: ["sam@fieldnote.example"] };

test("a turn with writePolicy immediate still holds a calendar invite for Apply and sends nothing", async () => {
  script([{ name: "calendar_create_event", arguments: EVENT }], "Ready to apply: the design review invite.");
  const result = await turn(settings({ writePolicy: "immediate" }), [GOOGLE]);
  const call = result.toolCalls[0]!;
  assert.equal(call.state, "awaiting_approval");
  assert.equal(call.area, "apps");
  assert.equal(
    call.summary,
    "Create event “Design review” Wed 14 Oct 15:00–15:30 IST in Mira's calendar (mira@fieldnote.example) and email invites to sam@fieldnote.example.",
  );
  assert.ok(record.frames.some((frame) => frame.type === "pending" && frame.call.name === "calendar_create_event"));
  assert.equal(result.mutated, false);
  assert.deepEqual(record.fetches, [], "no request reached Google");
  assert.match(result.content, /press Apply/);

  const first = record.asked[0]!;
  assert.ok(first.tools.includes("calendar_create_event") && first.tools.includes("hub_create_tasks"));
  assert.equal(first.tools.some((name) => name.startsWith("outlook_")), false);
  const system = String(first.messages[0]?.content ?? "");
  assert.match(system, /^This conversation is inside Ensemble, where Mira keeps/);
  assert.match(system, /Mira works as a lawyer; they usually want/, "the onboarding role picks the persona when Act as is general");
  assert.match(system, /Google Workspace is connected as mira@fieldnote.example/);
  assert.match(system, /Not connected: Microsoft 365/);
  const toolMessage = record.asked[1]!.messages.find((message) => message.role === "tool");
  assert.match(String(toolMessage?.content ?? ""), /Nothing changes in the connected app, and nobody is emailed, until the person presses Apply/);
});

test("with app writes switched off the write is not offered, and a forced call is refused", async () => {
  script([{ name: "calendar_create_event", arguments: EVENT }], "I can't change your calendar.");
  const result = await turn(settings({ connectedAppWrites: false }), [GOOGLE]);
  assert.equal(record.asked[0]!.tools.includes("calendar_create_event"), false);
  assert.ok(record.asked[0]!.tools.includes("calendar_list_events"));
  assert.equal(result.toolCalls[0]?.state, "failed");
  assert.match(result.toolCalls[0]?.error ?? "", /There is no tool called calendar_create_event/);
});

test("a tool for a suite that is not connected cannot be called, and missing access is reported before Apply", async () => {
  script([{ name: "outlook_calendar_create_event", arguments: EVENT }], "Microsoft 365 is not connected.");
  const result = await turn(settings(), [GOOGLE]);
  assert.match(result.toolCalls[0]?.error ?? "", /There is no tool called outlook_calendar_create_event/);

  setAppTokenResolverForTests(async () => ({ token: "tok", account: null, scopes: [`${G}gmail.readonly`] }));
  script([{ name: "calendar_create_event", arguments: EVENT }], "Calendar access is missing.");
  const missing = await turn(settings(), [GOOGLE]);
  assert.equal(missing.toolCalls[0]?.state, "failed");
  assert.equal(missing.toolCalls[0]?.error, "Google Calendar is connected without the access this needs. Turn it on in Settings → Connections and approve the new permission.");
  assert.deepEqual(record.fetches, []);
});
