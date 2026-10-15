/**
 * The computer's side of an assistant turn the web handed it (docs/25 §4.8): it reads the turn,
 * runs the agent, sends the reply text in order, passes tool calls through, stops when the web
 * says so, and always says how the turn ended.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AgentTurnError, type AgentTurnIO, type AgentTurnSpec } from "../subscriptions/agents.js";
import { answerAssistantTurn, MAX_TURNS_AT_ONCE, stopAssistantTurn } from "./assistant.js";
import type { HostedClient } from "./client.js";

const SPEC: AgentTurnSpec = { agent: "claude-code", model: "haiku", effort: null, system: "You are the Ensemble assistant.", prompt: "hello", tools: [{ name: "hub_list_tasks", description: "List", inputSchema: { type: "object" } }], maxTurns: 8 };

function fakeClient(options: { spec?: unknown; stopAfter?: number } = {}) {
  const streamed: Array<{ seq: number; text: string }> = [];
  const tools: Array<{ name: string; input: unknown }> = [];
  const done: unknown[] = [];
  const client = {
    assistantTurn: async () => (options.spec === null ? null : { spec: options.spec ?? SPEC }),
    assistantTool: async (_id: string, body: { name: string; input: unknown }) => {
      tools.push(body);
      return { text: `{"ok":true,"name":"${body.name}"}` };
    },
    assistantStream: async (_id: string, body: { seq: number; text: string }) => {
      streamed.push(body);
      return { stop: options.stopAfter !== undefined && streamed.length >= options.stopAfter };
    },
    assistantDone: async (_id: string, body: unknown) => {
      done.push(body);
    },
  } as unknown as HostedClient;
  return { client, streamed, tools, done };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a turn runs, its tool calls pass through, and its reply arrives in order before done", async () => {
  const fake = fakeClient();
  let seen: AgentTurnSpec | null = null;
  await answerAssistantTurn(fake.client, { id: "turn-1" }, async (spec, io: AgentTurnIO) => {
    seen = spec;
    io.onDelta("Hel");
    io.onDelta("lo");
    const answer = await io.call("hub_list_tasks", { query: "brief" });
    assert.equal(answer.text, '{"ok":true,"name":"hub_list_tasks"}');
    await pause(260);
    io.onDelta(" there");
    return { text: "Hello there", model: "claude-haiku-5-5", tokensIn: 10, tokensOut: 3, costUsd: null };
  });
  assert.deepEqual(seen, SPEC);
  assert.deepEqual(fake.tools, [{ name: "hub_list_tasks", input: { query: "brief" } }]);
  assert.equal(fake.streamed.map((row) => row.text).join(""), "Hello there");
  assert.deepEqual(fake.streamed.map((row) => row.seq), fake.streamed.map((_row, index) => index + 1), "numbered in order from 1");
  assert.deepEqual(fake.done, [{ result: { text: "Hello there", model: "claude-haiku-5-5", tokensIn: 10, tokensOut: 3, costUsd: null } }]);
});

test("an agent's own problem goes back with its kind; a turn the computer cannot read asks for an update", async () => {
  const failing = fakeClient();
  await answerAssistantTurn(failing.client, { id: "turn-2" }, async () => {
    throw new AgentTurnError("signed_out", "Claude is not signed in on this computer.");
  });
  assert.deepEqual(failing.done, [{ error: { problem: "signed_out", message: "Claude is not signed in on this computer." } }]);

  const unreadable = fakeClient({ spec: { agent: "gemini" } });
  await answerAssistantTurn(unreadable.client, { id: "turn-3" }, async () => {
    throw new Error("not reached");
  });
  assert.match(JSON.stringify(unreadable.done), /Update Ensemble on this computer/);

  const gone = fakeClient({ spec: null });
  await answerAssistantTurn(gone.client, { id: "turn-4" }, async () => {
    throw new Error("not reached");
  });
  assert.deepEqual(gone.done, [], "a turn that already ended is left alone");
});

test("Stop from the web ends the agent's run, by frame or by the server's answer to a batch", async () => {
  const byFrame = fakeClient();
  const running = answerAssistantTurn(byFrame.client, { id: "turn-5" }, async (_spec, io) => {
    await new Promise<void>((resolve) => io.signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new DOMException("Stopped", "AbortError");
  });
  await pause(20);
  stopAssistantTurn({ id: "turn-5" });
  await running;
  assert.deepEqual(byFrame.done, [{ error: { problem: "failed", message: "Stopped." } }]);

  const byAnswer = fakeClient({ stopAfter: 1 });
  await answerAssistantTurn(byAnswer.client, { id: "turn-6" }, async (_spec, io) => {
    io.onDelta("partial");
    await new Promise<void>((resolve) => io.signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new DOMException("Stopped", "AbortError");
  });
  assert.deepEqual(byAnswer.done, [{ error: { problem: "failed", message: "Stopped." } }]);
});

test("a computer answers a few turns at once and refuses more with a reason", async () => {
  const fake = fakeClient();
  const release: Array<() => void> = [];
  const runs = Array.from({ length: MAX_TURNS_AT_ONCE }, (_value, index) =>
    answerAssistantTurn(fake.client, { id: `busy-${index}` }, async () => {
      await new Promise<void>((resolve) => release.push(resolve));
      return { text: "ok", model: null, tokensIn: null, tokensOut: null, costUsd: null };
    }),
  );
  await pause(20);
  await answerAssistantTurn(fake.client, { id: "one-too-many" }, async () => {
    throw new Error("not reached");
  });
  assert.match(JSON.stringify(fake.done[0]), /already answering 3 assistant messages/);
  for (const resolve of release) resolve();
  await Promise.all(runs);
  assert.equal(fake.done.length, MAX_TURNS_AT_ONCE + 1);
});
