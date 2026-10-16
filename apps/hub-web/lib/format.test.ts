import assert from "node:assert/strict";
import test from "node:test";
import { plural, pluralWord } from "./format";

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
