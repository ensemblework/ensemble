import assert from "node:assert/strict";
import test from "node:test";
import { Settings } from "./assistant.js";

const automations = (value: unknown) => Settings.parse({ automations: value }).automations;

test("meeting automations are one switch and one tier, Medium by default; settings saved before still load", () => {
  assert.deepEqual(automations({}).meetings, { enabled: true, tier: "medium", minutesBefore: 45 });
  const legacy = automations({ meetingTasks: { enabled: false, tier: "easy" }, meetingPrep: { enabled: true, tier: "easy", minutesBefore: 30 }, linkMeetingSeries: false });
  assert.deepEqual(legacy.meetings, { enabled: true, tier: "medium", minutesBefore: 30 }, "on if either was; the old default tier becomes Medium");
  assert.equal("linkMeetingSeries" in legacy, false, "series always share a project now");
  assert.equal(automations({ meetingTasks: { enabled: false, tier: "high" }, meetingPrep: { enabled: false } }).meetings.enabled, false);
  assert.equal(automations({ meetingTasks: { tier: "high" } }).meetings.tier, "high", "a tier someone picked stays");
  assert.deepEqual(automations({ meetingTasks: { enabled: true }, meetings: { enabled: false, tier: "max" } }).meetings, { enabled: false, tier: "max", minutesBefore: 45 }, "a value saved since wins");
});
