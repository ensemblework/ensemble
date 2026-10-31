import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://x";
const { answerCursor, cursorCall } = await import("./cursor.js");

type Ctx = Parameters<typeof answerCursor>[0];
const ctx = (overrides: Record<string, unknown> = {}) => ({ job: { unattended: false }, decisions: [], event: async () => undefined, ...overrides }) as unknown as Ctx;
const OPTIONS = [
  { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
  { optionId: "allow-always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject-once", kind: "reject_once", name: "Reject" },
];

test("Cursor's tool calls are read as the run's own tools", () => {
  assert.deepEqual(cursorCall({ kind: "execute", title: "`npm test -- --grep \\`x\\``" }), { tool: "Bash", input: { command: "npm test -- --grep `x`" } });
  assert.deepEqual(cursorCall({ kind: "edit", title: "Edit `src/a.ts`", content: [{ type: "diff", path: "/w/src/a.ts" }] }), { tool: "Write", input: { file_path: "/w/src/a.ts" } });
  assert.deepEqual(cursorCall({ kind: "edit", title: "Delete `/w/old.txt`" }), { tool: "Write", input: { file_path: "/w/old.txt" } });
  assert.deepEqual(cursorCall({ kind: "edit", title: "Write /w/new.txt" }), { tool: "Write", input: { file_path: "/w/new.txt" } });
  assert.equal(cursorCall({ kind: "other", title: "ensemble: ask_person" }).tool, "mcp__ensemble__ask_person");
  assert.equal(cursorCall({ kind: "other", title: "ensemble: browser_open" }).tool, "mcp__ensemble__browser_open", "the run's browser tools are judged by name, not passed as a question");
  assert.equal(cursorCall({ kind: "other", title: "github: create_issue" }).tool, "mcp__github__create_issue");
});

test("a permission is answered once, never always (that would change the person's own Cursor allowlist)", async () => {
  const judged: string[] = [];
  const judge = (async (_ctx: unknown, call: { tool: string; input: Record<string, unknown> }) => {
    judged.push(String(call.input.command ?? call.input.file_path));
    return String(call.input.command ?? "").includes("sudo") ? { decision: "deny" as const, message: "no" } : { decision: "allow" as const };
  }) as unknown as Parameters<typeof answerCursor>[3];
  assert.deepEqual(await answerCursor(ctx(), "session/request_permission", { toolCall: { kind: "execute", title: "`ls`" }, options: OPTIONS }, judge), { outcome: { outcome: "selected", optionId: "allow-once" } });
  assert.deepEqual(await answerCursor(ctx(), "session/request_permission", { toolCall: { kind: "execute", title: "`sudo rm -rf /`" }, options: OPTIONS }, judge), { outcome: { outcome: "selected", optionId: "reject-once" } });
  assert.deepEqual(judged, ["ls", "sudo rm -rf /"]);
});

test("Cursor's questions: the recommended option unattended, the person's pick or typed answer otherwise", async () => {
  const questions = [{ id: "q1", prompt: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B (Recommended)" }] }];
  const judge = (async () => ({ decision: "allow" })) as unknown as Parameters<typeof answerCursor>[3];
  const unattended = ctx({ job: { unattended: true } });
  assert.deepEqual(await answerCursor(unattended, "cursor/ask_question", { questions }, judge), { outcome: { outcome: "answered", answers: [{ questionId: "q1", selectedOptionIds: ["b"] }] } });
  const picked = (async () => ({ decision: "allow", answer: "A" })) as unknown as Parameters<typeof answerCursor>[4];
  assert.deepEqual(await answerCursor(ctx(), "cursor/ask_question", { questions }, judge, picked), { outcome: { outcome: "answered", answers: [{ questionId: "q1", selectedOptionIds: ["a"] }] } });
  const typed = (async () => ({ decision: "allow", answer: "Neither, use C" })) as unknown as Parameters<typeof answerCursor>[4];
  assert.deepEqual(await answerCursor(ctx(), "cursor/ask_question", { questions }, judge, typed), { outcome: { outcome: "skipped", reason: "The person answered: Neither, use C" } });
  await assert.rejects(answerCursor(ctx(), "cursor/create_plan", {}, judge), (error: Error & { code?: number }) => error.code === -32601);
});
