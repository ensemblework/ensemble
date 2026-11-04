import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultChatModel, fastChatModel, leadChatModel, modelProblem, nodeModelOptions } from "./model.js";

const included = { AZURE_FOUNDRY_RESOURCE: "ensemble-ai", AZURE_FOUNDRY_API_KEY: "test-key" };
const noTier = { models: { medium: null } } as never;

test("nodes default to GPT-5 mini, use GPT-4.1 mini when rate-limited, and permit explicit restored models", () => {
  assert.deepEqual(defaultChatModel(noTier, included), { provider: "ensemble", model: "gpt-5-mini" });
  assert.deepEqual(fastChatModel(noTier, included), { provider: "ensemble", model: "gpt-4.1-mini" });
  assert.deepEqual(defaultChatModel(noTier, { ...included, ENSEMBLE_INCLUDED_MODELS: "gpt-4.1-mini" }), { provider: "ensemble", model: "gpt-4.1-mini" });
  assert.deepEqual(defaultChatModel(noTier, { ...included, ENSEMBLE_NODE_MODEL: "gpt-4.1-mini" }), { provider: "ensemble", model: "gpt-4.1-mini" });
  assert.deepEqual(defaultChatModel(noTier, { ...included, ENSEMBLE_INCLUDED_MODELS: "gpt-6-luna,gpt-6.1-sol", ENSEMBLE_NODE_MODEL: "gpt-6.1-sol" }), { provider: "ensemble", model: "gpt-6.1-sol" });
});

test("a crew's lead plans with the lead model at medium thinking, unless its owner chose its model or thinking level", () => {
  assert.deepEqual(leadChatModel({ model: null, effort: null }, included), { pick: { provider: "ensemble", model: "gpt-5-mini" }, effort: "medium" });
  assert.equal(leadChatModel({ model: "gpt-6-luna", effort: null }, included), null, "the owner's choice of model stands");
  assert.equal(leadChatModel({ model: null, effort: "high" }, included)?.effort, "high", "the owner's thinking level stands");
  assert.equal(leadChatModel({ model: null, effort: null }, { ...included, ENSEMBLE_INCLUDED_MODELS: "gpt-4.1-mini" }), null, "not offered here: the node's own default");
  assert.equal(leadChatModel({ model: null, effort: null }, { ...included, ENSEMBLE_NODE_LEAD_MODEL: "off" }), null);
  assert.equal(leadChatModel({ model: null, effort: null }, { ...included, ENSEMBLE_NODE_LEAD_EFFORT: "low" })?.effort, "low");
});

test("a node may use any model its AI plan lists, not only the first ones the picker shows", async () => {
  const models = Array.from({ length: 50 }, (_, index) => ({ id: `model-${index}`, label: `Model ${index}` }));
  const device = { name: "Box", lastSeenAt: new Date(), capabilities: { assistantTurns: 3, agents: [{ id: "opencode", via: "cli", version: "1", signedIn: true, models, checkedAt: "2026-10-31T00:00:00Z" }] } };
  const prisma = { device: { findMany: async () => [device] } } as never;
  const { options } = await nodeModelOptions(prisma, "account-1");
  assert.equal(options.filter((row) => row.provider === "opencode").length, 40, "the picker's list stays short");
  assert.equal(await modelProblem(prisma, "account-1", "opencode", "model-45"), null);
  assert.match((await modelProblem(prisma, "account-1", "opencode", "model-99")) ?? "", /not available/);
});
