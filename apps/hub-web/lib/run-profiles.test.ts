import assert from "node:assert/strict";
import test from "node:test";
import { canAddProfile, defaultProfile, differs, profileChoices, profileFields, profileSummary, quickProfile, removeProfile, upsertProfile } from "./run-profiles";

const quick = quickProfile({ defaultExecution: "sandbox", sandboxNetwork: false });

test("Quick is the default until a profile is saved", () => {
  assert.equal(quick.network, false);
  assert.deepEqual(profileChoices([], quick), [quick]);
  assert.equal(defaultProfile(undefined, null, quick).id, "quick");
});

test("the marked default wins, else the first saved profile", () => {
  const careful = { ...quick, id: "a", name: "Careful", mode: "ask" as const };
  const away = { ...quick, id: "b", name: "Away", mode: "unattended" as const };
  assert.equal(defaultProfile([careful, away], "b", quick).name, "Away");
  assert.equal(defaultProfile([careful, away], "gone", quick).name, "Careful");
});

test("at most three profiles; updating one keeps its place", () => {
  let list = upsertProfile([], { ...quick, id: "a", name: "One" });
  list = upsertProfile(list, { ...quick, id: "b", name: "Two" });
  list = upsertProfile(list, { ...quick, id: "c", name: "Three" });
  assert.equal(canAddProfile(list), false);
  assert.throws(() => upsertProfile(list, { ...quick, id: "d", name: "Four" }), /at most 3/);
  list = upsertProfile(list, { ...quick, id: "b", name: "Renamed" });
  assert.deepEqual(list.map((row) => row.name), ["One", "Renamed", "Three"]);
  assert.deepEqual(removeProfile(list, "a").map((row) => row.id), ["b", "c"]);
});

test("a changed field marks the form as modified", () => {
  const fields = profileFields(quick);
  assert.equal(differs(quick, fields), false);
  assert.equal(differs(quick, { ...fields, mode: "review" }), true);
  assert.equal(differs(quick, { ...fields, maxMinutes: 30 }), true);
});

test("the summary names the mode and git permission", () => {
  assert.equal(profileSummary(quick), "Code · Ask · may commit (asks before each commit)");
  assert.equal(profileSummary({ ...quick, mode: "unattended", delivery: "push" }), "Code · Run unattended · may commit and push");
});

import { quickAssignInput } from "./quick-assign.js";

test("quick assignment preserves the default profile's permissions and exact provider", () => {
  const input = quickAssignInput("task-12345678", { ...quick, id: "careful", name: "Careful", branchMode: "new", deviceId: "studio", model: "anthropic::claude-sonnet-5-5", effort: "high", mode: "review", delivery: "local", askBeforePublish: true, useCredentials: false, network: false, sandbox: true, maxMinutes: 12 });
  assert.equal(input.provider, "anthropic");
  assert.equal(input.model, "claude-sonnet-5-5");
  assert.equal(input.deviceId, "studio");
  assert.equal(input.mode, "review");
  assert.equal(input.delivery, "local");
  assert.equal(input.network, false);
  assert.equal(input.sandbox, true);
  assert.equal(input.reasoningEffort, "high");
  assert.equal(input.maxMinutes, 12);
  assert.match(input.branch ?? "", /^ensemble\/task-/);
});

test("subscription engines keep their model string and omit API effort", () => {
  const input = quickAssignInput("task", { ...quick, engine: "claude-code", model: "sonnet", effort: "high" });
  assert.equal(input.engine, "claude-code");
  assert.equal(input.model, "sonnet");
  assert.equal(input.provider, undefined);
  assert.equal(input.reasoningEffort, undefined);
});

import type { SubscriptionAgent } from "@ensemble/shared-types";
import { computerRuns, engineAssign, engineModel, fitEngineChoice } from "./engine-models.js";

const copilot: SubscriptionAgent = {
  id: "copilot-cli",
  via: "cli",
  version: "1.0.40",
  signedIn: true,
  account: "mira-chen",
  checkedAt: "2026-10-20T09:00:00.000Z",
  models: [
    { id: "auto", label: "Auto" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", isDefault: true, efforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contexts: [{ id: "default", label: "200K (standard)", tokens: 200000 }, { id: "long_context", label: "922K (long context)", tokens: 922000 }], vision: true, cost: "low cost", description: "OpenAI" },
    { id: "claude-haiku-4.5", label: "Claude Haiku 4.5", contexts: [{ id: "default", label: "136K", tokens: 136000 }], cost: "0.33× premium requests", description: "Anthropic" },
  ],
};

test("GitHub Copilot offers each model's own thinking levels and context windows, and sends only those", () => {
  const luna = engineModel(copilot, "");
  assert.equal(luna.model?.id, "gpt-5.6-luna", "Copilot default is the model the agent marks default");
  assert.deepEqual(luna.efforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(luna.defaultEffort, "medium");
  assert.deepEqual(luna.contexts.map((row) => row.id), ["default", "long_context"]);
  const haiku = engineModel(copilot, "claude-haiku-4.5");
  assert.deepEqual([haiku.efforts, haiku.contexts], [[], []], "one fixed size and no thinking setting: nothing to choose");
  assert.deepEqual(fitEngineChoice(haiku, "high", "long_context"), { effort: "default", context: undefined }, "switching to Haiku drops what it lacks");
  assert.deepEqual(fitEngineChoice(luna, "xhigh", "long_context"), { effort: "xhigh", context: "long_context" });

  assert.deepEqual(engineAssign("copilot-cli", { model: "gpt-5.6-luna", effort: "xhigh", context: "long_context" }, engineModel(copilot, "gpt-5.6-luna")), { engine: "copilot-cli", model: "gpt-5.6-luna", reasoningEffort: "xhigh", contextTier: "long_context" });
  assert.deepEqual(engineAssign("copilot-cli", { model: "gpt-5.6-luna", effort: "default" }, luna), { engine: "copilot-cli", model: "gpt-5.6-luna", contextTier: "default" });
  assert.deepEqual(engineAssign("copilot-cli", { model: "claude-haiku-4.5", effort: "high", context: "long_context" }, haiku), { engine: "copilot-cli", model: "claude-haiku-4.5" });
  assert.deepEqual(engineAssign("codex", { model: "gpt-6-luna", effort: "high", context: "long_context" }), { engine: "codex", model: "gpt-6-luna" }, "other agents take a model name only");

  assert.equal(computerRuns("copilot-cli", { engines: ["claude-code", "codex", "cursor-agent", "copilot-cli"] }), true);
  assert.equal(computerRuns("copilot-cli", {}), false, "a runtime without the engines list predates Copilot");
  assert.equal(computerRuns("codex", {}), true);
});

test("a Copilot profile keeps its model, thinking level and context window", () => {
  const profile = { ...quick, id: "copilot", name: "Copilot", engine: "copilot-cli" as const, model: "gpt-5.6-luna", effort: "high" as const, context: "long_context" as const };
  const input = quickAssignInput("task", profile);
  assert.deepEqual([input.engine, input.model, input.reasoningEffort, input.contextTier, input.provider], ["copilot-cli", "gpt-5.6-luna", "high", "long_context", undefined]);
  assert.equal(profileSummary(profile), "GitHub Copilot · Code · Ask · may commit (asks before each commit)");
  const fields = profileFields(profile);
  assert.equal(differs(profile, { ...fields, context: undefined }), true);
  assert.equal(differs({ ...profile, context: "default" }, { ...fields, context: undefined }), false, "unset and Standard are the same window");
});

import { computerPullRequestBases, pullRequestNotices, pullRequestProblem, runPullRequest, runPullRequestLabel } from "./pull-request.js";

test("a profile that ends in a pull request says where it goes and what happens after, keeps it in Quick assign, and counts as a change", () => {
  const pr = { ...quick, id: "pr", name: "PR", delivery: "local" as const, network: false, pullRequest: { base: "testing", merge: "ask" as const } };
  assert.equal(profileSummary(pr), "Code · Ask · may commit (asks before each commit) · PR → testing (ask to merge)");
  assert.match(profileSummary({ ...pr, pullRequest: { base: "testing", merge: "auto" } }), /PR → testing \(merge when checks pass\)$/);
  assert.match(profileSummary({ ...pr, pullRequest: { base: "staging", merge: "never" } }), /PR → staging \(left open\)$/);
  const input = quickAssignInput("task", pr);
  assert.deepEqual([input.pullRequest, input.delivery, input.network], [{ base: "testing", merge: "ask" }, "commit", true]);
  assert.equal(quickAssignInput("task", quick).pullRequest, undefined);
  const fields = profileFields(pr);
  assert.equal(differs(pr, { ...fields, pullRequest: { base: "testing", merge: "ask" } }), false, "the same plan in a new object is no change");
  assert.equal(differs(pr, { ...fields, pullRequest: { base: "testing", merge: "auto" } }), true);
  assert.equal(differs(pr, { ...fields, pullRequest: null }), true);
});

test("pull request notices: a too-old computer, never-bases, a base the computer does not allow, a folder worked in place, a bad branch", () => {
  const capabilities = { pullRequests: 1, pullRequestBases: ["testing", "main"], folders: [{ label: "ensemble", kind: "repo" }, { label: "notes", kind: "folder" }] };
  assert.deepEqual(computerPullRequestBases(capabilities), ["testing"], "never main, even if a computer lists it");
  assert.equal(computerPullRequestBases({ engines: ["codex"] }), null);
  const check = { computer: "Studio Mac", capabilities, place: "folder" as const, repo: "", folder: "ensemble", base: "testing", branch: "" };
  assert.deepEqual(pullRequestNotices(check), { tooOld: null, place: null, base: null, branch: null });
  assert.equal(pullRequestNotices({ ...check, capabilities: {} }).tooOld, "Ensemble on Studio Mac is too old to open pull requests. Update it there (`ensemble update`), then assign.");
  assert.equal(pullRequestNotices({ ...check, folder: "notes" }).place, "notes is worked in place. Pick a repository, or a folder Studio Mac shares as a repository.");
  assert.equal(pullRequestNotices({ ...check, computer: null, folder: "/work/app" }).place, "app is worked in place. Pick a repository.");
  assert.equal(pullRequestNotices({ ...check, base: "master" }).base, "A run never opens a pull request into master: it is production or a deploy pointer.");
  assert.equal(pullRequestNotices({ ...check, computer: null, base: "testing-live" }).base, "A run never opens a pull request into testing-live: it is production or a deploy pointer.");
  assert.equal(pullRequestNotices({ ...check, computer: null, base: "staging" }).base, null, "this server's own list is checked when the run starts");
  assert.match(pullRequestNotices({ ...check, base: "staging" }).base ?? "", /^Studio Mac does not open pull requests into staging\. It allows: testing \(change it there with `ensemble git bases add staging`\)\.$/);
  assert.equal(pullRequestNotices({ ...check, branch: "production" }).branch, "A run never pushes production.");
  assert.deepEqual(pullRequestProblem(pullRequestNotices({ ...check, folder: "notes", branch: "testing" })), { text: "notes is worked in place. Pick a repository, or a folder Studio Mac shares as a repository.", field: "place" });
  assert.deepEqual(pullRequestProblem(pullRequestNotices({ ...check, branch: "testing" }))?.field, "branch");
});

test("a run's pull request comes from its latest event, else its summary, and only from github.com", () => {
  const summary = "Fixed the flaky test.\nOpened and merged pull request #12 from live-test/a into testing: https://github.com/fieldnote/app/pull/12";
  const fromSummary = runPullRequest({ summary });
  assert.deepEqual(fromSummary, { url: "https://github.com/fieldnote/app/pull/12", number: 12, head: "live-test/a", base: "testing", state: "merged" });
  assert.equal(runPullRequestLabel(fromSummary!), "Pull request #12 (merged into testing)");
  const open = runPullRequest({ summary: "Opened pull request #7 from a into testing: https://github.com/fieldnote/app/pull/7\nLeft open: you did not approve the merge." });
  assert.equal(runPullRequestLabel(open!), "Pull request #7 (open, into testing)");
  assert.equal(runPullRequest({ summary: "Opened pull request #7 from a into testing: https://evil.example/pull/7" }), null);
  const events = [
    { kind: "pull_request", data: { url: "https://github.com/fieldnote/app/pull/12", number: 12, base: "testing", head: "a", state: "open" } },
    { kind: "pull_request", data: { url: "https://github.com/fieldnote/app/pull/12", number: 12, base: "testing", head: "a", state: "merged" } },
  ];
  assert.equal(runPullRequest({ summary: "", events })?.state, "merged");
  assert.equal(runPullRequest({ summary: null, events: [] }), null);
});
