/**
 * A chat's agent session used outside Ensemble (session-touch.ts, turn-sessions.ts): prompts counted from the
 * agent's own transcript, and a touched session kept unresumed until the chat is deleted.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeProjectName, claudePrompt, copilotPrompt, sessionPrompts } from "./session-touch.js";
import { dropSession, findSession, forgetSession, saveSession, setNativeDropForTests } from "./turn-sessions.js";

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
    await forgetSession(key);
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
