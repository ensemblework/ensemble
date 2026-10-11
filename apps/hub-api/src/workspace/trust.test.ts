import assert from "node:assert/strict";
import test from "node:test";
import {
  UNATTENDED_CODE,
  UNATTENDED_MESSAGE,
  UnattendedTrustError,
  checkUnattended,
  ReviewTrustError,
  checkModeTrust,
  commandGate,
  isFolderTrusted,
  pathCovers,
  rulesForJob,
  runModeOf,
  storedMode,
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

test("Ask: commands inside trust stay quiet, everything else asks", () => {
  const base = { trusted: true, silentWorkspace: true, explicitTrust: false, unattended: false, accessMode: "read-write" as const, inside: true };
  assert.equal(commandGate({ ...base, action: "command" }), "allow");
  assert.equal(commandGate({ ...base, silentWorkspace: false, action: "command" }), "prompt");
  assert.equal(commandGate({ ...base, silentWorkspace: false, explicitTrust: true, action: "command" }), "allow");
  assert.equal(commandGate({ ...base, trusted: false, action: "command" }), "prompt");
  assert.equal(commandGate({ ...base, trusted: false, action: "write" }), "prompt");
  assert.equal(commandGate({ ...base, action: "network" }), "prompt");
  assert.equal(commandGate({ ...base, action: "outside", inside: false }), "prompt");
});

test("a push the git permission allows does not ask in a trusted folder", () => {
  const base = { trusted: true, silentWorkspace: true, explicitTrust: false, unattended: false, accessMode: "read-write" as const, inside: true, action: "push" as const };
  assert.equal(commandGate(base), "allow");
  assert.equal(commandGate({ ...base, explicitTrust: true, silentWorkspace: false }), "allow");
  assert.equal(commandGate({ ...base, silentWorkspace: false }), "prompt");
  assert.equal(commandGate({ ...base, trusted: false }), "prompt");
  assert.equal(commandGate({ ...base, unattended: true }), "allow");
  assert.equal(commandGate({ ...base, accessMode: "auto" }), "allow");
});

test("Review only runs freely inside a trusted folder and refuses paths outside it", () => {
  const base = { trusted: true, silentWorkspace: false, explicitTrust: false, unattended: false, accessMode: "auto" as const, inside: true };
  for (const action of ["command", "write", "network", "credential"] as const) assert.equal(commandGate({ ...base, action }), "allow", action);
  assert.equal(commandGate({ ...base, action: "outside", inside: false }), "block");
  // Untrusted: Review only falls back to asking (assignment refuses it first).
  assert.equal(commandGate({ ...base, trusted: false, action: "command" }), "prompt");
  assert.equal(commandGate({ ...base, trusted: false, action: "outside", inside: false }), "prompt");
});

test("Run unattended never asks: inside is allowed, outside and untrusted are blocked", () => {
  const base = { trusted: true, silentWorkspace: false, explicitTrust: false, unattended: true, accessMode: "read-write" as const, inside: true };
  for (const action of ["command", "write", "network", "credential", "push"] as const) assert.equal(commandGate({ ...base, action }), "allow", action);
  assert.equal(commandGate({ ...base, action: "outside", inside: false }), "block");
  assert.equal(commandGate({ ...base, trusted: false, action: "command" }), "block");
});

test("with the sandbox off, Review only and Run unattended use outside paths without asking", () => {
  const free = { trusted: true, silentWorkspace: false, explicitTrust: false, accessMode: "read-write" as const, inside: false, action: "outside" as const };
  assert.equal(commandGate({ ...free, unattended: true, sandboxed: false }), "allow");
  assert.equal(commandGate({ ...free, unattended: true, sandboxed: true }), "block");
  assert.equal(commandGate({ ...free, unattended: false, accessMode: "auto", sandboxed: false }), "allow");
  assert.equal(commandGate({ ...free, unattended: false, accessMode: "auto", sandboxed: true }), "block");
  // Ask always asks; an untrusted folder never runs unattended.
  assert.equal(commandGate({ ...free, unattended: false, sandboxed: false }), "prompt");
  assert.equal(commandGate({ ...free, unattended: true, trusted: false, sandboxed: false }), "block");
});

test("sandboxed: the outside-folder setting says what goes ahead (read only by default)", () => {
  const outside = { trusted: true, silentWorkspace: false, explicitTrust: false, inside: false, action: "outside" as const, sandboxed: true };
  const free = { ...outside, unattended: true, accessMode: "read-write" as const };
  const ask = { ...outside, unattended: false, accessMode: "read-write" as const };
  // Read only (default): reading goes ahead in every mode; writing asks in Ask and is refused when nobody answers.
  assert.equal(commandGate({ ...free, outsideAccess: "read", outsideWrite: false }), "allow");
  assert.equal(commandGate({ ...free, outsideAccess: "read", outsideWrite: true }), "block");
  assert.equal(commandGate({ ...ask, outsideAccess: "read", outsideWrite: false }), "allow");
  assert.equal(commandGate({ ...ask, outsideAccess: "read", outsideWrite: true }), "prompt");
  // Read and write: both go ahead.
  assert.equal(commandGate({ ...free, outsideAccess: "read-write", outsideWrite: true }), "allow");
  // No access: the folder is the edge.
  assert.equal(commandGate({ ...free, outsideAccess: "none", outsideWrite: false }), "block");
  assert.equal(commandGate({ ...ask, outsideAccess: "none", outsideWrite: false }), "prompt");
  // A read-only run never writes outside, whatever the setting.
  assert.equal(commandGate({ ...ask, accessMode: "review", outsideAccess: "read-write", outsideWrite: true }), "block");
  // Unsandboxed runs ignore the setting.
  assert.equal(commandGate({ ...free, sandboxed: false, outsideAccess: "none", outsideWrite: true }), "allow");
});

test("read-only never writes and never uses the network", () => {
  const base = { trusted: true, silentWorkspace: true, explicitTrust: true, unattended: false, accessMode: "review" as const, inside: true };
  assert.equal(commandGate({ ...base, action: "command" }), "allow");
  for (const action of ["write", "network", "push", "credential"] as const) assert.equal(commandGate({ ...base, action }), "block", action);
  assert.equal(commandGate({ ...base, unattended: true, action: "write" }), "block");
  assert.equal(commandGate({ ...base, action: "command", strength: "advisory" }), "prompt");
  assert.equal(commandGate({ ...base, unattended: true, action: "command", strength: "advisory" }), "block");
});

test("without an OS sandbox Ask still follows trust, and Windows asks before everything", () => {
  const base = { trusted: true, silentWorkspace: true, explicitTrust: true, unattended: false, accessMode: "read-write" as const, inside: true };
  assert.equal(commandGate({ ...base, action: "command", strength: "advisory" }), "allow");
  assert.equal(commandGate({ ...base, action: "command", strength: "ask" }), "prompt");
  assert.equal(commandGate({ ...base, action: "write", strength: "ask" }), "prompt");
  assert.equal(commandGate({ ...base, accessMode: "auto", action: "command", strength: "ask" }), "prompt");
  assert.equal(commandGate({ ...base, unattended: true, action: "command", strength: "ask" }), "block");
});

test("Review only and Run unattended need a trusted folder; Ask does not", () => {
  assert.ok(checkModeTrust({ accessMode: "auto", unattended: false, trusted: false }) instanceof ReviewTrustError);
  assert.ok(checkModeTrust({ accessMode: "read-write", unattended: true, trusted: false }) instanceof UnattendedTrustError);
  assert.equal(checkModeTrust({ accessMode: "read-write", unattended: false, trusted: false }), null);
  assert.equal(checkModeTrust({ accessMode: "auto", unattended: false, trusted: true }), null);
});

test("run modes map to the stored pair and back", () => {
  for (const mode of ["ask", "review", "unattended"] as const) assert.equal(runModeOf(storedMode(mode)), mode);
  assert.equal(runModeOf({ accessMode: "review", unattended: false }), "ask");
});
