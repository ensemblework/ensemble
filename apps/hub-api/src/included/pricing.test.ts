import assert from "node:assert/strict";
import test from "node:test";
import { includedConfig, parseIncludedConfig } from "./config.js";
import { includedCost, worstCaseUsd, toCredits } from "./pricing.js";

const close = (actual: number, expected: number, what = "") => assert.ok(Math.abs(actual - expected) < 1e-12, `${what} ${actual} ≠ ${expected}`);

test("cache reads and writes are priced apart from new input; output separately", () => {
  const cost = includedCost("gpt-6.1-sol", { inputTokens: 100_000, cacheReadTokens: 60_000, cacheWriteTokens: 30_000, outputTokens: 2_000 });
  close(cost.inputUsd, (10_000 * 2 + 60_000 * 0.1 + 30_000 * 2.5) / 1e6);
  close(cost.outputUsd, (2_000 * 10) / 1e6);
  close(cost.usd, cost.inputUsd + cost.outputUsd);
  close(includedCost("deepseek-v4-flash", { inputTokens: 10_000, cacheReadTokens: 4_000, cacheWriteTokens: 0, outputTokens: 1_000 }).usd, (6_000 * 0.19 + 4_000 * 0.028 + 1_000 * 0.51) / 1e6);
});

test("a long prompt pays the long-context rates for the whole request", () => {
  close(includedCost("gpt-6-luna", { inputTokens: 272_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000 }).usd, (272_000 * 0.1 + 1_000 * 0.5) / 1e6);
  close(includedCost("gpt-6-luna", { inputTokens: 272_001, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000 }).usd, (272_001 * 0.2 + 1_000 * 0.75) / 1e6);
  close(includedCost("gpt-6.1-sol", { inputTokens: 300_000, cacheReadTokens: 100_000, cacheWriteTokens: 0, outputTokens: 1_000 }).usd, (200_000 * 4 + 100_000 * 0.2 + 1_000 * 15) / 1e6);
  close(includedCost("grok-4.7", { inputTokens: 199_999, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000 }).usd, (199_999 * 2 + 1_000 * 6) / 1e6);
  close(includedCost("grok-4.7", { inputTokens: 200_000, cacheReadTokens: 50_000, cacheWriteTokens: 0, outputTokens: 1_000 }).usd, (150_000 * 4 + 50_000 * 1 + 1_000 * 12) / 1e6, "from 200,000 prompt tokens");
  close(includedCost("deepseek-v4-flash", { inputTokens: 900_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }).usd, (900_000 * 0.19) / 1e6);
  close(includedCost("gpt-5-mini", { inputTokens: 20_000, cacheReadTokens: 10_000, cacheWriteTokens: 0, outputTokens: 1_000 }).usd, (10_000 * 0.25 + 10_000 * 0.025 + 1_000 * 2) / 1e6);
  close(includedCost("gpt-4.1-mini", { inputTokens: 20_000, cacheReadTokens: 10_000, cacheWriteTokens: 0, outputTokens: 1_000 }).usd, (10_000 * 0.4 + 10_000 * 0.1 + 1_000 * 1.6) / 1e6);
});

test("counts are clamped: cache cannot exceed input, negatives are zero", () => {
  close(includedCost("gpt-6-luna", { inputTokens: 1_000, cacheReadTokens: 5_000, cacheWriteTokens: 5_000, outputTokens: -5 }).usd, (1_000 * 0.01) / 1e6);
  assert.throws(() => includedCost("gpt-4.1", { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }), /No price/);
});

test("the worst case is all input uncached plus the full reply cap; 1,000 credits are $1", () => {
  close(worstCaseUsd("gpt-6-luna", 20_000, 16_000), (20_000 * 0.1 + 16_000 * 0.5) / 1e6);
  close(toCredits(0.009), 9);
});

test("configuration: off, unknown models, resource names and limits", () => {
  const base = { AZURE_FOUNDRY_RESOURCE: "ensemble-ai", AZURE_FOUNDRY_API_KEY: "key" };
  assert.equal(includedConfig({}), null);
  assert.equal(includedConfig({ ...base, ENSEMBLE_INCLUDED_MODELS: "off" }), null);
  const all = includedConfig(base)!;
  assert.deepEqual(all.models.map((model) => model.id), ["gpt-6-luna", "deepseek-v4-flash", "gpt-6.1-sol", "grok-4.7"]);
  assert.equal(all.monthlyCredits, 20_000);
  assert.equal(all.totalMonthlyUsd, 180);
  assert.equal(all.maxOutputTokens, 16_000);
  assert.equal(includedConfig({ ...base, ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS: "4096" })!.maxOutputTokens, 4_096);
  assert.throws(() => parseIncludedConfig({ ...base, ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS: "1.5" }), /whole number/);
  assert.deepEqual(includedConfig({ ...base, ENSEMBLE_INCLUDED_MODELS: "gpt-6-luna" })!.models.map((model) => model.id), ["gpt-6-luna"]);
  assert.deepEqual(includedConfig({ ...base, ENSEMBLE_INCLUDED_MODELS: "gpt-4.1-mini,gpt-5-mini" })!.models.map((model) => model.id), ["gpt-5-mini", "gpt-4.1-mini"], "free-account models only when named");
  assert.throws(() => parseIncludedConfig({ ...base, ENSEMBLE_INCLUDED_MODELS: "claude-haiku-5-5" }), /does not include: claude-haiku-5-5/);
  assert.throws(() => parseIncludedConfig({ ...base, AZURE_FOUNDRY_RESOURCE: "https://ensemble-ai.services.ai.azure.com" }), /resource name/);
  assert.throws(() => parseIncludedConfig({ ...base, ENSEMBLE_INCLUDED_TOTAL_MONTHLY_USD: "-1" }), /positive/);
  assert.equal(includedConfig({ ...base, ENSEMBLE_INCLUDED_MODELS: "typo" }), null, "a wrong value turns included AI off instead of failing requests");
});
