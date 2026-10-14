/**
 * The computer's side of the web terminal (protocol 4): its switches, and the same rules as the
 * terminal on this computer's page. Commands that would run are not started here (no nested sandbox in
 * tests); what is refused or asks first never starts at all.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const state = mkdtempSync(join(tmpdir(), "remote-terminal-"));
const workspace = realpathSync(mkdtempSync(join(tmpdir(), "remote-terminal-ws-")));
mkdirSync(join(workspace, "repo"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = state;
process.env.ENSEMBLE_WORKSPACE_ROOT = workspace;
process.env.REDIS_URL ??= "memory://local";
const { terminalAnswerFor, NO_SANDBOX } = await import("./terminal.js");
const { sandboxAvailable } = await import("../workspace/guard.js");

function settings(change: Record<string, unknown>): void {
  writeFileSync(join(state, "remote.json"), JSON.stringify({ version: 1, enabled: true, ...change }));
}

function fakeApp(terminal: Record<string, unknown> = {}) {
  return {
    prisma: {
      preference: { findFirst: async () => ({ value: { terminal } }) },
      workspaceJob: { findMany: async () => [] },
    },
  } as never;
}

const sent: unknown[] = [];
const client = { terminalOutput: async (_id: string, chunk: unknown) => (sent.push(chunk), true), answerCode: async () => undefined } as never;
const request = (op: "status" | "cd" | "run" | "kill", extra: Record<string, unknown> = {}) => ({ id: "t1", op, confirmed: false, ...extra }) as never;

test("the web terminal answers with this computer's folders and moves only inside them", async () => {
  settings({});
  const status = await terminalAnswerFor(fakeApp(), client, request("status"));
  assert.equal(status.status, 200);
  assert.deepEqual((status.body as { roots: string[] }).roots, [workspace]);
  const cd = await terminalAnswerFor(fakeApp(), client, request("cd", { cwd: workspace, path: "repo" }));
  assert.deepEqual(cd.body, { cwd: join(workspace, "repo"), scope: workspace });
  assert.equal((await terminalAnswerFor(fakeApp(), client, request("cd", { cwd: workspace, path: "/etc" }))).status, 422);
});

test("refused commands say why; destructive ones ask first; without the OS sandbox nothing runs from the web; none starts here", async () => {
  settings({});
  const reset = await terminalAnswerFor(fakeApp(), client, request("run", { cwd: workspace, line: "git reset --hard HEAD" }));
  if (sandboxAvailable()) {
    assert.equal(reset.status, 428);
    assert.match(String((reset.body as { confirm: string }).confirm), /uncommitted/);
  } else {
    assert.equal(reset.status, 409);
    assert.equal((reset.body as { error: string }).error, NO_SANDBOX);
  }
  for (const line of ["ssh example.com", "ls | sh", "sudo ls"]) {
    const refused = await terminalAnswerFor(fakeApp(), client, request("run", { cwd: workspace, line }));
    assert.equal(refused.status, 422, line);
  }
  assert.equal(sent.length, 0, "nothing ran");
  assert.deepEqual((await terminalAnswerFor(fakeApp(), client, request("kill", { runId: "nothing" }))).body, { killed: 0 });
});

test("this computer's switches turn the web terminal off", async () => {
  settings({ webTerminal: false });
  const off = await terminalAnswerFor(fakeApp(), client, request("status"));
  assert.equal(off.status, 409);
  assert.match(String((off.body as { error: string }).error), /ensemble web terminal on/);
  settings({});
  const disabled = await terminalAnswerFor(fakeApp({ enabled: false }), client, request("run", { cwd: workspace, line: "ls" }));
  assert.equal(disabled.status, 409);
  assert.match(String((disabled.body as { error: string }).error), /turned off in Settings/);
});
