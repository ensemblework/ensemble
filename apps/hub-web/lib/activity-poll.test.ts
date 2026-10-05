import assert from "node:assert/strict";
import test from "node:test";
import { activityCommandsPerDay, activityPollInterval, activityRedisCommandsPerPoll } from "./activity-poll";

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
