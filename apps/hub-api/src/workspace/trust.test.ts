import assert from "node:assert/strict";
import test from "node:test";
import { commandGate, isFolderTrusted, pathCovers, rulesForJob, runModeOf, storedMode } from "./trust.js";

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

test("Review only runs freely in its folder, trusted or not, and asks once before changing another folder", () => {
  const base = { trusted: true, silentWorkspace: false, explicitTrust: false, unattended: false, accessMode: "auto" as const, inside: true };
  for (const action of ["command", "write", "network", "credential", "push"] as const) {
    assert.equal(commandGate({ ...base, action }), "allow", action);
    assert.equal(commandGate({ ...base, trusted: false, action }), "allow", `${action} untrusted`);
  }
  // Another computer, or a command outside the OS sandbox, is worth a question.
  assert.equal(commandGate({ ...base, action: "remote" }), "prompt");
  assert.equal(commandGate({ ...base, action: "escape" }), "prompt");
  const outside = { ...base, inside: false, action: "outside" as const };
  for (const zone of ["workspace", "outside"] as const) {
    assert.equal(commandGate({ ...outside, zone, outsideWrite: false }), "allow", `${zone} read`);
    assert.equal(commandGate({ ...outside, zone, outsideWrite: true }), "prompt", `${zone} write`);
  }
  assert.equal(commandGate({ ...outside, zone: "temp", outsideWrite: true }), "allow");
});

test("Run unattended never asks and needs no trusted folder or sandbox: it works across the workspace and the person's folders", () => {
  const base = { trusted: false, silentWorkspace: false, explicitTrust: false, unattended: true, accessMode: "read-write" as const, inside: true };
  for (const action of ["command", "write", "network", "credential", "push", "remote", "escape"] as const) {
    assert.equal(commandGate({ ...base, action }), "allow", action);
    assert.equal(commandGate({ ...base, action, strength: "ask" }), "allow", `${action} without a sandbox`);
  }
  const outside = { ...base, inside: false, action: "outside" as const };
  for (const zone of ["workspace", "temp", "outside"] as const) {
    for (const sandboxed of [true, false]) assert.equal(commandGate({ ...outside, zone, sandboxed, outsideWrite: true }), "allow", `${zone} ${sandboxed}`);
  }
});

test("outside the workspace, the person's outside-folder setting holds; inside the workspace it does not apply", () => {
  const outside = { trusted: true, silentWorkspace: false, explicitTrust: false, inside: false, action: "outside" as const, sandboxed: true };
  const free = { ...outside, unattended: true, accessMode: "read-write" as const };
  const ask = { ...outside, unattended: false, accessMode: "read-write" as const };
  // Read only (default): reading goes ahead in every mode; writing asks in Ask.
  assert.equal(commandGate({ ...ask, outsideAccess: "read", outsideWrite: false }), "allow");
  assert.equal(commandGate({ ...ask, outsideAccess: "read", outsideWrite: true }), "prompt");
  // Read and write: both go ahead.
  assert.equal(commandGate({ ...ask, outsideAccess: "read-write", outsideWrite: true }), "allow");
  // No access: asks in Ask, and is the edge when nobody answers.
  assert.equal(commandGate({ ...free, outsideAccess: "none", outsideWrite: false }), "block");
  assert.equal(commandGate({ ...free, outsideAccess: "none", outsideWrite: true }), "block");
  assert.equal(commandGate({ ...ask, outsideAccess: "none", outsideWrite: false }), "prompt");
  assert.equal(commandGate({ ...free, zone: "workspace", outsideAccess: "none", outsideWrite: true }), "allow");
  // A read-only run never writes outside, whatever the setting.
  assert.equal(commandGate({ ...ask, accessMode: "review", outsideAccess: "read-write", outsideWrite: true }), "block");
  // Unsandboxed runs ignore No access.
  assert.equal(commandGate({ ...free, sandboxed: false, outsideAccess: "none", outsideWrite: true }), "allow");
  assert.equal(commandGate({ ...ask, sandboxed: false, outsideAccess: "none", outsideWrite: false }), "allow");
});

test("read-only never writes and never uses the network", () => {
  const base = { trusted: true, silentWorkspace: true, explicitTrust: true, unattended: false, accessMode: "review" as const, inside: true };
  assert.equal(commandGate({ ...base, action: "command" }), "allow");
  for (const action of ["write", "network", "push", "credential"] as const) assert.equal(commandGate({ ...base, action }), "block", action);
  assert.equal(commandGate({ ...base, unattended: true, action: "write" }), "block");
  assert.equal(commandGate({ ...base, action: "command", strength: "advisory" }), "prompt");
  assert.equal(commandGate({ ...base, unattended: true, action: "command", strength: "advisory" }), "block");
});

test("without an OS sandbox Ask still follows trust, and a runtime with none asks before everything", () => {
  const base = { trusted: true, silentWorkspace: true, explicitTrust: true, unattended: false, accessMode: "read-write" as const, inside: true };
  assert.equal(commandGate({ ...base, action: "command", strength: "advisory" }), "allow");
  assert.equal(commandGate({ ...base, action: "command", strength: "ask" }), "prompt");
  assert.equal(commandGate({ ...base, action: "write", strength: "ask" }), "prompt");
  assert.equal(commandGate({ ...base, accessMode: "auto", action: "command", strength: "ask" }), "allow");
  assert.equal(commandGate({ ...base, action: "remote" }), "prompt");
});

test("run modes map to the stored pair and back", () => {
  for (const mode of ["ask", "review", "unattended"] as const) assert.equal(runModeOf(storedMode(mode)), mode);
  assert.equal(runModeOf({ accessMode: "review", unattended: false }), "ask");
});
