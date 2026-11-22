import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import test, { after } from "node:test";
import type { StepReport } from "../node/report.js";
import { acceptanceCommands } from "./acceptance-checks.js";
import { agentCommandEnv, completionOf, isTestRunner, rerunChecks, rerunVerdict, taskStatusAfter, testCounts, verifiedReport, type CheckRun } from "./completion.js";
import type { JobContext } from "./tools.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-completion-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
const folder = (name: string) => {
  mkdirSync(join(scratch, name), { recursive: true });
  return join(scratch, name);
};
const fieldnote = folder("fieldnote");
mkdirSync(join(fieldnote, "web"));

const ctx = (over: Partial<JobContext> = {}) =>
  ({ root: fieldnote, userId: "u1", sandboxed: false, network: false, accessMode: "read-write", secretEnv: {}, job: { id: "job-1" }, ...over }) as unknown as JobContext;
const signal = new AbortController().signal;
const allow = async () => ({ decision: "allow" as const });

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
  assert.equal(rerunVerdict(result(0, "Built none"), { outputMatches: "Built \\d+ files" }).verdict, "uncertain");
  // A pattern that could take forever is matched as plain text.
  assert.equal(rerunVerdict(result(0, "(a+)+$ is in the output"), { outputMatches: "(a+)+$" }).verdict, "pass");
  assert.equal(rerunVerdict({ ...result(-1, ""), timedOut: true }, "exit_0").verdict, "fail");
});

test("the exit code decides; what the output shows is compared leniently, and a difference with exit 0 is uncertain, not a failure", () => {
  // Node's TAP reporter where the agent ran it, its spec reporter where Ensemble did: the same tests passing.
  const spec = "\n> fixture@1.0.0 test\n> node --test\n\n✔ sums the lines (0.88ms)\nℹ tests 4\nℹ suites 0\nℹ pass 4\nℹ fail 0\n";
  assert.equal(rerunVerdict(result(0, spec), { outputMatches: "# pass 4" }, "node scripts/report.js").verdict, "pass", "reporter marks, colours and case are set aside");
  assert.equal(rerunVerdict(result(0, "\u001b[32m✔  Built   3 files\u001b[0m\n"), { outputMatches: "# built 3 FILES" }, "node build.js").verdict, "pass");
  const fewer = rerunVerdict(result(0, "ℹ Built 2 files\n"), { outputMatches: "# Built 3 files" }, "node build.js");
  assert.equal(fewer.verdict, "uncertain", "the numbers in it are compared");
  assert.equal(fewer.reason, 'Output differed: expected "# Built 3 files", saw "ℹ Built 2 files".');
  assert.equal(rerunVerdict(result(0, "ℹ pass 40\nBuilt 13 files\n"), { outputMatches: "pass 4" }, "node report.js").verdict, "uncertain", "4 is not 40");
  assert.equal(rerunVerdict(result(0, "Built 13 files\n"), { outputMatches: "3 files" }, "node build.js").verdict, "uncertain");
  assert.match(rerunVerdict(result(0, ""), { outputMatches: "Built 3 files" }, "node build.js").reason ?? "", /saw no output/);
  assert.equal(rerunVerdict(result(1, "ℹ Built 3 files\n"), { outputMatches: "Built 3 files" }, "node build.js").verdict, "fail", "a command that failed fails, whatever it printed");
  assert.equal(rerunVerdict(result(127, "sh: 1: node: not found\n"), { outputMatches: "Built 3 files" }, "node build.js").verdict, "not_run");

  // A test runner's output depends on its reporter: its exit code (and its own count of failures) decides.
  const runner = rerunVerdict(result(0, spec), { outputMatches: "4 passing" }, "npm test");
  assert.equal(runner.verdict, "pass");
  assert.match(runner.reason ?? "", /not compared/);
  assert.equal(rerunVerdict(result(0, "ℹ pass 3\nℹ fail 1\n"), { outputMatches: "# pass 4" }, "npm test").verdict, "fail");
  for (const command of ["node --test", "npx tsx --test src/a.test.ts", "cd web && npm test -- export", "npm run test:unit", "pnpm --filter @fieldnote/web test", "yarn test", "pytest -q tests/test_export.py", "python -m pytest", "cargo test --all", "go test ./...", "npx vitest run", "jest --ci", "bun test"]) {
    assert.ok(isTestRunner(command), command);
  }
  for (const command of ["node scripts/build.js", "npm run build", "git diff --check", "echo test", "cat test.txt", "ls tests"]) {
    assert.ok(!isTestRunner(command), command);
  }

  const report: StepReport = { outcome: "pass", summary: "Done.", checks: [{ name: "export", verdict: "pass", rerun: { command: "node build.js", expects: { outputMatches: "Built 3 files" } } }] };
  const uncertain = completionOf({ outcome: "success", files: [], report, runs: [{ name: "export", id: null, command: "node build.js", cwd: null, expects: { outputMatches: "Built 3 files" }, claimed: "pass", verdict: "uncertain", reason: fewer.reason, exitCode: 0, ms: 4, counts: null, output: "ℹ Built 2 files" }], pr: { state: "none", url: null, source: null } });
  assert.deepEqual([uncertain.checks.state, uncertain.checks.passed, uncertain.checks.failed, uncertain.checks.uncertain], ["uncertain", 0, 0, 1], "not passed, not failed: uncertain");
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
  assert.deepEqual(ran.map((row) => row.cwd), [fieldnote, join(fieldnote, "web")]);
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

test("a check runs again where the run may work: its folder, or one it was let into; never through a link out, nor in a folder that holds keys", async () => {
  const root = folder("cwd/run");
  mkdirSync(join(root, "web"));
  const sibling = folder("cwd/sibling");
  const granted = folder("cwd/granted");
  const readable = folder("cwd/readable");
  symlinkSync(sibling, join(root, "out"));
  const check = (name: string, cwd: string) => ({ name, verdict: "pass" as const, rerun: { command: "npm test", cwd, expects: "exit_0" as const } });
  const report: StepReport = {
    outcome: "pass",
    summary: "Done.",
    checks: [check("web", "web"), check("sibling", `../${basename(sibling)}`), check("link", "out"), check("missing", "gone"), check("granted", granted), check("readable", readable), check("home", "~")],
  };
  const ran: Array<{ cwd: string; readWrite?: string[]; readOnly?: string[] }> = [];
  const runs = await rerunChecks(ctx({ root, grants: [granted, homedir()], readGrants: [readable] }), report, {
    signal,
    judge: allow,
    run: async (options) => {
      ran.push({ cwd: options.cwd, readWrite: options.readWrite, readOnly: options.readOnly });
      return result(0, "ok");
    },
  });
  assert.deepEqual(runs.map((row) => [row.name, row.verdict]), [["web", "pass"], ["sibling", "not_run"], ["link", "not_run"], ["missing", "not_run"], ["granted", "pass"], ["readable", "pass"], ["home", "not_run"]]);
  assert.deepEqual(ran, [
    { cwd: join(root, "web"), readWrite: [root], readOnly: [] },
    { cwd: granted, readWrite: [root, granted], readOnly: [] },
    { cwd: readable, readWrite: [root], readOnly: [readable] },
  ]);
  assert.match(runs[1]!.reason ?? "", /outside the run's folder/);
  assert.match(runs[6]!.reason ?? "", /keys|sign-ins/);
});

test("a check runs again with the PATH and HOME the agent's own commands had, without key variables; a program missing here is not run, not failed", async () => {
  const engine = { PATH: ["/home/mira/.cargo/bin", join(fieldnote, "node_modules", ".bin"), "/usr/bin"].join(delimiter), HOME: "/home/mira", CARGO_HOME: "/home/mira/.cargo", ANTHROPIC_API_KEY: "sk-ant-api03-not-for-checks", DATABASE_URL: "postgres://ensemble" };
  assert.deepEqual(agentCommandEnv(fieldnote, engine), { PATH: ["/home/mira/.cargo/bin", "/usr/bin"].join(delimiter), HOME: "/home/mira", CARGO_HOME: "/home/mira/.cargo" });

  const report: StepReport = { outcome: "pass", summary: "Done.", checks: [{ name: "cargo", verdict: "pass", rerun: { command: "cargo test", expects: "exit_0" } }] };
  const seen: Array<{ engineEnv?: Record<string, string>; extraEnv?: Record<string, string> }> = [];
  const runs = await rerunChecks(ctx({ secretEnv: { ANTHROPIC_API_KEY: "sk-ant-api03-not-for-checks", FIELDNOTE_REGION: "eu" } }), report, {
    signal,
    judge: allow,
    run: async (options) => {
      seen.push({ engineEnv: options.engineEnv, extraEnv: options.extraEnv });
      return result(127, "sh: 1: cargo: not found\n");
    },
  });
  assert.deepEqual(seen[0]!.engineEnv, agentCommandEnv(fieldnote));
  assert.equal(seen[0]!.engineEnv?.HOME, process.env.HOME ?? homedir());
  assert.deepEqual(seen[0]!.extraEnv, { FIELDNOTE_REGION: "eu" });
  assert.deepEqual([runs[0]!.verdict, runs[0]!.exitCode], ["not_run", 127]);
  assert.match(runs[0]!.reason ?? "", /cargo: not found/);
  assert.equal(completionOf({ outcome: "success", files: [], report, runs, pr: { state: "none", url: null, source: null } }).checks.state, "unverified");
  // A command that could not start here at all is not run either.
  const unstarted = await rerunChecks(ctx(), report, { signal, judge: allow, run: async () => Promise.reject(new Error("sh is not installed on this computer.")) });
  assert.deepEqual([unstarted[0]!.verdict, unstarted[0]!.reason], ["not_run", "Ensemble could not start it here: sh is not installed on this computer."]);
});

test("no check runs after the owner discards the turn's changes", async () => {
  const report: StepReport = {
    outcome: "pass",
    summary: "Done.",
    checks: [
      { name: "unit", verdict: "pass", rerun: { command: "npm test", expects: "exit_0" } },
      { name: "e2e", verdict: "pass", rerun: { command: "npm run e2e", expects: "exit_0" } },
    ],
  };
  let discarded = false;
  const ran: string[] = [];
  const runs = await rerunChecks(ctx(), report, {
    signal,
    judge: allow,
    stopped: async () => (discarded ? "The owner discarded the turn's changes." : null),
    run: async (options) => {
      ran.push(options.argv.at(-1)!);
      discarded = true;
      return result(0, "ok");
    },
  });
  assert.deepEqual(ran, ["npm test"]);
  assert.deepEqual(runs.map((row) => [row.name, row.verdict, row.reason]), [["unit", "pass", null], ["e2e", "not_run", "The owner discarded the turn's changes."]]);
});

test("the commands acceptance criteria name are checks: `X` passes, run `X`, or a known program; never a file or a word", () => {
  const checks = acceptanceCommands([
    { id: "AC-1", text: "`node accept.js` passes in the export folder." },
    { id: "AC-2", text: "`out.csv` has the header row, and the `export` button works." },
    { id: "AC-3", text: "Run `./scripts/check.sh` before handing it over" },
    { id: "AC-4", text: "pytest: `pytest -q tests/test_export.py`" },
    { id: "AC-5", text: "`formatMoney(5, 'EUR')` returns '€5.00' and `--verbose` prints the total" },
    { id: "AC-6", text: "`npm run build` and `npm test` pass in `web/`" },
    { id: "AC-7", text: "`node accept.js` passes" },
  ]);
  assert.deepEqual(checks.map((check) => [check.id, check.command, check.folder]), [
    ["AC-1", "node accept.js", "export"],
    ["AC-3", "./scripts/check.sh", null],
    ["AC-4", "pytest -q tests/test_export.py", null],
    ["AC-6", "npm run build", "web"],
    ["AC-6", "npm test", "web"],
  ], "each command once, the folder a criterion names kept");
});

test("a criterion's command runs again only when it checks: never one that pushes, publishes, deploys or installs, an unknown program, or a program named alone", () => {
  const checks = acceptanceCommands([
    { id: "AC-1", text: "Run `git commit -am done` when finished" },
    { id: "AC-2", text: "`npm publish` succeeds" },
    { id: "AC-3", text: "`git push origin main` passes" },
    { id: "AC-4", text: "Run `npm run deploy` after the build" },
    { id: "AC-5", text: "It uses `git` and `node` only" },
    { id: "AC-6", text: "Run `rm -rf dist` first, and `vercel --prod` succeeds" },
    { id: "AC-7", text: "`git diff --exit-code` passes and `make` succeeds" },
    { id: "AC-8", text: "`cargo build --release` succeeds; run `npm install` once" },
  ]);
  assert.deepEqual(checks.map((check) => [check.id, check.command]), [
    ["AC-7", "git diff --exit-code"],
    ["AC-7", "make"],
    ["AC-8", "cargo build --release"],
  ]);
});

test("a check without a command to run again stays the agent's word: it neither holds back nor confirms the task or its step", () => {
  const report: StepReport = {
    outcome: "done",
    summary: "Exported.",
    checks: [
      { id: "AC-1", name: "acceptance", verdict: "pass", rerun: { command: "node accept.js", expects: "exit_0" } },
      { id: "AC-2", name: "looked at the CSV", verdict: "pass", strength: "A" },
    ],
  };
  const run: CheckRun = { name: "acceptance", id: "AC-1", command: "node accept.js", cwd: null, expects: "exit_0", claimed: "pass", verdict: "pass", reason: null, exitCode: 0, ms: 5, counts: null, output: "" };
  const none = { state: "none" as const, url: null, source: null };
  const completion = completionOf({ outcome: "success", files: [], report, runs: [run], pr: none });
  assert.equal(completion.checks.state, "unverified", "the turn's own line still says one check rests on the agent's word");
  assert.deepEqual(taskStatusAfter({ outcome: "success", markDone: true, checks: completion.checks }), { status: "done", verified: "passed", question: null });
  assert.equal(verifiedReport(report, completion).outcome, "done", "the step ends as reported when every check Ensemble ran passed");
  const claims = completionOf({ outcome: "success", files: [], report: { ...report, checks: report.checks!.slice(1) }, runs: [], pr: none });
  assert.deepEqual(taskStatusAfter({ outcome: "success", markDone: true, checks: claims.checks }), { status: "done", verified: null, question: null }, "nothing to run again: as before");
});

test("an assigned run's acceptance commands run again with its reported checks, each once, where the criterion says", async () => {
  const report: StepReport = { outcome: "done", summary: "Done.", checks: [{ id: "AC-1", name: "acceptance script", verdict: "pass", rerun: { command: "node  accept.js", expects: "exit_0" } }, { id: "AC-2", name: "looked at the CSV", verdict: "pass" }] };
  const acceptance = [
    { id: "AC-1", text: "`node accept.js` passes in the export folder.", command: "node accept.js", folder: "export" },
    { id: "AC-2", text: "`npm test` passes in the missing folder.", command: "npm test", folder: "missing" },
    { id: "AC-3", text: "`npm run lint` passes", command: "npm run lint", folder: null },
  ];
  const ran: Array<{ command: string; cwd: string }> = [];
  const runs = await rerunChecks(ctx(), report, {
    signal,
    judge: allow,
    acceptance,
    run: async (options) => {
      ran.push({ command: options.argv.at(-1)!, cwd: options.cwd });
      return result(options.argv.at(-1) === "npm run lint" ? 1 : 0, "");
    },
  });
  assert.deepEqual(ran, [
    { command: "node  accept.js", cwd: fieldnote },
    { command: "npm test", cwd: fieldnote },
    { command: "npm run lint", cwd: fieldnote },
  ], "the reported run of the same command in the same folder is not run twice; a folder that is not there is the run's own");
  assert.deepEqual(runs.map((row) => [row.id, row.from ?? "report", row.claimed, row.verdict]), [
    ["AC-1", "report", "pass", "pass"],
    ["AC-2", "acceptance", "pass", "pass"],
    ["AC-3", "acceptance", "skipped", "fail"],
  ]);
  const completion = completionOf({ outcome: "success", files: [], report, runs, pr: { state: "none", url: null, source: null } });
  assert.deepEqual([completion.checks.state, completion.checks.claimed, completion.checks.failed], ["failed", 3, 1], "the task's own commands count with the agent's");
  const passing = completionOf({ outcome: "success", files: [], report, runs: runs.map((row) => ({ ...row, verdict: "pass" as const })), pr: { state: "none", url: null, source: null } });
  assert.equal(passing.checks.state, "passed", "AC-2's claim is covered by the task's own command");
  // With nothing reported, the task's commands are the checks.
  const only = await rerunChecks(ctx(), null, { signal, judge: allow, acceptance: acceptance.slice(2), run: async () => result(0, "") });
  assert.deepEqual(only.map((row) => [row.id, row.verdict]), [["AC-3", "pass"]]);
  assert.equal(completionOf({ outcome: "success", files: [], report: null, runs: only, pr: { state: "none", url: null, source: null } }).checks.state, "passed");
});

test("a task is done only when the checks Ensemble ran again passed; failed is not done, uncertain or not run is finished, not verified", () => {
  const run = (verdict: CheckRun["verdict"], reason: string | null = null): CheckRun => ({ name: "AC-1 `node accept.js` passes", id: "AC-1", command: "node accept.js", cwd: null, expects: "exit_0", claimed: "pass", verdict, reason, exitCode: verdict === "fail" ? 1 : 0, ms: 5, counts: null, output: "" });
  const checks = (verdict: CheckRun["verdict"], reason?: string) => completionOf({ outcome: "success", files: [], report: null, runs: [run(verdict, reason)], pr: { state: "none", url: null, source: null } }).checks;
  assert.deepEqual(taskStatusAfter({ outcome: "success", markDone: true, checks: checks("pass") }), { status: "done", verified: "passed", question: null });
  assert.deepEqual(taskStatusAfter({ outcome: "success", markDone: false, checks: checks("pass") }), { status: "waiting_approval", verified: "passed", question: null });
  const failed = taskStatusAfter({ outcome: "success", markDone: true, checks: checks("fail", "It exited 1.") });
  assert.deepEqual([failed.status, failed.verified], ["blocked", "failed"]);
  assert.equal(failed.question, "Its checks failed when Ensemble ran them again: AC-1 node accept.js: It exited 1.");
  for (const verdict of ["uncertain", "not_run"] as const) {
    const end = taskStatusAfter({ outcome: "success", markDone: true, checks: checks(verdict, "A program it needs was not found here (exit 127).") });
    assert.deepEqual([end.status, end.verified], ["waiting_approval", "not_verified"], verdict);
  }
  assert.deepEqual(taskStatusAfter({ outcome: "success", markDone: true, checks: null, hasChecks: true }), { status: "waiting_approval", verified: "not_verified", question: null }, "checks no one ran again are not passed");
  // Without checks, as before.
  assert.deepEqual(taskStatusAfter({ outcome: "success", markDone: true, checks: completionOf({ outcome: "success", files: [], report: null, runs: [], pr: { state: "none", url: null, source: null } }).checks }), { status: "done", verified: null, question: null });
  assert.deepEqual(taskStatusAfter({ outcome: "success", markDone: true, checks: null }), { status: "done", verified: null, question: null });
  assert.equal(taskStatusAfter({ outcome: "cancelled", markDone: true, checks: null }).status, "todo");
  assert.equal(taskStatusAfter({ outcome: "failed", markDone: true, checks: null }).status, "blocked");
});

test("a plan step's report carries Ensemble's own runs of its checks, not the worker's word", () => {
  const report: StepReport = { outcome: "done", summary: "Exported.", checks: [{ id: "AC-1", name: "acceptance", verdict: "pass", rerun: { command: "node accept.js", expects: "exit_0" } }] };
  const base = { id: "AC-1", command: "node accept.js", cwd: null, expects: "exit_0" as const, claimed: "pass" as const, exitCode: 1, ms: 5, counts: null, output: "" };
  const failed = completionOf({ outcome: "success", files: [], report, runs: [{ ...base, name: "acceptance", verdict: "fail", reason: "It exited 1." }], pr: { state: "none", url: null, source: null } });
  const verified = verifiedReport(report, failed);
  assert.equal(verified.outcome, "fail");
  assert.deepEqual(verified.checks?.map((check) => [check.id, check.verdict, check.detail]), [["AC-1", "fail", "Ensemble ran it again: It exited 1."]]);
  const extra = completionOf({ outcome: "success", files: [], report, runs: [{ ...base, name: "acceptance", verdict: "pass", reason: null, exitCode: 0 }, { ...base, id: "AC-2", name: "AC-2 `npm test` passes", command: "npm test", claimed: "skipped", verdict: "not_run", reason: "A program it needs was not found here (exit 127).", from: "acceptance" }], pr: { state: "none", url: null, source: null } });
  const uncertain = verifiedReport(report, extra);
  assert.equal(uncertain.outcome, "uncertain");
  assert.deepEqual(uncertain.checks?.map((check) => [check.id, check.verdict]), [["AC-1", "pass"], ["AC-2", "skipped"]]);
  assert.equal(verifiedReport(report, null), report, "nothing ran again: the report as it was");
});
