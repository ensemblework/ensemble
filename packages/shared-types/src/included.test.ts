import assert from "node:assert/strict";
import test from "node:test";
import { INCLUDED_MODELS, includedModelName, includedPeriod, includedResetsAt, isIncludedErrorCode } from "./included.js";

test("four included models by default plus two for free accounts, each named with its version, none of them Claude", () => {
  assert.deepEqual(INCLUDED_MODELS.filter((model) => model.offeredByDefault).map((model) => model.id), ["gpt-6-luna", "deepseek-v4-flash", "gpt-6.1-sol", "grok-4.7"]);
  assert.deepEqual(INCLUDED_MODELS.filter((model) => !model.offeredByDefault).map((model) => model.id), ["gpt-5-mini", "gpt-4.1-mini"]);
  assert.equal(includedModelName("gpt-5-mini"), "GPT-5 mini (2025-08-07)");
  assert.ok(INCLUDED_MODELS.every((model) => model.vendor !== "Anthropic"), "Azure credits cannot pay for Claude");
  assert.equal(includedModelName("grok-4.7"), "Grok 4.7");
  assert.equal(includedModelName("gpt-6-luna"), "GPT-6 Luna (2026-09-22)");
  assert.equal(includedModelName("somebody-else"), "somebody-else");
});

test("the month is UTC and credits reset at 00:00 UTC on the 1st", () => {
  const late = new Date("2026-10-31T23:59:59Z");
  assert.equal(includedPeriod(late), "2026-10");
  assert.equal(includedResetsAt(late).toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(includedResetsAt(new Date("2026-12-05T00:00:00Z")).toISOString(), "2027-01-01T00:00:00.000Z");
});

test("error codes", () => {
  assert.equal(isIncludedErrorCode("included_paused"), true);
  assert.equal(isIncludedErrorCode("model_quota_exceeded"), false);
});
