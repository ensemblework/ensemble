/**
 * A chat's agent session used outside Ensemble (session-touch.ts, turn-sessions.ts): prompts counted from the
 * agent's own transcript, and a touched session kept unresumed until the chat is deleted.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeProjectName, claudePrompt, copilotPrompt, sessionPrompts } from "./session-touch.js";
import { dropSession, findSession, forgetSession, lookSession, notePrompts, ROTATE_MESSAGES, saveSession, setNativeDropForTests } from "./turn-sessions.js";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("only prompts count in Claude Code's transcript: not tool results, command echoes, hook notes or compaction", () => {
  assert.equal(claudePrompt(JSON.stringify({ type: "user", message: { role: "user", content: "Plan the launch" } })), true);
  assert.equal(claudePrompt(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "document" }, { type: "text", text: "Read this" }] } })), true);
  assert.equal(claudePrompt(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } })), false);
  assert.equal(claudePrompt(JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "Caveat: local commands" } })), false);
  assert.equal(claudePrompt(JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } })), false);
  assert.equal(claudePrompt(JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "Summary of the conversation" } })), false);
  assert.equal(claudePrompt(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "user" }] } })), false);
  assert.equal(claudePrompt("not json"), false);
  assert.equal(copilotPrompt(JSON.stringify({ type: "user.message", data: { content: "Hi" } })), true);
  assert.equal(copilotPrompt(JSON.stringify({ type: "assistant.message", data: { content: "user.message" } })), false);
  assert.equal(claudeProjectName("/Users/mira/Library/Application Support/ensemble/assistant/chat-1"), "-Users-mira-Library-Application-Support-ensemble-assistant-chat-1");
});

test("prompts are read from Claude Code's and Copilot's own transcripts; other agents are unknown", async () => {
  const home = await mkdtemp(join(tmpdir(), "ensemble-touch-"));
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, COPILOT_HOME: process.env.COPILOT_HOME };
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.COPILOT_HOME = join(home, ".copilot");
  try {
    const folder = join(home, "state", "assistant", "chat-0001");
    const claudeId = randomUUID();
    const claudeDir = join(home, ".claude", "projects", claudeProjectName(folder));
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, `${claudeId}.jsonl`), line({ type: "user", message: { content: "One" } }) + line({ type: "assistant", message: { content: [] } }) + line({ type: "user", message: { content: [{ type: "tool_result" }] } }));
    assert.equal(await sessionPrompts("claude-code", claudeId, folder), 1);
    // A transcript under another spelling of the folder is still found by the session's id.
    const moved = randomUUID();
    await mkdir(join(home, ".claude", "projects", "-private-elsewhere"), { recursive: true });
    await writeFile(join(home, ".claude", "projects", "-private-elsewhere", `${moved}.jsonl`), line({ type: "user", message: { content: "Two" } }).repeat(2));
    assert.equal(await sessionPrompts("claude-code", moved, folder), 2);

    const copilotId = randomUUID();
    const events = join(home, ".copilot", "session-state", copilotId, "events.jsonl");
    await mkdir(join(home, ".copilot", "session-state", copilotId), { recursive: true });
    await writeFile(events, line({ type: "session.start" }) + line({ type: "user.message" }) + line({ type: "assistant.message" }));
    assert.equal(await sessionPrompts("copilot-cli", copilotId, folder), 1);
    await appendFile(events, line({ type: "session.resume" }) + line({ type: "user.message" }));
    assert.equal(await sessionPrompts("copilot-cli", copilotId, folder), 2);

    assert.equal(await sessionPrompts("codex", randomUUID(), folder), null);
    assert.equal(await sessionPrompts("copilot-cli", randomUUID(), folder), null, "no transcript: unknown, never a reason to start over");
    assert.equal(await sessionPrompts("claude-code", "../escape", folder), null);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("a session used outside Ensemble is kept unresumed, and deleted with the chat", async () => {
  const state = await mkdtemp(join(tmpdir(), "ensemble-touch-state-"));
  const saved = process.env.ENSEMBLE_REMOTE_STATE_DIR;
  process.env.ENSEMBLE_REMOTE_STATE_DIR = state;
  const dropped: string[] = [];
  setNativeDropForTests(async (_agent, id) => void dropped.push(id));
  try {
    const key = "chat-touched-0001";
    await saveSession(key, "copilot-cli", "first", "Instructions", { next: 2, prompts: 1 });
    assert.equal((await findSession(key, "copilot-cli", "Instructions", false, 2))?.prompts, 1);
    // The next turn found prompts of someone else's in it: a new session, the touched one retired, not deleted.
    await saveSession(key, "copilot-cli", "second", "Instructions", { next: 4, prompts: 1, retire: "first" });
    await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(dropped, []);
    assert.equal((await findSession(key, "copilot-cli", "Instructions", false, 4))?.id, "second");
    // Its session then disappears in the agent: the retired one still waits for the chat's deletion.
    await forgetSession(key, { gone: true });
    assert.equal(await findSession(key, "copilot-cli", "Instructions", false, 4), null);
    await saveSession(key, "copilot-cli", "third", "Instructions", { next: 6, prompts: 1 });
    assert.equal(await dropSession(key), true);
    await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(dropped.sort(), ["first", "third"]);
  } finally {
    setNativeDropForTests(null);
    if (saved === undefined) delete process.env.ENSEMBLE_REMOTE_STATE_DIR;
    else process.env.ENSEMBLE_REMOTE_STATE_DIR = saved;
    await rm(state, { recursive: true, force: true });
  }
});

test("a turn that failed or was stopped notes its session's prompts: only in the chat's own session, the chat's place moved only by a stopped turn, an unknown count dropped", async () => {
  const state = await mkdtemp(join(tmpdir(), "ensemble-noted-state-"));
  const saved = process.env.ENSEMBLE_REMOTE_STATE_DIR;
  process.env.ENSEMBLE_REMOTE_STATE_DIR = state;
  try {
    const key = "chat-noted-000001";
    await saveSession(key, "claude-code", "session-1", "Instructions", { next: 2, perTurn: true, prompts: 1 });
    // The turn at position 2 failed after Claude Code took its message: a failed exchange does not move the chat on.
    await notePrompts(key, "session-1", 2);
    assert.deepEqual(await findSession(key, "claude-code", "Instructions", true, 2), { id: "session-1", text: null, prompts: 2 }, "the next message goes on in the session and reads only what comes after the failed one");
    // The turn at position 2 was stopped: its message and "Stopped." stay in the chat, so the session's place moves past them.
    await notePrompts(key, "session-1", 3, 4);
    assert.deepEqual(await findSession(key, "claude-code", "Instructions", true, 4), { id: "session-1", text: null, prompts: 3 }, "the turn after the stop goes on in the session");
    assert.deepEqual(await lookSession(key, "claude-code", "Instructions", true, 6), { found: null, declined: "moved" }, "its place is 4, not further");
    await notePrompts(key, "session-0", 5);
    assert.equal((await findSession(key, "claude-code", "Instructions", true, 4))?.prompts, 3, "a session the chat no longer has notes nothing");
    await notePrompts(key, "session-1", null);
    const unknown = await findSession(key, "claude-code", "Instructions", true, 4);
    assert.equal(unknown?.id, "session-1");
    assert.equal(unknown?.prompts, undefined, "a count that could not be made is dropped: the next turn brings nothing in");
    await forgetSession(key, { gone: true });
    await notePrompts(key, "session-1", 3);
    assert.equal(await findSession(key, "claude-code", "Instructions", true, 4), null, "a session forgotten meanwhile is not brought back");
    await notePrompts("chat-noted-000002", "session-1", 3);
    assert.equal(await findSession("chat-noted-000002", "claude-code", "Instructions", true), null, "nor is a chat made for it");
  } finally {
    if (saved === undefined) delete process.env.ENSEMBLE_REMOTE_STATE_DIR;
    else process.env.ENSEMBLE_REMOTE_STATE_DIR = saved;
    await rm(state, { recursive: true, force: true });
  }
});

test("a session that could not be reopened though the agent still has it is kept, unresumed, and deleted with the chat", async () => {
  const state = await mkdtemp(join(tmpdir(), "ensemble-busy-state-"));
  const saved = process.env.ENSEMBLE_REMOTE_STATE_DIR;
  process.env.ENSEMBLE_REMOTE_STATE_DIR = state;
  const dropped: string[] = [];
  setNativeDropForTests(async (_agent, id) => void dropped.push(id));
  try {
    const key = "chat-busy-000001";
    await saveSession(key, "codex", "thread-1", "Instructions", { next: 2, perTurn: true });
    // The ChatGPT app held the thread ("already has an active writer"): the chat goes on in a new one.
    await forgetSession(key);
    assert.equal(await findSession(key, "codex", "Instructions", true, 2), null, "not resumed");
    await saveSession(key, "codex", "thread-2", "Instructions", { next: 4, perTurn: true });
    await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(dropped, [], "the held thread is not deleted while the chat lives");
    assert.equal((await findSession(key, "codex", "Instructions", true, 4))?.id, "thread-2");
    assert.equal(await dropSession(key), true);
    await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(dropped.sort(), ["thread-1", "thread-2"], "both go with the chat");
  } finally {
    setNativeDropForTests(null);
    if (saved === undefined) delete process.env.ENSEMBLE_REMOTE_STATE_DIR;
    else process.env.ENSEMBLE_REMOTE_STATE_DIR = saved;
    await rm(state, { recursive: true, force: true });
  }
});

test("why a chat's session is not resumed: expired, moved on elsewhere, rotated, or older instructions changed", async () => {
  const state = await mkdtemp(join(tmpdir(), "ensemble-declined-state-"));
  const saved = process.env.ENSEMBLE_REMOTE_STATE_DIR;
  process.env.ENSEMBLE_REMOTE_STATE_DIR = state;
  try {
    const key = "chat-declined-01";
    await saveSession(key, "claude-code", "session-1", "Instructions", { next: 2, perTurn: true });
    assert.deepEqual(await lookSession(key, "claude-code", "Instructions", true, 2), { found: { id: "session-1", text: null } });
    assert.deepEqual(await lookSession(key, "claude-code", "Instructions", true, 6), { found: null, declined: "moved" }, "a turn ran elsewhere since");
    assert.deepEqual(await lookSession(key, "claude-code", "Instructions", true, 0), { found: { id: "session-1", text: null } }, "ahead of the chat: it answered a turn the chat keeps as failed, and misses nothing");
    // Another message of the same turn (asked for its reply, or what the answer check found missing) has no place in the chat: the session keeps its own.
    await saveSession(key, "claude-code", "session-1", "Instructions", { perTurn: true });
    assert.deepEqual(await lookSession(key, "claude-code", "Instructions", true, 6), { found: null, declined: "moved" }, "still at 2");
    assert.deepEqual(await lookSession(key, "claude-code", "Instructions", true, 2), { found: { id: "session-1", text: null } });
    assert.deepEqual(await lookSession(key, "codex", "Instructions", true, 2), { found: null }, "another agent: nothing to restart");
    assert.deepEqual(await lookSession("chat-never-0001", "claude-code", "Instructions", true, 0), { found: null });
    await saveSession(key, "claude-code", "session-1", "Instructions", { next: ROTATE_MESSAGES + 2, perTurn: true });
    assert.deepEqual(await lookSession(key, "claude-code", "Instructions", true, ROTATE_MESSAGES + 2), { found: null, declined: "rotated" });
    // An older entry kept only its instructions' fingerprint: changed instructions start a new session.
    const path = join(state, "assistant-sessions.json");
    const store = JSON.parse(await readFile(path, "utf8")) as Record<string, Record<string, unknown>>;
    store["chat-hashonly-01"] = { agent: "copilot-cli", id: "old", instructions: "0".repeat(24), at: Date.now(), next: 2 };
    store["chat-expired-001"] = { agent: "copilot-cli", id: "older", instructions: "0".repeat(24), at: Date.now() - 31 * 86_400_000, next: 2 };
    await writeFile(path, JSON.stringify(store));
    assert.deepEqual(await lookSession("chat-hashonly-01", "copilot-cli", "Instructions", false, 2), { found: null, declined: "instructions" });
    assert.deepEqual(await lookSession("chat-expired-001", "copilot-cli", "Instructions", false, 2), { found: null, declined: "expired" });
  } finally {
    if (saved === undefined) delete process.env.ENSEMBLE_REMOTE_STATE_DIR;
    else process.env.ENSEMBLE_REMOTE_STATE_DIR = saved;
    await rm(state, { recursive: true, force: true });
  }
});
