import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError, parseProviderError } from "./errors.js";
import { canCrossModelFallback, retryPlan } from "./payload.js";

test("a bare 429 is not retried, and RESOURCE_EXHAUSTED is quota", () => {
  assert.equal(retryPlan(new ProviderError(429, "rate_limit", "slow", null, 2), 0, () => 0), 2);
  assert.equal(retryPlan(new ProviderError(429, "rate_limit", "slow"), 0, () => 0), null);
  const exhausted = parseProviderError(
    429,
    JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Resource exhausted. Please try again later." } }),
    null,
  );
  assert.equal(exhausted.kind, "quota");
  assert.equal(retryPlan(exhausted, 0, () => 0), null);
  assert.equal(retryPlan(new ProviderError(429, "quota", "out", null, 30), 0, () => 0), null);
  const again = retryPlan(new ProviderError(503, "unavailable", "high demand"), 0, () => 0);
  assert.equal(again, 0.4);
});

test("there is no silent cross-model fallback, including lite to flash", () => {
  const busy = new ProviderError(503, "unavailable", "high demand");
  assert.equal(canCrossModelFallback(busy, "gemini-3.5-flash-lite", "gemini-3.5-flash"), false);
  assert.equal(canCrossModelFallback(busy, "gemini-3.5-flash", "gemini-3.5-flash-lite"), false);
});
