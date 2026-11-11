import assert from "node:assert/strict";
import test from "node:test";
import { activityCommandsPerDay, activityPollInterval, activityRedisCommandsPerPoll } from "./activity-poll";
import { activityStatus } from "./activity-status";
import type { AgentJob, AgentState } from "./api";

test("a hidden tab stops polling and an idle tab backs off", () => {
  assert.equal(activityPollInterval({ hidden: true, open: true, idle: false }), false);
  assert.equal(activityPollInterval({ hidden: false, open: true, idle: true }), 2_000);
  assert.equal(activityPollInterval({ hidden: false, open: false, idle: false }), 30_000);
  assert.equal(activityPollInterval({ hidden: false, open: false, idle: true }), 5 * 60_000);
});

test("one idle visible tab drops from KEYS every 30s to two indexed commands every 5 minutes", () => {
  const before = activityCommandsPerDay(30_000, activityRedisCommandsPerPoll(false));
  const after = activityCommandsPerDay(
    activityPollInterval({ hidden: false, open: false, idle: true }),
    activityRedisCommandsPerPoll(false),
  );
  const hidden = activityCommandsPerDay(activityPollInterval({ hidden: true, open: false, idle: true }), activityRedisCommandsPerPoll(false));
  assert.equal(before, 5_760);
  assert.equal(after, 576);
  assert.equal(hidden, 0);
});

const empty: AgentState = { paused: false, calls: [], running: [], waiting: [], queued: [] };
const job = (status: AgentJob["status"]) => ({ status }) as AgentJob;

test("only a successful activity snapshot establishes Idle", () => {
  assert.equal(activityStatus({ connected: true }).word, "Checking…");
  assert.equal(activityStatus({ connected: true, failed: true }).word, "Unavailable");
  assert.equal(activityStatus({ connected: true, data: empty }).word, "Idle");
  assert.equal(activityStatus({ connected: false, data: empty }).word, "Offline");
  assert.equal(activityStatus({ connected: false, serverError: true, data: empty }).word, "Server error");
  assert.equal(activityStatus({ connected: true, failed: true, data: { ...empty, running: [job("running")] } }).tone, "unknown", "a failed refresh cannot keep asserting that stale work is running");
});

test("queued, paused, stopping and human waits stay distinct from working", () => {
  assert.equal(activityStatus({ connected: true, data: { ...empty, queued: [job("queued")] } }).tone, "queued");
  assert.equal(activityStatus({ connected: true, data: { ...empty, waiting: [job("waiting_approval")] } }).tone, "needs");
  assert.equal(activityStatus({ connected: true, data: { ...empty, running: [job("stopping")] } }).tone, "stopping");
  assert.equal(activityStatus({ connected: true, data: { ...empty, running: [job("claimed")] } }).tone, "starting");
  assert.equal(activityStatus({ connected: true, data: { ...empty, paused: true, running: [job("running")] } }).tone, "paused");
  const mixed = activityStatus({ connected: true, data: { ...empty, running: [job("running"), job("stopping")], waiting: [job("waiting_approval")] } });
  assert.equal(mixed.tone, "working");
  assert.equal(mixed.count, 1);
  assert.equal(mixed.attention, true);
  assert.equal(mixed.summary, "1 running · 1 stopping · 1 waiting for you");
});
