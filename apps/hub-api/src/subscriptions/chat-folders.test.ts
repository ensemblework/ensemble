/**
 * Each assistant chat works in a folder named after it (turn-sessions.ts chatFolder), so the agents' apps,
 * which group sessions by folder, list it readably. The folder is kept for as long as a session of the chat
 * began there, since the agents find a session by that folder.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const state = mkdtempSync(join(tmpdir(), "ensemble-chat-folders-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = state;
after(() => rmSync(state, { recursive: true, force: true }));

const { chatFolder, chatFolderName, dropSession, findSession, forgetSession, saveSession, sessionFolder, setNativeDropForTests } = await import("./turn-sessions.js");
const dropped: Array<{ id: string; folder: string }> = [];
setNativeDropForTests(async (_agent, id, folder) => void dropped.push({ id, folder }));
const storePath = join(state, "assistant-sessions.json");
const store = () => JSON.parse(readFileSync(storePath, "utf8")) as Record<string, { id: string; dir?: string; keep?: number }>;
const chats = join(state, "assistant");
const settle = () => new Promise((done) => setTimeout(done, 30));

test("a chat's folder is its title as a slug, then the start of its id", () => {
  const key = "74afcd40-1111-4222-8333-944455556666";
  assert.equal(chatFolderName("68b71387-5787-4d2e-9f3c-1a2b3c4d5e6f", "Session test 244 chat on Claude"), "session-test-244-chat-on-claude-68b71387");
  assert.equal(chatFolderName("ask-task-c4bd4006aa11bb22cc33dd44ee55ff66", "Ask Ensemble: Copilot note"), "ask-ensemble-copilot-note-c4bd4006", "an ask: the start of its hash");
  assert.equal(chatFolderName(key, "Café crème, s'il vous plaît!"), "cafe-creme-s-il-vous-plait-74afcd40");
  assert.equal(chatFolderName(key, "Plan the launch of the new pricing page with the marketing team"), "plan-the-launch-of-the-new-pricing-page-74afcd40", "cut at a word, 40 characters at most");
  assert.equal(chatFolderName(key, "会議のメモ"), "chat-74afcd40", "no Latin letters or digits");
  assert.equal(chatFolderName(key, null), "chat-74afcd40");
  assert.equal(chatFolderName(key, "Plan", true), "plan-74afcd40111142228333944455556666", "all of the key, when the short name is taken");
});

test("a new chat gets its named folder before its first turn, and keeps it once its session began there", async () => {
  const key = "4b0f8c1e-9d2a-4c55-8f31-0a6c2e9d7b11";
  const first = await chatFolder(key, { agent: "claude-code", title: "Plan the launch" });
  assert.deepEqual(first, { folder: join(chats, "plan-the-launch-4b0f8c1e"), dir: "plan-the-launch-4b0f8c1e" });
  assert.equal(store()[key]!.dir, first.dir, "kept in the store before the turn runs");
  assert.equal(await findSession(key, "claude-code", "Rules.", true), null, "a folder alone is no session to resume");
  mkdirSync(first.folder, { recursive: true });
  await saveSession(key, "claude-code", "0b9f2c4e-1d3a-4e5b-8c6d-7e8f9a0b1c2d", "Rules.", { next: 2, perTurn: true, dir: first.dir });
  // The person renames the chat: its session began in this folder, where Claude Code finds it.
  assert.deepEqual(await chatFolder(key, { agent: "claude-code", title: "Launch plan, second round" }), first);
  assert.deepEqual(await findSession(key, "claude-code", "Rules.", true, 2), { id: "0b9f2c4e-1d3a-4e5b-8c6d-7e8f9a0b1c2d", text: null });
  // A session that replaces it starts in the same folder.
  await saveSession(key, "claude-code", "1c0a3d5f-2e4b-4f6c-9d7e-8f9a0b1c2d3e", "Rules.", { next: 4, perTurn: true, dir: first.dir });
  assert.equal(store()[key]!.dir, first.dir);
  // Deleting the chat deletes its session where it ran, and the chat's folder.
  await settle();
  dropped.length = 0;
  assert.equal(await dropSession(key), true);
  assert.deepEqual(dropped, [{ id: "1c0a3d5f-2e4b-4f6c-9d7e-8f9a0b1c2d3e", folder: first.folder }]);
  assert.equal(existsSync(first.folder), false);
  assert.ok(!(key in store()));
});

test("a chat from before named folders keeps its folder while a session of it began there", async () => {
  const key = "9e3c2b10-55aa-4d0e-8c7f-1b2a3c4d5e6f";
  mkdirSync(sessionFolder(key), { recursive: true });
  await saveSession(key, "gemini-cli", "older-session", "Rules.", { next: 2 });
  assert.deepEqual(await chatFolder(key, { agent: "gemini-cli", title: "Weekly review" }), { folder: sessionFolder(key), dir: key }, "Gemini CLI finds the session by this folder");
  // One used outside Ensemble, and one that could not be reopened though Gemini may still have it, are set aside:
  // both are deleted with the chat, from the folder they began in.
  await saveSession(key, "gemini-cli", "newer-session", "Rules.", { next: 4, retire: "older-session" });
  await forgetSession(key);
  assert.deepEqual(await chatFolder(key, { agent: "gemini-cli", title: "Weekly review" }), { folder: sessionFolder(key), dir: key });
  dropped.length = 0;
  await dropSession(key);
  assert.deepEqual(dropped, [{ id: "older-session", folder: sessionFolder(key) }, { id: "newer-session", folder: sessionFolder(key) }]);
});

test("a folder no session began in takes the chat's name: an old one moves, and so does one whose chat was renamed", async () => {
  // A chat from before whose session its agent no longer has: nothing of it is left in its folder to find.
  const legacy = "5d6e7f80-1a2b-4c3d-9e4f-5a6b7c8d9e0f";
  mkdirSync(sessionFolder(legacy), { recursive: true });
  writeFileSync(join(sessionFolder(legacy), "system.md"), "Rules.");
  await saveSession(legacy, "opencode", "gone-session", "Rules.", { next: 2 });
  await forgetSession(legacy, { gone: true });
  const moved = await chatFolder(legacy, { agent: "opencode", title: "Weekly review" });
  assert.deepEqual(moved, { folder: join(chats, "weekly-review-5d6e7f80"), dir: "weekly-review-5d6e7f80" });
  assert.ok(existsSync(join(moved.folder, "system.md")) && !existsSync(sessionFolder(legacy)), "the folder moved to its name");
  // A new chat whose first turn failed (no session saved), then renamed.
  const fresh = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
  const before = await chatFolder(fresh, { agent: "codex", title: "Draft" });
  mkdirSync(before.folder, { recursive: true });
  const after = await chatFolder(fresh, { agent: "codex", title: "Release notes" });
  assert.equal(after.dir, "release-notes-3c4d5e6f");
  assert.ok(existsSync(after.folder) && !existsSync(before.folder));
  // Another chat with that title and a key that starts the same gets all of its key.
  const twin = await chatFolder("3c4d5e6f-0000-4000-8000-000000000000", { agent: "codex", title: "Release notes" });
  assert.equal(twin.dir, "release-notes-3c4d5e6f000040008000000000000000");
});

test("a session another agent saves after a failed first turn keeps the chat's folder", async () => {
  const key = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d";
  const placed = await chatFolder(key, { agent: "claude-code", title: "Switch agents" });
  mkdirSync(placed.folder, { recursive: true });
  await settle();
  dropped.length = 0;
  await saveSession(key, "codex", "thread-1", "Rules.", { next: 2, perTurn: true, dir: placed.dir });
  await settle();
  assert.ok(existsSync(placed.folder), "the folder the new session began in stays");
  assert.deepEqual(dropped, []);
  assert.equal(store()[key]!.dir, placed.dir);
});

test("an ask keeps its days and its named folder, also when its session could not be reopened", async () => {
  const key = "ask-page-0123456789abcdef0123456789abcdef";
  const placed = await chatFolder(key, { agent: "copilot-cli", title: "Ask Ensemble: Launch plan", keepDays: 1 });
  assert.equal(placed.dir, "ask-ensemble-launch-plan-01234567");
  assert.equal(store()[key]!.keep, 1);
  await saveSession(key, "copilot-cli", "ask-session-1", "Rules.", { keepDays: 1, dir: placed.dir });
  await forgetSession(key);
  assert.equal(store()[key]!.dir, placed.dir);
  assert.deepEqual(await chatFolder(key, { agent: "copilot-cli", title: "Ask Ensemble: Launch plan", keepDays: 1 }), placed);
});

test("a folder name in the store that is a path is never used", async () => {
  const key = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
  writeFileSync(storePath, JSON.stringify({ ...store(), [key]: { agent: "codex", id: "thread-9", instructions: "x", at: Date.now(), dir: "../../outside" } }));
  assert.deepEqual(await chatFolder(key, { agent: "codex", title: "Anything" }), { folder: sessionFolder(key), dir: key });
  dropped.length = 0;
  await dropSession(key);
  assert.deepEqual(dropped, [{ id: "thread-9", folder: sessionFolder(key) }]);
});
