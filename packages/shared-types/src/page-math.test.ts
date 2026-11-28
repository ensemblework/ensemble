import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeMarkdown, markdownToNodes } from "./page-markdown.js";
import { escapeMathText, mathBlockAt, mathMarkdown } from "./page-math.js";
import type { PageNode } from "./domain.js";

const ISSUE_EXAMPLE = String.raw`A colour image with height $H$, width $W$ and three channels can be represented as a vector:

$$ x_0 \in \mathbb{R}^{d}, \qquad d=H\times W\times 3. $$

For example, a $32\times32$ colour image has $3072$ coordinates.`;

const maths = (nodes: PageNode[]): PageNode[] => nodes.flatMap((node) => (node.type === "inlineMath" || node.type === "blockMath" ? [node] : maths(node.content ?? [])));
const texts = (nodes: PageNode[]): string => nodes.map((node) => node.text ?? texts(node.content ?? [])).join("");

test("inline $…$ and display $$…$$ become equations; the text around them stays text", () => {
  const nodes = markdownToNodes(ISSUE_EXAMPLE);
  assert.deepEqual(nodes.map((node) => node.type), ["paragraph", "blockMath", "paragraph"]);
  assert.deepEqual(nodes[1], { type: "blockMath", attrs: { latex: String.raw`x_0 \in \mathbb{R}^{d}, \qquad d=H\times W\times 3.` } });
  assert.deepEqual(maths([nodes[0]!, nodes[2]!]).map((node) => node.attrs?.latex), ["H", "W", String.raw`32\times32`, "3072"]);
  assert.equal(texts([nodes[2]!]), "For example, a  colour image has  coordinates.");
  assert.equal(looksLikeMarkdown(ISSUE_EXAMPLE), true, "pasted, it reads as Markdown");
});

test("prices and shell variables are not equations", () => {
  for (const text of ["It costs $5 and $10.", "between $5 and $10", "$1,000 or $2,000", "$5/$10", "$20 (or $30)", "set $HOME and $PATH", "US$5 and US$6", "a $ sign"]) {
    assert.deepEqual(maths(markdownToNodes(text)), [], text);
    assert.equal(looksLikeMarkdown(text), false, text);
  }
});

test("TeX keeps its stars and underscores, code keeps its dollars, and \\$ is a dollar sign", () => {
  assert.deepEqual(maths(markdownToNodes(String.raw`$a*b*c$ and $x_1 + y_2$`)).map((node) => node.attrs?.latex), ["a*b*c", "x_1 + y_2"]);
  assert.deepEqual(markdownToNodes("Run `echo $x$` now"), [{ type: "paragraph", content: [{ type: "text", text: "Run " }, { type: "text", text: "echo $x$", marks: [{ type: "code" }] }, { type: "text", text: " now" }] }]);
  assert.deepEqual(markdownToNodes(String.raw`Pay \$5 for \$x\$`), [{ type: "paragraph", content: [{ type: "text", text: "Pay $5 for $x$" }] }]);
});

test("display equations over several lines, \\[ \\] and \\( \\), and $$ inside a sentence", () => {
  assert.deepEqual(markdownToNodes("Then\n$$\n\\begin{aligned}\n  a &= b \\\\\n  c &= d\n\\end{aligned}\n$$\nso"), [
    { type: "paragraph", content: [{ type: "text", text: "Then" }] },
    { type: "blockMath", attrs: { latex: "\\begin{aligned}\n  a &= b \\\\\n  c &= d\n\\end{aligned}" } },
    { type: "paragraph", content: [{ type: "text", text: "so" }] },
  ]);
  assert.deepEqual(markdownToNodes("\\[\ne^{i\\pi} + 1 = 0\n\\]"), [{ type: "blockMath", attrs: { latex: "e^{i\\pi} + 1 = 0" } }]);
  assert.deepEqual(maths(markdownToNodes("where \\(\\alpha > 0\\) holds")), [{ type: "inlineMath", attrs: { latex: "\\alpha > 0" } }]);
  assert.deepEqual(maths(markdownToNodes("The loss $$L = \\sum_i l_i$$ falls.")), [{ type: "inlineMath", attrs: { latex: "L = \\sum_i l_i", display: true } }]);
  assert.deepEqual(maths(markdownToNodes("- step $$a+b$$\n  $$\n  c\n  $$")), [{ type: "inlineMath", attrs: { latex: "a+b", display: true } }, { type: "blockMath", attrs: { latex: "c" } }]);
});

test("an unclosed $$ or one with text after its close is not a display equation", () => {
  assert.equal(mathBlockAt(["$$", "x", "", "$$"], 0), null, "TeX has no blank lines");
  assert.equal(mathBlockAt(["$$ x $$ is the loss"], 0), null);
  assert.equal(mathBlockAt(["$$", "x"], 0), null);
  assert.equal(mathBlockAt(["$$ $$"], 0), null);
  assert.deepEqual(maths(markdownToNodes("$$\nx\n\nmore")), []);
});

test("an equation's Markdown reads back as the same node, and text that looks like math is escaped", () => {
  for (const node of [
    { type: "inlineMath", attrs: { latex: "x^2" } },
    { type: "inlineMath", attrs: { latex: "\\frac{a}{b}", display: true } },
  ]) assert.deepEqual(maths(markdownToNodes(`see ${mathMarkdown(node)} here`)), [node]);
  const block = { type: "blockMath", attrs: { latex: "a \\\\\nb" } };
  assert.equal(mathMarkdown(block), "$$\na \\\\\nb\n$$");
  assert.deepEqual(markdownToNodes(mathMarkdown(block)!), [block]);
  assert.equal(mathMarkdown({ type: "paragraph" }), null);
  const literal = "Paths like $HOME/$USER and $x$ typed as text";
  assert.equal(escapeMathText("It costs $5 and $10"), "It costs $5 and $10");
  assert.deepEqual(markdownToNodes(escapeMathText(literal)), [{ type: "paragraph", content: [{ type: "text", text: literal }] }]);
});
