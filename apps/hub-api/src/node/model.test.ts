import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultChatModel, fastChatModel, leadChatModel, modelProblem, nodeModelOptions } from "./model.js";

const included = { AZURE_FOUNDRY_RESOURCE: "ensemble-ai", AZURE_FOUNDRY_API_KEY: "test-key", ENSEMBLE_INCLUDED_MODELS: "gpt-6-luna,gpt-6.1-sol" };
const noTier = { models: { medium: null } } as never;

test("a node with no model of its own talks with Sol, falls back to Luna when rate-limited, and the server can name another", () => {
  assert.deepEqual(defaultChatModel(noTier, included), { provider: "ensemble", model: "gpt-6.1-sol" });
  assert.deepEqual(fastChatModel(noTier, included), { provider: "ensemble", model: "gpt-6-luna" });
  assert.deepEqual(defaultChatModel(noTier, { ...included, ENSEMBLE_INCLUDED_MODELS: "gpt-6-luna" }), { provider: "ensemble", model: "gpt-6-luna" }, "Sol not offered here");
  assert.deepEqual(defaultChatModel(noTier, { ...included, ENSEMBLE_NODE_MODEL: "gpt-6-luna" }), { provider: "ensemble", model: "gpt-6-luna" });
});

test("a crew's lead plans with the lead model at medium thinking, unless its owner chose its model or thinking level", () => {
  assert.deepEqual(leadChatModel({ model: null, effort: null }, included), { pick: { provider: "ensemble", model: "gpt-6.1-sol" }, effort: "medium" });
  assert.equal(leadChatModel({ model: "gpt-6-luna", effort: null }, included), null, "the owner's choice of model stands");
  assert.equal(leadChatModel({ model: null, effort: "high" }, included)?.effort, "high", "the owner's thinking level stands");
  assert.equal(leadChatModel({ model: null, effort: null }, { ...included, ENSEMBLE_INCLUDED_MODELS: "gpt-6-luna" }), null, "not offered here: the node's own default");
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
