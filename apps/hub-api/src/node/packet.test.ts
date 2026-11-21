import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePacket, conflictsOf, dispatchable, PACKET_FORMAT, PACKET_LIMIT, storedPacket } from "./packet.js";
import type { PlanData, PlanStep } from "./plans.js";

function step(over: Partial<PlanStep> & Pick<PlanStep, "id" | "kind">): PlanStep {
  return {
    nodeId: `node-${over.id}`,
    handle: over.id,
    name: over.id,
    executor: "node",
    brief: `Do ${over.id}.`,
    after: [],
    verifies: null,
    requirementIds: [],
    status: "working",
    held: false,
    heldBy: null,
    outcome: "unknown",
    attempt: 1,
    attempts: [{ n: 1, reason: "first", outcome: "unknown", summary: null, startedAt: null, endedAt: null }],
    result: null,
    progress: null,
    startedAt: null,
    endedAt: null,
    sessionId: null,
    ...over,
  };
}

function plan(steps: PlanStep[], over: Partial<PlanData> = {}): PlanData {
  return {
    type: "plan",
    version: 3,
    contract: 3,
    missionId: "m1",
    kind: "plan",
    leadNodeId: "lead",
    leadHandle: "lead",
    leadTurnId: null,
    originRoomId: "room",
    originPrivate: false,
    status: "running",
    revision: 0,
    goal: "Tables in node messages render safely",
    constraints: {
      folder: "~/ensemble-workspace/live-test",
      branch: "live-testing",
      publish: "push",
      environment: "testing",
      agent: "copilot-cli",
      model: "gpt-6.1-sol",
      effort: "medium",
      context: "long_context",
      notes: ["Webapp only: no CLI or native changes."],
    },
    requirements: [
      {
        id: "R1",
        text: "Markdown tables escape pipes in record titles",
        status: "in_progress",
        acceptance: [
          { id: "A1", text: "A title containing | stays in one cell", mandatory: true },
          { id: "A2", text: "Links in neighbouring cells still work", mandatory: true },
        ],
        evidence: ["screenshot"],
      },
    ],
    deferred: [],
    steps,
    routine: null,
    ...over,
  };
}

const who = {
  ownerName: "Akash",
  node: { name: "Builder", handle: "builder", role: "Writes code" },
  settings: { agent: "GitHub Copilot", model: "GPT 6.1 Sol", effort: "medium", context: "long_context" },
  planUrl: "https://node-test.ensemblework.com/r/room",
};

const count = (text: string, part: string) => text.split(part).length - 1;

test("a build packet says each constraint exactly once, settings as facts, and how to report", () => {
  const build = step({ id: "builder", kind: "build", requirementIds: ["R1"], brief: "Escape | in record titles when rendering Markdown tables in node messages." });
  const verify = step({ id: "tester", kind: "verify", verifies: "builder", after: ["builder"], requirementIds: ["R1"], status: "waiting" });
  const packet = compilePacket(plan([build, verify]), build, "first", who);
  for (const part of ["~/ensemble-workspace/live-test", "Branch: live-testing", "commit and push", "Environment: testing", "Webapp only: no CLI or native changes."]) {
    assert.equal(count(packet.prompt, part), 1, part);
  }
  // Agent settings are applied facts, said once, never as a constraint to check.
  assert.equal(count(packet.prompt, "GPT 6.1 Sol"), 1);
  assert.equal(count(packet.prompt, "gpt-6.1-sol"), 0);
  assert.match(packet.prompt, /do not check or change them/);
  assert.match(packet.prompt, /A1 \(must pass\): A title containing \| stays in one cell/);
  assert.match(packet.prompt, /Evidence to attach: screenshot/);
  assert.match(packet.prompt, /An independent check follows your work/);
  assert.match(packet.prompt, /report_result/);
  assert.match(packet.prompt, /check it with capture_check/, "captures are checked before they are named");
  assert.match(packet.prompt, /with the file's id in their evidence/);
  assert.match(packet.prompt, /\.ensemble\/result\.json/);
  assert.deepEqual(
    packet.sections.map((section) => section.name),
    ["Goal", "Your part", "Constraints", "Inputs", "Settings", "Who you are", "Report", "Task"],
  );
  assert.equal(packet.title, "Build: Escape | in record titles when rendering Markdown tables in node messages");
});

test("a check packet names the candidate it tests and says not to fix it", () => {
  const build = step({
    id: "builder",
    kind: "build",
    status: "done",
    outcome: "done",
    attempts: [{ n: 1, reason: "first", outcome: "done", summary: "Escaped pipes.", candidate: { branch: "live-testing", commit: "4ea13ef" }, startedAt: null, endedAt: null }],
  });
  const verify = step({ id: "tester", kind: "verify", verifies: "builder", after: ["builder"], requirementIds: ["R1"] });
  const packet = compilePacket(plan([build, verify]), verify, "first", who);
  assert.match(packet.prompt, /independently, at commit 4ea13ef on live-testing/);
  assert.match(packet.prompt, /Do not fix what you test/);
  assert.match(packet.prompt, /one check per acceptance criterion, named with its id/);
  assert.match(packet.prompt, /- @builder \(build, done\): Escaped pipes\. \[commit 4ea13ef on live-testing\]/);
  assert.equal(packet.title.startsWith("Check: "), true);
});

test("a repair packet carries the failing checks and the tested commit; a retest names the new candidate", () => {
  const failed = {
    n: 1,
    reason: "first" as const,
    outcome: "fail" as const,
    summary: "Titles with | break the table.",
    checks: [
      { id: "A1", name: "pipe stays in one cell", verdict: "fail" as const, detail: "the cell splits at |" },
      { id: "A2", name: "links work", verdict: "pass" as const },
    ],
    candidate: { commit: "4ea13ef" },
    startedAt: null,
    endedAt: null,
  };
  const build = step({
    id: "builder",
    kind: "build",
    attempt: 2,
    attempts: [
      { n: 1, reason: "first", outcome: "done", summary: "Escaped.", candidate: { commit: "4ea13ef" }, startedAt: null, endedAt: null },
      { n: 2, reason: "repair", outcome: "unknown", summary: null, forVerify: "tester", startedAt: null, endedAt: null },
    ],
  });
  const verify = step({ id: "tester", kind: "verify", verifies: "builder", after: ["builder"], requirementIds: ["R1"], status: "waiting", outcome: "fail", attempts: [failed] });
  const repair = compilePacket(plan([build, verify]), build, "repair", who);
  assert.match(repair.prompt, /FAILED\. This is attempt 2: fix only what failed/);
  assert.match(repair.prompt, /- FAIL A1 pipe stays in one cell: the cell splits at \|/);
  assert.doesNotMatch(repair.prompt, /PASS A2/);
  assert.match(repair.prompt, /Tested: commit 4ea13ef\./);
  assert.equal(repair.title.startsWith("Repair: "), true);

  const repaired = step({ ...build, status: "done", outcome: "done", attempts: [...build.attempts.slice(0, 1), { ...build.attempts[1]!, outcome: "done", candidate: { commit: "9b1c2d3" } }] });
  const retest = step({
    ...verify,
    status: "working",
    attempt: 2,
    attempts: [failed, { n: 2, reason: "retest", outcome: "unknown", summary: null, candidate: { commit: "9b1c2d3" }, startedAt: null, endedAt: null }],
  });
  const packet = compilePacket(plan([repaired, retest]), retest, "retest", who);
  assert.match(packet.prompt, /Check the new candidate: commit 9b1c2d3/);
  assert.match(packet.prompt, /What failed last time:\n- FAIL A1/);
});

test("a packet stays within the limit: earlier results go first, constraints and report rules stay", () => {
  const before = Array.from({ length: 12 }, (_, index) =>
    step({ id: `s${index}`, kind: "research", status: "done", outcome: "done", result: "x".repeat(2000), attempts: [{ n: 1, reason: "first", outcome: "done", summary: "y".repeat(2000), startedAt: null, endedAt: null }] }),
  );
  const build = step({ id: "builder", kind: "build", after: before.map((row) => row.id), brief: "z".repeat(1500) });
  const packet = compilePacket(plan([...before, build]), build, "first", who);
  assert.ok(packet.prompt.length <= PACKET_LIMIT, String(packet.prompt.length));
  assert.match(packet.prompt, /Branch: live-testing/);
  assert.match(packet.prompt, /report_result/);
  assert.match(packet.prompt, /The whole plan, with every step's report: https:\/\/node-test/);
  assert.ok(packet.prompt.includes("z".repeat(1500)), "the step's own part is kept whole");
});

test("only building, checking what was built, and writing files where the mission names them go straight to an agent", () => {
  const build = step({ id: "b", kind: "build" });
  const research = step({ id: "r", kind: "research" });
  const write = step({ id: "w", kind: "write" });
  const checkBuild = step({ id: "v", kind: "verify", verifies: "b" });
  const checkResearch = step({ id: "v2", kind: "verify", verifies: "r" });
  const own = step({ id: "o", kind: "build", executor: "self" });
  const onComputer = plan([build, research, write, checkBuild, checkResearch, own]);
  const nowhere = plan([build, research, write, checkBuild, checkResearch, own], { constraints: {} });
  assert.equal(dispatchable(onComputer, build, "first"), true);
  assert.equal(dispatchable(nowhere, build, "first"), false, "with no folder or repository its node decides where");
  assert.equal(dispatchable(plan([build], { constraints: { computer: "Laptop" } }), build, "first"), false);
  assert.equal(dispatchable(plan([build], { constraints: { repos: ["ensemblework/ensemble"] } }), build, "first"), true);
  assert.equal(dispatchable(onComputer, build, "repair"), true);
  assert.equal(dispatchable(onComputer, build, "nudge"), false);
  assert.equal(dispatchable(onComputer, research, "first"), false);
  assert.equal(dispatchable(onComputer, write, "first"), true);
  assert.equal(dispatchable(nowhere, write, "first"), false);
  assert.equal(dispatchable(onComputer, checkBuild, "retest"), true);
  assert.equal(dispatchable(onComputer, checkResearch, "first"), false);
  assert.equal(dispatchable(onComputer, own, "first"), false);
  assert.equal(dispatchable(plan([build], { contract: 1 }), build, "first"), false);
});

test("a packet's header is versioned and hashed, and the prompt carries it after the body", () => {
  const build = step({ id: "builder", kind: "build", requirementIds: ["R1"] });
  const verify = step({ id: "tester", kind: "verify", verifies: "builder", after: ["builder"], requirementIds: ["R1"], status: "waiting" });
  const data = plan([build, verify], { leadTurnId: "turn-1" });
  const artifacts = [{ ref: "docs/spec.md", label: "the spec", hash: "aaaa1111", at: "2026-01-01T00:00:00.000Z" }];
  const packet = compilePacket(data, build, "first", { ...who, artifacts });
  const header = packet.header;
  assert.equal(header.format, PACKET_FORMAT);
  assert.equal(header.packetVersion, 1);
  assert.equal(header.taskId, "m1/builder");
  assert.equal(header.parentTaskId, "m1");
  assert.deepEqual(header.origin, { kind: "message", id: "turn-1" });
  assert.deepEqual(header.acceptance.map((item) => item.id), ["A1", "A2"]);
  assert.deepEqual(header.artifacts, [{ ref: "docs/spec.md", label: "the spec", hash: "aaaa1111", authoritative: true }]);
  assert.deepEqual(header.returnChannel, { roomId: "room", private: false });
  assert.equal(header.amendmentOf, null);
  assert.match(header.hash, /^[0-9a-f]{64}$/);
  assert.match(header.instructionVersion, /^[0-9a-f]{16}$/);
  // The prompt ends with the header's identity, never repeating what the body says.
  const block = /```json ensemble-task\n(.+)\n```$/.exec(packet.prompt);
  assert.ok(block, "the header block closes the prompt");
  const embedded = JSON.parse(block[1]!) as Record<string, unknown>;
  assert.equal(embedded.hash, header.hash);
  assert.equal(embedded.packetVersion, 1);
  assert.equal("constraints" in embedded || "target" in embedded || "provider" in embedded, false);
  assert.deepEqual(compilePacket(data, build, "first", { ...who, artifacts }).header.hash, header.hash, "the same packet hashes the same");
  assert.deepEqual(storedPacket({ header, title: packet.title, prompt: packet.prompt })?.header.hash, header.hash);
  assert.equal(storedPacket({ prompt: "old" }), null);
});

test("a later version names what changed and what stays, from the headers alone", () => {
  const build = step({ id: "builder", kind: "build", requirementIds: ["R1"] });
  const first = compilePacket(plan([build]), build, "first", { ...who, artifacts: [{ ref: "docs/spec.md", hash: "aaaa1111", at: "t" }] });
  const amended = step({ ...build, attempt: 2, attempts: [...build.attempts, { n: 2, reason: "amend", outcome: "unknown", summary: null, startedAt: null, endedAt: null }] });
  const data = plan([amended], {
    constraints: { ...plan([]).constraints, branch: "release" },
    requirements: [{ ...plan([]).requirements[0]!, acceptance: [{ id: "A1", text: "A title containing | stays in one cell", mandatory: true }, { id: "A3", text: "Tables scroll on phones", mandatory: true, proof: "browser" }] }],
  });
  const second = compilePacket(data, amended, "amend", { ...who, artifacts: [{ ref: "docs/spec.md", hash: "bbbb2222", at: "t" }], previous: first.header });
  const { header } = second;
  assert.equal(header.packetVersion, 2);
  assert.equal(header.amendmentOf, "m1/builder@v1");
  const changes = header.amendment!.changes.join("\n");
  assert.match(changes, /Attempt 2: an update/);
  assert.match(changes, /Constraint changed: Branch: release\. \(was: Branch: live-testing\.\)/);
  assert.match(changes, /New acceptance criterion A3 \(must pass; proof: browser\): Tables scroll on phones/);
  assert.match(changes, /Acceptance criterion A2 no longer applies/);
  assert.match(changes, /docs\/spec\.md changed: aaaa1111 is now bbbb2222/);
  const keeps = header.amendment!.keeps.join("; ");
  assert.match(keeps, /your part/);
  assert.match(keeps, /acceptance A1/);
  assert.match(keeps, /constraints \(Where, Environment, Publish/);
  assert.match(second.prompt, /^## Changes\nThis is version 2 of this task\. Since version 1:/);
  assert.notEqual(header.hash, first.header.hash);
});

test("an artifact or a checked candidate that changed after the packet named it is a conflict", () => {
  const build = step({ id: "builder", kind: "build", status: "done", outcome: "done", attempts: [{ n: 1, reason: "first", outcome: "done", summary: "Built.", candidate: { commit: "4ea13ef" }, startedAt: null, endedAt: null }] });
  const review = step({ id: "reviewer", kind: "review", verifies: "builder", after: ["builder"], requirementIds: ["R1"] });
  const registry = [{ ref: "docs/spec.md", hash: "aaaa1111", at: "t" }];
  const { header } = compilePacket(plan([build, review]), review, "first", { ...who, artifacts: registry });
  assert.deepEqual(conflictsOf(header, registry, plan([build, review]), "now"), [], "nothing changed");
  const rebuilt = step({ ...build, attempts: [...build.attempts, { n: 2, reason: "retry", outcome: "done", summary: "Again.", candidate: { commit: "9b1c2d3" }, startedAt: null, endedAt: null }] });
  const conflicts = conflictsOf(header, [{ ref: "docs/spec.md", hash: "cccc3333", at: "t" }], plan([rebuilt, review]), "now");
  assert.deepEqual(
    conflicts.map((row) => [row.ref, row.was, row.now]),
    [
      ["docs/spec.md", "aaaa1111", "cccc3333"],
      ["candidate:builder", "4ea13ef", "9b1c2d3"],
    ],
  );
  assert.deepEqual(conflictsOf(header, registry, plan([step({ ...build, attempts: [{ ...build.attempts[0]!, candidate: { commit: "4ea13ef0c0ffee" } }] }), review]), "now"), [], "a short commit is its long form");
});

test("a review packet lists the acceptance ids it judges with their proof, the candidate and the commands to run again", () => {
  const build = step({
    id: "builder",
    kind: "build",
    status: "done",
    outcome: "done",
    attempts: [
      {
        n: 1,
        reason: "first",
        outcome: "done",
        summary: "Built.",
        candidate: { commit: "4ea13ef", branch: "live-testing" },
        checks: [{ name: "unit tests", verdict: "pass", rerun: { command: "pnpm test", expects: "exit_0" } }],
        startedAt: null,
        endedAt: null,
      },
    ],
  });
  const review = step({ id: "reviewer", kind: "review", verifies: "builder", after: ["builder"], requirementIds: ["R1"], acceptanceIds: ["A2"] });
  const data = plan([build, review], { requirements: [{ ...plan([]).requirements[0]!, acceptance: [{ id: "A1", text: "A title containing | stays in one cell", mandatory: true }, { id: "A2", text: "Links in neighbouring cells still work", mandatory: true, proof: "browser" }] }] });
  const packet = compilePacket(data, review, "first", who);
  assert.equal(packet.title.startsWith("Review: "), true);
  assert.match(packet.prompt, /You review @builder's build independently, at commit 4ea13ef on live-testing\. Its builder's report and green tests are input, not proof\./);
  assert.match(packet.prompt, /- A2 \(must pass; proof: browser\): Links in neighbouring cells still work/);
  assert.doesNotMatch(packet.prompt, /- A1 /, "only the criteria it judges");
  assert.match(packet.prompt, /- `pnpm test`, expecting exit 0 \(unit tests, from @builder\)/);
  assert.match(packet.prompt, /A pass rests on evidence of strength A or B/);
  assert.deepEqual(packet.header.acceptance.map((item) => item.id), ["A2"]);
  assert.deepEqual(packet.header.artifacts, [{ ref: "candidate:builder", label: "@builder's build", hash: "4ea13ef", authoritative: true }]);
  assert.ok(packet.prompt.length <= PACKET_LIMIT);
  assert.equal(dispatchable(data, review, "first"), true);
});
