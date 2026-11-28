import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeMarkdown, markdownToNodes } from "./page-markdown.js";
import { escapeMathBlockStarts, escapeMathText, mathBlockAt, mathMarkdown } from "./page-math.js";
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

test("hostile input parses in well under a second (no lookahead or backtracking blow-up)", () => {
  const cases = {
    "unclosed \\[ lines": "\\[a\n".repeat(50_000),
    "unclosed $$ lines": "$$ a\nb\n".repeat(30_000),
    "\\( on one line": "\\(a ".repeat(50_000),
    "\\( with backslashes": "\\(\\a".repeat(50_000),
    "$ on one line": "$a ".repeat(66_000),
    "$$ on one line": "$$a ".repeat(50_000),
    "mixed": "$x \\(y $$z \\[w\n".repeat(13_000),
    "unclosed [ lines": "[a\n".repeat(66_000),
    "escaped dollars": "\\$a".repeat(66_000),
    "escaped \\( runs": "\\\\(a".repeat(40_000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const start = performance.now();
    markdownToNodes(text);
    markdownToNodes(text, { lineBreaks: true });
    looksLikeMarkdown(text);
    escapeMathText(text);
    const took = performance.now() - start;
    assert.ok(took < 1000, `${name}: ${Math.round(took)} ms for ${text.length} characters`);
  }
});

test("shell variables and paths stay text, and inline math alone does not make a paste Markdown", () => {
  for (const text of ["export PATH=$PATH:$HOME/bin", "cp $SRC/$DST", "echo ${A}${B}", "rm $TMP_$ID.log", "mv $a$b"]) {
    assert.deepEqual(maths(markdownToNodes(text)), [], text);
    assert.equal(looksLikeMarkdown(text), false, text);
  }
  assert.equal(looksLikeMarkdown("where $x$ holds"), false);
  assert.equal(looksLikeMarkdown("then\n$$\nx^2\n$$"), true);
  assert.deepEqual(markdownToNodes(String.raw`C:\$Recycle.Bin and foo\$bar`), [{ type: "paragraph", content: [{ type: "text", text: String.raw`C:\$Recycle.Bin and foo\$bar` }] }]);
});

test("escaped prices and equations inside bold, italics, strikethrough and links", () => {
  const line = (markdown: string) => markdownToNodes(markdown)[0]!.content;
  assert.deepEqual(line(String.raw`**Total: \$5**`), [{ type: "text", text: "Total: $5", marks: [{ type: "bold" }] }]);
  assert.deepEqual(line("**the value $x$ here**"), [
    { type: "text", text: "the value ", marks: [{ type: "bold" }] },
    { type: "inlineMath", attrs: { latex: "x" } },
    { type: "text", text: " here", marks: [{ type: "bold" }] },
  ]);
  assert.deepEqual(maths(markdownToNodes("*see $y$* and ~~$z$~~ and [area $\\pi r^2$](https://example.com)")).map((node) => node.attrs?.latex), ["y", "z", "\\pi r^2"]);
});

test("text that would read as math is escaped so it reads back as the same text, however often", () => {
  const roundTrip = (text: string) => {
    const markdown = escapeMathBlockStarts(escapeMathText(text));
    const back = markdownToNodes(markdown);
    assert.deepEqual(back, [{ type: "paragraph", content: [{ type: "text", text }] }], `${text} → ${markdown}`);
    assert.equal(escapeMathBlockStarts(escapeMathText(texts(back))), markdown, `${text} is stable`);
  };
  for (const text of ["$x$", "a $b$ and $c$ end", "($x$)", "ratio:$x$", String.raw`\(a\)`, "$$ a $$", String.raw`\[1\]`, "$$x$$ mid", String.raw`C:\$Recycle.Bin`, String.raw`costs \$5`, String.raw`\$x$`, "It costs $5 and $10", String.raw`a \\$5`]) roundTrip(text);
});

test("an equation with blank lines in its TeX writes without them, so it stays one equation", () => {
  const markdown = mathMarkdown({ type: "blockMath", attrs: { latex: "a = b\n\n\nc = d" } })!;
  assert.deepEqual(markdownToNodes(markdown), [{ type: "blockMath", attrs: { latex: "a = b\nc = d" } }]);
});
