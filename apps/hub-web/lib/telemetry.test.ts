import assert from "node:assert/strict";
import test from "node:test";
import { IDLE_MS, Tracker, type TrackerEnv } from "./telemetry.js";

function fakeEnv() {
  const state = { now: 1_000_000, visible: true, sent: [] as Array<{ body: Record<string, unknown>; beacon: boolean }>, ok: true };
  const env: TrackerEnv = {
    now: () => state.now,
    visible: () => state.visible,
    send: async (body, beacon) => {
      state.sent.push({ body: JSON.parse(body) as Record<string, unknown>, beacon });
      return state.ok;
    },
  };
  return { state, env, advance: (ms: number, tracker: Tracker) => { for (let left = ms; left > 0; left -= 5_000) { state.now += Math.min(5_000, left); tracker.tick(); } } };
}

test("a screen's time counts only while the tab is visible and someone used it in the last minute", () => {
  const { state, env, advance } = fakeEnv();
  const tracker = new Tracker(env, "tab0123456789");
  tracker.navigate("/board");
  advance(30_000, tracker);
  state.visible = false;
  advance(60_000, tracker);
  state.visible = true;
  tracker.input();
  advance(IDLE_MS + 120_000, tracker);
  tracker.navigate("/pages/abc");
  const events = tracker.pending();
  assert.deepEqual(events.map((event) => [event.kind, event.path]), [["session", "/board"], ["view", "/board"]]);
  assert.equal(events[1]!.durationMs, 30_000 + IDLE_MS, "visible time, then the idle minute, and nothing after");
});

test("actions carry the current screen; a failed send keeps the events for the next try", async () => {
  const { state, env } = fakeEnv();
  const tracker = new Tracker(env, "tab0123456789", "web", "1440x900");
  tracker.navigate("/today");
  tracker.action("palette.open", { from: "shortcut" });
  state.ok = false;
  await tracker.flush();
  assert.equal(tracker.pending().length, 2);
  state.ok = true;
  await tracker.flush(true);
  assert.equal(tracker.pending().length, 0);
  const last = state.sent.at(-1)!;
  assert.equal(last.beacon, true);
  assert.equal(last.body.sessionKey, "tab0123456789");
  assert.equal(last.body.viewport, "1440x900");
  assert.deepEqual((last.body.events as Array<{ action?: string; path: string }>).map((event) => [event.path, event.action]), [["/today", undefined], ["/today", "palette.open"]]);
});

test("a glance under a second is not a view", () => {
  const { state, env } = fakeEnv();
  const tracker = new Tracker(env, "tab0123456789");
  tracker.navigate("/board");
  state.now += 500;
  tracker.navigate("/pages");
  assert.deepEqual(tracker.pending().map((event) => event.kind), ["session"]);
});
