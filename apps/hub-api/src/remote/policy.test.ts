/**
 * The Mac's policy, without a sidecar: a hosted spec can only narrow what a
 * local assignment could do, and a phone answer only covers the question the
 * Mac asked.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { LocalDecision } from "./policy.js";
import type { JobSpec } from "./contract.js";
import type { RemoteSettings } from "./store.js";

// policy.ts pulls in the API config. A unit run has no .env; the value is never connected to.
process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
const { isRefusal, judgeAnswer, planLocalJob, riskOf } = await import("./policy.js");

const settings = (folders: RemoteSettings["folders"] = [], acceptWebApprovals = true): RemoteSettings => ({
  version: 1,
  enabled: true,
  acceptWebApprovals,
  browseFiles: true,
  webEdit: true,
  webTerminal: true,
  apiBase: "http://127.0.0.1:9",
  deviceId: "device",
  deviceName: "Test",
  pairedAt: "2026-10-02T00:00:00.000Z",
  folders,
  disconnected: null,
  unreachable: null,
  installId: "install-test",
});

function spec(over: Partial<JobSpec> = {}): JobSpec {
  return {
    id: "hosted-1",
    leaseToken: "lease",
    kind: "code",
    delivery: "local",
    unattended: false,
    useCredentials: false,
    ...over,
  } as JobSpec;
}

const question = (over: Partial<LocalDecision> = {}): LocalDecision => ({
  id: "local-1",
  event: "question",
  toolName: "Question",
  title: "Which greeting?",
  detail: { options: ["world", "there"], allowCustom: false, command: null },
  status: "pending",
  ...over,
});

test("a remote spec cannot name a path or an unshared folder; its sign-in, SSH repositories and branches are the person's call", () => {
  const none = () => null;
  const creds = planLocalJob(spec({ useCredentials: true }), settings(), none);
  assert.ok(!isRefusal(creds) && creds.assign.useCredentials, "the computer's sign-in clones a private repository");
  const narrowed = planLocalJob(spec({ useCredentials: true }), settings([], false), none);
  assert.ok(!isRefusal(narrowed) && !narrowed.assign.useCredentials, "unless this computer keeps web settings to itself");

  const ssh = planLocalJob(spec({ repoUrl: "git@github.com:acme/secret.git" }), settings(), none);
  assert.ok(!isRefusal(ssh) && ssh.assign.repoUrl === "git@github.com:acme/secret.git");

  const raw = planLocalJob(spec({ repoUrl: "/tmp/not-shared" }), settings(), none);
  assert.equal(isRefusal(raw) && raw.code, "REPO_NOT_ALLOWED");

  const unknown = planLocalJob(spec({ folderLabel: "notes" }), settings(), none);
  assert.equal(isRefusal(unknown) && unknown.code, "UNKNOWN_FOLDER");

  const branch = planLocalJob(spec({ branchMode: "existing", branch: "main" }), settings(), none);
  assert.ok(!isRefusal(branch) && branch.assign.branchMode === "existing" && branch.assign.branch === "main");
});

test("a code task with no repository and no shared folder works in a new empty folder on the computer", () => {
  const plan = planLocalJob(spec({ instructions: "Start a small script" }), settings(), () => null);
  assert.equal(isRefusal(plan), false);
  if (isRefusal(plan)) return;
  assert.equal(plan.assign.folder, undefined);
  assert.equal(plan.assign.repoUrl, undefined);
});

test("a shared label becomes a local folder, and an https URL is cloned as given", () => {
  const shared = settings([
    { label: "notes", path: "/work/notes", kind: "folder", access: "read-write" },
    { label: "source", path: "/work/source", kind: "repo", access: "read-write" },
  ]);
  const folder = planLocalJob(spec({ folderLabel: "notes", model: "stub-model", provider: "openai", reasoningEffort: "low" }), shared, () => null);
  assert.equal(isRefusal(folder), false);
  if (!isRefusal(folder)) {
    assert.equal(folder.assign.folder, "/work/notes");
    assert.equal(folder.assign.repoUrl, undefined);
    assert.equal(folder.assign.model, "stub-model");
    assert.equal(folder.assign.provider, "openai");
    assert.equal(folder.assign.reasoningEffort, "low");
    assert.equal(folder.assign.useCredentials, false);
    assert.equal(folder.assign.trust, "none");
  }
  const repo = planLocalJob(spec({ folder: "source" }), shared, () => null);
  assert.equal(isRefusal(repo), false);
  if (!isRefusal(repo)) assert.equal(repo.assign.repoUrl, "/work/source");

  const pub = planLocalJob(spec({ repoUrl: "https://github.com/octocat/Hello-World.git" }), settings(), () => null);
  assert.equal(isRefusal(pub), false);
  if (!isRefusal(pub)) {
    assert.equal(pub.assign.repoUrl, "https://github.com/octocat/Hello-World.git");
    assert.equal(pub.assign.useCredentials, false);
  }
});

test("web settings apply when this computer accepts them, and only narrow when it does not", () => {
  const folders = [{ label: "notes", path: "/work/notes", kind: "folder" as const, access: "read-write" as const }];
  const claim = spec({ folderLabel: "notes", networkAccess: true, mode: "review", askBeforePublish: false, maxMinutes: 20, maxTurns: 10, maxToolCalls: 30 });
  const accepted = planLocalJob(claim, settings(folders), () => null);
  assert.equal(isRefusal(accepted), false);
  if (!isRefusal(accepted)) {
    assert.equal(accepted.assign.network, true);
    assert.equal(accepted.assign.mode, "review");
    assert.equal(accepted.assign.askBeforePublish, false);
    assert.equal(accepted.assign.maxMinutes, 20);
    assert.equal(accepted.assign.maxTurns, 10);
    assert.equal(accepted.assign.maxToolCalls, 30);
    assert.equal(accepted.assign.trust, "none");
  }
  const narrow = planLocalJob(claim, settings(folders, false), () => null);
  if (!isRefusal(narrow)) {
    assert.equal(Object.hasOwn(narrow.assign, "network"), false);
    assert.equal(narrow.assign.mode, "ask");
    assert.equal(narrow.assign.askBeforePublish, true);
  }
  const off = planLocalJob(spec({ folderLabel: "notes", networkAccess: false }), settings(folders, false), () => null);
  if (!isRefusal(off)) assert.equal(off.assign.network, false);
  const older = planLocalJob(spec({ folderLabel: "notes", unattended: true }), settings(folders), () => null);
  if (!isRefusal(older)) assert.equal(older.assign.mode, "unattended");
});

test("the web's sandbox toggle applies only when this computer accepts web settings", () => {
  const folders = [{ label: "notes", path: "/Users/person/notes", kind: "folder" as const, access: "read-write" as const }];
  const off = planLocalJob(spec({ folderLabel: "notes", sandbox: false }), settings(folders), () => null);
  assert.ok(!isRefusal(off) && off.assign.sandbox === false);
  const kept = planLocalJob(spec({ folderLabel: "notes", sandbox: false }), settings(folders, false), () => null);
  assert.ok(!isRefusal(kept) && kept.assign.sandbox === true);
  const older = planLocalJob(spec({ folderLabel: "notes" }), settings(folders), () => null);
  assert.ok(!isRefusal(older) && older.assign.sandbox === true);
  const outside = planLocalJob(spec({ folderLabel: "notes", outsideAccess: "read-write" }), settings(folders), () => null);
  assert.ok(!isRefusal(outside) && outside.assign.outsideAccess === "read-write");
  const ownSetting = planLocalJob(spec({ folderLabel: "notes", outsideAccess: "read-write" }), settings(folders, false), () => null);
  assert.ok(!isRefusal(ownSetting) && ownSetting.assign.outsideAccess === undefined, "without web settings, this computer's own setting applies");
});

test("a phone answer applies only to the question the Mac asked, once", () => {
  const local = question();
  const base = { askedId: "hosted-d", hash: "abc", risk: "ordinary" as const, local };
  assert.deepEqual(
    judgeAnswer({ ...base, answer: { id: "hosted-d", status: "answered", decision: "allow", scope: "once", reason: "world", actionHash: "abc" } }),
    { kind: "apply", decision: "allow", reason: "world" },
  );
  assert.equal(
    judgeAnswer({ ...base, answer: { id: "hosted-d", status: "answered", decision: "allow", scope: null, reason: "world", actionHash: null } }).kind,
    "apply",
  );
  assert.equal(
    judgeAnswer({ ...base, answer: { id: "other", status: "answered", decision: "allow", scope: "once", reason: "world", actionHash: "abc" } }).kind,
    "refuse",
  );
  assert.equal(
    judgeAnswer({ ...base, answer: { id: "hosted-d", status: "answered", decision: "allow", scope: "always", reason: "world", actionHash: "abc" } }).kind,
    "refuse",
  );
  assert.equal(
    judgeAnswer({ ...base, answer: { id: "hosted-d", status: "answered", decision: "allow", scope: "once", reason: "trust me", actionHash: "abc" } }).kind,
    "refuse",
  );
  assert.deepEqual(
    judgeAnswer({ ...base, answer: { id: "hosted-d", status: "answered", decision: "deny", scope: "once", reason: "no", actionHash: "abc" } }),
    { kind: "apply", decision: "deny", reason: null },
  );
  assert.equal(
    judgeAnswer({ ...base, risk: "high", answer: { id: "hosted-d", status: "answered", decision: "allow", scope: "once", reason: null, actionHash: "abc" } }).kind,
    "refuse",
  );
  const push: LocalDecision = { id: "local-1", event: "permission", toolName: "git push", title: "Push", detail: { command: "git push" }, status: "pending" };
  assert.deepEqual(
    judgeAnswer({ ...base, local: push, risk: "high", acceptWeb: true, answer: { id: "hosted-d", status: "answered", decision: "allow", scope: "once", reason: null, actionHash: "abc" } }),
    { kind: "apply", decision: "allow", reason: null },
  );
  assert.equal(judgeAnswer({ ...base, local: { ...local, status: "decided" }, answer: { id: "hosted-d", status: "answered", decision: "allow", scope: "once", reason: "world", actionHash: "abc" } }).kind, "stop");
});

test("pushes, outside paths and trust grants are high risk; an ordinary question is not, whatever it says", () => {
  assert.equal(riskOf({ toolName: "git push" }), "high");
  assert.equal(riskOf({ toolName: "outside" }), "high");
  assert.equal(riskOf({ toolName: "trust" }), "high");
  assert.equal(riskOf(question({ detail: { options: ["Trust the input data", "Validate it first"], allowCustom: false } })), "ordinary");
});

test("the task page from the web becomes the local task's page, read once, whatever the server's age", async () => {
  const { PAGE_HEADING } = await import("./contract.js");
  const page = "lets clone this repo:\nhttps://github.com/morluto/rea\n\nand summarise what it does.";
  const description = `Short note\n\n${PAGE_HEADING}\n${page}\n\nThis task came from github: https://example.test/1`;
  const plan = planLocalJob(spec({ task: { title: "Clone a repo", description, page } }), settings(), () => null);
  assert.ok(!isRefusal(plan));
  if (isRefusal(plan)) return;
  assert.equal(plan.page, page, "the page is the local task's page");
  assert.equal(plan.description, "Short note\n\nThis task came from github: https://example.test/1", "and is not also in the description");
  const older = planLocalJob(spec({ task: { title: "Clone a repo", description } }), settings(), () => null);
  if (isRefusal(older)) return assert.fail("refused");
  assert.equal(older.page, "");
  assert.match(older.description, /morluto\/rea/, "a spec without the field still carries the page in its description");
});

test("a pull request from the web: into any branch, from a clone or a folder worked in place, on a branch it may name", () => {
  const none = () => null;
  const repo = settings([{ label: "ensemble", path: "/work/ensemble", kind: "repo", access: "read-write" }, { label: "notes", path: "/work/notes", kind: "folder", access: "read-write" }]);
  const ok = planLocalJob(spec({ folderLabel: "ensemble", branch: "feature-a", branchMode: "new", delivery: "push", pullRequest: { base: "testing", merge: "auto" } }), repo, none);
  assert.ok(!isRefusal(ok), JSON.stringify(ok));
  if (!isRefusal(ok)) {
    assert.deepEqual(ok.assign.pullRequest, { base: "testing", merge: "auto" });
    assert.equal(ok.assign.branchMode, "new");
    assert.equal(ok.assign.branch, "feature-a");
    assert.equal(ok.assign.delivery, "push", "the agent may push too");
    assert.equal(ok.assign.repoUrl, "/work/ensemble", "a repository folder: the run works in its own clone");
  }
  for (const base of ["main", "production", "release", ""]) {
    const any = planLocalJob(spec({ folderLabel: "ensemble", pullRequest: { base, merge: "auto" } }), repo, none);
    assert.ok(!isRefusal(any), base);
  }
  const inPlace = planLocalJob(spec({ folderLabel: "notes", pullRequest: { base: "testing", merge: "ask" } }), repo, none);
  assert.ok(!isRefusal(inPlace) && inPlace.assign.folder === "/work/notes");
  const badHead = planLocalJob(spec({ folderLabel: "ensemble", branch: "testing", branchMode: "new", pullRequest: { base: "testing", merge: "ask" } }), repo, none);
  assert.match(isRefusal(badHead) ? badHead.message : "", /into itself/);
  const plain = planLocalJob(spec({ folderLabel: "ensemble", branch: "feature-a", branchMode: "new" }), repo, none);
  assert.ok(!isRefusal(plain) && plain.assign.branchMode === "new" && plain.assign.branch === "feature-a", "a branch named on the web is used as named");
});
