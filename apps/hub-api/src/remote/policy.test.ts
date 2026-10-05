/**
 * The Mac's policy, without a sidecar: a hosted spec can only narrow what a
 * local assignment could do, and a phone answer only covers the question the
 * Mac asked.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GIT_GATE_CLONE, GIT_GATE_CODE, GIT_GATE_PUSH } from "./origin.js";
import type { LocalDecision } from "./policy.js";
import type { JobSpec } from "./contract.js";
import type { RemoteSettings } from "./store.js";

// policy.ts pulls in the API config. A unit run has no .env; the value is never connected to.
process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
const { isRefusal, judgeAnswer, planLocalJob, riskOf } = await import("./policy.js");

const settings = (folders: RemoteSettings["folders"] = []): RemoteSettings => ({
  version: 1,
  enabled: true,
  runBranchPush: false,
  apiBase: "http://127.0.0.1:9",
  deviceId: "device",
  deviceName: "Test",
  pairedAt: "2026-10-02T00:00:00.000Z",
  folders,
  disconnected: null,
  unreachable: null,
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

test("a remote spec cannot name a path, a private clone, credentials, or another branch", () => {
  const none = () => null;
  const creds = planLocalJob(spec({ useCredentials: true }), settings(), none);
  assert.equal(isRefusal(creds) && creds.code, GIT_GATE_CODE);
  assert.match(isRefusal(creds) ? creds.message : "", /desktop steps 2 and 4/);
  assert.match(GIT_GATE_CLONE, /desktop steps 2 and 4/);
  assert.match(GIT_GATE_PUSH, /desktop steps 2 and 4/);

  const ssh = planLocalJob(spec({ repoUrl: "git@github.com:acme/secret.git" }), settings(), none);
  assert.equal(isRefusal(ssh) && ssh.message, GIT_GATE_CLONE);

  const raw = planLocalJob(spec({ repoUrl: "/tmp/not-shared" }), settings(), none);
  assert.equal(isRefusal(raw) && raw.code, "REPO_NOT_ALLOWED");

  const unknown = planLocalJob(spec({ folderLabel: "notes" }), settings(), none);
  assert.equal(isRefusal(unknown) && unknown.code, "UNKNOWN_FOLDER");

  const branch = planLocalJob(spec({ branchMode: "existing", branch: "main" }), settings(), none);
  assert.equal(isRefusal(branch) && branch.code, "BRANCH_NOT_ALLOWED");
});

test("a shared label becomes a local folder, and a public https URL is checked before clone", () => {
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
    assert.equal(folder.publicCheck, null);
  }
  const repo = planLocalJob(spec({ folder: "source" }), shared, () => null);
  assert.equal(isRefusal(repo), false);
  if (!isRefusal(repo)) assert.equal(repo.assign.repoUrl, "/work/source");

  const pub = planLocalJob(spec({ repoUrl: "https://github.com/octocat/Hello-World.git" }), settings(), () => null);
  assert.equal(isRefusal(pub), false);
  if (!isRefusal(pub)) {
    assert.equal(pub.publicCheck, "https://github.com/octocat/Hello-World.git");
    assert.equal(pub.assign.useCredentials, false);
  }
});

test("a claimed networkAccess is not copied onto the local assignment", () => {
  const shared = settings([{ label: "notes", path: "/work/notes", kind: "folder", access: "read-write" }]);
  const planned = planLocalJob(spec({ folderLabel: "notes", networkAccess: true }), shared, () => null);
  assert.equal(isRefusal(planned), false);
  if (!isRefusal(planned)) {
    assert.equal(Object.hasOwn(planned.assign, "network"), false);
    assert.equal(planned.assign.trust, "none");
  }
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
  assert.equal(judgeAnswer({ ...base, local: { ...local, status: "decided" }, answer: { id: "hosted-d", status: "answered", decision: "allow", scope: "once", reason: "world", actionHash: "abc" } }).kind, "stop");
});

test("a push the Mac would have to confirm is high risk, even if the server says otherwise", () => {
  const push: LocalDecision = { id: "p", event: "permission", toolName: "git push", title: "Push main", detail: { command: "git push origin main" }, status: "pending" };
  assert.equal(riskOf(push, { runBranchPush: true, ownRunBranch: true, trusted: true, pushTargetLocal: true }), "ordinary");
  assert.equal(riskOf(push, { runBranchPush: true, ownRunBranch: false, trusted: true, pushTargetLocal: true }), "high");
  assert.equal(riskOf(push, { runBranchPush: false, ownRunBranch: true, trusted: true, pushTargetLocal: true }), "high");
  assert.equal(riskOf({ ...push, toolName: "outside" }, { runBranchPush: true, ownRunBranch: true, trusted: true, pushTargetLocal: true }), "high");
  const trust = question({ detail: { options: ["Trust this folder"], allowCustom: false } });
  assert.equal(riskOf(trust, { runBranchPush: true, ownRunBranch: true, trusted: true, pushTargetLocal: true }), "high");
});
