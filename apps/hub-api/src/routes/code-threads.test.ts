import assert from "node:assert/strict";
import test from "node:test";

// The module pulls in the API config. A unit run has no .env; the value is never connected to.
process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
const { askedText, keptMarkdown, threadPlace } = await import("./code-threads.js");
const { agentOutputBlock } = await import("../pages/agent-output.js");

test("a kept reply says what was asked, the answer and the files the turn changed, without the mentions written for the agent", () => {
  const instructions = "Fix the export\nand run the tests\n\n(Mentioned in Ensemble: @Fix export [task] ensemble://task/5f1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f)";
  assert.equal(askedText(instructions), "Fix the export\nand run the tests");
  const markdown = keptMarkdown({ instructions, summary: "Done: dates are kept.", evidence: { files: [{ path: "src/export.ts", added: 3, removed: 1 }] } });
  assert.equal(markdown, "> Fix the export\n> and run the tests\n\nDone: dates are kept.\n\nFiles changed: `src/export.ts` (+3 −1)");
});

test("the agent block names its source, agent, model, thread, folder and computer", () => {
  const block = agentOutputBlock("Done.", { source: "code-agent", jobId: "j1", runId: "r1", engine: "codex", model: "gpt-6-luna", title: "Codex in relay", threadId: "t1", folder: "/work/relay", computer: "Mira's Mac" }, new Date("2026-11-18T00:00:00Z"));
  assert.equal(block.type, "agentBlock");
  assert.deepEqual({ ...block.attrs, fingerprint: undefined }, { jobId: "j1", runId: "r1", model: "gpt-6-luna", title: "Codex in relay", at: "2026-11-18T00:00:00.000Z", fingerprint: undefined, source: "code-agent", engine: "codex", threadId: "t1", folder: "/work/relay", computer: "Mira's Mac" });
});

test("a thread's place comes from its first turn: a paired computer's folder by its path, none for a workspace folder", () => {
  assert.deepEqual(threadPlace({ deviceId: "d1", externalRoot: null, repoPath: null, context: { chat: true, surface: "code", codeFolder: "/work/relay" }, device: { name: "Mac" } }, false), { deviceId: "d1", deviceName: "Mac", folder: "/work/relay", workdir: null });
  assert.deepEqual(threadPlace({ deviceId: "d1", externalRoot: null, repoPath: null, context: { chat: true, surface: "code" }, device: { name: "Mac" } }, false), { deviceId: "d1", deviceName: "Mac", folder: null, workdir: null });
  assert.deepEqual(threadPlace({ deviceId: null, externalRoot: null, repoPath: "/ws/runs/abc", context: {} }, true), { deviceId: null, deviceName: null, folder: null, workdir: "/ws/runs/abc" });
  // On Ensemble on the web this server's own paths stay hidden.
  assert.deepEqual(threadPlace({ deviceId: null, externalRoot: "/srv/x", repoPath: "/srv/x", context: {} }, false), { deviceId: null, deviceName: null, folder: null, workdir: null });
});

test("a message for a turn not started yet joins its own, mentions together", async () => {
  const { amendedMessage } = await import("./code-threads.js");
  const before = "Fix the export\n\n(Mentioned in Ensemble: @Export [task] ensemble://task/a1)";
  const more = "Also keep the dates\n\n(Mentioned in Ensemble: @Dates [task] ensemble://task/b2)";
  assert.equal(amendedMessage(before, more), "Fix the export\n\nAlso keep the dates\n\n(Mentioned in Ensemble: @Export [task] ensemble://task/a1; @Dates [task] ensemble://task/b2)");
  assert.equal(amendedMessage("Fix it", "and test it"), "Fix it\n\nand test it");
});

test("a model's thread name is kept short and plain, or not at all", async () => {
  const { cleanThreadName } = await import("./code-threads.js");
  assert.equal(cleanThreadName('"BFS example in C++."'), "BFS example in C++");
  assert.equal(cleanThreadName("Title: **fix the export dates**"), "Fix the export dates");
  assert.equal(cleanThreadName("<think>hm</think>\nPlan next week"), "Plan next week");
  assert.equal(cleanThreadName("Sure! Here is a title for this conversation that describes the work in detail"), null);
  assert.equal(cleanThreadName(""), null);
});

test("where a reply was kept reads the same for events from before and after kinds", async () => {
  const { keptPlace } = await import("./code-threads.js");
  assert.deepEqual(keptPlace({ pageId: "p1", taskId: null, title: "Notes" }), { kind: "page", id: "p1", pageId: "p1", taskId: null, title: "Notes", href: "/pages/p1" });
  assert.deepEqual(keptPlace({ pageId: "p2", taskId: "t2", title: "Fix" }), { kind: "task", id: "t2", pageId: "p2", taskId: "t2", title: "Fix", href: "/tasks/t2" });
  assert.deepEqual(keptPlace({ kind: "meeting", id: "m1", title: "Standup", href: "/meetings?session=m1" })?.kind, "meeting");
  assert.equal(keptPlace({ title: "nothing" }), null);
});

test("a Code tab message carries the meeting notes it mentions, within what a computer accepts, and the thread can tell them apart", async () => {
  const { mentionsIn, withMentionedContent, withoutAttached } = await import("../workspace/mentioned.js");
  const message = "Write up the decisions\n\n(Mentioned in Ensemble: @Standup [meeting] ensemble://meeting/5f1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f; @Mira [people] ensemble://people/p1)";
  assert.deepEqual(mentionsIn(message).map((row) => row.kind), ["meeting", "people"]);
  const db = { meetingSession: { findFirst: async () => ({ title: "Standup", notes: "We ship on Friday.\n".repeat(2000), recap: "", startedAt: new Date("2026-11-17T09:00:00Z") }) } };
  const sent = await withMentionedContent(db as never, "u1", message);
  assert.ok(sent.length <= 8000, "a computer refuses longer messages");
  assert.match(sent, /\(Attached from Ensemble:[\s\S]*### Meeting notes: Standup \(2026-11-17\)\nWe ship on Friday\./);
  assert.equal(withoutAttached(sent), message);
  assert.equal(await withMentionedContent(db as never, "u1", "No mentions here"), "No mentions here");
});
