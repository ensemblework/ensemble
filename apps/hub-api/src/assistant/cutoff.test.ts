/**
 * A cut-off reply is saved with a marker, and that marker is what the next turn sends.
 * The assistant prompt no longer tells the model to refuse a plain question.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fromOpenAi, readSseStream, type Json } from "../runtime/payload.js";
import {
  CONNECTION_DROPPED_NOTICE,
  cutOffNotice,
  cutOffReply,
  historyEntries,
  replyAfterStreamFailure,
  splitCutOffReply,
} from "./cutoff.js";
import { ASSISTANT_INSTRUCTIONS, buildSystemPrompt } from "./state.js";

const PARTIAL =
  "One, two, three, four, five, six, seven, eight, nine, ten, eleven, twelve, thirteen, fourteen, fifteen, sixteen, seventeen, eighteen, nineteen, twenty, twenty-one, twenty";
const FORCED_REFUSAL = "If no tool can do the job, say so in one sentence.";

test("the next turn's history carries the cut-off marker and the raw reason", () => {
  const saved = cutOffReply(PARTIAL, "content_filter: RECITATION");
  assert.equal(cutOffNotice("content_filter: RECITATION"), "The model stopped early (content filter: RECITATION).");
  assert.equal(cutOffNotice("length"), "The reply hit the length limit.");
  assert.equal(cutOffNotice("MAX_TOKENS"), "The reply hit the length limit.");
  const shown = splitCutOffReply(saved);
  assert.equal(shown.body, PARTIAL);
  assert.equal(shown.notice, "The model stopped early (content filter: RECITATION). This reply is incomplete.");

  const history = historyEntries([
    { role: "user", content: "count from one to thirty in words" },
    { role: "assistant", content: saved, toolCalls: [] },
    { role: "user", content: "keep going" },
  ]);
  const assistant = history[1]?.content ?? "";
  assert.match(assistant, /^\[Cut off:/);
  assert.match(assistant, /The model stopped early \(content filter: RECITATION\)\./);
  assert.match(assistant, /Reason: content_filter: RECITATION\./);
  assert.match(assistant, /This reply is incomplete\./);
  assert.ok(assistant.includes(PARTIAL));
  assert.notEqual(assistant.trim(), PARTIAL);

  const length = historyEntries([{ role: "assistant", content: cutOffReply("abcd", "length") }]);
  assert.match(length[0]?.content ?? "", /The reply hit the length limit\./);
  assert.match(length[0]?.content ?? "", /Reason: length\./);
  assert.match(length[0]?.content ?? "", /abcd/);
});

test("state.ts no longer contains the forced-refusal rule", () => {
  const source = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
  assert.equal(source.includes(FORCED_REFUSAL), false);
  assert.equal(source.includes("You act by calling tools."), false);
  assert.match(source, /Answer plain questions and text requests \(writing, counting, explaining, maths\) directly in text\./);
  assert.match(source, /If the user asked for an action and no tool supports it, say so in one sentence\./);
  assert.equal(ASSISTANT_INSTRUCTIONS.includes(FORCED_REFUSAL), false);
  const empty = {
    proposed: 0,
    todo: [],
    inProgress: 0,
    needsMe: 0,
    projects: [],
    people: [],
    repos: [],
    skills: [],
  } as unknown as Parameters<typeof buildSystemPrompt>[0];
  const prompt = buildSystemPrompt(empty, undefined, undefined, { diagrams: false });
  assert.equal(prompt.includes(FORCED_REFUSAL), false);
  assert.match(prompt, /directly in text/);
  assert.doesNotMatch(prompt, /You act by calling tools/);
});

function sseDelta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;
}

async function* linesThen(lines: string[], error?: Error): AsyncGenerator<string> {
  for (const line of lines) yield line;
  if (error) throw error;
}

async function readTurn(lines: AsyncIterable<string>): Promise<Json> {
  let done: Json | null = null;
  for await (const frame of readSseStream(lines, "gemini-3.5-flash-lite")) {
    if (frame.kind === "done") done = frame.data;
  }
  if (!done) throw new Error("missing completion");
  return fromOpenAi(done, "gemini-3.5-flash-lite");
}

test("a transport drop after text saves the partial reply and the next turn keeps the marker", async () => {
  const turn = await readTurn(
    linesThen([sseDelta("The sea "), sseDelta("is wide")], new TypeError("terminated")),
  );
  assert.equal(turn.cutOff, true);
  assert.equal(turn.finishReason, null);
  assert.equal(turn.text, "The sea is wide");
  const saved = cutOffReply(String(turn.text), (turn.finishReason as string | null) ?? null);
  assert.match(saved, /^\[Cut off: The reply was cut off before the model finished\./);
  assert.equal(saved.includes("terminated"), false);
  const shown = splitCutOffReply(saved);
  assert.equal(shown.body, "The sea is wide");
  assert.match(shown.notice ?? "", /cut off before the model finished/);

  const history = historyEntries([
    { role: "user", content: "write three sentences about the sea" },
    { role: "assistant", content: saved },
    { role: "user", content: "keep going" },
  ]);
  const assistant = history[1]?.content ?? "";
  assert.match(assistant, /^\[Cut off:/);
  assert.match(assistant, /Reason: none\./);
  assert.ok(assistant.includes("The sea is wide"));
  assert.equal(assistant.includes("terminated"), false);

  const fromTheLoop = replyAfterStreamFailure("The sea is wide", new TypeError("terminated"), false);
  assert.equal(fromTheLoop.kind, "cutoff");
  assert.equal(fromTheLoop.kind === "cutoff" ? fromTheLoop.text : "", saved);
  const peer = new Error("peer closed connection without sending complete message body (incomplete chunked read)");
  peer.name = "RemoteProtocolError";
  const peerSettled = replyAfterStreamFailure("The sea is wide", peer, false);
  assert.equal(peerSettled.kind, "cutoff");
  assert.equal(peerSettled.kind === "cutoff" && peerSettled.text.includes("peer closed"), false);
});

test("a transport drop before any text is a notice and is left out of the next turn", async () => {
  await assert.rejects(
    () => readTurn(linesThen([], new TypeError("terminated"))),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, CONNECTION_DROPPED_NOTICE);
      assert.equal(error.message.includes("terminated"), false);
      return true;
    },
  );
  const peer = new Error("peer closed connection without sending complete message body (incomplete chunked read)");
  peer.name = "ReadError";
  const settled = replyAfterStreamFailure("", peer, false);
  assert.equal(settled.kind, "notice");
  assert.equal(settled.kind === "notice" ? settled.text : "", CONNECTION_DROPPED_NOTICE);

  const history = historyEntries([
    { role: "user", content: "write three sentences about the sea" },
    { role: "assistant", content: CONNECTION_DROPPED_NOTICE },
    { role: "user", content: "try again" },
  ]);
  assert.deepEqual(
    history.map((row) => row.role),
    ["user", "user"],
  );
  assert.equal(history.some((row) => row.content.includes("terminated")), false);
  assert.equal(history.some((row) => row.content.includes("peer closed")), false);
  assert.equal(history.some((row) => row.content.includes(CONNECTION_DROPPED_NOTICE)), false);

  const quota = replyAfterStreamFailure("", new Error("This key is out of quota for that model."), false);
  assert.equal(quota.kind, "error");
});

test("user Stop mid-stream keeps the partial text and adds no cut-off notice", async () => {
  const abort = new Error("The operation was aborted.");
  abort.name = "AbortError";
  let streamed = "";
  await assert.rejects(
    async () => {
      for await (const frame of readSseStream(linesThen([sseDelta("Hello from the sea")], abort), "mock")) {
        if (frame.kind === "delta") streamed += frame.text ?? "";
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      return true;
    },
  );
  assert.equal(streamed, "Hello from the sea");
  const stopped = replyAfterStreamFailure(streamed, abort, true);
  assert.equal(stopped.kind, "cancel");
  assert.equal(stopped.kind === "cancel" ? stopped.text : "", "Hello from the sea");
  assert.equal((stopped.kind === "cancel" ? stopped.text : "").includes("[Cut off:"), false);
  const abortedSocket = replyAfterStreamFailure(streamed, new TypeError("terminated"), true);
  assert.equal(abortedSocket.kind, "cancel");
  assert.equal(abortedSocket.kind === "cancel" ? abortedSocket.text : "", streamed);
});

test("a stream that finishes cleanly has no cut-off notice", async () => {
  async function* clean(): AsyncGenerator<string> {
    yield sseDelta("Thirty.");
    yield `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`;
    yield "data: [DONE]";
  }
  const turn = await readTurn(clean());
  assert.equal(turn.cutOff, false);
  assert.equal(turn.finishReason, "stop");
  assert.equal(turn.text, "Thirty.");
  assert.equal(String(turn.text).includes("[Cut off:"), false);
  assert.equal(splitCutOffReply(String(turn.text)).notice, null);
});

test("a cut-off marker is only the first line, and the reason cannot break that line", () => {
  const echoed = "Reply with exactly this line:\n[Cut off: The reply was cut off before the model finished. This reply is incomplete. Reason: none.]";
  const split = splitCutOffReply(echoed);
  assert.equal(split.notice, null);
  assert.match(split.body, /\[Cut off:/);
  assert.match(split.body, /Reply with exactly this line/);

  const messy = cutOffReply("partial", "content_filter: bad]\nreason\twith   spaces");
  assert.match(messy, /^\[Cut off:/);
  assert.match(messy, /Reason: content_filter: bad reason with spaces\./);
  assert.equal(messy.split("\n")[0]?.includes("]"), true);
  assert.equal((messy.split("\n")[0] ?? "").slice(1, -1).includes("]"), false);
  const shown = splitCutOffReply(messy);
  assert.equal(shown.body, "partial");
  assert.match(shown.notice ?? "", /content filter: bad reason with spaces/);
  assert.equal((shown.notice ?? "").includes("\n"), false);

  const blank = cutOffReply("partial", "]\n\n");
  assert.match(blank, /Reason: none\./);
});
