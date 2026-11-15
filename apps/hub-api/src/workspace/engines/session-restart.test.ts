import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_WRITER, CodexThreadBusy, provenGone, restartOf, resumeCodexThread } from "./session-restart.js";

const BUSY = "thread 01a1ddf8-8355-7f20-a317-2a797d8d576a already has an active writer";

/** A stand-in app-server: `thread/resume` refused as busy `busy` times, then answered. */
function server(busy: number, other?: string) {
  const calls: unknown[] = [];
  return {
    calls,
    request: async (method: string, params: unknown) => {
      assert.equal(method, "thread/resume");
      calls.push(params);
      if (other) throw new Error(other);
      if (calls.length <= busy) throw new Error(BUSY);
      return { thread: { id: (params as { threadId: string }).threadId } };
    },
  };
}

test("a thread the ChatGPT app held is resumed once the app lets go", async () => {
  const fake = server(2);
  const waits: number[] = [];
  const thread = await resumeCodexThread(fake.request, { threadId: "thread-1", cwd: "/w" }, { signal: new AbortController().signal, everyMs: 5, limitMs: 1_000, waiting: (waited) => void waits.push(waited) });
  assert.deepEqual(thread, { thread: { id: "thread-1" } }, "the same thread");
  assert.equal(fake.calls.length, 3);
  assert.equal(waits.length, 2, "told each time it waits");
});

test("a thread the app holds for the whole wait is busy, not gone; any other refusal is thrown at once", async () => {
  const held = server(Number.POSITIVE_INFINITY);
  const started = Date.now();
  await assert.rejects(resumeCodexThread(held.request, { threadId: "thread-1" }, { signal: new AbortController().signal, everyMs: 10, limitMs: 60 }), (error: unknown) => {
    assert.ok(error instanceof CodexThreadBusy);
    assert.match(error.message, ACTIVE_WRITER);
    assert.ok(error.waitedMs >= 60);
    return true;
  });
  assert.ok(Date.now() - started < 1_000);
  assert.ok(held.calls.length >= 5, "tried again until the limit");

  const gone = server(0, "no rollout found for thread id thread-1");
  await assert.rejects(resumeCodexThread(gone.request, { threadId: "thread-1" }, { signal: new AbortController().signal, everyMs: 10, limitMs: 60 }), /no rollout found/);
  assert.equal(gone.calls.length, 1);
});

test("stopping the turn ends the wait", async () => {
  const stop = new AbortController();
  const held = server(Number.POSITIVE_INFINITY);
  setTimeout(() => stop.abort(), 30);
  await assert.rejects(resumeCodexThread(held.request, { threadId: "thread-1" }, { signal: stop.signal, everyMs: 10_000, limitMs: 60_000 }), (error: unknown) => !(error instanceof CodexThreadBusy));
  assert.equal(held.calls.length, 1);
});

test("only an agent saying it has no such session proves it gone", () => {
  for (const said of [
    "no rollout found for thread id 01a1ddf3-0000-7000-8000-000000000000",
    "thread not found: 01a1ddf3",
    "No conversation found with session ID: 7c6b5a49-3827-4615-9a0b-1c2d3e4f5a6b",
    "Session not found: sess-1",
    "session sess-1 not found",
    "Copilot no longer has session sess-1",
    "Resource not found: /home/me/.local/share/opencode/storage/session/ses_1.json",
  ])
    assert.equal(provenGone(said), true, said);
  for (const said of [BUSY, "model not found", "Request timed out", "connection reset", "Internal error"]) assert.equal(provenGone(said), false, said);
});

test("a restart keeps the agent's words on one short line", () => {
  assert.deepEqual(restartOf("rotated"), { reason: "rotated" });
  assert.deepEqual(restartOf("busy", new Error(`${BUSY}\n  at codex_core`)), { reason: "busy", error: `${BUSY} at codex_core` });
  assert.equal(restartOf("gone", "x".repeat(1_000)).error?.length, 300);
});
