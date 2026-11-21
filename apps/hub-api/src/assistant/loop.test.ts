/**
 * Ensemble's own loop with a scripted model (docs/11, Turn limits): reads that run together, writes in
 * order, long results kept for read_tool_output, runaway detection, step budgets by model class,
 * compaction, the history budget, and model calls asked again after a passing failure.
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
import { HISTORY_LEFT_OUT } from "./compaction.js";
import { RunawayGuard } from "./runaway.js";

type Call = { name: string; input?: Record<string, unknown> };
type Reply = { calls?: Call[]; text?: string } | Error;
type Seen = { messages: ModelMessage[]; tools: string[] };
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
    const current: Seen = { messages: args.messages.map((message) => ({ ...message })), tools: (args.chatTools as Array<{ function: { name: string } }>).map((spec) => spec.function.name) };
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

test("compaction shortens older results and history, never a person's words or the last eight exchanges", async () => {
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
  assert.deepEqual(replies.slice(0, 6).map((message) => message.content), Array(6).fill(HISTORY_LEFT_OUT), "older history replies give way first");
  const results = toolMessages(seen.at(-1)!).map(resultOf);
  assert.equal(results.length, 14);
  assert.ok(results.slice(0, 6).every((payload) => payload.shortened === true && typeof payload.output === "string"), "older results become their summaries");
  assert.deepEqual(results.slice(0, 6).map((payload) => payload.summary), ["Chunk 0.", "Chunk 1.", "Chunk 2.", "Chunk 3.", "Chunk 4.", "Chunk 5."]);
  assert.ok(results.slice(6).every((payload) => payload.shortened === undefined && String((payload.data as { body?: string }).body).startsWith("chunk")), "the last eight exchanges stay whole");
  assert.ok(seen.at(-1)!.tools.includes("read_tool_output"), "a shortened result can be read again");
  assert.ok(frames.some((frame) => frame.type === "status" && frame.text === "Shortened earlier parts of this turn to fit the model's context."));
  const loop = metrics.find((row) => row.kind === "assistant.turn")?.payload?.loop as Record<string, number>;
  assert.ok(loop.compactions >= 1);
  assert.deepEqual([loop.rowsLeftOut, loop.resultsShortened], [6, 6]);
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

test("a rate limit before any tool is asked again in a chat, and left to an Ensemble Node turn's own fallback", async () => {
  const waits: number[] = [];
  setModelRetryWaitForTests(async (ms) => {
    waits.push(ms);
  });
  const limited = () => new RuntimeError("Ensemble is rate-limiting this key. Wait about 1s and try again.", 429, false, "rate_limit");
  script((_current, index) => (index === 0 ? limited() : { text: "Here you go." }));
  assert.equal((await turn({ tools: [] })).content, "Here you go.");
  assert.deepEqual(waits, [5_000]);

  waits.length = 0;
  script(() => limited());
  await assert.rejects(() => turn({ tools: [], agentPersona: "You are Scout (@scout), an Ensemble Node." }), /rate-limiting/);
  assert.deepEqual(waits, [], "node/brain.ts falls back to its fast model, or runs the turn again later");
});

test("looking again after something changed is not a repeat; looking again with nothing in between is", () => {
  const guard = new RunawayGuard({ nudge: 3, stop: 5, failedSteps: 8 });
  const look = { name: "browser_snapshot", input: "{}", state: "ok", acts: true };
  const click = (ref: string) => ({ name: "browser_click", input: JSON.stringify({ ref }), state: "ok", acts: true });
  for (let index = 0; index < 6; index += 1) assert.equal(guard.step([look, click(`e${index}`)]), null);
  const reads = new RunawayGuard({ nudge: 3, stop: 5, failedSteps: 8 });
  const list = (order: string) => ({ name: "hub_list_tasks", input: order, state: "ok", acts: false });
  assert.equal(reads.step([list('{"a":1,"b":2}')]), null);
  assert.equal(reads.step([list('{"b":2,"a":1}')]), null);
  assert.deepEqual(reads.step([list('{"a":1, "b":2}')]), { kind: "nudge", tool: "hub_list_tasks", times: 3 }, "the same input written another way is the same call");
});
