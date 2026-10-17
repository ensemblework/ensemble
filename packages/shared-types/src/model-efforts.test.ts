import assert from "node:assert/strict";
import test from "node:test";
import { checkEffort, modelEfforts } from "./model-efforts.js";

test("what the provider's own model list says wins, in order, with known names only", () => {
  const listed = modelEfforts("copilot", "claude-opus-5.5", { efforts: ["max", "low", "high", "xhigh", "medium"] });
  assert.deepEqual(listed, { levels: ["low", "medium", "high", "xhigh", "max"], fallback: null, source: "provider" });
  assert.equal(modelEfforts("anthropic", "claude-opus-5-5", { efforts: ["low", "medium", "high", "xhigh", "max"] }).fallback, "medium");
  assert.deepEqual(modelEfforts("anthropic", "claude-haiku-4-5", { efforts: [] }).levels, []);
  assert.deepEqual(modelEfforts("copilot", "gpt-4.1", {}).levels, [], "a Copilot model with no listed levels has no setting");
});

test("documented families: Claude, OpenAI, Gemini, Ollama, and providers with no setting", () => {
  assert.deepEqual(modelEfforts("anthropic", "claude-opus-4-6").levels, ["low", "medium", "high", "max"]);
  assert.deepEqual(modelEfforts("anthropic", "claude-sonnet-5-5"), { levels: ["low", "medium", "high", "xhigh", "max"], fallback: "high", source: "documented" });
  assert.deepEqual(modelEfforts("anthropic", "claude-haiku-4-5").levels, []);
  assert.deepEqual(modelEfforts("openai", "gpt-6-luna").levels, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(modelEfforts("openai", "gpt-6.1-sol").levels, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(modelEfforts("openai", "gpt-5.5").levels, ["none", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(modelEfforts("openai", "gpt-5-mini").levels, ["minimal", "low", "medium", "high"]);
  assert.deepEqual(modelEfforts("openai", "gpt-4.1").levels, []);
  assert.equal(modelEfforts("openai", "gpt-7-nova").source, "unknown", "a model the table does not know: the provider decides");
  assert.deepEqual(modelEfforts("google", "gemini-3.5-flash-lite").levels, ["minimal", "low", "medium", "high"]);
  assert.deepEqual(modelEfforts("google", "gemini-3.1-pro").levels, ["low", "medium", "high"], "on Pro, minimal is the same as low");
  assert.deepEqual(modelEfforts("google", "gemini-2.5-flash").levels, ["none", "low", "medium", "high"]);
  assert.deepEqual(modelEfforts("google", "gemma-3-27b-it").levels, []);
  assert.deepEqual(modelEfforts("ollama", "gpt-oss:20b").levels, ["low", "medium", "high"]);
  for (const provider of ["mistral", "kimi", "qwen", "cursor"]) assert.deepEqual(modelEfforts(provider, "any-model").levels, []);
});

test("a chosen level is sent as it is, or refused with the levels the model takes; never swapped", () => {
  assert.deepEqual(checkEffort("anthropic", "claude-opus-5-5", "xhigh"), { ok: true, send: "xhigh" });
  assert.deepEqual(checkEffort("anthropic", "claude-opus-5-5", "default"), { ok: true, send: null });
  const refused = checkEffort("anthropic", "claude-opus-5-5", "minimal");
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.message : "", /does not take thinking “Minimal”\. It takes Low, Medium, High, Extra high and Max/);
  assert.deepEqual(checkEffort("mistral", "mistral-large-latest", "high"), { ok: true, send: null }, "no setting on the model: nothing is sent");
  assert.deepEqual(checkEffort("openai", "gpt-7-nova", "max"), { ok: true, send: null }, "unknown models use their default until capabilities are known");
  assert.deepEqual(checkEffort("google", "gemini-3.5-flash-lite", "minimal"), { ok: true, send: "minimal" });
});

test("included models offer Auto, Low, Medium and High at most, whatever the catalog says", () => {
  assert.deepEqual(modelEfforts("ensemble", "gpt-6-luna"), { levels: ["low", "medium", "high"], fallback: "medium", source: "documented" });
  assert.deepEqual(modelEfforts("ensemble", "gpt-6.1-sol", { efforts: ["low", "max"] }).levels, ["low", "medium", "high"]);
  assert.equal(modelEfforts("ensemble", "grok-4.7").fallback, "high");
  assert.deepEqual(modelEfforts("ensemble", "deepseek-v4-flash").levels, [], "DeepSeek has no thinking setting: Auto only");
  assert.deepEqual(modelEfforts("ensemble", "not-a-deployment").levels, []);
  assert.deepEqual(checkEffort("ensemble", "gpt-6-luna", "high"), { ok: true, send: "high" });
  assert.deepEqual(checkEffort("ensemble", "gpt-6-luna", "default"), { ok: true, send: null });
  assert.deepEqual(checkEffort("ensemble", "deepseek-v4-flash", "high"), { ok: true, send: null }, "a model with no setting gets no level");
  for (const level of ["max", "xhigh", "none"]) assert.equal(checkEffort("ensemble", "grok-4.7", level).ok, false, level);
});
