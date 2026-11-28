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
  const doc: PageDocument = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Use $HOME/$USER here" }] }] };
  assert.equal(pageMarkdown(doc, ""), String.raw`Use \$HOME/\$USER here`);
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
