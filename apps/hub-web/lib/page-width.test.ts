import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampPageWidth } from "./page-width";

describe("page width", () => {
  it("clamps to the shared range and rounds", () => {
    assert.equal(clampPageWidth(10), 28);
    assert.equal(clampPageWidth(90), 80);
    assert.equal(clampPageWidth(50.4), 50);
    assert.equal(clampPageWidth(Number.NaN), 50);
  });
});
