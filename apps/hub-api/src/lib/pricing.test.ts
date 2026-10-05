import assert from "node:assert/strict";
import test from "node:test";
import { estimateUsd } from "./pricing.js";

test("current Gemini flash-lite price is used for metrics", () => {
  const cost = estimateUsd("gemini-3.5-flash-lite", 1_000_000, 1_000_000);
  assert.equal(cost, 2.8);
});

test("unknown models stay unpriced", () => {
  assert.equal(estimateUsd("gemini-2.0-flash", 100, 100), null);
});

test("gemini 2.5 list prices used by the branch desk", () => {
  assert.equal(estimateUsd("gemini-2.5-flash", 1_000_000, 1_000_000), 0.75);
  assert.equal(estimateUsd("gemini-2.5-pro", 1_000_000, 0), 1.25);
});
