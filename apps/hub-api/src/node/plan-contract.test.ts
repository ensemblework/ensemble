import assert from "node:assert/strict";
import test from "node:test";
import { mergeConstraints, renderConstraints, validatePlan, type PlanShape } from "./plan-contract.js";

const req = (id: string, acceptance: string[] = []) => ({ id, acceptance: acceptance.map((a) => ({ id: a })) });
const step = (id: string, kind: string, requirementIds: string[], after: string[] = [], verifies?: string) => ({ id, kind, requirementIds, after, ...(verifies ? { verifies } : {}) });

test("F2: every requested feature must be covered by a step or deferred with a reason", () => {
  const plan: PlanShape = {
    requirements: [req("md"), req("expiry"), req("resize"), req("board")],
    deferred: [],
    constraints: {},
    steps: [step("b1", "build", ["md"]), step("b2", "build", ["expiry"])],
  };
  const problems = validatePlan(plan);
  assert.equal(problems.length, 2);
  assert.match(problems.join(" "), /No step covers requirement “resize”[\s\S]*No step covers requirement “board”/);
  assert.deepEqual(validatePlan({ ...plan, deferred: [{ requirementId: "resize" }, { requirementId: "board" }] }), []);
});

test("a requirement with acceptance criteria needs a verify step that checks a build before it", () => {
  const base: PlanShape = { requirements: [req("md", ["tables"])], deferred: [], constraints: {}, steps: [step("b1", "build", ["md"])] };
  assert.match(validatePlan(base).join(" "), /no verify step/);
  assert.match(validatePlan({ ...base, steps: [step("b1", "build", ["md"]), step("t1", "verify", ["md"])] }).join(" "), /must name the build step/);
  assert.match(validatePlan({ ...base, steps: [step("b1", "build", ["md"]), step("t1", "verify", ["md"], [], "b1")] }).join(" "), /must come after the build/);
  assert.deepEqual(validatePlan({ ...base, steps: [step("b1", "build", ["md"]), step("t1", "verify", ["md"], ["b1"], "b1")] }), []);
});

test("serial order: features are chained through their checks, and one build step per feature", () => {
  const requirements = [req("a", ["a1"]), req("b", ["b1"])];
  const grouped: PlanShape = { requirements, deferred: [], constraints: { order: "serial" }, steps: [step("build", "build", ["a", "b"]), step("test", "verify", ["a", "b"], ["build"], "build")] };
  assert.match(validatePlan(grouped).join(" "), /covers 2 requirements; give each feature its own build step/);
  const parallel: PlanShape = {
    requirements,
    deferred: [],
    constraints: { order: "serial" },
    steps: [step("ba", "build", ["a"]), step("ta", "verify", ["a"], ["ba"], "ba"), step("bb", "build", ["b"]), step("tb", "verify", ["b"], ["bb"], "bb")],
  };
  assert.match(validatePlan(parallel).join(" "), /“bb” \(for “b”\) must come after the check of “a”/);
  const chained: PlanShape = { ...parallel, steps: [step("ba", "build", ["a"]), step("ta", "verify", ["a"], ["ba"], "ba"), step("bb", "build", ["b"], ["ta"]), step("tb", "verify", ["b"], ["bb"], "bb")] };
  assert.deepEqual(validatePlan(chained), []);
  assert.deepEqual(validatePlan({ ...parallel, constraints: { order: "parallel_ok" } }), [], "parallel features are fine when the owner allows it");
});

test("unknown references, duplicates and cycles are reported", () => {
  const plan: PlanShape = {
    requirements: [req("a", ["x"]), req("b", ["x"])],
    deferred: [{ requirementId: "zzz" }],
    constraints: {},
    steps: [step("s1", "build", ["a", "nope"], ["s2"]), step("s2", "build", ["b"], ["s1"]), step("s3", "other", []), step("s3", "other", [])],
  };
  const text = validatePlan(plan).join(" ");
  assert.match(text, /Two steps have the id “s3”/);
  assert.match(text, /Two acceptance criteria have the id “x”/);
  assert.match(text, /covers “nope”, which is not a requirement/);
  assert.match(text, /cycle/);
  assert.match(text, /Deferred “zzz” is not a requirement/);
});

test("briefs stay short when constraints carry the rules; revisions may name existing steps", () => {
  const long = "x".repeat(1600);
  assert.match(validatePlan({ requirements: [], deferred: [], constraints: {}, steps: [{ ...step("s1", "build", []), brief: long }] }, { briefMax: 1500 }).join(" "), /keep it to the step's own objective/);
  assert.deepEqual(validatePlan({ requirements: [], deferred: [], constraints: {}, steps: [step("n1", "build", [], ["s1-abc"])], existing: new Set(["s1-abc"]) }), []);
});

test("constraints render once as rules for every step, and merge with clearing", () => {
  const text = renderConstraints({ folder: "ensemble", branch: "live-testing", publish: "push", environment: "testing", agent: "copilot-cli", model: "GPT 6.1 Sol", context: "long_context", substitution: "forbid", order: "serial", notes: ["Web app only."] });
  assert.match(text, /Where: folder ensemble/);
  assert.match(text, /Branch: live-testing/);
  assert.match(text, /commit and push/);
  assert.match(text, /copilot-cli, GPT 6\.1 Sol, long context \(already applied/);
  assert.match(text, /Never substitute/);
  assert.match(text, /one at a time/);
  assert.match(text, /Web app only\./);
  assert.deepEqual(mergeConstraints({ branch: "a", publish: "push" }, { branch: "", publish: "commit" }), { publish: "commit" });
});

test("parallel worktrees: builds that work apart are integrated once, after their checks, and checked again", () => {
  const requirements = [req("a", ["a1"]), req("b", ["b1"])];
  const builds = [step("ba", "build", ["a"]), step("ta", "verify", ["a"], ["ba"], "ba"), step("bb", "build", ["b"]), step("tb", "verify", ["b"], ["bb"], "bb")];
  const constraints: PlanShape["constraints"] = { folder: "live-test", parallel: "worktrees" };
  assert.match(validatePlan({ requirements, deferred: [], constraints, steps: builds }).join(" "), /add an integration step that brings “ba”, “bb” into the folder/);
  assert.match(validatePlan({ requirements, deferred: [], constraints: { parallel: "worktrees" }, steps: builds }).join(" "), /name it in constraints\.folder/);

  const integrate = (after: string[], over: Record<string, unknown> = {}) => ({ ...step("in", "build", ["a", "b"], after), integrates: ["ba", "bb"], ...over });
  const early = validatePlan({ requirements, deferred: [], constraints, steps: [...builds, integrate(["ba", "bb"])] }).join(" ");
  assert.match(early, /must come after “ba” and its checks: add “ta” to after/);
  assert.match(early, /needs a verify step after it \(verifies “in”\)/);
  const whole = [...builds, integrate(["ta", "tb"]), step("tin", "verify", ["a", "b"], ["in"], "in")];
  assert.deepEqual(validatePlan({ requirements, deferred: [], constraints, steps: whole }), []);
  assert.deepEqual(validatePlan({ requirements, deferred: [], constraints: { ...constraints, order: "serial" }, steps: whole.map((row) => (row.id === "bb" ? { ...row, after: ["ta"] } : row)) }), [], "an integration covering two features is not a grouped build");

  assert.match(validatePlan({ requirements, deferred: [], constraints, steps: [...builds, integrate(["ta", "tb"], { integrates: ["ba", "ta"] }), step("tin", "verify", [], ["in"], "in")] }).join(" "), /integrates “ta”, which is not a build step/);
  assert.match(validatePlan({ requirements, deferred: [], constraints: { folder: "live-test" }, steps: whole }).join(" "), /works in one checkout: set constraints\.parallel/);
  assert.match(validatePlan({ requirements, deferred: [], constraints: { ...constraints, parallel: "snapshots", integrate: "rebase" }, steps: whole }).join(" "), /Snapshots have no branches to rebase/);
  assert.deepEqual(validatePlan({ requirements: [req("a", ["a1"])], deferred: [], constraints, steps: builds.slice(0, 2) }), [], "one build alone needs no integration");
});

test("parallel constraints render once, with how the work comes together", () => {
  assert.match(renderConstraints({ parallel: "worktrees" }), /Parallel work: each build works in its own git worktree[^\n]*merges their branches into the folder's current branch\. The builds' branches stay on the computer/);
  assert.match(renderConstraints({ parallel: "worktrees", integrate: "rebase" }), /an integration step replays their commits/);
  assert.match(renderConstraints({ parallel: "worktrees", integrate: "merge", publish: "none" }), /an integration step applies their changes to the folder/, "with nothing committed there is nothing to merge");
  assert.match(renderConstraints({ parallel: "snapshots" }), /detached copy of the folder[^\n]*applies each one's changes/);
  assert.match(renderConstraints({ parallel: "serial" }), /Parallel work: one checkout of the folder; steps that change it take turns\./);
  assert.equal(renderConstraints({ folder: "app" }).includes("Parallel"), false, "the default says nothing new");
  assert.deepEqual(mergeConstraints({ parallel: "worktrees", folder: "app" }, { parallel: "" as never }), { folder: "app" });
});
