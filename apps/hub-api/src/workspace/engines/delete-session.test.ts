import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteNativeSession } from "./delete-session.js";

test("native Claude, Cursor and pinned Antigravity deletion removes only exact recorded history", async () => {
  const home = await mkdtemp(join(tmpdir(), "ensemble-session-delete-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR, CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.CLAUDE_CONFIG_DIR = join(home, ".claude"); process.env.ENSEMBLE_REMOTE_STATE_DIR = join(home, "runtime");
  delete process.env.CURSOR_CONFIG_DIR; delete process.env.XDG_CONFIG_HOME;
  const id = randomUUID(), other = randomUUID();
  try {
    const claude = join(home, ".claude", "projects", "project");
    const cursor = join(home, ".cursor", "chats", "workspace");
    const agy = join(home, "runtime", "agents", "antigravity", "home", "antigravity-acp");
    for (const root of [claude, cursor, join(agy, "conversations"), join(agy, "brain")]) await mkdir(root, { recursive: true });
    await writeFile(join(claude, `${id}.jsonl`), "selected");
    await writeFile(join(claude, `${other}.jsonl`), "keep");
    await mkdir(join(claude, id));
    await writeFile(join(claude, id, "subagent.jsonl"), "selected child");
    await mkdir(join(cursor, id));
    await writeFile(join(cursor, id, "store.db"), "selected");
    await mkdir(join(cursor, other));
    await writeFile(join(cursor, other, "store.db"), "keep");
    for (const suffix of [".db", ".meta", ".db-wal", ".db-shm"]) await writeFile(join(agy, "conversations", id + suffix), "selected");
    await writeFile(join(agy, "acp_token.json"), "credential sentinel");
    await writeFile(join(home, "project.ts"), "project sentinel");
    await mkdir(join(agy, "brain", id));
    await deleteNativeSession("claude-code", id, home);
    await deleteNativeSession("cursor-agent", id, home);
    await deleteNativeSession("antigravity", id, home);
    for (const path of [join(claude, `${id}.jsonl`), join(claude, id), join(cursor, id), join(agy, "conversations", `${id}.db`), join(agy, "brain", id)]) await assert.rejects(lstat(path), { code: "ENOENT" });
    assert.equal(await readFile(join(claude, `${other}.jsonl`), "utf8"), "keep");
    assert.equal(await readFile(join(cursor, other, "store.db"), "utf8"), "keep");
    assert.equal(await readFile(join(agy, "acp_token.json"), "utf8"), "credential sentinel");
    assert.equal(await readFile(join(home, "project.ts"), "utf8"), "project sentinel");
    await deleteNativeSession("claude-code", id, home);
    await deleteNativeSession("cursor-agent", id, home);
    await deleteNativeSession("antigravity", id, home);
    await assert.rejects(deleteNativeSession("claude-code", "../project.ts", home));
    await assert.rejects(deleteNativeSession("antigravity", "../acp_token", home));
    if (process.platform !== "win32") {
      await symlink(join(home, "project.ts"), join(claude, `${id}.jsonl`));
      await assert.rejects(deleteNativeSession("claude-code", id, home), /Linked native session history/);
      assert.equal(await readFile(join(home, "project.ts"), "utf8"), "project sentinel");
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(home, { recursive: true, force: true });
  }
});

test("Cursor's agent deletion removes its ACP session from Cursor's config folder and leaves every other session", async () => {
  const home = await mkdtemp(join(tmpdir(), "ensemble-cursor-delete-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.CURSOR_CONFIG_DIR; delete process.env.XDG_CONFIG_HOME;
  // What cursor-agent's ACP server keeps for a session: `acp-sessions/<id>/store.db` and `meta.json`.
  const session = async (config: string, id: string, text: string) => {
    await mkdir(join(config, "acp-sessions", id), { recursive: true });
    await writeFile(join(config, "acp-sessions", id, "store.db"), text);
    await writeFile(join(config, "acp-sessions", id, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd: home }));
  };
  const gone = (path: string) => assert.rejects(lstat(path), { code: "ENOENT" });
  try {
    const cursor = join(home, ".cursor");
    const id = randomUUID(), other = randomUUID();
    await session(cursor, id, "selected");
    await session(cursor, other, "keep");
    await mkdir(join(cursor, "chats", "workspace", id), { recursive: true });
    await writeFile(join(cursor, "chats", "workspace", id, "store.db"), "selected chat");
    await writeFile(join(cursor, "cli-config.json"), "config sentinel");
    await deleteNativeSession("cursor-agent", id, home);
    await gone(join(cursor, "acp-sessions", id));
    await gone(join(cursor, "chats", "workspace", id));
    assert.equal(await readFile(join(cursor, "acp-sessions", other, "store.db"), "utf8"), "keep");
    assert.equal(await readFile(join(cursor, "acp-sessions", other, "meta.json"), "utf8"), JSON.stringify({ schemaVersion: 1, cwd: home }));
    assert.equal(await readFile(join(cursor, "cli-config.json"), "utf8"), "config sentinel");
    // Already gone counts as deleted.
    await deleteNativeSession("cursor-agent", id, home);
    await assert.rejects(deleteNativeSession("cursor-agent", "../cli-config.json", home));

    // CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor, is where Cursor keeps its sessions instead of ~/.cursor.
    const configured = join(home, "cursor-config"), xdg = join(home, "xdg");
    const inConfigured = randomUUID(), inXdg = randomUUID();
    await session(configured, inConfigured, "selected");
    await session(cursor, inConfigured, "not Cursor's folder now");
    await session(join(xdg, "cursor"), inXdg, "selected");
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.CURSOR_CONFIG_DIR = configured;
    await deleteNativeSession("cursor-agent", inConfigured, home);
    await gone(join(configured, "acp-sessions", inConfigured));
    assert.equal(await readFile(join(cursor, "acp-sessions", inConfigured, "store.db"), "utf8"), "not Cursor's folder now");
    delete process.env.CURSOR_CONFIG_DIR;
    await deleteNativeSession("cursor-agent", inXdg, home);
    await gone(join(xdg, "cursor", "acp-sessions", inXdg));
    assert.equal(await readFile(join(cursor, "acp-sessions", other, "store.db"), "utf8"), "keep");

    if (process.platform !== "win32") {
      delete process.env.XDG_CONFIG_HOME;
      const linked = randomUUID();
      await mkdir(join(home, "project"));
      await writeFile(join(home, "project", "notes.md"), "project sentinel");
      await symlink(join(home, "project"), join(cursor, "acp-sessions", linked));
      await assert.rejects(deleteNativeSession("cursor-agent", linked, home), /Linked native session history/);
      assert.equal(await readFile(join(home, "project", "notes.md"), "utf8"), "project sentinel");
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(home, { recursive: true, force: true });
  }
});

test("Gemini CLI deletion removes only the session that records the exact id and never runs `gemini --delete-session`", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "ensemble-gemini-delete-"));
  const bin = join(home, "bin");
  const calls = join(home, "gemini-calls.log");
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME, PATH: process.env.PATH };
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.GEMINI_CLI_HOME;
  const tmp = join(home, ".gemini", "tmp");
  const mine = join(tmp, "my-repo", "chats");
  const record = (id: string) => JSON.stringify({ sessionId: id, projectHash: "hash", startTime: "2026-11-01T10:00:00.000Z", lastUpdated: "2026-11-01T10:05:00.000Z", kind: "main" });
  const chat = async (chats: string, time: string, id: string) => {
    await mkdir(chats, { recursive: true });
    const file = join(chats, `session-${time}-${id.slice(0, 8)}.jsonl`);
    await writeFile(file, `${record(id)}\n{"id":"m1","type":"user","content":"hello"}\n`);
    return file;
  };
  const deleteCalls = async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter((line) => line.includes("--delete-session"));
  const gone = (path: string) => assert.rejects(lstat(path), { code: "ENOENT" });
  try {
    // Gemini CLI 0.68 as a stand-in: `--list-sessions` lists this folder's sessions, and `--delete-session <x>` deletes the
    // session whose id is x or, failing that, the list's Nth session when x reads as the number N.
    await mkdir(bin);
    await writeFile(
      join(bin, "gemini"),
      `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
const chats = ${JSON.stringify(mine)};
const sessions = fs.readdirSync(chats).filter((name) => name.startsWith("session-")).sort().map((name) => ({ name, id: JSON.parse(fs.readFileSync(path.join(chats, name), "utf8").split("\\n")[0]).sessionId }));
const at = process.argv.indexOf("--delete-session");
if (process.argv.includes("--list-sessions")) sessions.forEach((session, index) => console.log(\`  \${index + 1}. Chat (1 day ago) [\${session.id}]\`));
else if (at > 0) {
  const asked = process.argv[at + 1];
  const target = sessions.find((session) => session.id === asked) ?? sessions[parseInt(asked, 10) - 1];
  if (target) fs.unlinkSync(path.join(chats, target.name));
}
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${saved.PATH ?? ""}`;

    // The person's own sessions in their folder; Gemini reads "3d7b4ba0-…" as its third.
    const own: string[] = [];
    for (const [index, id] of ["1a2b3c4d-1111-4111-8111-111111111111", "2b3c4d5e-2222-4222-8222-222222222222", "3c4d5e6f-3333-4333-8333-333333333333"].entries()) own.push(await chat(mine, `2026-11-0${index + 1}T10-00`, id));
    // Another session that shares the first 8 characters of the id Ensemble deletes.
    const twin = await chat(mine, "2026-11-04T10-00", "3d7b4ba0-9999-4999-8999-999999999999");
    await writeFile(join(tmp, "my-repo", ".project_root"), join(home, "my-repo"));
    await mkdir(join(home, "my-repo"));

    // A session Gemini no longer has: nothing is deleted, and Gemini is never asked.
    await deleteNativeSession("gemini-cli", "3d7b4ba0-1111-4222-8333-444455556666", join(home, "my-repo"));
    for (const kept of [...own, twin]) await lstat(kept);
    assert.deepEqual(await deleteCalls(), []);

    // Ensemble's session, filed by a run in Gemini's macOS sandbox under another folder, with what Gemini keeps by its id.
    const id = "5e6f7a8b-5555-4555-8555-555555555555", subagent = "6f7a8b9c-6666-4666-8666-666666666666";
    const project = join(home, ".cache", ".gemini", "tmp", "ensemble-chat");
    const file = await chat(join(project, "chats"), "2026-11-05T10-00", id);
    await mkdir(join(project, "chats", id));
    await writeFile(join(project, "chats", id, `${subagent}.jsonl`), record(subagent));
    // Only a subagent's own id names what goes with it: never one of the project's own folders.
    for (const folder of ["chats", "logs", "tool-outputs"]) await writeFile(join(project, "chats", id, `${folder}.jsonl`), record(folder));
    const neighbour = await chat(join(project, "chats"), "2026-11-07T10-00", "9f8e7d6c-9999-4999-8999-999999999999");
    for (const each of [id, subagent]) {
      await mkdir(join(project, "logs"), { recursive: true });
      await writeFile(join(project, "logs", `session-${each}.jsonl`), "log");
      await mkdir(join(project, "tool-outputs", `session-${each}`), { recursive: true });
      await writeFile(join(project, "tool-outputs", `session-${each}`, "output.txt"), "output");
      await mkdir(join(project, each, "plans"), { recursive: true });
    }
    const otherLog = join(project, "logs", "session-1a2b3c4d-1111-4111-8111-111111111111.jsonl");
    await writeFile(otherLog, "keep");
    // An older Gemini's session: one JSON file, its id inside.
    const legacyId = "0a1b2c3d-7777-4777-8777-777777777777";
    const legacy = join(tmp, "4f9c0d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d", "chats");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, `session-2025-09-01T10-00-${legacyId.slice(0, 8)}.json`), JSON.stringify({ sessionId: legacyId, projectHash: "hash", messages: [] }, null, 2));
    await writeFile(join(home, ".gemini", "settings.json"), "settings sentinel");

    await deleteNativeSession("gemini-cli", id, join(home, "somewhere-else"));
    for (const path of [file, join(project, "chats", id), ...[id, subagent].flatMap((each) => [join(project, "logs", `session-${each}.jsonl`), join(project, "tool-outputs", `session-${each}`), join(project, each)])]) await gone(path);
    assert.equal(await readFile(otherLog, "utf8"), "keep");
    await lstat(neighbour);
    await deleteNativeSession("gemini-cli", legacyId, home);
    await gone(join(legacy, `session-2025-09-01T10-00-${legacyId.slice(0, 8)}.json`));
    for (const kept of [...own, twin]) await lstat(kept);
    assert.equal(await readFile(join(home, ".gemini", "settings.json"), "utf8"), "settings sentinel");

    // GEMINI_CLI_HOME stands in for the home folder.
    process.env.GEMINI_CLI_HOME = join(home, "gemini-home");
    const moved = await chat(join(home, "gemini-home", ".gemini", "tmp", "repo", "chats"), "2026-11-06T10-00", "7a8b9c0d-8888-4888-8888-888888888888");
    await deleteNativeSession("gemini-cli", "7a8b9c0d-8888-4888-8888-888888888888", home);
    await gone(moved);

    // Never a list number, and never anything but an exact recorded id.
    await assert.rejects(deleteNativeSession("gemini-cli", "3", home), /recorded session ID is invalid/);
    for (const kept of [...own, twin]) await lstat(kept);
    assert.deepEqual(await deleteCalls(), []);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(home, { recursive: true, force: true });
  }
});

test("a Codex thread the person already deleted counts as deleted", { skip: process.platform === "win32" }, async () => {
  const bin = await mkdtemp(join(tmpdir(), "ensemble-codex-bin-"));
  const saved = process.env.PATH;
  // Codex's app-server answers thread/delete for a thread it no longer has with "no rollout found for thread id <id>".
  await writeFile(
    join(bin, "codex"),
    `#!/usr/bin/env node
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "codex/0.163.0" } }) + "\\n");
  if (message.method === "thread/delete") process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32600, message: "no rollout found for thread id " + message.params.threadId } }) + "\\n");
});
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${saved ?? ""}`;
  try {
    await deleteNativeSession("codex", "0199a0b2-1111-7222-8333-444455556666", bin);
  } finally {
    process.env.PATH = saved;
    await rm(bin, { recursive: true, force: true });
  }
});

test("a session the person already deleted in OpenCode counts as deleted; any other failure does not", { skip: process.platform === "win32" }, async () => {
  const bin = await mkdtemp(join(tmpdir(), "ensemble-opencode-bin-"));
  const saved = process.env.PATH;
  // `opencode session delete <id>` for a session it no longer has: the error names the session and exits 1.
  await writeFile(
    join(bin, "opencode"),
    `#!/bin/sh
if [ "$1" = "session" ] && [ "$2" = "delete" ]; then
  case "$3" in
    ses_gone*) echo "Session not found: $3" >&2; exit 1 ;;
    *) echo "Could not reach the OpenCode server" >&2; exit 1 ;;
  esac
fi
exit 2
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${saved ?? ""}`;
  try {
    await deleteNativeSession("opencode", "ses_gone4f2a9c1b7e", bin);
    await assert.rejects(deleteNativeSession("opencode", "ses_live4f2a9c1b7e", bin), /could not delete its session: Could not reach/);
  } finally {
    process.env.PATH = saved;
    await rm(bin, { recursive: true, force: true });
  }
});
