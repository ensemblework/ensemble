import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeMarkdown, markdownToNodes } from "./page-markdown.js";

const text = (value: string, ...marks: string[]) => (marks.length ? { type: "text", text: value, marks: marks.map((type) => ({ type })) } : { type: "text", text: value });

test("Markdown becomes headings, lists, checklists, quotes, code, tables and rules", () => {
  const nodes = markdownToNodes([
    "## Plan",
    "",
    "Ship **Friday** with *care* and `code`, ~~not~~ [docs](https://example.com).",
    "",
    "- one",
    "- two",
    "",
    "1. first",
    "2. second",
    "",
    "- [x] done",
    "- [ ] open",
    "",
    "> quoted",
    "",
    "```ts",
    "let x = 1;",
    "```",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "---",
  ].join("\n"));
  assert.deepEqual(nodes.map((node) => node.type), ["heading", "paragraph", "bulletList", "orderedList", "taskList", "blockquote", "codeBlock", "table", "horizontalRule"]);
  assert.equal(nodes[0]!.attrs?.level, 2);
  assert.deepEqual(nodes[1]!.content, [
    text("Ship "),
    text("Friday", "bold"),
    text(" with "),
    text("care", "italic"),
    text(" and "),
    text("code", "code"),
    text(", "),
    text("not", "strike"),
    text(" "),
    { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
    text("."),
  ]);
  assert.deepEqual(nodes[4]!.content!.map((item) => item.attrs?.checked), [true, false]);
  assert.equal(nodes[6]!.attrs?.language, "ts");
  assert.equal(nodes[7]!.content![0]!.content![0]!.type, "tableHeader");
});

test("underscores inside words stay text", () => {
  assert.deepEqual(markdownToNodes("call my_var_name and __init__ or _this_")[0]!.content, [
    text("call my_var_name and "),
    text("init", "bold"),
    text(" or "),
    text("this", "italic"),
  ]);
});

test("plain prose and a lone link do not read as Markdown; Markdown structure does", () => {
  for (const plain of ["Hello there", "Meet at 3 * 4 pm", "https://example.com/a_b_c", "snake_case_name", "Line one\nLine two"]) {
    assert.equal(looksLikeMarkdown(plain), false, plain);
  }
  for (const markdown of ["# Title", "- item", "1. step", "- [ ] todo", "> quote", "```\ncode\n```", "| a | b |\n| - | - |", "---", "a **bold** word", "use `npm`", "see [docs](https://example.com)", "an *aside* here"]) {
    assert.equal(looksLikeMarkdown(markdown), true, markdown);
  }
});

test("tables without pipes at the ends are tables too, even right after a paragraph", () => {
  const nodes = markdownToNodes(["Papers to read:", "Name | Status", "--- | :-:", "Survey **one** | Promising", "a \\| b |", "", "after"].join("\n"));
  assert.deepEqual(nodes.map((node) => node.type), ["paragraph", "table", "paragraph"]);
  const rows = nodes[1]!.content!;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0]!.content!.map((cell) => cell.type), ["tableHeader", "tableHeader"]);
  assert.deepEqual(rows[1]!.content![0]!.content![0]!.content, [text("Survey "), text("one", "bold")]);
  assert.deepEqual(rows[2]!.content!.map((cell) => cell.content![0]!.content?.[0]?.text), ["a | b", undefined]);
});

test("a <br> in a table cell is a line break", () => {
  const cell = markdownToNodes("| A |\n| --- |\n| one<br>two |")[0]!.content![1]!.content![0]!;
  assert.deepEqual(cell.content![0]!.content, [text("one"), { type: "hardBreak" }, text("two")]);
});

test("a pipe in prose is not a table without the rule under it", () => {
  assert.deepEqual(markdownToNodes("this | that\nnext line").map((node) => node.type), ["paragraph"]);
  assert.equal(looksLikeMarkdown("this | that"), false);
  assert.equal(looksLikeMarkdown("Name | Status\n--- | ---\nA | done"), true);
});
