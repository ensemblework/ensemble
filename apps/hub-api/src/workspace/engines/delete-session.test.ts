import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteNativeSession } from "./delete-session.js";

test("native Claude, Cursor and pinned Antigravity deletion removes only exact recorded history", async () => {
  const home = await mkdtemp(join(tmpdir(), "ensemble-session-delete-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR };
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.CLAUDE_CONFIG_DIR = join(home, ".claude"); process.env.ENSEMBLE_REMOTE_STATE_DIR = join(home, "runtime");
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
