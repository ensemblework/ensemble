import assert from "node:assert/strict";
import test from "node:test";
import { Settings } from "@ensemble/shared-types";
import { diffFields, sameValue } from "./undo.js";

test("undo depth and history retention have bounded defaults", () => {
  const settings = Settings.parse({});
  assert.equal(settings.undoDepth, 5);
  assert.equal(settings.historyRetentionDays, 90);
  assert.equal(Settings.parse({ retentionDays: 30 }).undoDepth, 5);
  assert.throws(() => Settings.parse({ undoDepth: 2 }));
  assert.throws(() => Settings.parse({ undoDepth: 21 }));
  assert.throws(() => Settings.parse({ historyRetentionDays: 29 }));
  assert.equal(Settings.parse({ undoDepth: 20, historyRetentionDays: 365 }).undoDepth, 20);
});

test("a patch stores changed fields and leaves the clock out", () => {
  const before = { title: "Draft", priority: "p1", pinned: false, updatedAt: new Date("2026-09-01T00:00:00.000Z"), id: "a", userId: "u" };
  const after = { title: "Draft", priority: "p0", pinned: false, updatedAt: new Date("2026-09-02T00:00:00.000Z"), id: "a", userId: "u" };
  assert.deepEqual(diffFields(before, after), { priority: { before: "p1", after: "p0" } });
  assert.equal(sameValue(new Date("2026-09-02T00:00:00.000Z"), "2026-09-02T00:00:00.000Z"), true);
  assert.equal(sameValue(null, undefined), true);
});
