import assert from "node:assert/strict";
import test from "node:test";
import { blocksFromMarkdown, blocksFromPage, toHtml, toMarkdown, toText } from "./document";

const page = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Ship " },
        { type: "text", text: "Friday", marks: [{ type: "bold" }] },
        { type: "text", text: " with " },
        { type: "mention", attrs: { kind: "person", id: "p1", label: "Ben" } },
      ],
    },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }] }] },
    { type: "codeBlock", content: [{ type: "text", text: "let x = 1" }] },
    { type: "agentBlock", attrs: { id: "x" } },
  ],
};

test("a page becomes Markdown with marks, mentions, lists and to-dos", () => {
  const markdown = toMarkdown({ title: "Launch", meta: [["Status", "Doing"]], blocks: blocksFromPage(page) });
  assert.match(markdown, /^# Launch\n/);
  assert.match(markdown, /- \*\*Status:\*\* Doing/);
  assert.match(markdown, /## Plan/);
  assert.match(markdown, /Ship \*\*Friday\*\* with @Ben/);
  assert.match(markdown, /^- one$/m);
  assert.match(markdown, /^- \[x\] done$/m);
  assert.match(markdown, /```\nlet x = 1\n```/);
});

test("HTML escapes text and plain text drops the Markdown", () => {
  const doc = { title: "<b>x</b>", blocks: blocksFromMarkdown("a **b** `c`") };
  assert.ok(toHtml(doc).includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(toHtml(doc).includes("<strong>b</strong>"));
  assert.equal(toText(doc).trim(), "<b>x</b>\n\na b c");
});

test("Markdown notes keep headings, numbered lists and checkboxes", () => {
  const blocks = blocksFromMarkdown("## Agenda\n1. intro\n2. demo\n- [ ] follow up\n\ntext");
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["heading", "list", "todo", "paragraph"],
  );
});
