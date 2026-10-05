import assert from "node:assert/strict";
import test from "node:test";
import { untilLabel } from "./format";

test("a day left reads in hours", () => {
  assert.equal(untilLabel(1433 * 60), "about 24 h");
});

test("a short wait stays in minutes or seconds", () => {
  assert.equal(untilLabel(50 * 60), "50 min");
  assert.equal(untilLabel(40), "40s");
});
