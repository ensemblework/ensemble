import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJudgement, picturesAsked, visionModel } from "./vision.js";

const included = { AZURE_FOUNDRY_RESOURCE: "ensemble-ai", AZURE_FOUNDRY_API_KEY: "test-key", ENSEMBLE_INCLUDED_MODELS: "gpt-6-luna,gpt-6.1-sol,deepseek-v4-flash" };

test("pictures are judged by an included model that reads them; the server can name another or none", () => {
  assert.equal(visionModel(included), "gpt-6.1-sol");
  assert.equal(visionModel({ ...included, ENSEMBLE_INCLUDED_MODELS: "gpt-6-luna" }), "gpt-6-luna");
  assert.equal(visionModel({ ...included, ENSEMBLE_NODE_VISION_MODEL: "gpt-6-luna" }), "gpt-6-luna");
  assert.equal(visionModel({ ...included, ENSEMBLE_NODE_VISION_MODEL: "deepseek-v4-flash" }), null, "a model that reads no pictures never judges them");
  assert.equal(visionModel({ ...included, ENSEMBLE_NODE_VISION_MODEL: "off" }), null);
  assert.equal(visionModel({}), null, "no included models");
});

test("what the pictures must show: only the step's requirements that asked for a screenshot or video, with their criteria", () => {
  const requirements = [
    { id: "R1", text: "The app lists notifications", evidence: ["screenshot"], acceptance: [{ text: "At least one notification shows" }, { text: "No error banner" }] },
    { id: "R2", text: "Docs updated", evidence: ["doc"] },
    { id: "R3", text: "A video of the animation", evidence: ["video"] },
  ];
  assert.deepEqual(picturesAsked(requirements, ["R1", "R2"]), ["The app lists notifications\n  Acceptance: At least one notification shows; No error banner"]);
  assert.deepEqual(picturesAsked(requirements, ["R2"]), []);
  assert.deepEqual(picturesAsked(requirements, ["R3"]), ["A video of the animation"]);
});

test("the judge's answer counts only for the pictures it was shown, once each", () => {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const text = `Here: {"pictures":[{"id":"${ids[0]}","verdict":"fail","reason":"Blank page."},{"id":"${ids[0]}","verdict":"pass"},{"id":"someone-else","verdict":"pass"},{"id":"${ids[1]}","verdict":"maybe"}]}`;
  assert.deepEqual(parseJudgement(text, ids), [{ id: ids[0], verdict: "fail", reason: "Blank page." }]);
  assert.deepEqual(parseJudgement("not json", ids), []);
});
