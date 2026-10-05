import assert from "node:assert/strict";
import test from "node:test";
import { applyRepliesToCache } from "./assistant-apply.js";

test("apply replies replace the cached sentence and tool rows", () => {
  const current = {
    conversation: { id: "conv" },
    messages: [
      {
        id: "m1",
        content: "Create it.\n\nNothing has changed yet — press Apply.",
        toolCalls: [{ id: "c1", state: "awaiting_approval", summary: "Create project “Launch”" }],
      },
    ],
  };
  const next = applyRepliesToCache(current, [
    {
      id: "m1",
      content: "Create it.\n\nApplied. Created “Launch”.",
      toolCalls: [{ id: "c1", state: "ok", summary: "Created “Launch”." }],
    },
  ]);
  assert.equal(next?.messages[0]?.content.includes("Nothing has changed yet"), false);
  assert.equal(next?.messages[0]?.toolCalls[0]?.state, "ok");
  assert.equal(next?.conversation.id, "conv");
});
