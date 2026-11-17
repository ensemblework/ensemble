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
