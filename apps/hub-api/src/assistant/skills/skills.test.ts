/**
 * The assistant's playbooks: every file parses, every tool it names exists, routing picks the
 * right playbook for real requests, a turn advertises the core tools plus the playbooks' tools,
 * and loading a playbook with hub_how_to brings its tools into the next step. No database.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "../../runtime/test-env.js";
import { DEFAULT_SETTINGS, catalogEntry, type Settings } from "@ensemble/shared-types";
import type { FastifyInstance } from "fastify";
import { setAskRuntimeStreamForTests, type RuntimeTurn } from "../../lib/model-turn.js";
import { runAssistantTurn } from "../agent.js";
import { appNames } from "../connections.js";
import { APP_TOOL_LIST, TOOL_NAMES, getTool } from "../registry.js";
import { assistantInstructions } from "../state.js";
import type { AnyHubTool } from "../types.js";
import { CORE_TOOLS, advertisedTools, allPlaybooks, appMap, findPlaybook, parsePlaybook, playbooksFor, routePlaybooks } from "./index.js";

const KNOWN = new Set([...TOOL_NAMES, ...APP_TOOL_LIST.map((tool) => tool.name), "apps_search", "apps_read", "apps_post_update"]);

test("every playbook parses and names only tools that exist", () => {
  const playbooks = allPlaybooks();
  assert.ok(playbooks.length >= 12, `found ${playbooks.length} playbooks`);
  const names = new Set<string>();
  for (const playbook of playbooks) {
    assert.match(playbook.name, /^[a-z][a-z-]+$/);
    assert.ok(!names.has(playbook.name), `duplicate ${playbook.name}`);
    names.add(playbook.name);
    assert.ok(playbook.body.length > 200, `${playbook.name} has steps`);
    assert.ok(playbook.when.length < 260, `${playbook.name}'s index line stays one line`);
    for (const tool of playbook.tools) assert.ok(KNOWN.has(tool) || playbook.requires.includes(tool), `${playbook.name} names unknown tool ${tool}`);
    for (const tool of playbook.requires) assert.ok(playbook.tools.includes(tool), `${playbook.name} uses what it requires`);
  }
  // A playbook whose tool this build does not have yet is not offered.
  for (const playbook of playbooksFor()) for (const tool of playbook.requires) assert.ok(KNOWN.has(tool), `${playbook.name} needs ${tool}`);
  assert.equal(playbooksFor().some((playbook) => playbook.name === "web-files"), KNOWN.has("hub_save_file"));
  for (const tool of CORE_TOOLS) assert.ok(KNOWN.has(tool), `core tool ${tool} exists`);
  assert.match(appMap(), /Map of Ensemble/);
  assert.match(findPlaybook("diagrams")!.body, /# Block diagrams/, "the diagrams playbook carries the block-diagram skill");
});

test("hub_how_to offers exactly the playbook names", () => {
  const tool = getTool("hub_how_to")!;
  assert.equal(tool.isWrite, false);
  const parsed = tool.input.safeParse({ name: "diagrams" });
  assert.ok(parsed.success);
  assert.equal(tool.input.safeParse({ name: "nonsense" }).success, false);
  for (const playbook of allPlaybooks()) {
    assert.ok(tool.input.safeParse({ name: playbook.name }).success, playbook.name);
    assert.ok(tool.description.includes(`${playbook.name}: `), `the description says what ${playbook.name} covers`);
  }
  assert.ok(tool.input.safeParse({ name: "map" }).success, "the map of Ensemble loads on demand");
});

const routed = (message: string, extra: { path?: string; mentions?: Array<{ kind: string }> } = {}, modules?: string | null) =>
  routePlaybooks({ message, ...extra }, playbooksFor(modules)).map((playbook) => playbook.name);

test("routing picks the playbook for the owner's example requests", () => {
  const cases: Array<[string, string]> = [
    ["Make a block diagram of the transformer architecture", "diagrams"],
    ["Turn this page into a flowchart", "diagrams"],
    ["Make a bar plot of revenue by region from sales.xlsx", "plots"],
    ["Filter my emails from Anureet in the past 4 days", "inbox"],
    ["Summarise my unread Slack messages", "inbox"],
    ["Find the PDF about the Q3 budget in my Google Drive", "apps"],
    ["Import all my Notion pages about pricing", "apps"],
    ["What meetings do I have tomorrow?", "calendar"],
    ["Write meeting notes for the design sync and list the action items", "meeting-notes"],
    ["Give me my weekly recap", "recap"],
    ["Which agents are running right now? Stop the one on the deck", "agents"],
    ["Where do I change my time zone?", "settings"],
    ["Move the onboarding task to in progress and mark the deck task done", "tasks"],
    ["Who is Mira and what parts are we testing?", "context"],
    ["Create a page with an outline for the launch plan", "pages"],
    ["Summarise the contract PDF I uploaded", "files"],
    ["Look up the latest reviews of the Pixel 10 and cite your sources", "web-research"],
  ];
  for (const [message, expected] of cases) assert.ok(routed(message).includes(expected), `${message} → ${routed(message).join(", ")}`);
  assert.deepEqual(routed("What is 17 times 23?"), [], "a plain question loads nothing");
  assert.deepEqual(routed("hello", { path: "/diagrams/abc" }), [], "the open page alone loads nothing");
  assert.deepEqual(routed("what tasks are left?", { path: "/board" }), ["tasks"]);
  assert.ok(routed("make it bigger", { mentions: [{ kind: "plot" }] }).includes("plots"), "a mention routes");
  assert.ok(routed("@task:Clone a repo do this on my machine", { mentions: [{ kind: "task" }] }).includes("agents"), "a task to run on their computer");
  assert.ok(routed("assign this task to an agent with my Careful profile").includes("agents"));
  assert.ok(routed("delete all tasks from the board").includes("tasks"));
  assert.ok(routed("x".repeat(10) + " diagram chart meeting email task recap").length <= 2, "at most two");
});

test("a custom board, by its name or a pasted link, routes to the boards playbook; the Ensemble board stays with tasks", () => {
  for (const message of [
    "work on my EnsembleWork board",
    "can you work on my custom board EnsembleWork?",
    "https://app.ensemblework.com/board?board=71182e17-5c4e-4b1a-9d2e-0a1b2c3d4e5f take the next card",
    "add a Review column to the Launch board",
    "make a new board for hiring with three columns",
    "move the deck note to Done on my research board",
  ]) assert.ok(routed(message).includes("boards"), `${message} → ${routed(message).join(", ")}`);
  assert.deepEqual(routed("delete all tasks from the board"), ["tasks"]);
  assert.deepEqual(routed("what tasks are left?", { path: "/board" }), ["tasks"]);
  const onBoard = (message: string) => routePlaybooks({ message, path: "/board", customBoard: true }, playbooksFor(undefined)).map((playbook) => playbook.name);
  for (const message of ["mark the onboarding task done", "move the onboarding task to in progress"]) {
    assert.ok(onBoard(message).includes("tasks") && onBoard(message).includes("boards"), `on a custom board, task work is about its cards: ${onBoard(message).join(", ")}`);
    assert.equal(routed(message, { path: "/board" }).includes("boards"), false, "not on the Ensemble board");
  }
  assert.deepEqual(onBoard("hello"), [], "the open board alone loads nothing");
  const boards = findPlaybook("boards")!;
  for (const name of ["hub_list_boards", "hub_read_board", "hub_move_to_board", "hub_update_task"]) assert.ok(boards.tools.includes(name), name);
  assert.match(boards.body, /pass it as board to hub_read_board exactly as given/);
  assert.match(boards.body, /never open a board's link in a browser and never ask the person to sign in/);
  assert.match(findPlaybook("tasks")!.body, /A custom board .*hub_how_to boards/);
  assert.match(getTool("hub_how_to")!.description, /\nboards: the person's own boards beside the Ensemble board/);
});

test("a message naming a connected app, or a meeting while a meeting app is connected, also loads the apps playbook", () => {
  const app = (id: string, meetings = false) => ({ names: appNames(catalogEntry(id)!), meetings });
  const route = (message: string, apps: Array<{ names: string[]; meetings?: boolean }>) => routePlaybooks({ message, apps }, playbooksFor(undefined)).map((playbook) => playbook.name);
  const hf = [app("huggingface")];
  assert.ok(route("Search Hugging Face for small speech models", hf).includes("apps"));
  assert.ok(route("what does huggingface say about whisper?", hf).includes("apps"), "its id works too");
  assert.equal(route("Search Hugging Face for small speech models", []).includes("apps"), false, "not when it is not connected");
  const vercel = route("can you see that Vercel is connected? can you list the projects on Vercel?", [app("vercel")]);
  assert.ok(vercel.includes("apps") && vercel.includes("tasks"), vercel.join(", "));
  const crowded = route("Add a task from my diagram chart email recap in Hugging Face", hf);
  assert.equal(crowded.length, 3, "the app adds a third playbook rather than pushing one out");
  assert.equal(crowded.at(-1), "apps");
  const close = [app("close")];
  assert.equal(route("close the deck task", close).includes("apps"), false, "an everyday word needs its capital");
  assert.ok(route("show my open deals in Close", close).includes("apps"));
  const notes = route("Summarise yesterday's meeting notes", [app("granola", true)]);
  assert.ok(notes.includes("meeting-notes") && notes.includes("apps"), notes.join(", "));
  assert.equal(route("Summarise yesterday's meeting notes", [app("vercel")]).includes("apps"), false);
  for (const message of ["what's connected?", "Which apps are connected here?", "Is Asana connected?", "list my connections"]) assert.ok(routed(message).includes("apps"), message);
  assert.ok(findPlaybook("apps")!.tools.includes("hub_list_connections") && findPlaybook("settings")!.tools.includes("hub_list_connections"));
});

test("module playbooks follow the person's modules", () => {
  assert.equal(playbooksFor("tasks").some((playbook) => playbook.name === "diagrams"), false);
  assert.equal(routed("Draw a flowchart of signup", {}, "tasks").includes("diagrams"), false);
  assert.ok(playbooksFor("diagrams,plots").some((playbook) => playbook.name === "plots"));
  assert.equal(findPlaybook("plots", "tasks"), undefined);
});

test("a turn shows the core tools plus the tools of the playbooks in play", () => {
  const all = [...TOOL_NAMES.map((name) => getTool(name)!), ...APP_TOOL_LIST] as AnyHubTool[];
  const bare = advertisedTools(all, []).map((tool) => tool.name);
  assert.deepEqual(new Set(bare), new Set(CORE_TOOLS.filter((name) => all.some((tool) => tool.name === name))));
  assert.ok(bare.length < 25, `a plain turn shows ${bare.length} tools, not ${all.length}`);
  const diagrams = advertisedTools(all, [findPlaybook("diagrams")!]).map((tool) => tool.name);
  assert.ok(diagrams.includes("hub_create_diagram") && diagrams.includes("hub_validate_diagram"));
  assert.equal(diagrams.includes("gmail_search"), false);
  const inbox = advertisedTools(all, [findPlaybook("apps")!]).map((tool) => tool.name);
  assert.ok(inbox.includes("gmail_search") && inbox.includes("docs_create"), "appTools brings every connected-app tool");
  process.env.ENSEMBLE_ASSISTANT_TOOLSETS = "off";
  try {
    assert.equal(advertisedTools(all, []).length, all.length);
  } finally {
    delete process.env.ENSEMBLE_ASSISTANT_TOOLSETS;
  }
});

test("the instructions name the open space and the playbooks, and stay the same for every message", () => {
  const state = { skills: [], user: { firstName: "Mira", onboardingRole: null, guestOf: null, spaceName: "Lab notebook" } };
  const prompt = assistantInstructions(state, { timezone: "UTC", playbooks: playbooksFor(undefined) });
  assert.match(prompt, /in their space “Lab notebook”/);
  assert.match(prompt, /Only this space is reachable; for another one, they switch spaces in the sidebar/);
  assert.match(prompt, /call hub_how_to with its name \(agents, apps, .*diagrams.*\)/);
  assert.doesNotMatch(prompt, /Map of Ensemble|## Playbook/);
  assert.ok(prompt.length < 2000, `instructions stay short (${prompt.length} chars)`);
});

// A whole turn with a scripted model --------------------------------------------------

afterEach(() => setAskRuntimeStreamForTests(null));

function fakeApp(): FastifyInstance {
  const sets = new Map<string, Set<string>>();
  const empty = () => ({ findMany: async () => [], findFirst: async () => null, findUnique: async () => null, count: async () => 0, create: async () => ({}) });
  const prisma = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "authToken") return { findMany: async () => [], findUnique: async () => null };
        if (prop === "user") return { findUnique: async () => ({ name: "Mira Chen", onboardingRole: null, spaceName: "Lab notebook", ownerId: "account-mira" }) };
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

test("hub_how_to loads a playbook mid-turn and its tools are offered on the next step", async () => {
  const asked: Array<{ tools: string[]; system: string }> = [];
  let step = 0;
  setAskRuntimeStreamForTests(async (args) => {
    asked.push({
      tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name),
      system: String((args.messages as Array<{ content?: unknown }>)[0]?.content ?? ""),
    });
    step += 1;
    const turn: RuntimeTurn = {
      text: step === 1 ? "" : "Here is how it fits together.",
      toolCalls: step === 1 ? [{ id: "call-0", name: "hub_how_to", arguments: JSON.stringify({ name: "diagrams" }) }] : [],
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
  const settings: Settings = { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata" };
  const result = await runAssistantTurn({
    app: fakeApp(),
    userId: "space-lab",
    conversationId: "conv-skills",
    message: "Help me understand our onboarding",
    settings,
    model: "test-model",
    emit: () => undefined,
  });
  assert.equal(result.toolCalls[0]?.name, "hub_how_to");
  assert.equal(result.toolCalls[0]?.state, "ok");
  assert.equal(asked[0]!.tools.includes("hub_create_diagram"), false, "not offered before the playbook is loaded");
  assert.ok(asked[0]!.tools.includes("hub_how_to"));
  assert.ok(asked[1]!.tools.includes("hub_create_diagram") && asked[1]!.tools.includes("hub_validate_diagram"), "offered after hub_how_to");
  assert.match(asked[0]!.system, /in their space “Lab notebook”/);
  assert.match(asked[0]!.system, /call hub_how_to with its name/);
});

test("a routed turn starts with the playbook's text, as a guide in the message, and its tools", async () => {
  const asked: Array<{ tools: string[]; system: string; message: string }> = [];
  setAskRuntimeStreamForTests(async (args) => {
    const messages = args.messages as Array<{ content?: unknown }>;
    asked.push({
      tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name),
      system: String(messages[0]?.content ?? ""),
      message: String(messages[messages.length - 1]?.content ?? ""),
    });
    const turn: RuntimeTurn = { text: "Sure.", toolCalls: [], model: "test-model", credits: 0, tokensIn: 1, tokensOut: 1, reasoning: "", raw: {}, finishReason: "stop", cutOff: false };
    args.onDelta?.(turn.text);
    return turn;
  });
  await runAssistantTurn({
    app: fakeApp(),
    userId: "space-lab",
    conversationId: "conv-skills-2",
    message: "Draw a block diagram of the transformer architecture",
    settings: { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata" },
    model: "test-model",
    emit: () => undefined,
  });
  assert.ok(asked[0]!.tools.includes("hub_create_diagram"));
  assert.match(asked[0]!.message, /<guide name="Diagrams and flowcharts">/);
  assert.match(asked[0]!.message, /Transformer \(encoder–decoder\)/);
  assert.match(asked[0]!.message, /<\/guide>\n\nDraw a block diagram of the transformer architecture$/, "the message comes last");
  assert.doesNotMatch(asked[0]!.system, /Diagrams and flowcharts|Transformer/, "a guide never changes the instructions");
});

test("a playbook with Windows line endings (a Windows checkout) parses like one with LF", () => {
  const unix = "---\nname: demo\ntitle: Demo\nwhen: always\ntools: hub_how_to\n---\n\n# Steps\n\n1. Do it.\n";
  const windows = unix.replace(/\n/g, "\r\n");
  const parsed = parsePlaybook(windows, "demo.md");
  assert.deepEqual(parsed, parsePlaybook(unix, "demo.md"));
  assert.ok(!parsed.body.includes("\r"));
});

test("Ensemble Code keeps local tools while staying within the provider's schema limit", async () => {
 const asked: string[][] = [];
 setAskRuntimeStreamForTests(async args => {
  asked.push(((args.chatTools ?? []) as Array<{ function: { name: string } }>).map(tool => tool.function.name));
  return { text: "Ready.", toolCalls: [], model: "test-model", credits: 0, tokensIn: 1, tokensOut: 1, reasoning: "", raw: {}, finishReason: "stop", cutOff: false };
 });
 const app = fakeApp(); const original = app.prisma;
 app.prisma = new Proxy(original, { get(target, prop) {
  if (prop === "authToken") return { findMany: async () => [{ provider: "google", account: "mira@fieldnote.example", scopes: [] }, { provider: "microsoft", account: "mira@fieldnote.example", scopes: [] }], findUnique: async () => null };
  return Reflect.get(target, prop);
 } });
 process.env.ENSEMBLE_ASSISTANT_TOOLSETS = "off";
 try {
  await runAssistantTurn({ app, userId: "space-lab", conversationId: "code-catalog", message: "Hello", settings: DEFAULT_SETTINGS, model: "test-model", code: { folder: "/tmp/fictional-project" }, emit() {} });
  assert.ok(asked[0]!.length <= 128, `${asked[0]!.length} schemas`);
  assert.ok(asked[0]!.includes("ensemble_start_agent"));
  assert.ok(asked[0]!.includes("code_read_file"));
 } finally { delete process.env.ENSEMBLE_ASSISTANT_TOOLSETS; }
});

test("Ensemble Code can load another area's tools during a turn", async () => {
 const seen: string[][] = []; let step = 0;
 setAskRuntimeStreamForTests(async args => {
  seen.push(((args.chatTools ?? []) as Array<{ function: { name: string } }>).map(tool => tool.function.name)); step++;
  return { text: step === 1 ? "" : "Ready.", toolCalls: step === 1 ? [{ id: "load-pages", name: "hub_how_to", arguments: JSON.stringify({ name: "pages" }) }] : [], model: "test-model", credits: 0, tokensIn: 1, tokensOut: 1, reasoning: "", raw: {}, finishReason: "stop", cutOff: false };
 });
 await runAssistantTurn({ app: fakeApp(), userId: "space-lab", conversationId: "code-load", message: "Help me organize", settings: DEFAULT_SETTINGS, model: "test-model", code: { folder: "/tmp/fictional-project" }, emit() {} });
 assert.equal(seen[0]!.includes("hub_create_page"), false);
 assert.ok(seen[1]!.includes("hub_create_page"));
 assert.ok(seen[1]!.includes("ensemble_start_agent"));
});
