import assert from "node:assert/strict";
import test from "node:test";
import { claudeCodeModels, claudeCodeModelsFrom, claudeLaunch, claudeModel, claudeUpdateNote } from "./claude-models.js";

test("Claude Code lists each model it can run with its own thinking levels and context windows", () => {
  const models = claudeCodeModels("2.1.284");
  assert.equal(models[0]!.id, "default");
  const ids = models.map((row) => row.id);
  assert.ok(ids.includes("claude-opus-5-5") && ids.includes("claude-sonnet-5-5"));
  assert.ok(!ids.includes("claude-haiku-5-5"), "Haiku 5.5 needs 2.1.293");
  const sonnet46 = models.find((row) => row.id === "claude-sonnet-4-6")!;
  assert.deepEqual(sonnet46.efforts, ["low", "medium", "high", "max"]);
  assert.equal(sonnet46.defaultEffort, "high");
  assert.deepEqual(sonnet46.contexts?.map((row) => [row.id, row.tokens]), [["default", 200_000], ["long_context", 1_000_000]]);
  const opus = models.find((row) => row.id === "claude-opus-5-5")!;
  assert.deepEqual(opus.contexts?.map((row) => row.tokens), [1_000_000], "one fixed window");
  assert.equal(opus.defaultEffort, "medium");
  assert.ok(opus.aliases?.includes("opus"));
  assert.equal(claudeModel("opus")?.id, "claude-opus-5-5");
  assert.equal(claudeModel("claude-opus-4-6[1m]")?.id, "claude-opus-4-6");
  assert.equal(claudeUpdateNote("2.1.284"), "Claude Code 2.1.284 cannot run Claude Haiku 5.5. Update it to 2.1.293 or newer (`claude update`).");
  assert.equal(claudeUpdateNote("2.1.304"), null);
});

test("a run passes the model's 1M window as [1m] and each thinking level under Claude Code's own name", () => {
  assert.deepEqual(claudeLaunch({ model: "claude-opus-4-6", effort: "max", context: "long_context" }), { model: "claude-opus-4-6[1m]", effort: "max", notes: [] });
  assert.deepEqual(claudeLaunch({ model: "claude-opus-4-7", effort: "xhigh" }), { model: "claude-opus-4-7", effort: "max", notes: [] }, "4.7 takes Extra high as max");
  const fixed = claudeLaunch({ model: "opus", effort: "xhigh", context: "long_context" });
  assert.equal(fixed.model, "opus");
  assert.equal(fixed.effort, "xhigh");
  assert.match(fixed.notes[0]!, /one context window \(1M\)/);
  const skipped = claudeLaunch({ model: "claude-sonnet-4-6", effort: "xhigh" });
  assert.equal(skipped.effort, null);
  assert.match(skipped.notes[0]!, /does not take thinking/);
  assert.deepEqual(claudeLaunch({ model: "default", effort: "high" }), { model: null, effort: "high", notes: [] });
  assert.deepEqual(claudeLaunch({ model: "claude-haiku-4-5", effort: "default" }), { model: "claude-haiku-4-5", effort: null, notes: [] });
  assert.equal(claudeLaunch({ model: "opus", fast: true }).fast, true, "Opus has fast mode");
  const slow = claudeLaunch({ model: "claude-sonnet-5-5", fast: true });
  assert.equal(slow.fast, undefined);
  assert.match(slow.notes[0]!, /has no fast mode/);
});

test("the models Claude Code lists for the plan come first, with the table's context windows; earlier models follow", () => {
  const models = claudeCodeModelsFrom(
    [
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsEffort: true, supportsFastMode: true },
      { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", description: "Sonnet 5.5 · Efficient", supportedEffortLevels: ["low", "high"], supportsEffort: true },
    ],
    "2.1.304",
  );
  assert.deepEqual(models.slice(0, 2).map((model) => [model.id, model.label, model.isDefault ?? false, model.fast ?? null, model.efforts, model.contexts?.map((row) => row.tokens)]), [
    ["default", "Default (recommended)", true, "on", ["low", "medium", "high", "xhigh", "max"], [1_000_000]],
    ["sonnet", "Sonnet", false, null, ["low", "high"], [1_000_000]],
  ]);
  assert.deepEqual(models[1]!.aliases, ["claude-sonnet-5-5"]);
  assert.ok(models.some((model) => model.id === "claude-opus-4-6"), "earlier models stay choosable");
  assert.ok(!models.some((model) => model.id === "claude-sonnet-5-5"), "a listed model is not repeated by its full name");
  assert.equal(claudeCodeModelsFrom(null, "2.1.304")[0]!.id, "default", "without a list, the table");
});
