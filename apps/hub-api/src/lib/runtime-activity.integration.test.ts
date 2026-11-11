import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Settings } from "@ensemble/shared-types";
import { createHttpHarness } from "../test/http.js";

const harness = await createHttpHarness();
after(() => harness.close());
process.env.ENSEMBLE_INPROCESS_RUNTIME = "0";
const { complete } = await import("./runtime.js");
const { beginActivity, endActivity, listActivities, requestCancel, setPaused, withActivity } = await import("./activity.js");
const { sseHub } = await import("./sse.js");
const person = await harness.asUser();
const settings = Settings.parse({ models: { easy: { provider: "google", model: "test-model", effort: "default" } } });
const args = { userId: person.id, settings, prompt: "Summarize the meeting", purpose: "Meeting prep" };

type Request = { signal: AbortSignal; finish: () => void; fail: (error: Error) => void };
async function mocked(work: (requests: Request[], waitFor: (count: number) => Promise<void>) => Promise<void>) {
  const fetch = globalThis.fetch;
  const requests: Request[] = [];
  const waiting: Array<{ count: number; resolve: () => void }> = [];
  globalThis.fetch = (async (input, init) => {
    assert.ok(String(input).endsWith("/api/complete"), String(input));
    const signal = init?.signal;
    assert.ok(signal, "Stop must reach the actual model transport");
    return new Promise<Response>((resolve, reject) => {
      const request: Request = {
        signal,
        finish: () => resolve(new Response(JSON.stringify({ text: "Meeting ready", model: "test-model", tokensIn: 3, tokensOut: 2 }), { status: 200 })),
        fail: reject,
      };
      requests.push(request);
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      for (const waiter of waiting) if (requests.length >= waiter.count) waiter.resolve();
    });
  }) as typeof fetch;
  try {
    await work(requests, count => requests.length >= count ? Promise.resolve() : new Promise(resolve => waiting.push({ count, resolve })));
  } finally { globalThis.fetch = fetch; }
}

test("a direct model completion reports real activity until success or failure", async () => {
  const events: unknown[] = [];
  const unsubscribe = sseHub.onFrame(({ userId, frame }) => {
    if (userId === person.id && frame.event === "activity.changed") events.push(frame.data);
  });
  try {
    await mocked(async (requests, waitFor) => {
      const pending = complete(args);
      await waitFor(1);
      const [activity] = await listActivities(harness.app.redis, person.id);
      assert.equal(activity?.kind, "model");
      assert.equal(activity?.label, "Meeting prep");
      assert.ok(activity?.id.startsWith("model:"));
      requests[0]!.finish();
      assert.equal((await pending).text, "Meeting ready");
      assert.deepEqual(await listActivities(harness.app.redis, person.id), []);
      assert.deepEqual(events, [{ id: activity!.id, phase: "started" }, { id: activity!.id, phase: "ended" }]);

      const failure = complete(args);
      const rejected = assert.rejects(failure);
      await waitFor(2);
      requests[1]!.fail(new Error("Provider unavailable"));
      await rejected;
      assert.deepEqual(await listActivities(harness.app.redis, person.id), []);
    });
  } finally { unsubscribe(); }
});

test("Stop on a direct completion aborts the provider request and closes activity", async () => {
  await mocked(async (requests, waitFor) => {
    const pending = complete(args);
    const rejected = assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
    await waitFor(1);
    const [activity] = await listActivities(harness.app.redis, person.id);
    await requestCancel(harness.app.redis, person.id, activity!.id);
    // Keep the test alive while the production monitor's unref'ed timer checks Stop.
    const keepAlive = setInterval(() => {}, 1_000);
    try { await rejected; } finally { clearInterval(keepAlive); }
    assert.equal(requests[0]!.signal.aborted, true);
    assert.deepEqual(await listActivities(harness.app.redis, person.id), []);
  });
});

test("concurrent direct completions have independent lifecycles", async () => {
  await mocked(async (requests, waitFor) => {
    const first = complete(args);
    await waitFor(1);
    const second = complete({ ...args, purpose: "Test skill" });
    await waitFor(2);
    const active = await listActivities(harness.app.redis, person.id);
    assert.equal(active.length, 2);
    assert.equal(new Set(active.map(row => row.id)).size, 2);
    requests[0]!.finish(); await first;
    assert.equal((await listActivities(harness.app.redis, person.id))[0]?.label, "Test skill");
    requests[1]!.finish(); await second;
    assert.deepEqual(await listActivities(harness.app.redis, person.id), []);
  });
});

test("a nested completion inherits the parent's activity and cancellation", async () => {
  const controller = new AbortController();
  await beginActivity(harness.app.redis, person.id, { id: "parent-turn", kind: "assistant", label: "Assistant" });
  try {
    await mocked(async (requests, waitFor) => {
      const pending = withActivity(person.id, "parent-turn", controller.signal, async () => {
        await Promise.resolve();
        return complete(args);
      });
      const rejected = assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
      await waitFor(1);
      assert.deepEqual((await listActivities(harness.app.redis, person.id)).map(row => row.id), ["parent-turn"]);
      controller.abort(new DOMException("Stopped parent", "AbortError"));
      await rejected;
      assert.equal(requests[0]!.signal.aborted, true);
      assert.deepEqual((await listActivities(harness.app.redis, person.id)).map(row => row.id), ["parent-turn"], "the child cannot end its parent");
    });
  } finally { await endActivity(harness.app.redis, person.id, "parent-turn"); }
});

test("paused or already cancelled completions never register working activity", async () => {
  await setPaused(harness.app.redis, person.id, true);
  try {
    await assert.rejects(complete(args), /paused/);
    assert.deepEqual(await listActivities(harness.app.redis, person.id), []);
  } finally { await setPaused(harness.app.redis, person.id, false); }
  await assert.rejects(complete({ ...args, signal: AbortSignal.abort(new DOMException("Stopped", "AbortError")) }), /Stopped/);
  assert.deepEqual(await listActivities(harness.app.redis, person.id), []);
});
