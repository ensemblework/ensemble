import assert from "node:assert/strict";
import test from "node:test";
import {
  UNATTENDED_CODE,
  UNATTENDED_MESSAGE,
  UnattendedTrustError,
  checkUnattended,
  commandGate,
  isFolderTrusted,
  pathCovers,
  rulesForJob,
  sandboxGrant,
} from "./trust.js";

const root = "/Users/person/ensemble-workspace";
const project = "/Users/person/src/fieldnote";

test("the workspace is trusted without a saved rule, and a refused folder is not implied", () => {
  assert.equal(isFolderTrusted({ folder: root, workspaceRoot: root, rules: [] }), true);
  assert.equal(isFolderTrusted({ folder: `${root}/runs/job`, workspaceRoot: root, rules: [] }), true);
  assert.equal(isFolderTrusted({ folder: project, workspaceRoot: root, rules: [] }), false);
  assert.equal(isFolderTrusted({ folder: project, workspaceRoot: root, rules: [], grantingNow: true }), true);
  assert.equal(isFolderTrusted({ folder: `${project}/pkg`, workspaceRoot: root, rules: [project] }), true);
  assert.equal(pathCovers("/a/b", "/a/bc"), false);
});

test("path rules are device rules or this job only", () => {
  const rows = [
    { pattern: project, sessionId: null, decision: "allow", toolName: "path", source: "ensemble" },
    { pattern: "/tmp/once", sessionId: "job-1", decision: "allow", toolName: "path", source: "ensemble" },
    { pattern: "/tmp/other", sessionId: "job-2", decision: "allow", toolName: "path", source: "ensemble" },
    { pattern: "/tmp/no", sessionId: null, decision: "deny", toolName: "path", source: "ensemble" },
    { pattern: "npm test", sessionId: null, decision: "allow", toolName: "npm", source: "ensemble" },
  ];
  assert.deepEqual(rulesForJob(rows, "job-1"), [project, "/tmp/once"]);
});

test("unattended on an untrusted folder is rejected with the fixed message", () => {
  const error = checkUnattended({ unattended: true, trusted: false });
  assert.ok(error instanceof UnattendedTrustError);
  assert.equal(error?.statusCode, 400);
  assert.equal(error?.code, UNATTENDED_CODE);
  assert.equal(error?.message, UNATTENDED_MESSAGE);
  assert.equal(checkUnattended({ unattended: true, trusted: true }), null);
  assert.equal(checkUnattended({ unattended: false, trusted: false }), null);
});

test("commands inside trust stay quiet, review only asks for more access, outside paths are blocked when unattended", () => {
  const base = { trusted: true, silentWorkspace: true, explicitTrust: false, unattended: false, accessMode: "read-write" as const, inside: true };
  assert.equal(commandGate({ ...base, action: "command" }), "allow");
  assert.equal(commandGate({ ...base, silentWorkspace: false, action: "command" }), "prompt");
  assert.equal(commandGate({ ...base, silentWorkspace: false, explicitTrust: true, action: "command" }), "allow");
  assert.equal(commandGate({ ...base, unattended: true, action: "command" }), "allow");
  assert.equal(commandGate({ ...base, unattended: true, action: "push" }), "block");
  assert.equal(commandGate({ ...base, explicitTrust: true, action: "push" }), "prompt");
  assert.equal(commandGate({ ...base, action: "push" }), "prompt");
  assert.equal(commandGate({ ...base, action: "network" }), "prompt");
  assert.equal(commandGate({ ...base, unattended: true, trusted: false, action: "command" }), "block");
  assert.equal(commandGate({ ...base, action: "outside", inside: false }), "prompt");
  assert.equal(commandGate({ ...base, unattended: true, action: "outside", inside: false }), "block");

  const review = { ...base, accessMode: "review" as const };
  assert.equal(commandGate({ ...review, action: "command" }), "allow");
  assert.equal(commandGate({ ...review, action: "write" }), "prompt");
  assert.equal(commandGate({ ...review, unattended: true, action: "write" }), "block");
  assert.equal(commandGate({ ...review, action: "network" }), "prompt");
});

test("without an OS sandbox, review asks before commands and Ask mode asks before everything", () => {
  const base = { trusted: true, silentWorkspace: true, explicitTrust: true, unattended: false, accessMode: "read-write" as const, inside: true };
  assert.equal(commandGate({ ...base, accessMode: "review", action: "command", strength: "advisory" }), "prompt");
  assert.equal(commandGate({ ...base, accessMode: "review", unattended: true, action: "command", strength: "advisory" }), "block");
  assert.equal(commandGate({ ...base, action: "command", strength: "advisory" }), "allow");
  assert.equal(commandGate({ ...base, action: "command", strength: "ask" }), "prompt");
  assert.equal(commandGate({ ...base, action: "write", strength: "ask" }), "prompt");
  assert.equal(commandGate({ ...base, unattended: true, action: "command", strength: "ask" }), "block");
});

test("a folder outside the workspace is read-only unless the person asked to fix it", () => {
  const cache = `${root}/.cache`;
  assert.deepEqual(sandboxGrant({ folder: project, workspaceRoot: root, cache, accessMode: "review" }), {
    readWrite: [cache],
    readOnly: [project],
  });
  assert.deepEqual(sandboxGrant({ folder: project, workspaceRoot: root, cache, accessMode: "read-write" }), {
    readWrite: [project, cache],
    readOnly: [],
  });
  assert.deepEqual(sandboxGrant({ folder: `${root}/runs/job`, workspaceRoot: root, cache, accessMode: "review" }), {
    readWrite: [`${root}/runs/job`, cache],
    readOnly: [],
  });
});
