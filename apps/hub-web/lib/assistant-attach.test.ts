import assert from "node:assert/strict";
import test from "node:test";
import { attachmentContext, quoteAttachments, splitQuoted } from "./assistant-attach.js";

test("a handed part goes quoted with its page, and comes back as a card with the rest of the message", () => {
  const list = [
    { text: "Ship the beta\nby Friday", source: { kind: "page" as const, id: "p-1", title: "Launch plan" } },
    { text: "", source: { kind: "task" as const, id: "t-1", title: "Write release notes" } },
  ];
  const message = `${quoteAttachments(list)}\n\nIs this realistic?`;
  assert.equal(message, "> Ship the beta\n> by Friday\nFrom “Launch plan”\n\n[Attached: “Write release notes”]\n\nIs this realistic?");
  assert.deepEqual(splitQuoted(message), {
    parts: [
      { text: "Ship the beta\nby Friday", from: "Launch plan", whole: false },
      { text: "", from: "Write release notes", whole: true },
    ],
    rest: "Is this realistic?",
  });
  const context = attachmentContext(list);
  assert.match(context, /page id p-1/);
  assert.match(context, /All of the task “Write release notes” \(task id t-1\)/);
  assert.doesNotMatch(message, /p-1|t-1/, "ids stay out of what the person sees");
  assert.deepEqual(splitQuoted("> not an attachment"), { parts: [], rest: "> not an attachment" });
  assert.deepEqual(splitQuoted("> Ship it\n— from “Plan”\n\nOk?"), { parts: [{ text: "Ship it", from: "Plan", whole: false }], rest: "Ok?" }, "messages sent with the old dash still show as cards");
});
