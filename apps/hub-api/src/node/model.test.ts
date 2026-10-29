import assert from "node:assert/strict";
import { test } from "node:test";
import { leadChatModel } from "./model.js";

const included = { AZURE_FOUNDRY_RESOURCE: "ensemble-ai", AZURE_FOUNDRY_API_KEY: "test-key", ENSEMBLE_INCLUDED_MODELS: "gpt-6-luna,gpt-6.1-sol" };

test("a crew's lead plans with the lead model at medium thinking, unless its owner chose its model or thinking level", () => {
  assert.deepEqual(leadChatModel({ model: null, effort: null }, included), { pick: { provider: "ensemble", model: "gpt-6.1-sol" }, effort: "medium" });
  assert.equal(leadChatModel({ model: "gpt-6-luna", effort: null }, included), null, "the owner's choice of model stands");
  assert.equal(leadChatModel({ model: null, effort: "high" }, included)?.effort, "high", "the owner's thinking level stands");
  assert.equal(leadChatModel({ model: null, effort: null }, { ...included, ENSEMBLE_INCLUDED_MODELS: "gpt-6-luna" }), null, "not offered here: the node's own default");
  assert.equal(leadChatModel({ model: null, effort: null }, { ...included, ENSEMBLE_NODE_LEAD_MODEL: "off" }), null);
  assert.equal(leadChatModel({ model: null, effort: null }, { ...included, ENSEMBLE_NODE_LEAD_EFFORT: "low" })?.effort, "low");
});
