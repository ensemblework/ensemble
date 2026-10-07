import assert from "node:assert/strict";
import test from "node:test";
import { applyNotice, applyRepliesToCache } from "./assistant-apply.js";

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

test("a partly applied batch says what landed and what did not", () => {
  assert.deepEqual(applyNotice({ summary: "Created “Launch”." }), { text: "Created “Launch”.", tone: "ok" });
  assert.deepEqual(applyNotice({ summary: "" }), { text: "Applied.", tone: "ok" });
  assert.deepEqual(
    applyNotice({
      summary: "Created “Launch”.",
      partial: true,
      failed: [
        { callId: "c2", name: "docs_create", error: "Google Docs refused the request (HTTP 500): Backend error.", attempted: true },
        { callId: "c3", name: "sheets_create", error: "Not applied: an earlier change in this batch failed, so this one was not sent.", attempted: false },
      ],
    }),
    {
      text: "Created “Launch”. Not applied: Google Docs refused the request (HTTP 500): Backend error; an earlier change in this batch failed, so this one was not sent.",
      tone: "error",
    },
  );
});
