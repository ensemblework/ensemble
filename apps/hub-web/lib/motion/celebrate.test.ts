import assert from "node:assert/strict";
import test from "node:test";
import { initialClear, initialToday, inboxCount, needsCount, stepClear, stepToday, type TaskSnap } from "./celebrate";

const task = (patch: Partial<TaskSnap> & Pick<TaskSnap, "id" | "status">): TaskSnap => ({
  priority: "p1",
  due: null,
  todayFocus: "auto",
  snoozedUntil: null,
  ...patch,
});

test("a queue that is already empty on the first reading does not celebrate", () => {
  const first = stepClear(initialClear(), 0);
  assert.equal(first.fire, false);
  const again = stepClear(first.watch, 0);
  assert.equal(again.fire, false);
});

test("clearing a queue fires once, and a later clear is a new event", () => {
  const seen = stepClear(initialClear(), 2);
  assert.equal(seen.fire, false);
  const cleared = stepClear(seen.watch, 0);
  assert.equal(cleared.fire, true);
  const held = stepClear(cleared.watch, 0);
  assert.equal(held.fire, false);
  const returned = stepClear(held.watch, 1);
  const again = stepClear(returned.watch, 0);
  assert.equal(again.fire, true);
});

test("unknown counts never fire", () => {
  const pending = stepClear(initialClear(), null);
  assert.equal(pending.fire, false);
  assert.equal(pending.watch.seen, false);
});

test("today celebrates only when the tasks that were on the list are marked done", () => {
  const open = [task({ id: "a", status: "todo", todayFocus: "keep" }), task({ id: "b", status: "todo", priority: "p0" })];
  const seen = stepToday(initialToday(), open);
  assert.equal(seen.fire, false);
  const hidden = stepToday(seen.watch, [task({ id: "a", status: "todo", todayFocus: "hidden" }), task({ id: "b", status: "todo", todayFocus: "hidden" })]);
  assert.equal(hidden.fire, false);
  const again = stepToday(initialToday(), open);
  const done = stepToday(again.watch, [
    task({ id: "a", status: "done", todayFocus: "keep" }),
    task({ id: "b", status: "done", priority: "p0" }),
  ]);
  assert.equal(done.fire, true);
  assert.equal(stepToday(done.watch, []).fire, false);
});

test("an already-finished day does not celebrate on load", () => {
  const first = stepToday(initialToday(), [task({ id: "a", status: "done", todayFocus: "keep" })]);
  assert.equal(first.fire, false);
});

test("inbox and needs me counts", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const tasks = [
    task({ id: "mail", status: "proposed" }),
    task({ id: "later", status: "proposed", snoozedUntil: "2026-10-02T12:00:00Z" }),
    task({ id: "mine", status: "todo" }),
  ];
  assert.equal(inboxCount(tasks, now), 1);
  assert.equal(needsCount({ shell: { approvals: 1, decisions: 0 }, approvals: null, decisions: null, blocked: null }), 1);
  assert.equal(needsCount({ shell: { approvals: 1, decisions: 2 }, approvals: 0, decisions: 0, blocked: 1 }), 1);
  assert.equal(needsCount({ shell: null, approvals: null, decisions: null, blocked: 3 }), null);
});
