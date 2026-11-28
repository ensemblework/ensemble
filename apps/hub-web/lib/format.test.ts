import assert from "node:assert/strict";
import test from "node:test";
import { dueDate, dueLabel, isoDate, plural, pluralWord } from "./format";

test("plurals follow English endings instead of always adding an s", () => {
  assert.equal(plural(3, "class"), "3 classes");
  assert.equal(plural(1, "class"), "1 class");
  assert.equal(plural(2, "box"), "2 boxes");
  assert.equal(plural(2, "match"), "2 matches");
  assert.equal(plural(2, "reply"), "2 replies");
  assert.equal(plural(2, "day"), "2 days");
  assert.equal(plural(2, "key"), "2 keys");
  assert.equal(plural(2, "task"), "2 tasks");
  assert.equal(plural(0, "page"), "0 pages");
  assert.equal(plural(2, "person"), "2 people");
  assert.equal(plural(2, "meeting note"), "2 meeting notes");
  assert.equal(plural(2, "plot space"), "2 plot spaces");
  assert.equal(plural(2, "status"), "2 statuses");
  assert.equal(plural(2, "selected task", "selected tasks"), "2 selected tasks");
  assert.equal(pluralWord("data file"), "data files");
});

test("a date-only due reads as its own day west of UTC, and a due with a time as its local day", () => {
  const zone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const day = (offset: number) => {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      return isoDate(date);
    };
    // Midnight UTC is the previous evening in Los Angeles; the date must not move.
    assert.equal(dueLabel(`${day(1)}T00:00:00.000Z`)?.text, "due tomorrow");
    assert.equal(dueLabel(`${day(0)}T00:00:00.000Z`)?.text, "due today");
    assert.equal(dueLabel(`${day(-1)}T00:00:00.000Z`)?.overdue, true);
    // 17:00 local is the next day in UTC; it is still due on its local day.
    assert.equal(dueLabel(new Date(`${day(1)}T17:00:00`).toISOString())?.text, "due tomorrow");
    assert.equal(isoDate(dueDate(`${day(2)}T00:00:00.000Z`)!), day(2));
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
