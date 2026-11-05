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
