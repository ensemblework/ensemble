import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addClaudeDesktopSession, codexProject, removeClaudeDesktopSessions, sessionTitle } from "./app-sessions.js";

test("a session's title is one line of at most 80 characters", () => {
  assert.equal(sessionTitle("  Plan the\nlaunch  "), "Plan the launch");
  assert.equal(sessionTitle("x".repeat(100))?.length, 80);
  assert.equal(sessionTitle(""), null);
});

test("a new Claude Code session is listed in the Claude app's Code tab once, copied from the app's newest entry, and goes with the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-desktop-"));
  try {
    assert.equal(await addClaudeDesktopSession({ root, cliSessionId: "c1", cwd: "/w/p", title: "Plan" }), null, "never used: no account to file it under");
    const org = join(root, "account-1", "org-1");
    mkdirSync(org, { recursive: true });
    writeFileSync(
      join(org, "local_old.json"),
      JSON.stringify({ sessionId: "local_old", cliSessionId: "old", cwd: "/x", model: "claude-opus", title: "Theirs", titleSource: "auto", permissionMode: "acceptEdits", remoteMcpServersConfig: [{ name: "m" }], completedTurns: 9, alwaysAllowedReasons: ["Bash"], sessionPermissionUpdates: [{ a: 1 }], branch: "feature", worktreePath: "/wt", lastFocusedAt: 5 }),
    );
    const file = await addClaudeDesktopSession({ root, cliSessionId: "c1", cwd: "/home/me/ensemble-workspace/projects/launch", title: "Write the launch plan", model: "claude-haiku-5-5", now: 1000 });
    assert.ok(file && file.startsWith(org));
    const entry = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.match(String(entry.sessionId), /^local_[0-9a-f-]{36}$/);
    assert.equal(file.endsWith(`${entry.sessionId}.json`), true);
    assert.deepEqual(
      [entry.cliSessionId, entry.cwd, entry.originCwd, entry.title, entry.model, entry.createdAt, entry.isArchived, entry.completedTurns, entry.alwaysAllowedReasons, entry.sessionPermissionUpdates],
      ["c1", "/home/me/ensemble-workspace/projects/launch", "/home/me/ensemble-workspace/projects/launch", "Write the launch plan", "claude-haiku-5-5", 1000, false, 1, [], []],
    );
    assert.deepEqual([entry.permissionMode, entry.remoteMcpServersConfig], ["acceptEdits", [{ name: "m" }]], "the app's own settings come from its entry");
    assert.equal("branch" in entry || "worktreePath" in entry || "lastFocusedAt" in entry, false, "nothing of the other session's worktree");
    assert.equal(await addClaudeDesktopSession({ root, cliSessionId: "c1", cwd: "/w", title: "Again" }), null, "listed once");
    assert.equal(await removeClaudeDesktopSessions("c1", root), 1);
    assert.deepEqual(readdirSync(org), ["local_old.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an Ensemble project is one Codex project: found by Ensemble's id or its folder, renamed with it, else made once", async () => {
  const calls: Array<[string, unknown]> = [];
  const server = (rows: unknown[]) => ({
    request: async (method: string, params?: unknown) => {
      calls.push([method, params]);
      if (method === "project/list") return { data: rows };
      if (method === "project/create") return { project: { id: "new-project" } };
      return {};
    },
  });
  const project = { id: "p-1", name: "Launch", folder: "/w/projects/launch" };
  assert.equal(await codexProject(server([]), project), "new-project");
  assert.deepEqual(calls.at(-1), ["project/create", { name: "Launch", roots: [{ path: "/w/projects/launch" }], metadata: { ensembleProjectId: "p-1" }, idempotencyKey: "ensemble-project:p-1" }]);
  calls.length = 0;
  assert.equal(await codexProject(server([{ id: "c-1", name: "Old name", roots: [{ path: "/elsewhere" }], metadata: { ensembleProjectId: "p-1" } }]), project), "c-1");
  assert.deepEqual(calls.at(-1), ["project/update", { projectId: "c-1", name: "Launch" }]);
  calls.length = 0;
  assert.equal(await codexProject(server([{ id: "theirs", name: "Mine", roots: [{ path: "/w/projects/launch/" }] }]), project), "theirs", "a project the person made for the folder");
  assert.deepEqual(calls.map(([method]) => method), ["project/list"], "and it keeps the person's name");
  assert.equal(await codexProject({ request: async () => { throw new Error("Method not found: project/list"); } }, project), null, "an older Codex has no projects");
});
