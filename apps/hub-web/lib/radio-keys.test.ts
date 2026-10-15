import assert from "node:assert/strict";
import test from "node:test";
import { radioKeyTarget } from "./radio-keys";

test("arrow keys move through a radio group and wrap; Home and End jump; other keys do nothing", () => {
  assert.equal(radioKeyTarget("ArrowRight", 0, 3), 1);
  assert.equal(radioKeyTarget("ArrowDown", 2, 3), 0);
  assert.equal(radioKeyTarget("ArrowLeft", 0, 3), 2);
  assert.equal(radioKeyTarget("ArrowUp", 1, 3), 0);
  assert.equal(radioKeyTarget("Home", 2, 3), 0);
  assert.equal(radioKeyTarget("End", 0, 3), 2);
  assert.equal(radioKeyTarget("Enter", 1, 3), null);
  assert.equal(radioKeyTarget("ArrowRight", 0, 0), null);
});
