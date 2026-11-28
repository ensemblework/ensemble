import assert from "node:assert/strict";
import test from "node:test";
import type { PageNode } from "./domain.js";
import { latexToMarkdown, looksLikeLatex } from "./page-latex.js";
import { markdownPlainText, markdownToNodes, mathTextNodes, textToPageNodes } from "./page-markdown.js";
import { notesDocument } from "./page-notes.js";

const EQUATION = String.raw`$$ x_0 \in \mathbb{R}^{d}, \qquad d=H\times W\times 3. $$`;
const TEX = String.raw`x_0 \in \mathbb{R}^{d}, \qquad d=H\times W\times 3.`;
const types = (nodes: PageNode[] | null) => (nodes ?? []).map((node) => node.type);
const maths = (nodes: PageNode[]): PageNode[] => nodes.flatMap((node) => (node.type === "inlineMath" || node.type === "blockMath" ? [node] : maths(node.content ?? [])));

test("pasted plain text with the issue's equation becomes an equation, alone or inside a paragraph", () => {
  assert.deepEqual(textToPageNodes(EQUATION), [{ type: "blockMath", attrs: { latex: TEX } }]);
  assert.deepEqual(textToPageNodes(`A colour image is a vector:\n${EQUATION}\nFor example, a $32\\times32$ image.`), [
    { type: "paragraph", content: [{ type: "text", text: "A colour image is a vector:" }] },
    { type: "blockMath", attrs: { latex: TEX } },
    { type: "paragraph", content: [{ type: "text", text: "For example, a " }, { type: "inlineMath", attrs: { latex: "32\\times32" } }, { type: "text", text: " image." }] },
  ]);
  assert.deepEqual(maths(textToPageNodes(`It is a vector ${EQUATION} for example.`)!), [{ type: "inlineMath", attrs: { latex: TEX, display: true } }]);
  assert.deepEqual(maths(textToPageNodes("the first coordinate $x_0$ of the vector")!), [{ type: "inlineMath", attrs: { latex: "x_0" } }]);
  assert.deepEqual(textToPageNodes("\\[\na^2 + b^2 = c^2\n\\]"), [{ type: "blockMath", attrs: { latex: "a^2 + b^2 = c^2" } }]);
});

test("prices, shell variables and $$ in shell text stay plain text", () => {
  for (const text of ["It costs $5 and $10.", "export PATH=$PATH:$HOME/bin", "echo $$ and kill $$", "cp $SRC/$DST", "Total $1,000 or $2,000"]) {
    assert.equal(textToPageNodes(text), null, text);
    assert.equal(mathTextNodes(text), null, text);
  }
});

test("the plain-text math pass reads only math: other Markdown characters stay as typed", () => {
  assert.deepEqual(mathTextNodes("**not bold** and $x$\n\n# not a heading"), [
    { type: "paragraph", content: [{ type: "text", text: "**not bold** and " }, { type: "inlineMath", attrs: { latex: "x" } }] },
    { type: "paragraph", content: [{ type: "text", text: "# not a heading" }] },
  ]);
});

test("a project page stored as Markdown opens as headings and lists, plain notes one paragraph per line", () => {
  const project = notesDocument("## What it is\nA recap tool for teams.\n\n## Repositories\n- ensemble\n- docs");
  assert.deepEqual(types(project.content), ["heading", "paragraph", "heading", "bulletList"]);
  assert.equal(project.content[0]!.content![0]!.text, "What it is");
  assert.deepEqual(notesDocument("Call Mira\nAsk about the budget\n\nThen book"), {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Call Mira" }] },
      { type: "paragraph", content: [{ type: "text", text: "Ask about the budget" }] },
      { type: "paragraph" },
      { type: "paragraph", content: [{ type: "text", text: "Then book" }] },
    ],
  });
  assert.deepEqual(notesDocument(""), { type: "doc", content: [{ type: "paragraph" }] });
  assert.deepEqual(types(notesDocument(`Steps\n${EQUATION}`).content), ["paragraph", "blockMath"]);
  assert.deepEqual(types(notesDocument("- [ ] Book the room\n- [x] Send the invite").content), ["taskList"]);
});

const LATEX = String.raw`\documentclass{article}
\usepackage{amsmath}
\title{Image vectors}
\begin{document}
\maketitle
% Drafted for the reading group
\section{Introduction}
A colour image with \textbf{height} $H$ and \emph{width} $W$ is a vector \\
in $\mathbb{R}^d$; see \textit{Section 2}.
\begin{equation}
x_0 \in \mathbb{R}^{d} \label{eq:x}
\end{equation}
\subsection{Steps}
\begin{itemize}
  \item Flatten the \underline{image}
  \item Normalise
  \begin{enumerate}
    \item Subtract the mean
  \end{enumerate}
\end{itemize}
\subsubsection*{Identity}
\begin{align}
a &= b \\
c &= d
\end{align}
\[ e^{i\pi} + 1 = 0 \]
\paragraph{Note} The \foo{bar} command stays. It costs \$5, 50\% off.
\end{document}`;

test("a short LaTeX document becomes headings, marks, lists and equations; unknown commands stay as text", () => {
  assert.equal(looksLikeLatex(LATEX), true);
  const nodes = textToPageNodes(LATEX)!;
  assert.deepEqual(types(nodes), ["heading", "heading", "paragraph", "blockMath", "heading", "bulletList", "heading", "blockMath", "blockMath", "heading", "paragraph"]);
  assert.deepEqual(nodes.filter((node) => node.type === "heading").map((node) => [node.attrs?.level, node.content![0]!.text]), [[1, "Image vectors"], [1, "Introduction"], [2, "Steps"], [3, "Identity"], [3, "Note"]]);
  const intro = nodes[2]!.content!;
  assert.deepEqual(intro.filter((node) => node.marks).map((node) => [node.text, node.marks![0]!.type]), [["height", "bold"], ["width", "italic"], ["Section 2", "italic"]]);
  assert.ok(intro.some((node) => node.type === "hardBreak"), "\\\\ breaks the line");
  assert.deepEqual(maths(nodes).map((node) => node.attrs?.latex), ["H", "W", "\\mathbb{R}^d", "x_0 \\in \\mathbb{R}^{d}", "\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}", "e^{i\\pi} + 1 = 0"]);
  const list = nodes[5]!;
  assert.deepEqual(list.content![0]!.content![0]!.content, [{ type: "text", text: "Flatten the " }, { type: "text", text: "image", marks: [{ type: "underline" }] }]);
  assert.equal(list.content![1]!.content![1]!.type, "orderedList");
  assert.deepEqual(nodes.at(-1)!.content, [{ type: "text", text: "The \\foo{bar} command stays. It costs $5, 50% off." }]);
  assert.doesNotMatch(JSON.stringify(nodes), /documentclass|usepackage|Drafted|label/);
});

test("only text that is clearly LaTeX is converted", () => {
  for (const text of ["Use \\section{} to start a section.", "Prices: $5 and $10", "```latex\n\\begin{itemize}\n```", "A \\textbf{bold} word alone"]) assert.equal(looksLikeLatex(text), false, text);
  assert.equal(looksLikeLatex("\\section{Results}\nWe found it."), true);
  assert.equal(latexToMarkdown("\\section{Results}\nWe found it."), "# Results\n\nWe found it.");
});

test("hostile LaTeX and long pastes convert in well under a second", () => {
  const cases = {
    "unclosed equations": `\\section{a}\n${"\\begin{equation}\nx\n".repeat(30_000)}`,
    "unclosed brackets": `\\section{a}\n${"\\[ x\n".repeat(50_000)}`,
    "unclosed bold": `\\section{a}\n${"\\textbf{a ".repeat(30_000)}`,
    "deep lists": `\\section{a}\n${"\\begin{itemize}\n\\item a\n".repeat(20_000)}`,
    "plain math lines": "a $x$ b\n".repeat(25_000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const start = performance.now();
    textToPageNodes(text);
    notesDocument(text);
    const took = performance.now() - start;
    assert.ok(took < 1000, `${name}: ${Math.round(took)} ms`);
  }
});

test("previews show Markdown as one line of plain text", () => {
  assert.equal(markdownPlainText("## What it is\nA **recap** tool for `teams`.\n\n## Repositories\n- [ensemble](https://github.com/x/ensemble)\n- docs"), "What it is A recap tool for teams. Repositories ensemble docs");
  assert.equal(markdownPlainText("snake_case and 2 * 3 * 4 stay"), "snake_case and 2 * 3 * 4 stay");
  assert.equal(markdownPlainText("> quoted\n---\n1. first"), "quoted first");
});

test("<u> is underline in page Markdown", () => {
  assert.deepEqual(markdownToNodes("an <u>underlined</u> word")[0]!.content, [{ type: "text", text: "an " }, { type: "text", text: "underlined", marks: [{ type: "underline" }] }, { type: "text", text: " word" }]);
});

test("LaTeX comments do not split a paragraph, and quote becomes a quote", () => {
  const nodes = textToPageNodes("\\section{A}\nOne line\n% a note\nsame paragraph.\n\\begin{quote}\nQuoted words.\n\\end{quote}")!;
  assert.deepEqual(types(nodes), ["heading", "paragraph", "blockquote"]);
  assert.equal(nodes[1]!.content![0]!.text, "One line same paragraph.");
});

test("LaTeX is detected only from the first line, never inside Markdown or a fence, and keeps what people wrote", () => {
  const readme = "# Intro\nHello\n\n```latex\n\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n```";
  assert.equal(looksLikeLatex(readme), false);
  assert.deepEqual(types(textToPageNodes(readme)), ["heading", "paragraph", "codeBlock"]);
  assert.match(JSON.stringify(textToPageNodes(readme)), /documentclass/, "the fenced example is kept");
  assert.equal(looksLikeLatex("Notes for Friday\n\\section{Results}"), false, "the marker must open the text");
  assert.equal(looksLikeLatex("% draft\n\n\\section{Results}\nText"), true, "comment lines before it are fine");
  assert.equal(looksLikeLatex("\\section{Results}\nSee below.\n\n```\ncode\n```"), false, "a Markdown fence means Markdown");
  assert.deepEqual(textToPageNodes("\\section{Results}\nRevenue grew 20% this quarter."), [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Results" }] },
    { type: "paragraph", content: [{ type: "text", text: "Revenue grew 20% this quarter." }] },
  ]);
});

test("% starts a comment only at a line start or after a space in a real document; \\% is a percent sign", () => {
  const doc = "\\documentclass{article}\n\\begin{document}\nText here % a comment\n50% stays and \\% too\n\\end{document}";
  assert.deepEqual(textToPageNodes(doc), [{ type: "paragraph", content: [{ type: "text", text: "Text here 50% stays and % too" }] }]);
  assert.deepEqual(textToPageNodes("\\section{A}\nKeep 30 % of it"), [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "A" }] },
    { type: "paragraph", content: [{ type: "text", text: "Keep 30 % of it" }] },
  ], "without \\documentclass a % after a space is kept");
});

test("a preamble is dropped only when it is all commands and comments", () => {
  const plain = "\\documentclass{article}\n\\usepackage{amsmath} % maths\n\\title{T}\n\\begin{document}\nBody\n\\end{document}";
  assert.deepEqual(textToPageNodes(plain), [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "T" }] }, { type: "paragraph", content: [{ type: "text", text: "Body" }] }]);
  const mixed = "\\documentclass{article}\nA sentence someone wrote here.\n\\begin{document}\nBody\n\\end{document}";
  assert.match(JSON.stringify(textToPageNodes(mixed)), /A sentence someone wrote here\..*Body/);
  assert.match(JSON.stringify(textToPageNodes("\\section{A}\nBody\n\\end{document}\nAfter the end.")), /After the end\./);
});

test("notes opened as a page never convert LaTeX", () => {
  const notes = "\\section{Results}\nRevenue grew 20% this quarter.";
  assert.deepEqual(notesDocument(notes), {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "\\section{Results}" }] }, { type: "paragraph", content: [{ type: "text", text: "Revenue grew 20% this quarter." }] }],
  });
});

test("markdownPlainText stays linear on very long lines", () => {
  for (const line of [`${" ".repeat(40_000)}-x`, `${" ".repeat(20_000)}|${" ".repeat(20_000)}x`, "| ".repeat(20_000), "-".repeat(40_000), `|${" -".repeat(20_000)}`, "**a ".repeat(10_000), `${"a ".repeat(20_000)}`.replace(/^/, "- ")]) {
    const start = performance.now();
    markdownPlainText(line);
    const took = performance.now() - start;
    assert.ok(took < 100, `${JSON.stringify(line.slice(0, 12))}…: ${Math.round(took)} ms`);
  }
});
