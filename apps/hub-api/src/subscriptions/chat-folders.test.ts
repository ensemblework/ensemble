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

const { chatFolder, chatFolderName, dropSession, findSession, forgetSession, lookSession, saveSession, sessionFolder, setNativeDropForTests, takeSession, untakeSession } = await import("./turn-sessions.js");
const dropped: Array<{ id: string; folder: string }> = [];
setNativeDropForTests(async (_agent, id, folder) => void dropped.push({ id, folder }));
const storePath = join(state, "assistant-sessions.json");
const store = () => JSON.parse(readFileSync(storePath, "utf8")) as Record<string, { id: string; dir?: string; keep?: number; retired?: string[]; taking?: { id: string } }>;
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

test("a replaced session is deleted from the agent and the chat goes on in its folder; a chat unused past its days goes with it", async () => {
  const key = "9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
  const placed = await chatFolder(key, { agent: "copilot-cli", title: "Long chat" });
  mkdirSync(placed.folder, { recursive: true });
  writeFileSync(join(placed.folder, "system.md"), "Rules.");
  await saveSession(key, "copilot-cli", "first-session", "Rules.", { next: 2, dir: placed.dir });
  await settle();
  dropped.length = 0;
  // Rotated (or its instructions changed): a new session of the same agent.
  await saveSession(key, "copilot-cli", "second-session", "Rules.", { next: 4, dir: placed.dir });
  await settle();
  assert.deepEqual(dropped, [{ id: "first-session", folder: placed.folder }], "deleted from Copilot, from the folder it began in");
  assert.ok(existsSync(join(placed.folder, "system.md")), "the chat goes on in its folder");
  // Another agent takes the chat over: its old session goes, the folder stays.
  await saveSession(key, "codex", "thread-3", "Rules.", { next: 6, perTurn: true, dir: placed.dir });
  await settle();
  assert.ok(dropped.some((row) => row.id === "second-session"));
  assert.ok(existsSync(join(placed.folder, "system.md")));
  // A chat from before named folders, the same.
  const legacy = "0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e";
  mkdirSync(sessionFolder(legacy), { recursive: true });
  await saveSession(legacy, "gemini-cli", "old-gemini", "Rules.", { next: 2 });
  await saveSession(legacy, "gemini-cli", "new-gemini", "Rules.", { next: 4 });
  await settle();
  assert.ok(dropped.some((row) => row.id === "old-gemini" && row.folder === sessionFolder(legacy)));
  assert.ok(existsSync(sessionFolder(legacy)));
  // Unused past its keeping days: the whole chat is dropped, its folder too, when another chat's turn saves.
  writeFileSync(storePath, JSON.stringify({ ...store(), [key]: { ...store()[key], at: 0 } }));
  dropped.length = 0;
  await saveSession("1c2d3e4f-5a6b-4c7d-8e8f-9a0b1c2d3e4f", "codex", "thread-4", "Rules.", { next: 2, perTurn: true });
  await settle();
  assert.deepEqual(dropped, [{ id: "thread-3", folder: placed.folder }]);
  assert.equal(existsSync(placed.folder), false, "an expired chat's folder goes with it");
  assert.ok(!(key in store()));
});

test("the session a turn began in, noted before the agent has the message, is where the turn goes on after the computer stopped mid-turn", async () => {
  const key = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a";
  const placed = await chatFolder(key, { agent: "claude-code", title: "Venue week" });
  mkdirSync(placed.folder, { recursive: true });
  // The chat's first message starts a session; the computer stops before the turn ends, so nothing after is saved.
  await takeSession(key, "claude-code", "cut-session", "Rules.", { position: 0, perTurn: true });
  assert.deepEqual(await chatFolder(key, { agent: "claude-code", title: "Venue week and catering" }), placed, "the folder that session began in keeps its name");
  assert.deepEqual((await lookSession(key, "claude-code", "Rules.", true, 0, true)).found, { id: "cut-session", text: null }, "the turn's continuation goes on in it");
  assert.deepEqual((await lookSession(key, "claude-code", "Rules.", true, 0)).found, { id: "cut-session", text: null }, "so does the chat's next turn after a failed one");
  await saveSession(key, "claude-code", "cut-session", "Rules.", { next: 2, perTurn: true, dir: placed.dir });
  assert.equal(store()[key]!.taking, undefined, "the turn's end replaces the note");

  // A turn that ends here takes its note back: the chat's session is as it was.
  await takeSession(key, "claude-code", "cut-session", "Rules.", { position: 2, perTurn: true });
  await untakeSession(key, "cut-session");
  assert.deepEqual(await lookSession(key, "claude-code", "Rules.", true, 2, true), { found: null, declined: "moved" });

  // A noted session that cannot be reopened is the one forgotten; the chat's own stays until another replaces it.
  await takeSession(key, "claude-code", "noted-session", "Rules.", { position: 2, perTurn: true });
  await forgetSession(key);
  assert.equal(store()[key]!.id, "cut-session");
  assert.deepEqual(store()[key]!.retired, ["noted-session"]);
  assert.equal(store()[key]!.taking, undefined);

  // Another session goes on in place of a noted one: it is deleted from the agent, like any session it replaced.
  await takeSession(key, "claude-code", "replaced-session", "Rules.", { position: 2, perTurn: true });
  await settle();
  dropped.length = 0;
  await saveSession(key, "claude-code", "third-session", "Rules.", { next: 4, perTurn: true, dir: placed.dir });
  await settle();
  assert.deepEqual(dropped.map((row) => row.id).sort(), ["cut-session", "replaced-session"]);

  // Deleting the chat deletes a noted session with the rest.
  await takeSession(key, "claude-code", "last-session", "Rules.", { position: 4, perTurn: true });
  dropped.length = 0;
  assert.equal(await dropSession(key), true);
  assert.deepEqual(dropped.map((row) => row.id).sort(), ["last-session", "noted-session", "third-session"]);
});

test("a turn under way in a chat whose session expired keeps its new session while another chat's turn sweeps; an expired chat with no turn under way is swept", async () => {
  const key = "4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c";
  const placed = await chatFolder(key, { agent: "claude-code", title: "Weekly digest", keepDays: 7 });
  mkdirSync(placed.folder, { recursive: true });
  await saveSession(key, "claude-code", "weekly-old", "Rules.", { next: 2, perTurn: true, keepDays: 7, dir: placed.dir });
  // Unused for more than its 7 days: the turn declines it and starts a new session, noted before the agent has the message.
  writeFileSync(storePath, JSON.stringify({ ...store(), [key]: { ...store()[key], at: Date.now() - 8 * 24 * 3600_000 } }));
  assert.deepEqual(await lookSession(key, "claude-code", "Rules.", true, 2), { found: null, declined: "expired" });
  await takeSession(key, "claude-code", "weekly-new", "Rules.", { position: 2, perTurn: true, keepDays: 7 });
  await settle();
  dropped.length = 0;
  await saveSession("5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d", "codex", "thread-other", "Rules.", { next: 2, perTurn: true });
  await settle();
  assert.deepEqual(dropped.map((row) => row.id), [], "neither the session the turn runs in nor the chat goes");
  assert.equal(store()[key]!.taking?.id, "weekly-new");
  assert.ok(existsSync(placed.folder));
  // The turn ends: the new session replaces the expired one, which is deleted from the agent.
  await saveSession(key, "claude-code", "weekly-new", "Rules.", { next: 4, perTurn: true, keepDays: 7, dir: placed.dir });
  await settle();
  assert.deepEqual(dropped.map((row) => row.id), ["weekly-old"]);
  assert.deepEqual((await lookSession(key, "claude-code", "Rules.", true, 4)).found, { id: "weekly-new", text: null });

  // A note is not a use of the session it names: a turn that took its note back leaves the chat as old as it was.
  writeFileSync(storePath, JSON.stringify({ ...store(), [key]: { ...store()[key], at: Date.now() - 8 * 24 * 3600_000 } }));
  await takeSession(key, "claude-code", "weekly-later", "Rules.", { position: 4, perTurn: true, keepDays: 7 });
  await untakeSession(key, "weekly-later");
  assert.equal(store()[key]!.taking, undefined);
  dropped.length = 0;
  await saveSession("5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d", "codex", "thread-other", "Rules.", { next: 4, perTurn: true });
  await settle();
  assert.deepEqual(dropped, [{ id: "weekly-new", folder: placed.folder }], "an expired chat with no turn under way is swept");
  assert.ok(!(key in store()));
  assert.equal(existsSync(placed.folder), false);
});

test("a turn cut off in a session it made in the other home goes on there, and only there", async () => {
  const key = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b";
  await saveSession(key, "kimi-code", "own-session", "Rules.", { next: 2, perTurn: true, home: "own" });
  // A turn someone else can steer starts a session in Ensemble's home for the agent; the computer stops mid-turn.
  await takeSession(key, "kimi-code", "others-session", "Rules.", { position: 2, perTurn: true, home: "others" });
  assert.deepEqual(await lookSession(key, "kimi-code", "Rules.", true, 2, true, "others"), { found: { id: "others-session", text: null, home: "others" } }, "the turn's continuation goes on in it");
  assert.deepEqual(await lookSession(key, "kimi-code", "Rules.", true, 4, false, "own"), { found: null, declined: "audience", retire: "others-session" }, "the person's own turn never resumes it");
});

test("a folder name in the store that is a path is never used", async () => {
  const key = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
  writeFileSync(storePath, JSON.stringify({ ...store(), [key]: { agent: "codex", id: "thread-9", instructions: "x", at: Date.now(), dir: "../../outside" } }));
  assert.deepEqual(await chatFolder(key, { agent: "codex", title: "Anything" }), { folder: sessionFolder(key), dir: key });
  dropped.length = 0;
  await dropSession(key);
  assert.deepEqual(dropped, [{ id: "thread-9", folder: sessionFolder(key) }]);
});
