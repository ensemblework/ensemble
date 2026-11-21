/**
 * Ensemble's own loop with a scripted model (docs/11, Turn limits): reads that run together, writes in
 * order, long results kept for read_tool_output, runaway detection, step budgets by model class and the
 * checkpoint of an uncapped turn, compaction, the history budget, model calls asked again after a
 * failure the runtime does not retry itself, a turn that ends without words, and a reply's claims of
 * what reached the chat.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import "../runtime/test-env.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { DEFAULT_SETTINGS, INCLUDED_PROVIDER, type AssistantStreamFrame } from "@ensemble/shared-types";
import { runAssistantTurn } from "./agent.js";
import { errorFromStreamFrame, setAskRuntimeStreamForTests, setModelRetryWaitForTests, type ModelMessage, type RuntimeTurn } from "../lib/model-turn.js";
import { RuntimeError } from "../lib/runtime-error.js";
import { safePublicError } from "../lib/text.js";
import { saveAiActivityForTests } from "../lib/ai-activity.js";
import { defineTool, toolOk, type AnyHubTool, type ToolResult } from "./types.js";
import { resetLoopConfigCache } from "./loop-config.js";
import { readableText } from "./tool-output.js";
import { CHARS_PER_TOKEN, compactMessages, estimateTokens, HISTORY_LEFT_OUT } from "./compaction.js";
import { resultDigest, RunawayGuard } from "./runaway.js";
import { checkDelivery, deliveredWith } from "../node/delivery-claims.js";

type Call = { name: string; input?: Record<string, unknown> };
type Reply = { calls?: Call[]; text?: string } | Error;
type Seen = { messages: ModelMessage[]; tools: string[]; toolChars: number };
type Row = { role: string; content: string };
type Metric = { kind?: string; payload?: Record<string, unknown> };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

saveAiActivityForTests(async () => undefined);
after(() => saveAiActivityForTests(null));

afterEach(() => {
  setAskRuntimeStreamForTests(null);
  setModelRetryWaitForTests(null);
  delete process.env.ENSEMBLE_LOOP_CONFIG;
  resetLoopConfigCache();
});

/** A scripted model: `reply` gets every request (with the tools it offered) and says what the model does. */
function script(reply: (seen: Seen, index: number) => Reply): Seen[] {
  const seen: Seen[] = [];
  setAskRuntimeStreamForTests(async (args) => {
    const current: Seen = {
      messages: args.messages.map((message) => ({ ...message })),
      tools: (args.chatTools as Array<{ function: { name: string } }>).map((spec) => spec.function.name),
      toolChars: args.chatTools?.length ? JSON.stringify(args.chatTools).length : 0,
    };
    seen.push(current);
    const next = reply(current, seen.length - 1);
    if (next instanceof Error) throw next;
    const calls = next.calls ?? [];
    const text = calls.length ? "" : (next.text ?? "");
    if (text) args.onDelta?.(text);
    const turn: RuntimeTurn = {
      text,
      toolCalls: calls.map((call, index) => ({ id: `call-${seen.length}-${index}`, name: call.name, arguments: JSON.stringify(call.input ?? {}) })),
      model: "test-model",
      credits: 0,
      tokensIn: 1,
      tokensOut: 1,
      reasoning: "",
      raw: {},
      finishReason: "stop",
      cutOff: false,
    };
    return turn;
  });
  return seen;
}

function fakeApp(history: Row[] = [], metrics: Metric[] = []): FastifyInstance {
  const empty = () => ({ findMany: async () => [], findFirst: async () => null, findUnique: async () => null, count: async () => 0, create: async () => ({}) });
  const db = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "user") return { findUnique: async () => ({ name: "Mira Chen", onboardingRole: null, spaceName: null, ownerId: null }) };
        if (prop === "assistantMessage") {
          return {
            ...empty(),
            findMany: async (query: { take?: number }) =>
              [...history].reverse().slice(0, query.take ?? history.length).map((row) => ({ ...row, toolCalls: [], mentions: null, outside: null })),
          };
        }
        if (prop === "metricEvent") {
          return {
            create: async ({ data }: { data: Metric }) => {
              metrics.push(data);
              return data;
            },
          };
        }
        return empty();
      },
    },
  );
  return {
    prisma: db,
    redis: { get: async () => null, set: async () => "OK", del: async () => 1, mget: async (...keys: string[]) => keys.map(() => null), sadd: async () => 1, srem: async () => 1, smembers: async () => [], expire: async () => 1 },
    log: { error() {}, info() {}, warn() {} },
  } as unknown as FastifyInstance;
}

function read(name: string, run: (input: Record<string, unknown>) => Promise<ToolResult>): AnyHubTool {
  return defineTool({ name, area: "context", description: `Read (${name}).`, input: z.object({}).passthrough(), isWrite: false, parallelSafe: true, risk: "low", run: (_ctx, input) => run(input) });
}

function turn(options: { app?: FastifyInstance; provider?: string; tools: AnyHubTool[]; frames?: AssistantStreamFrame[]; message?: string; agentPersona?: string }) {
  return runAssistantTurn({
    app: options.app ?? fakeApp(),
    userId: "loop-user",
    conversationId: "loop-conversation",
    message: options.message ?? "Do the work.",
    settings: DEFAULT_SETTINGS,
    model: "test-model",
    ...(options.provider ? { provider: options.provider } : {}),
    extraTools: options.tools,
    ...(options.agentPersona ? { agentPersona: options.agentPersona } : {}),
    emit: (frame) => options.frames?.push(frame),
  });
}

const toolMessages = (seen: Seen) => seen.messages.filter((message) => message.role === "tool");
const resultOf = (message: ModelMessage | undefined) => JSON.parse(String(message?.content ?? "{}")) as Record<string, unknown>;

test("reads in one step run at the same time and keep the model's order; writes run alone, in order", async () => {
  const timeline: string[] = [];
  let running = 0;
  let most = 0;
  const timed = async (name: string, ms: number) => {
    running += 1;
    most = Math.max(most, running);
    timeline.push(`start ${name}`);
    await sleep(ms);
    timeline.push(`end ${name}`);
    running -= 1;
  };
  const reader = (name: string, ms: number) =>
    read(name, async () => {
      await timed(name, ms);
      return toolOk(`Read ${name}.`, { name });
    });
  const writer = (name: string) =>
    defineTool({
      name,
      area: "tasks",
      description: "Write.",
      input: z.object({}),
      isWrite: true,
      risk: "low",
      async run() {
        await timed(name, 5);
        return toolOk(`Wrote ${name}.`);
      },
    });
  const seen = script((_seen, index) => (index === 0 ? { calls: [{ name: "write_first" }, { name: "read_slow" }, { name: "read_fast" }, { name: "write_last" }] } : { text: "All done." }));
  const result = await turn({ tools: [writer("write_first"), reader("read_slow", 40), reader("read_fast", 5), writer("write_last")] });
  assert.match(result.content, /^All done\./);
  assert.deepEqual(timeline, ["start write_first", "end write_first", "start read_slow", "start read_fast", "end read_fast", "end read_slow", "start write_last", "end write_last"]);
  assert.equal(most, 2, "the two reads ran together, the writes alone");
  assert.deepEqual(toolMessages(seen[1]!).map((message) => message.name), ["write_first", "read_slow", "read_fast", "write_last"], "results follow the model's order, not the finish order");
  assert.deepEqual(result.toolCalls.map((call) => [call.name, call.state]), [["write_first", "ok"], ["read_slow", "ok"], ["read_fast", "ok"], ["write_last", "ok"]]);
});

test("a long result keeps its start and end in place and the whole for read_tool_output, by offset and by grep", async () => {
  const log = Array.from({ length: 2000 }, (_, index) => `line ${index + 1}: ${index === 1500 ? "the needle is here" : "plain text"}`).join("\n");
  const kept = readableText({ log });
  const seen = script((current, index) => {
    if (index === 0) return { calls: [{ name: "read_log" }] };
    if (index === 1) return { calls: [{ name: "read_tool_output", input: { id: "out_1", offset: 30_000, length: 120 } }] };
    if (index === 2) return { calls: [{ name: "read_tool_output", input: { id: "out_1", grep: "NEEDLE", context: 1 } }] };
    return { text: "Found it on line 1501." };
  });
  const result = await turn({ provider: INCLUDED_PROVIDER, tools: [read("read_log", async () => toolOk("Read the log.", { log }))] });
  assert.equal(result.content, "Found it on line 1501.");
  assert.ok(!seen[0]!.tools.includes("read_tool_output"), "offered only once something was kept");
  assert.ok(seen[1]!.tools.includes("read_tool_output"));
  const cut = resultOf(toolMessages(seen[1]!)[0]);
  assert.equal(cut.output, "out_1");
  assert.ok(String(cut.preview).length < 8_000, "an included model sees about 8,000 characters in place");
  assert.match(String(cut.preview), /^\{\n {2}"log": \nline 1: plain text/);
  assert.match(String(cut.preview), /line 2000: plain text\n\n\}$/, "the end survives");
  assert.match(String(cut.note), /kept as out_1 \(\d+ KB, 2,004 lines\)/);
  assert.match(String(cut.note), /read_tool_output/);
  const part = resultOf(toolMessages(seen[2]!)[1]).data as Record<string, unknown>;
  assert.deepEqual([part.text, part.offset, part.next], [kept.slice(30_000, 30_120), 30_000, 30_120]);
  const found = resultOf(toolMessages(seen[3]!)[2]).data as Record<string, unknown>;
  assert.equal(found.matches, 1);
  assert.match(String(found.text), /^ 1502 @\d+: line 1500: plain text\n>1503 @\d+: line 1501: the needle is here\n 1504 @\d+: line 1502: plain text$/);
});

test("the same call repeated gets one nudge, then the turn ends with an answer from what it has", async () => {
  let runs = 0;
  const metrics: Metric[] = [];
  const seen = script((current) => (current.tools.length ? { calls: [{ name: "read_same", input: { query: "status", page: 1 } }] } : { text: "Here is what I found." }));
  const result = await turn({ app: fakeApp([], metrics), provider: "openai", tools: [read("read_same", async () => (runs += 1, toolOk("Same answer.", { status: "unchanged" })))] });
  assert.equal(runs, 5, "the fifth identical call is the last");
  assert.equal(seen.length, 6);
  const nudges = seen.map((current) => current.messages.filter((message) => message.role === "user" && /same input 3 times/.test(String(message.content))).length);
  assert.deepEqual(nudges, [0, 0, 0, 1, 1, 1], "one nudge, after the third");
  assert.deepEqual(seen[5]!.tools, [], "the answer that ends it has no tools");
  assert.ok(seen[5]!.messages.some((message) => message.role === "system" && /kept repeating the same call/.test(String(message.content))));
  assert.equal(result.content, "Here is what I found.");
  const loop = metrics.find((row) => row.kind === "assistant.turn")?.payload?.loop as Record<string, unknown>;
  assert.deepEqual([loop.runaway, loop.nudges, loop.cap], ["repeat", 1, null]);
});

test("steps where every call fails end the turn; with no answer from the model it says so itself", async () => {
  const seen = script((current, index) => (current.tools.length ? { calls: [{ name: "read_broken", input: { attempt: index } }] } : { text: "" }));
  const result = await turn({
    provider: "openai",
    tools: [
      read("read_broken", async () => {
        throw new Error("The service said no.");
      }),
    ],
  });
  assert.equal(seen.length, 9, "eight failing steps, then the answer");
  assert.deepEqual(seen[8]!.tools, []);
  assert.equal(result.content, "I stopped because every step I tried kept failing. Nothing was changed.");
  assert.ok(!/[{}]/.test(result.content));
});

test("a call that failed keeps what it was sent, with secrets' shapes removed and long values cut", async () => {
  const sent = { pageId: "1ea55b02-92b2-4ea8-a841-82525a4c7093", note: "Authorization: Bearer abcdefghijklmnop", password: "hunter2", body: "x".repeat(2_000) };
  script((current) => (current.messages.some((message) => message.role === "tool") ? { text: "That page could not be read." } : { calls: [{ name: "read_broken", input: sent }] }));
  const result = await turn({
    provider: "openai",
    tools: [
      read("read_broken", async () => {
        throw new Error("No page with that id.");
      }),
    ],
  });
  const call = result.toolCalls[0]!;
  assert.equal(call.state, "failed");
  assert.equal(call.input?.pageId, sent.pageId, "what was sent, so a trace shows the id the model used");
  assert.equal(call.input?.note, "Authorization: Bearer [redacted]");
  assert.equal(call.input?.password, "[redacted]");
  assert.equal(String(call.input?.body).length, 501, "a long value is cut");
});

test("a page named by its exact title is found; an id that names nothing, or a title with no page, gets the closest pages with their ids", async () => {
  const pages = [
    { id: "1ea55b02-92b2-4ea8-841a-82525a4c7093", title: "Launch checklist" },
    { id: "7d3f0c1e-5b2a-4c8d-9e6f-0a1b2c3d4e5f", title: "Product sync" },
    { id: "8e4a1d2f-6c3b-4d9e-8f7a-1b2c3d4e5f60", title: "Product sync" },
  ];
  const base = fakeApp();
  const app = {
    ...base,
    prisma: new Proxy(base.prisma as object, {
      get: (target, prop) =>
        prop === "taskPage"
          ? { findMany: async () => pages.map(({ id, title }) => ({ id, title })), findFirst: async ({ where }: { where: { id: string } }) => pages.find((page) => page.id === where.id) ?? null }
          : Reflect.get(target, prop),
    }),
  } as unknown as FastifyInstance;
  const reads: string[] = [];
  const readPage = defineTool({
    name: "read_page",
    area: "projects",
    description: "Read a page by pageId.",
    input: z.object({ pageId: z.string().uuid() }),
    isWrite: false,
    risk: "low",
    async run(_ctx, input) {
      reads.push(input.pageId);
      if (!pages.some((page) => page.id === input.pageId)) throw Object.assign(new Error("No page with that id. Call hub_list_pages and use an id it returns."), { statusCode: 404 });
      return toolOk("Read it.", { id: input.pageId });
    },
  });
  // Another app's task id is no Ensemble id: it is passed on as it is.
  const appTask = defineTool({ name: "jira_read_issue", area: "apps", description: "Read an issue.", input: z.object({ taskId: z.string() }), isWrite: false, risk: "low", run: async (_ctx, input) => toolOk(`Read ${input.taskId}.`, { taskId: input.taskId }) });
  const errors = async (input: Record<string, unknown>, name = "read_page") => {
    script((current) => (current.messages.some((message) => message.role === "tool") ? { text: "ok" } : { calls: [{ name, input }] }));
    const result = await turn({ app, provider: "openai", tools: [readPage, appTask] });
    return result.toolCalls[0]!;
  };
  assert.equal((await errors({ pageId: " “launch   CHECKLIST” " })).state, "ok");
  assert.deepEqual(reads, [pages[0]!.id], "the exact title, case and spacing aside, is its id");
  assert.equal((await errors({ pageId: "ensemble://page/1ea55b02-92b2-4ea8-841a-82525a4c7093" })).state, "ok", "a link is its id");
  // The live run's mistake: two groups of the id swapped.
  const swapped = await errors({ pageId: "1ea55b02-92b2-4ea8-a841-82525a4c7093" });
  assert.equal(swapped.state, "failed");
  assert.match(swapped.error ?? "", /^No page with that id\..* No page has the id 1ea55b02-92b2-4ea8-a841-82525a4c7093\. Closest: “Launch checklist” \(1ea55b02-92b2-4ea8-841a-82525a4c7093\)\./);
  const typo = await errors({ pageId: "Lanch checklist" });
  assert.match(typo.error ?? "", /^No page is called “Lanch checklist”\. Closest: “Launch checklist” \(1ea55b02-92b2-4ea8-841a-82525a4c7093\)\. Pass one of these ids, or a page's exact title\./);
  const two = await errors({ pageId: "Product sync" });
  assert.match(two.error ?? "", /^2 pages are called “Product sync”: “Product sync” \(7d3f0c1e-[^)]+\), “Product sync” \(8e4a1d2f-[^)]+\)\. Pass the id of the one you mean\./);
  assert.equal(reads.length, 3, "a title that names no single page runs nothing");
  assert.equal((await errors({ taskId: "PROJ-12" }, "jira_read_issue")).state, "ok");
});

test("an included model has 24 steps, the last a forced answer; an owner's key has no cap unless their config sets one", async () => {
  const pages = read("read_page", async (input) => toolOk(`Page ${String(input.page)}.`, { page: input.page }));
  const until40 = (current: Seen, index: number): Reply => (!current.tools.length ? { text: "Stopped at the budget." } : index < 40 ? { calls: [{ name: "read_page", input: { page: index } }] } : { text: "Finished on my own." });

  let seen = script(until40);
  const included = await turn({ provider: INCLUDED_PROVIDER, tools: [pages] });
  assert.equal(seen.length, 24);
  assert.deepEqual(seen[23]!.tools, []);
  assert.ok(seen[22]!.tools.includes("read_page"));
  assert.ok(seen[23]!.messages.some((message) => message.role === "system" && /budget is exhausted/.test(String(message.content))));
  assert.equal(included.content, "Stopped at the budget.");

  seen = script(until40);
  const key = await turn({ provider: "openai", tools: [pages] });
  assert.equal(seen.length, 41, "forty steps of work, then its own answer");
  assert.ok(seen.every((current) => current.tools.includes("read_page")));
  assert.equal(key.content, "Finished on my own.");

  process.env.ENSEMBLE_LOOP_CONFIG = JSON.stringify({ steps: { key: 6 } });
  resetLoopConfigCache();
  seen = script(until40);
  const budgeted = await turn({ provider: "openai", tools: [pages] });
  assert.equal(seen.length, 6);
  assert.equal(budgeted.content, "Stopped at the budget.");
});

test("compaction shortens history and older results first and never a person's words or the newest exchange", async () => {
  // A window too small for even the last eight exchanges: everything but the newest gives way.
  process.env.ENSEMBLE_LOOP_CONFIG = JSON.stringify({ contextTokens: { models: { "test-model": 2_000 } } });
  resetLoopConfigCache();
  const history: Row[] = Array.from({ length: 6 }, (_, index) => [
    { role: "user", content: `Earlier question ${index}: ${"why ".repeat(20)}` },
    { role: "assistant", content: `Earlier answer ${index}: ${"because ".repeat(120)}` },
  ]).flat();
  const frames: AssistantStreamFrame[] = [];
  const metrics: Metric[] = [];
  const seen = script((_current, index) => (index < 14 ? { calls: [{ name: "read_chunk", input: { n: index } }] } : { text: "Summed up." }));
  const result = await turn({
    app: fakeApp(history, metrics),
    provider: "openai",
    frames,
    message: "Read every chunk and sum them up, please.",
    tools: [read("read_chunk", async (input) => toolOk(`Chunk ${String(input.n)}.`, { n: input.n, body: `chunk ${String(input.n)} `.repeat(300) }))],
  });
  assert.equal(result.content, "Summed up.");
  const last = seen.at(-1)!.messages;
  const users = last.filter((message) => message.role === "user").map((message) => String(message.content));
  for (const row of history.filter((row) => row.role === "user")) assert.ok(users.includes(row.content), "earlier questions stay word for word");
  assert.ok(users.some((content) => content.endsWith("Read every chunk and sum them up, please.")));
  const replies = last.filter((message) => message.role === "assistant");
  assert.deepEqual(replies.slice(0, 6).map((message) => message.content), Array(6).fill(HISTORY_LEFT_OUT), "history replies give way first");
  const results = toolMessages(seen.at(-1)!).map(resultOf);
  assert.equal(results.length, 14);
  assert.deepEqual(results.slice(0, 13).map((payload) => [payload.summary, payload.shortened, typeof payload.output]), Array.from({ length: 13 }, (_, n) => [`Chunk ${n}.`, true, "string"]), "older results become their summaries, oldest first");
  assert.ok(String((results[13]!.data as { body?: string }).body).startsWith("chunk 13"), "the newest exchange stays whole");
  assert.ok(seen.at(-1)!.tools.includes("read_tool_output"), "a shortened result can be read again");
  assert.ok(frames.some((frame) => frame.type === "status" && frame.text === "Shortened earlier parts of this turn to fit the model's context."));
  const loop = metrics.find((row) => row.kind === "assistant.turn")?.payload?.loop as Record<string, number>;
  assert.ok(loop.compactions >= 1);
  assert.deepEqual([loop.rowsLeftOut, loop.resultsShortened], [6, 13]);
});

test("compaction leaves the last eight exchanges whole when shortening what came before them is enough", () => {
  const call = (id: string): ModelMessage => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "read_chunk", arguments: "{}" } }] });
  const result = (id: string, n: number): ModelMessage => ({ role: "tool", tool_call_id: id, name: "read_chunk", content: JSON.stringify({ ok: true, summary: `Chunk ${n}.`, data: { body: "x".repeat(2_000) } }) });
  const messages: ModelMessage[] = [
    { role: "system", content: "Instructions." },
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer ".repeat(100) },
    { role: "user", content: "Read every chunk." },
  ];
  for (let n = 0; n < 12; n += 1) messages.push(call(`c${n}`), result(`c${n}`, n));
  const limit = estimateTokens(messages) - 1_500;
  const done = compactMessages(messages, {
    tools: [],
    limitTokens: limit,
    keepExchanges: 8,
    history: { start: 1, end: 3 },
    shorten: (id) => ({ role: "tool", tool_call_id: id, name: "read_chunk", content: JSON.stringify({ ok: true, summary: "Short.", shortened: true }) }),
  });
  assert.ok(done && done.after <= limit && estimateTokens(messages) <= limit);
  assert.equal(messages[2]!.content, HISTORY_LEFT_OUT);
  const shortened = messages.filter((message) => message.role === "tool").map((message) => JSON.parse(String(message.content)).shortened === true);
  assert.ok(shortened.slice(0, 4).some(Boolean), "results before the last eight exchanges give way");
  assert.deepEqual(shortened.slice(4), Array(8).fill(false), "the last eight exchanges stay whole");
  assert.deepEqual([messages[1]!.content, messages[3]!.content], ["Earlier question", "Read every chunk."]);
});

test("a turn whose last eight exchanges alone pass the limit still fits: their older results shrink, the newest stays whole", async () => {
  const page = Array.from({ length: 1_080 }, (_, index) => `Row ${index}: ${"cell ".repeat(8)}`).join("\n");
  assert.ok(page.length > 50_000 && page.length < 60_000, String(page.length));
  const seen = script((_current, index) => (index < 8 ? { calls: [0, 1, 2, 3].map((part) => ({ name: "read_page", input: { step: index, part } })) } : { text: "Read all 32 parts." }));
  const result = await turn({ provider: "openai", tools: [read("read_page", async (input) => toolOk(`Part ${String(input.step)}.${String(input.part)}.`, { page }))] });
  assert.equal(result.content, "Read all 32 parts.");
  const limit = Math.floor(128_000 * 0.6);
  for (const [index, current] of seen.entries()) {
    const tokens = estimateTokens(current.messages) + Math.ceil(current.toolChars / CHARS_PER_TOKEN);
    assert.ok(tokens <= limit, `request ${index}: ${tokens} tokens`);
  }
  const last = seen.at(-1)!;
  const results = toolMessages(last).map(resultOf);
  assert.equal(results.length, 32);
  const shortened = results.map((payload) => payload.shortened === true);
  const count = shortened.filter(Boolean).length;
  assert.ok(count >= 8, String(count));
  assert.deepEqual(shortened, [...Array(count).fill(true), ...Array(32 - count).fill(false)], "oldest first");
  assert.ok(results.slice(28).every((payload) => typeof payload.preview === "string" && payload.output), "the newest exchange stays as it came");
  const asked = new Set(last.messages.flatMap((message) => ((message.tool_calls ?? []) as Array<{ id: string }>).map((call) => call.id)));
  assert.ok(toolMessages(last).every((message) => asked.has(String(message.tool_call_id))), "every result still answers its request");
  assert.ok(last.messages.some((message) => message.role === "user" && String(message.content).endsWith("Do the work.")));
});

test("history is a token budget: an owner's key gets more of the conversation than an included model", async () => {
  const history: Row[] = Array.from({ length: 40 }, (_, index) => [
    { role: "user", content: `Question ${index}` },
    { role: "assistant", content: `Answer ${index}: ${"detail ".repeat(140)}` },
  ]).flat();
  const count = async (provider: string) => {
    const seen = script(() => ({ text: "ok" }));
    await turn({ app: fakeApp(history), provider, tools: [] });
    return seen[0]!.messages.filter((message) => message.role === "assistant").length;
  };
  const included = await count(INCLUDED_PROVIDER);
  const key = await count("openai");
  assert.ok(included >= 6 && included < 40, String(included));
  assert.equal(key, 40);
});

test("a model call that fails with a 502 after a tool ran is asked again; the tool does not run twice", async () => {
  const waits: number[] = [];
  setModelRetryWaitForTests(async (ms) => {
    waits.push(ms);
  });
  const frames: AssistantStreamFrame[] = [];
  let shops = 0;
  const dropped = () => errorFromStreamFrame({ message: "", kind: "other", status: 502 }, "test-model");
  script((_current, index) => (index === 0 ? { calls: [{ name: "browser_shop" }] } : index === 1 ? dropped() : { text: "Prices compared." }));
  const tools = [read("browser_shop", async () => (shops += 1, toolOk("Compared prices at 3 stores.", { stores: 3 })))];
  const result = await turn({ provider: INCLUDED_PROVIDER, tools, frames });
  assert.equal(result.content, "Prices compared.");
  assert.equal(shops, 1);
  assert.deepEqual(waits, [5_000]);
  assert.ok(frames.some((frame) => frame.type === "status" && frame.text === "The model's service failed (502). Trying again in 5 seconds."));

  waits.length = 0;
  script((_current, index) => (index === 0 ? { calls: [{ name: "browser_shop" }] } : dropped()));
  await assert.rejects(
    () => turn({ provider: INCLUDED_PROVIDER, tools }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeError);
      assert.equal(error.message, "The model's service failed (502). Nothing more was changed.");
      assert.equal(safePublicError(error, "fallback"), error.message, "what a person reads is that sentence, never the provider's JSON");
      return true;
    },
  );
  assert.deepEqual(waits, [5_000, 20_000]);
});

test("the loop leaves to the runtime what it retries itself: a rate limit, a 503 and anything with Retry-After fail at once", async () => {
  const waits: number[] = [];
  setModelRetryWaitForTests(async (ms) => {
    waits.push(ms);
  });
  const failures = [
    errorFromStreamFrame({ message: "slow down", kind: "rate_limit", status: 429, retryAfterSeconds: 2 }, "test-model"),
    errorFromStreamFrame({ message: "You exceeded your current quota, please check your plan and billing details.", kind: "rate_limit", status: 429 }, "test-model"),
    errorFromStreamFrame({ message: "", kind: "unavailable", status: 503 }, "test-model"),
    errorFromStreamFrame({ message: "", kind: "other", status: 502, retryAfterSeconds: 30 }, "test-model"),
  ];
  for (const failure of failures) {
    let shops = 0;
    script((_current, index) => (index === 0 ? { calls: [{ name: "browser_shop" }] } : failure));
    await assert.rejects(() => turn({ tools: [read("browser_shop", async () => (shops += 1, toolOk("Compared prices at 3 stores.")))] }), (error: unknown) => error === failure);
    assert.equal(shops, 1);
  }
  assert.deepEqual(waits, [], "never asked again on top of the runtime's own retries");
});

/** A browser on a computer, as an Ensemble Node has it: a click acts, a snapshot or a terminal read only looks. */
function browser(run: { click?: (ref: string) => ToolResult; snapshot?: () => ToolResult; terminal?: () => ToolResult }): AnyHubTool[] {
  const tool = (name: string, readOnly: boolean, answer: (input: Record<string, unknown>) => ToolResult) =>
    defineTool({ name, area: "tasks", description: `${name}.`, input: z.object({}).passthrough(), isWrite: false, ...(readOnly ? { readOnly: true } : {}), risk: "low", run: async (_ctx, input) => answer(input) });
  return [
    tool("browser_click", false, (input) => run.click?.(String(input.ref)) ?? toolOk(`Clicked ${String(input.ref)}.`)),
    tool("browser_snapshot", true, () => run.snapshot?.() ?? toolOk("The page.", { tree: "button Add to cart [ref=e5]" })),
    tool("terminal_read", true, () => run.terminal?.() ?? toolOk("Something is running.", { screen: "Downloading 40%" })),
  ];
}

const nudgesIn = (seen: Seen[], pattern: RegExp) => seen.map((current) => current.messages.filter((message) => message.role === "user" && pattern.test(String(message.content))).length);

test("clicking and looking again while nothing changes is going round in a loop: one nudge, then the turn ends", async () => {
  const seen = script((current, index) =>
    !current.tools.length ? { text: "The button does nothing: the cart stays empty." } : index >= 30 ? { text: "Gave up." } : { calls: [index % 2 === 0 ? { name: "browser_click", input: { ref: "e5" } } : { name: "browser_snapshot", input: { tab: "t1" } }] },
  );
  const result = await turn({ provider: "openai", tools: browser({}) });
  assert.equal(seen.length, 10, "the fifth click with the same result ends it");
  assert.deepEqual(nudgesIn(seen, /called browser_click with the same input 3 times and it returned the same result/), [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  assert.deepEqual(seen[9]!.tools, []);
  assert.equal(result.content, "The button does nothing: the cart stays empty.");

  // A click that changes the page each time is progress: looking again after it is not a repeat.
  let page = 0;
  const moving = script((current, index) => (index >= 12 ? { text: "Went through 6 pages." } : { calls: [index % 2 === 0 ? { name: "browser_click", input: { ref: "next" } } : { name: "browser_snapshot", input: { tab: "t1" } }] }));
  const paged = await turn({ provider: "openai", tools: browser({ click: () => toolOk(`Opened page ${(page += 1)}.`), snapshot: () => toolOk("The page.", { tree: `Page ${page}` }) }) });
  assert.equal(paged.content, "Went through 6 pages.");
  assert.deepEqual(nudgesIn(moving, /same input/), Array(13).fill(0));
});

test("polling a terminal whose screen changes is never a repeat; the same screen again and again is", async () => {
  let percent = 0;
  const polls = (current: Seen, index: number): Reply => (current.tools.length && index < 6 ? { calls: [{ name: "terminal_read", input: { session: "s1" } }] } : { text: "The download is still going." });
  let seen = script(polls);
  await turn({ provider: "openai", tools: browser({ terminal: () => toolOk("Something is running.", { screen: `Downloading ${(percent += 10)}%` }) }) });
  assert.equal(seen.length, 7, "six reads, then the answer");
  assert.deepEqual(nudgesIn(seen, /same input/), Array(7).fill(0));

  seen = script(polls);
  const result = await turn({ provider: "openai", tools: browser({}) });
  assert.deepEqual(nudgesIn(seen, /called terminal_read with the same input 3 times/), [0, 0, 0, 1, 1, 1]);
  assert.equal(seen.length, 6, "the fifth read of the same screen ends it");
  assert.deepEqual(seen[5]!.tools, []);
  assert.equal(result.content, "The download is still going.");
});

test("a turn with no step cap pauses at its checkpoint: it says what it did and asks whether to go on", async () => {
  process.env.ENSEMBLE_LOOP_CONFIG = JSON.stringify({ checkpointSteps: 10 });
  resetLoopConfigCache();
  const pages = read("read_page", async (input) => toolOk(`Page ${String(input.page)}.`, { page: input.page }));
  const metrics: Metric[] = [];
  const work = (current: Seen, index: number): Reply => (current.tools.length && index < 40 ? { calls: [{ name: "read_page", input: { page: index } }] } : { text: "I read pages 0 to 8. The rest are left." });
  let seen = script(work);
  const result = await turn({ app: fakeApp([], metrics), provider: "openai", tools: [pages] });
  assert.equal(seen.length, 10);
  assert.deepEqual(seen[9]!.tools, []);
  assert.ok(seen[9]!.messages.some((message) => message.role === "system" && /worked for 10 steps/.test(String(message.content))));
  assert.equal(result.content, "I read pages 0 to 8. The rest are left.\n\nI paused after 10 steps. Say continue to go on.");
  assert.deepEqual(result.paused, { steps: 10 });
  const loop = metrics.find((row) => row.kind === "assistant.turn")?.payload?.loop as Record<string, unknown>;
  assert.equal(loop.paused, true);

  // An included model's cap ends its turn instead.
  seen = script(work);
  const included = await turn({ provider: INCLUDED_PROVIDER, tools: [pages] });
  assert.equal(seen.length, 24);
  assert.equal(included.paused, undefined);
});

test("progress is what calls return: the same call with the same result repeats, so does a round of calls, and a change starts the counts again", () => {
  const limits = { nudge: 3, stop: 5, failedSteps: 8 };
  const call = (name: string, input: string, digest: string, readOnly = false) => ({ name, input, state: "ok", digest, readOnly });
  const looking = new RunawayGuard(limits);
  for (let index = 0; index < 6; index += 1) assert.equal(looking.step([call("browser_snapshot", "{}", "page", true), call("browser_click", JSON.stringify({ ref: `e${index}` }), `opened ${index}`)]), null);

  const reads = new RunawayGuard(limits);
  const list = (order: string) => call("hub_list_tasks", order, "same", true);
  assert.equal(reads.step([list('{"a":1,"b":2}')]), null);
  assert.equal(reads.step([list('{"b":2,"a":1}')]), null);
  assert.deepEqual(reads.step([list('{"a":1, "b":2}')]), { kind: "nudge", tool: "hub_list_tasks", times: 3, round: 1 }, "the same input written another way is the same call");

  const ran = (ms: number, run: string, output: string) => resultDigest({ ok: true, summary: `Exit code 1 in ${ms / 1000}s.`, data: { output, ms, run, at: new Date(ms).toISOString() } });
  assert.equal(ran(1_200, "0b9a1f3e-5d2c-4c1a-9a7e-2f3b4c5d6e7f", "build failed\n12s elapsed"), ran(3_400, "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f", "build failed\n31s elapsed"), "ids, times and durations each run makes anew are not a change");
  assert.notEqual(ran(1_200, "0b9a1f3e-5d2c-4c1a-9a7e-2f3b4c5d6e7f", "build failed"), ran(1_200, "0b9a1f3e-5d2c-4c1a-9a7e-2f3b4c5d6e7f", "build passed"));

  const rounds = new RunawayGuard(limits);
  const round = () => rounds.step([call("browser_click", '{"ref":"e5"}', "clicked"), call("browser_snapshot", "{}", "page", true)]);
  assert.equal(round(), null);
  assert.equal(round(), null);
  assert.deepEqual(round(), { kind: "nudge", tool: "browser_click, browser_snapshot", times: 3, round: 2 });
  assert.equal(round(), null);
  assert.deepEqual(round(), { kind: "stop", why: "repeat", tool: "browser_click, browser_snapshot", times: 5, round: 2 });
});

test("a model that acts and then says nothing is asked once for its reply; still nothing, and the reply says what its tools did", async () => {
  const save = defineTool({ name: "save_note", area: "tasks", description: "Save a note.", input: z.object({ title: z.string() }), isWrite: true, risk: "low", run: async (_ctx, input) => toolOk(`Created note “${input.title}”.`) });
  const look = read("read_inbox", async () => toolOk("Read 3 emails.", { count: 3 }));
  let seen = script((_current, index) => (index === 0 ? { calls: [{ name: "read_inbox" }, { name: "save_note", input: { title: "Launch plan" } }] } : { text: "" }));
  const result = await turn({ provider: "openai", tools: [look, save] });
  assert.equal(seen.length, 3, "the work, the empty answer, and the one request for the reply");
  assert.ok(seen[2]!.messages.some((message) => message.role === "user" && /you wrote nothing/.test(String(message.content))));
  assert.equal(result.content, "Done: created note “Launch plan”.", "what it did, in plain words, never an error");
  assert.equal(result.emptyReply, true);
  assert.equal(result.failed, undefined);

  // Only lookups: what it looked at.
  seen = script((_current, index) => (index === 0 ? { calls: [{ name: "read_inbox" }] } : { text: "" }));
  assert.equal((await turn({ provider: "openai", tools: [look] })).content, "Looked at: read 3 emails.");

  // Asked again, the model answers: that is the reply.
  seen = script((_current, index) => (index === 0 ? { calls: [{ name: "read_inbox" }] } : index === 1 ? { text: "" } : { text: "You have 3 new emails." }));
  const answered = await turn({ provider: "openai", tools: [look] });
  assert.equal(answered.content, "You have 3 new emails.");
  assert.equal(answered.emptyReply, undefined);
});

test("a model that does nothing and says nothing fails, in plain words", async () => {
  script(() => ({ text: "" }));
  await assert.rejects(turn({ provider: "openai", tools: [] }), (error: Error) => error.message === "The model ended its turn without replying or doing anything. Try again, or choose another model.");
});

test("a reply that says something reached the chat when nothing did goes back once; still claimed, the claim is taken out with a plain note", async () => {
  const look = read("read_page", async () => toolOk("Opened the status page.", { title: "Status" }));
  const ask = (reply: (seen: Seen, index: number) => Reply) => {
    const seen = script(reply);
    const run = runAssistantTurn({
      app: fakeApp(),
      userId: "loop-user",
      conversationId: "loop-conversation",
      message: "Send me a screenshot of the status page.",
      settings: DEFAULT_SETTINGS,
      model: "test-model",
      provider: "openai",
      extraTools: [look],
      claims: ({ text }) => checkDelivery(text, deliveredWith([], text)),
      emit: () => undefined,
    });
    return { seen, run };
  };
  const stubborn = ask((_current, index) => (index === 0 ? { calls: [{ name: "read_page" }] } : { text: "Here is the screenshot. The page shows 3 services up." }));
  const result = await stubborn.run;
  assert.equal(stubborn.seen.length, 3, "the work, the claim, and one round to fix it");
  assert.equal(String(stubborn.seen[2]!.messages.at(-1)!.content), "You said the screenshot is attached, but nothing reached the chat. Attach it with the right tool, or correct your reply.");
  assert.equal(result.content, "The page shows 3 services up.\n\nNo screenshot was attached.");
  assert.equal(result.falseClaims, 1);

  const fixed = ask((_current, index) => (index === 0 ? { calls: [{ name: "read_page" }] } : index === 1 ? { text: "Here is the screenshot." } : { text: "I could not take a screenshot: no browser here. The page shows 3 services up." }));
  const corrected = await fixed.run;
  assert.equal(corrected.content, "I could not take a screenshot: no browser here. The page shows 3 services up.");
  assert.equal(corrected.falseClaims, undefined);
});
