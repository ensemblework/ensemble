import assert from "node:assert/strict";
import test from "node:test";
import type { StepReport } from "../node/report.js";
import { completionOf, rerunChecks, rerunVerdict, testCounts } from "./completion.js";
import type { JobContext } from "./tools.js";

const ctx = (over: Partial<JobContext> = {}) =>
  ({ root: "/work/fieldnote", userId: "u1", sandboxed: false, network: false, accessMode: "read-write", secretEnv: {}, job: { id: "job-1" }, ...over }) as unknown as JobContext;

const result = (exitCode: number, output: string) => ({ exitCode, output, truncated: false, timedOut: false, killed: false, ms: 12 });

test("a test runner's own summary decides: exit 0 with a failing test is a failure", () => {
  assert.deepEqual(testCounts("# tests 5\n# pass 4\n# fail 1\n"), { total: 5, passed: 4, failed: 1 });
  assert.deepEqual(testCounts("ℹ tests 3\nℹ pass 3\nℹ fail 0\n"), { total: 3, passed: 3, failed: 0 });
  assert.deepEqual(testCounts("Tests:       1 failed, 7 passed, 8 total"), { total: 8, passed: 7, failed: 1 });
  assert.deepEqual(testCounts(" Tests  2 failed | 10 passed (12)"), { total: 12, passed: 10, failed: 2 });
  assert.deepEqual(testCounts("===== 1 failed, 3 passed in 0.42s ====="), { total: null, passed: 3, failed: 1 });
  assert.equal(testCounts("all good"), null);
  assert.equal(rerunVerdict(result(0, "# pass 4\n# fail 1\n"), "exit_0").verdict, "fail");
  assert.match(rerunVerdict(result(0, "# pass 4\n# fail 1\n"), "exit_0").reason ?? "", /1 of 5 tests failed, though the command exited 0/);
  assert.equal(rerunVerdict(result(0, "ok"), "exit_0").verdict, "pass");
  assert.equal(rerunVerdict(result(2, "boom"), "exit_0").verdict, "fail");
  assert.equal(rerunVerdict(result(0, "Built 3 files"), { outputMatches: "Built \\d+ files" }).verdict, "pass");
  assert.equal(rerunVerdict(result(0, "Built none"), { outputMatches: "Built \\d+ files" }).verdict, "fail");
  // A pattern that could take forever is matched as plain text.
  assert.equal(rerunVerdict(result(0, "(a+)+$ is in the output"), { outputMatches: "(a+)+$" }).verdict, "pass");
  assert.equal(rerunVerdict({ ...result(-1, ""), timedOut: true }, "exit_0").verdict, "fail");
});

test("Ensemble runs each reported check again under the run's rules: a claimed pass that fails is a failed check", async () => {
  const report: StepReport = {
    outcome: "pass",
    summary: "The export keeps the column order.",
    checks: [
      { id: "AC-1", name: "export test", verdict: "pass", rerun: { command: "npm test -- export", expects: "exit_0" } },
      { name: "build", verdict: "pass", rerun: { command: "npm run build", cwd: "web", expects: { outputMatches: "Compiled" } } },
      { name: "deploy", verdict: "pass", rerun: { command: "sudo systemctl restart web", expects: "exit_0" } },
      { name: "looked at it", verdict: "pass" },
    ],
  };
  const judged: string[] = [];
  const ran: Array<{ argv: string[]; cwd: string; timeoutMs: number }> = [];
  const runs = await rerunChecks(ctx(), report, {
    signal: new AbortController().signal,
    timeoutMs: 5000,
    judge: async (_ctx, call) => {
      judged.push(String(call.input.command));
      return String(call.input.command).startsWith("sudo") ? { decision: "deny", message: "The person did not allow this." } : { decision: "allow" };
    },
    run: async (options) => {
      ran.push({ argv: options.argv, cwd: options.cwd, timeoutMs: options.timeoutMs });
      return options.argv.at(-1)!.includes("export") ? result(1, "# tests 2\n# pass 1\n# fail 1\n") : result(0, "Compiled successfully");
    },
  });
  assert.deepEqual(judged, ["npm test -- export", "npm run build", "sudo systemctl restart web"]);
  assert.deepEqual(ran.map((row) => row.cwd), ["/work/fieldnote", "/work/fieldnote/web"]);
  assert.ok(ran.every((row) => row.timeoutMs === 5000));
  assert.deepEqual(runs.map((row) => [row.name, row.claimed, row.verdict]), [["export test", "pass", "fail"], ["build", "pass", "pass"], ["deploy", "pass", "not_run"]]);
  assert.match(runs[2]!.reason ?? "", /did not allow/);

  const completion = completionOf({ outcome: "success", files: [{ added: 4, removed: 1 }], report, runs, pr: { state: "none", url: null, source: null } });
  assert.equal(completion.conversation.state, "finished");
  assert.deepEqual(completion.files, { state: "changed", count: 1, added: 4, removed: 1 });
  assert.equal(completion.checks.state, "failed", "the agent's claim does not decide");
  assert.deepEqual([completion.checks.passed, completion.checks.failed, completion.checks.notRun, completion.checks.claimed], [1, 1, 1, 4]);
  assert.equal(completion.accepted.state, "pending");
  assert.equal(completion.claim.outcome, "pass");
});

test("checks pass only when every reported check ran again and passed", () => {
  const report: StepReport = { outcome: "done", summary: "Done.", checks: [{ name: "tests", verdict: "pass", rerun: { command: "npm test", expects: "exit_0" } }, { name: "eyeballed", verdict: "pass" }] };
  const passing = [{ name: "tests", id: null, command: "npm test", cwd: null, expects: "exit_0" as const, claimed: "pass" as const, verdict: "pass" as const, reason: null, exitCode: 0, ms: 5, counts: null, output: "" }];
  const none = { state: "none" as const, url: null, source: null };
  assert.equal(completionOf({ outcome: "success", files: [], report, runs: passing, pr: none }).checks.state, "unverified");
  assert.equal(completionOf({ outcome: "success", files: [], report: { ...report, checks: report.checks!.slice(0, 1) }, runs: passing, pr: none }).checks.state, "passed");
  assert.equal(completionOf({ outcome: "success", files: [], report: null, runs: [], pr: none }).checks.state, "none");
  const stopped = completionOf({ outcome: "cancelled", files: [], report: null, runs: [], pr: { state: "opened", url: "https://github.com/a/b/pull/3", source: "observed" } });
  assert.deepEqual([stopped.conversation.state, stopped.files.state, stopped.pr.state], ["stopped", "none", "opened"]);
});
