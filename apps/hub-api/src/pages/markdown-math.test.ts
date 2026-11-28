/**
 * Equations in pages on the server: page Markdown for agents writes them back as `$…$` and
 * `$$…$$` (the same nodes read back), the collaborative schema holds them, and search text and
 * agent-block fingerprints include their TeX.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PageDocument } from "@ensemble/shared-types";

// The page modules load the API config; nothing here connects to a database.
process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
const { fingerprint, markdownToNodes, pageMarkdown, pageSearchText } = await import("./markdown.js");
const { pageDoc, pageSchema } = await import("./schema.js");

const SOURCE = String.raw`A colour image with height $H$, width $W$ and three channels can be represented as a vector:

$$
x_0 \in \mathbb{R}^{d}, \qquad d=H\times W\times 3.
$$

For example, a $32\times32$ colour image has $3072$ coordinates. It costs $5 and $10.`;

test("a page's equations read back as the Markdown they came from", () => {
  const doc: PageDocument = { type: "doc", content: markdownToNodes(SOURCE) };
  assert.equal(pageMarkdown(doc, ""), SOURCE);
  assert.deepEqual(markdownToNodes(pageMarkdown(doc, "")), doc.content);
  const nested: PageDocument = { type: "doc", content: markdownToNodes("- First\n  $$\n  a = b\n  $$\n- Second $$c$$") };
  assert.deepEqual(markdownToNodes(pageMarkdown(nested, "")), nested.content);
});

test("text that only looks like an equation stays text through a rewrite", () => {
  const shell: PageDocument = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Use $HOME/$USER here" }] }] };
  assert.equal(pageMarkdown(shell, ""), "Use $HOME/$USER here", "shell variables need no escape");
  const doc: PageDocument = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Type $x$ here" }] }] };
  assert.equal(pageMarkdown(doc, ""), String.raw`Type \$x$ here`);
  assert.deepEqual(markdownToNodes(pageMarkdown(doc, "")), doc.content);
});

test("the server's page schema holds equations, and search and fingerprints see their TeX", () => {
  const doc: PageDocument = { type: "doc", content: markdownToNodes(SOURCE) };
  pageSchema.nodeFromJSON(doc).check();
  assert.deepEqual(pageDoc(doc).toJSON(), pageSchema.nodeFromJSON(doc).toJSON(), "no node dropped as unknown");
  assert.deepEqual(pageDoc(doc).toJSON().content.map((node: { type: string }) => node.type), ["paragraph", "blockMath", "paragraph"]);
  assert.match(pageSearchText("Vectors", doc, ""), /\\mathbb\{R\}\^\{d\}/);
  const other = markdownToNodes(SOURCE.replace("$H$", "$K$"));
  assert.notEqual(fingerprint(doc.content), fingerprint(other));
});

test("read and replace keeps text that looks like math, escaped prices and backslashes, however often", () => {
  const para = (...content: PageDocument["content"]): PageDocument["content"][number] => ({ type: "paragraph", content });
  const doc: PageDocument = {
    type: "doc",
    content: [
      para({ type: "text", text: String.raw`Literal \(a\) and $x$ typed as text` }),
      para({ type: "text", text: "$$ a $$" }),
      para({ type: "text", text: String.raw`\[1\]` }),
      para({ type: "text", text: String.raw`C:\$Recycle.Bin and costs \$5 typed with a backslash` }),
      para({ type: "text", text: "Total: $5", marks: [{ type: "bold" }] }, { type: "text", text: " and " }, { type: "text", text: "$y$ as text", marks: [{ type: "italic" }] }),
      para({ type: "text", text: "The value ", marks: [{ type: "bold" }] }, { type: "inlineMath", attrs: { latex: "x" } }),
      { type: "blockMath", attrs: { latex: "a = b\nc = d" } },
    ],
  };
  const once = pageMarkdown(doc, "");
  assert.deepEqual(markdownToNodes(once), doc.content, once);
  const twice = pageMarkdown({ type: "doc", content: markdownToNodes(once) }, "");
  assert.equal(twice, once, "a second read-and-replace changes nothing");
  assert.deepEqual(markdownToNodes(String.raw`**Total: \$5**`), [para({ type: "text", text: "Total: $5", marks: [{ type: "bold" }] })], "an agent's escaped price");
});

test("an equation saved with blank lines in its TeX stays one equation", () => {
  const doc: PageDocument = { type: "doc", content: [{ type: "blockMath", attrs: { latex: "a = b\n\nc = d" } }] };
  assert.deepEqual(markdownToNodes(pageMarkdown(doc, "")), [{ type: "blockMath", attrs: { latex: "a = b\nc = d" } }]);
});

test("a task's Markdown notes open as blocks on its page before it is first written; plain notes keep their lines", async () => {
  const { notesDoc } = await import("./store.js");
  assert.deepEqual(notesDoc("## What it is\nA recap tool.\n\n- one\n- two").content.map((node) => node.type), ["heading", "paragraph", "bulletList"]);
  assert.deepEqual(notesDoc("Call Mira\nThen book").content.map((node) => node.content?.[0]?.text), ["Call Mira", "Then book"]);
  pageSchema.nodeFromJSON(notesDoc("Steps\n$$\nx^2\n$$\nDone, it costs $5.")).check();
});
