import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acpTurns, claudeTurns, codexTurns, copilotTurns, MAX_OUTSIDE_TURNS, newestAfter, outsideOf, readOutside, toolLine } from "./outside.js";

const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const prompt = (text: string, entrypoint: string, timestamp: string) => ({ type: "user", entrypoint, timestamp, message: { role: "user", content: text } });
const answer = (content: unknown[]) => ({ type: "assistant", message: { role: "assistant", content } });

test("Claude Code: the prompts after Ensemble's are brought in with their answers, a line for their tools, and where they were typed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-outside-claude-"));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const id = "7c6b5a49-3827-4615-9a0b-1c2d3e4f5a6b";
    mkdirSync(join(root, "projects", "-w-chat"), { recursive: true });
    writeFileSync(
      join(root, "projects", "-w-chat", `${id}.jsonl`),
      jsonl([
        prompt("Remember KIWI.", "sdk-cli", "2026-11-15T07:00:00.000Z"),
        answer([{ type: "text", text: "Noted: KIWI." }]),
        prompt("Also remember MANGO", "claude-desktop-3p", "2026-11-15T07:05:00.000Z"),
        answer([{ type: "text", text: "Let me note it." }, { type: "tool_use", name: "Edit", input: { file_path: "/w/notes.md" } }]),
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
        answer([{ type: "tool_use", name: "Bash", input: { command: "ls" } }, { type: "tool_use", name: "Write", input: { file_path: "/w/b.md" } }]),
        answer([{ type: "text", text: "Noted MANGO." }]),
        { type: "user", isMeta: true, message: { role: "user", content: "Caveat" } },
        prompt("And PEAR", "claude-desktop-3p", "2026-11-15T07:06:00.000Z"),
        answer([{ type: "text", text: "PEAR too." }]),
      ]),
    );
    const read = await readOutside("claude-code", id, "/w/chat", 1);
    assert.deepEqual(read, {
      app: "the Claude app",
      turns: [
        { prompt: "Also remember MANGO", answer: "Noted MANGO.", tools: "Edited 2 files, ran 1 command", files: ["/w/notes.md", "/w/b.md"], at: "2026-11-15T07:05:00.000Z" },
        { prompt: "And PEAR", answer: "PEAR too.", at: "2026-11-15T07:06:00.000Z" },
      ],
      earlier: 0,
    });
    assert.equal(await readOutside("claude-code", id, "/w/chat", 3), null, "nothing after the count");
    assert.equal(await readOutside("claude-code", "11111111-2222-4333-8444-555555555555", "/w/chat", 0), null, "no transcript");
    assert.equal((await claudeTurns(join(root, "projects", "-w-chat", `${id}.jsonl`))).turns.length, 3, "one exchange per prompt, as session-touch.ts counts them");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub Copilot: one exchange per user.message, with its last answer and tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-outside-copilot-"));
  try {
    const path = join(root, "events.jsonl");
    writeFileSync(
      path,
      jsonl([
        { type: "session.start", data: { context: { cwd: "/w" } } },
        { type: "user.message", timestamp: "2026-11-15T07:00:00.000Z", data: { content: "Remember KIWI." } },
        { type: "assistant.message", data: { content: "Noted." } },
        { type: "user.message", timestamp: "2026-11-15T07:05:00.000Z", data: { content: "Also MANGO" } },
        { type: "tool.execution_start", data: { toolName: "bash", arguments: { command: "ls" } } },
        { type: "tool.execution_start", data: { toolName: "view", arguments: { path: "/w/a.md" } } },
        { type: "assistant.message", data: { content: "" } },
        { type: "assistant.message", data: { content: "Noted MANGO." } },
      ]),
    );
    assert.deepEqual(outsideOf("GitHub Copilot", await copilotTurns(path), 1), { app: "GitHub Copilot", turns: [{ prompt: "Also MANGO", answer: "Noted MANGO.", tools: "Ran 1 command, used 1 other tool", at: "2026-11-15T07:05:00.000Z" }], earlier: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sub-agent's task and a background sub-agent's wake-up are not exchanges of the person's", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-outside-sub-"));
  try {
    // Claude Code (2.1.3xx, `claude -p`): the Agent tool starts a background sub-agent; its result wakes the session, which answers again.
    const claude = join(root, "claude.jsonl");
    writeFileSync(
      claude,
      jsonl([
        prompt("Start one sub-agent that replies PLUM, then reply DONE.", "sdk-cli", "2026-11-15T07:00:00.000Z"),
        answer([{ type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "Reply PLUM", prompt: "Reply PLUM" } }]),
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Async agent launched" }] } },
        answer([{ type: "text", text: "The subagent is still running. I'll reply with DONE once it returns." }]),
        { type: "user", origin: { kind: "task-notification", producer: "session-task" }, message: { role: "user", content: "<task-notification>\n<status>completed</status>\n<result>PLUM</result>\n</task-notification>" } },
        answer([{ type: "text", text: "DONE" }]),
        prompt("And PEAR", "claude-desktop-3p", "2026-11-15T07:06:00.000Z"),
        answer([{ type: "text", text: "PEAR too." }]),
      ]),
    );
    const read = await claudeTurns(claude);
    assert.deepEqual(read.turns.map((turn) => [turn.prompt, turn.answer]), [["Start one sub-agent that replies PLUM, then reply DONE.", "DONE"], ["And PEAR", "PEAR too."]]);
    assert.deepEqual(outsideOf(read.app, read.turns, 1)?.turns.map((turn) => turn.prompt), ["And PEAR"], "Ensemble's one prompt, then the person's");

    // GitHub Copilot 1.0.109: the task tool's sub-agent writes its own prompt and answer into the session's events, marked with its agent id.
    const copilot = join(root, "events.jsonl");
    writeFileSync(
      copilot,
      jsonl([
        { type: "user.message", timestamp: "2026-11-15T07:00:00.000Z", data: { content: "Start one sub-agent that replies PLUM, then reply DONE.", parentAgentTaskId: "task-root" } },
        { type: "assistant.message", data: { content: "", toolRequests: [{ toolCallId: "call_1", name: "task" }] } },
        { type: "tool.execution_start", data: { toolCallId: "call_1", toolName: "task", arguments: { prompt: "Reply PLUM" } } },
        { type: "subagent.started", agentId: "f4a61520-b6fd-4f47-b531-484965e0fa6d", data: { toolCallId: "call_1", agentName: "general-purpose" } },
        { type: "user.message", agentId: "f4a61520-b6fd-4f47-b531-484965e0fa6d", data: { content: "Reply PLUM", source: "agent-1fad2886", parentAgentTaskId: "task-child" } },
        { type: "tool.execution_start", agentId: "f4a61520-b6fd-4f47-b531-484965e0fa6d", data: { toolCallId: "call_2", toolName: "bash", arguments: { command: "echo PLUM" } } },
        { type: "assistant.message", agentId: "f4a61520-b6fd-4f47-b531-484965e0fa6d", data: { content: "PLUM", parentToolCallId: "call_1" } },
        { type: "subagent.completed", agentId: "f4a61520-b6fd-4f47-b531-484965e0fa6d", data: { toolCallId: "call_1", totalTokens: 120 } },
        { type: "assistant.message", data: { content: "DONE" } },
        { type: "user.message", timestamp: "2026-11-15T07:05:00.000Z", data: { content: "Also MANGO", parentAgentTaskId: "task-root" } },
        { type: "assistant.message", data: { content: "Noted MANGO." } },
      ]),
    );
    const turns = await copilotTurns(copilot);
    assert.deepEqual(turns, [
      { prompt: "Start one sub-agent that replies PLUM, then reply DONE.", answer: "DONE", tools: "Ran 1 command, used 1 other tool", at: "2026-11-15T07:00:00.000Z" },
      { prompt: "Also MANGO", answer: "Noted MANGO.", at: "2026-11-15T07:05:00.000Z" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex: one exchange per turn of the thread, its final answer, commands and files", () => {
  const turns = codexTurns({
    turns: [
      { startedAt: 1_792_000_000, items: [{ type: "userMessage", content: [{ type: "text", text: "Remember KIWI." }] }, { type: "agentMessage", text: "Noted.", phase: "final_answer" }] },
      {
        items: [
          { type: "userMessage", content: [{ type: "text", text: "Also MANGO" }], startedAtMs: 1_792_000_300_000 },
          { type: "agentMessage", text: "Checking.", phase: "commentary" },
          { type: "commandExecution" },
          { type: "fileChange", changes: [{ path: "/w/a.md" }, { path: "/w/b.md" }] },
          { type: "agentMessage", text: "Noted MANGO.", phase: "final_answer" },
        ],
      },
    ],
  });
  assert.deepEqual(turns, [
    { prompt: "Remember KIWI.", answer: "Noted.", at: new Date(1_792_000_000_000).toISOString() },
    { prompt: "Also MANGO", answer: "Noted MANGO.", tools: "Edited 2 files, ran 1 command", files: ["/w/a.md", "/w/b.md"], at: new Date(1_792_000_300_000).toISOString() },
  ]);
  assert.equal(outsideOf("Codex", turns, 2), null);
  assert.deepEqual(codexTurns(null), []);
});

test("ACP: a replay's user chunks start an exchange, the agent's chunks after them are its answer", () => {
  const user = (text: string) => ({ sessionId: "s", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } });
  const agent = (text: string) => ({ sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  const turns = acpTurns([
    user("Remember "),
    { sessionId: "s", update: { sessionUpdate: "available_commands_update" } },
    user("KIWI."),
    agent("Noted"),
    agent("."),
    user("Also MANGO"),
    { sessionId: "s", update: { sessionUpdate: "tool_call", kind: "edit", locations: [{ path: "/w/a.md" }] } },
    { sessionId: "s", update: { sessionUpdate: "tool_call_update", status: "completed" } },
    { sessionId: "s", update: { sessionUpdate: "tool_call", kind: "execute" } },
    agent("Noted MANGO."),
  ]);
  assert.deepEqual(turns, [
    { prompt: "Remember KIWI.", answer: "Noted." },
    { prompt: "Also MANGO", answer: "Noted MANGO.", tools: "Edited 1 file, ran 1 command", files: ["/w/a.md"] },
  ]);
});

test("at most the newest 20 exchanges or 20,000 characters come in; the rest are counted", () => {
  const many = Array.from({ length: 25 }, (_, index) => ({ prompt: `Prompt ${index}`, answer: `Answer ${index}` }));
  const kept = newestAfter(many, 2);
  assert.equal(kept.turns.length, MAX_OUTSIDE_TURNS);
  assert.equal(kept.turns.at(-1)?.prompt, "Prompt 24");
  assert.equal(kept.earlier, 3);
  const long = Array.from({ length: 8 }, (_, index) => ({ prompt: `${index}`.repeat(3_000), answer: "x".repeat(3_000) }));
  const fit = newestAfter(long, 0);
  assert.ok(fit.turns.length < 8 && fit.turns.length >= 1);
  assert.equal(fit.earlier + fit.turns.length, 8);
  assert.equal(newestAfter([{ prompt: "y".repeat(9_000), answer: "" }], 0).turns[0]!.prompt.length, 4_000, "one long message is cut");
  assert.equal(toolLine({ files: new Set(), commands: 0, other: 0 }), undefined);
  assert.equal(toolLine({ files: new Set(), commands: 0, other: 2 }), "Used 2 tools");
});
