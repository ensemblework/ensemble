/**
 * Deleting an assistant chat deletes the agent session behind it on the computer (turn-sessions.ts
 * dropSession, remote/assistant-session-delete.ts): the store entry, the agent's own history (each
 * agent's delete in workspace/engines/delete-session.ts) and the chat's folder. A group's folder stays.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SUBSCRIPTION_PROVIDERS } from "@ensemble/shared-types";

const state = mkdtempSync(join(tmpdir(), "ensemble-chat-delete-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = state;
after(() => rmSync(state, { recursive: true, force: true }));

const { dropSession, findSession, saveSession, sessionFolder, setNativeDropForTests } = await import("./turn-sessions.js");
const { answerAssistantSessionDelete } = await import("../remote/assistant-session-delete.js");
const dropped: Array<{ agent: string; id: string; folder: string }> = [];
setNativeDropForTests(async (agent, id, folder) => dropped.push({ agent, id, folder }));
const store = () => JSON.parse(readFileSync(join(state, "assistant-sessions.json"), "utf8")) as Record<string, unknown>;

test("every subscription agent's session is deleted with its chat, and the chat's folder too", async () => {
  for (const [index, agent] of SUBSCRIPTION_PROVIDERS.entries()) {
    const key = `chat-${agent}-${index}`.padEnd(12, "x");
    await saveSession(key, agent, `session-${index}`, "Be brief.", { next: 2 });
    mkdirSync(sessionFolder(key), { recursive: true });
    dropped.length = 0;
    assert.equal(await dropSession(key), true);
    assert.deepEqual(dropped, [{ agent, id: `session-${index}`, folder: sessionFolder(key) }], `${agent}: deleted in the agent itself`);
    assert.equal(await findSession(key, agent, "Be brief.", true, 2), null);
    assert.ok(!(key in store()));
    assert.equal(existsSync(sessionFolder(key)), false, `${agent}: the chat's folder is gone`);
  }
});

test("a node's shared project folder stays; a chat this computer never ran is a no-op", async () => {
  const project = join(state, "project");
  mkdirSync(project, { recursive: true });
  await saveSession("room-chat-0001", "claude-code", "session-room", "Rules.", { next: 2, folder: project, perTurn: true });
  dropped.length = 0;
  assert.equal(await dropSession("room-chat-0001"), true);
  assert.deepEqual(dropped, [{ agent: "claude-code", id: "session-room", folder: project }]);
  assert.ok(existsSync(project));
  dropped.length = 0;
  assert.equal(await dropSession("never-ran-here-1"), false);
  assert.deepEqual(dropped, []);
  assert.equal(await dropSession("../escape"), false, "a key that is not a chat key is refused");
});

test("the web's request is answered with what happened, and a bad request is refused", async () => {
  await saveSession("asked-chat-0001", "codex", "thread-1", "Rules.", { next: 2, perTurn: true });
  const answers: Array<{ id: string; answer: unknown }> = [];
  const client = { answerCode: async (id: string, answer: unknown) => void answers.push({ id, answer }) };
  await answerAssistantSessionDelete(client as never, { id: "req-1", key: "asked-chat-0001" });
  await answerAssistantSessionDelete(client as never, { id: "req-2", key: "asked-chat-0001" });
  await answerAssistantSessionDelete(client as never, { id: "req-3", key: "../../etc" });
  assert.deepEqual(answers, [
    { id: "req-1", answer: { status: 200, body: { deleted: true, found: true } } },
    { id: "req-2", answer: { status: 200, body: { deleted: true, found: false } } },
    { id: "req-3", answer: { status: 409, body: { error: "Invalid chat session deletion request." } } },
  ]);
});
