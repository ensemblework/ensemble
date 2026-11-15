import assert from "node:assert/strict";
import test from "node:test";
import { outsideHistoryText, outsideMarkOf, saveOutside } from "./outside.js";

test("exchanges brought in from the agent's app are saved just before the turn's message, in order, marked with where they were said", async () => {
  const before = new Date("2026-11-15T08:00:00.000Z");
  const saved: Array<Record<string, unknown>> = [];
  const prisma = {
    assistantMessage: {
      findUnique: async () => ({ createdAt: before }),
      createMany: async (input: { data: Array<Record<string, unknown>> }) => {
        saved.push(...input.data);
        return { count: input.data.length };
      },
    },
  };
  const count = await saveOutside(prisma as never, {
    userId: "user-1",
    conversationId: "chat-1",
    before: "message-now",
    agent: "claude-code",
    session: "chat-1",
    outside: {
      app: "the Claude app",
      earlier: 3,
      turns: [
        { prompt: "Also remember MANGO", answer: "Noted MANGO.", tools: "Edited 1 file", at: "2026-11-15T07:05:00.000Z" },
        { prompt: "And PEAR", answer: "", at: "not a time" },
      ],
    },
  });
  assert.equal(count, 3, "an exchange without an answer saves only the message");
  assert.deepEqual(
    saved.map((row) => [row.role, row.content, row.outside, (row.createdAt as Date).getTime() - before.getTime()]),
    [
      ["user", "Also remember MANGO", { app: "the Claude app", at: "2026-11-15T07:05:00.000Z", earlier: 3 }, -3],
      ["assistant", "Noted MANGO.\n\n_Edited 1 file._", { app: "the Claude app", at: "2026-11-15T07:05:00.000Z" }, -2],
      ["user", "And PEAR", { app: "the Claude app" }, -1],
    ],
  );
  assert.ok(saved.every((row) => row.conversationId === "chat-1" && row.userId === "user-1"));
  assert.equal(await saveOutside(prisma as never, { userId: "user-1", conversationId: "chat-1", agent: "codex", session: "chat-1", outside: { app: "Codex", earlier: 0, turns: [{ prompt: " ", answer: "" }] } }), 0);
});

test("a message brought in reads as said in the app, in history and when its mark is read back", () => {
  assert.deepEqual(outsideMarkOf({ app: "Codex", at: "2026-11-15T07:05:00.000Z", earlier: 0 }), { app: "Codex", at: "2026-11-15T07:05:00.000Z" });
  assert.equal(outsideMarkOf(null), null);
  assert.equal(outsideMarkOf({ at: "x" }), null);
  assert.equal(outsideHistoryText("user", "And PEAR", { app: "the Claude app" }), "(Said in the Claude app, outside Ensemble) And PEAR");
  assert.equal(outsideHistoryText("assistant", "PEAR too.", { app: "Codex" }), "(Answered in Codex, outside Ensemble) PEAR too.");
});

test("messages brought in do not move the chat's position in its agent session", async () => {
  const { sessionPosition } = await import("./agent.js");
  const rows = [
    { role: "user", outside: null },
    { role: "assistant", outside: null },
    { role: "user", outside: { app: "the Claude app" } },
    { role: "assistant", outside: { app: "the Claude app" } },
  ];
  const prisma = { assistantMessage: { findMany: async () => rows } };
  assert.equal(await sessionPosition(prisma as never, "chat-1"), 2);
});
