import assert from "node:assert/strict";
import { test } from "node:test";
import { verdictOf, type StepReport } from "./report.js";
import { parseJudgement, picturesAsked, visionChecks, visionModel } from "./vision.js";

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

test("a review whose screenshot the picture check confirms passes: the picture's check is evidence of strength A", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const pictures = [{ id, name: "steps.png", caption: null }];
  const confirmed = visionChecks([{ id, verdict: "pass", reason: "The three steps show in order." }], pictures, "review");
  assert.deepEqual(confirmed.map((check) => [check.verdict, check.strength, check.evidence]), [["pass", "A", [id]]]);
  const report: StepReport = { outcome: "pass", summary: "The steps show in order.", checks: [{ id: "A1", name: "steps in order", verdict: "pass", strength: "A", evidence: [id] }, ...confirmed] };
  assert.deepEqual(verdictOf("review", report, ["A1"], ["A1"]), { outcome: "pass", problem: null });
  // A picture that does not show what was asked fails a review or verification; elsewhere it only stays unshown.
  const wrong = [{ id, verdict: "fail" as const, reason: "A sign-in page." }];
  assert.equal(visionChecks(wrong, pictures, "review")[0]!.verdict, "fail");
  assert.equal(visionChecks(wrong, pictures, "build")[0]!.verdict, "blocked");
});
