import assert from "node:assert/strict";
import test from "node:test";

process.env.REDIS_URL = "memory:";

test("a Code thread's finished turn does not notify while the person is on the Code tab, and otherwise opens the thread", async () => {
  const { markCodePresent, onCodeTab } = await import("../lib/code-watch.js");
  const { noticeCodeTurn } = await import("./review-notice.js");
  const made: Array<{ title: string; url: string }> = [];
  const db = { notification: { create: async ({ data }: { data: { title: string; url: string } }) => void made.push(data) } };
  const turn = { userId: "user-mira", taskId: "5f1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f", title: "Fix login redirect bug", summary: "Done.", failed: "The build failed." };

  await markCodePresent("user-mira", true);
  assert.equal(await onCodeTab("user-mira"), true);
  await noticeCodeTurn(db as never, turn);
  await noticeCodeTurn(db as never, { ...turn, failed: null });
  assert.equal(made.length, 0, "the thread list shows it instead");

  await markCodePresent("user-mira", false);
  await noticeCodeTurn(db as never, turn);
  assert.equal(made.length, 1);
  assert.equal(made[0]!.title, "Agent needs you: Fix login redirect bug");
  assert.equal(made[0]!.url, "/code?view=agent&thread=5f1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f", "it opens the thread, not its hidden task");
});
