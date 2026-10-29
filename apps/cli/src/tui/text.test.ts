import assert from "node:assert/strict";
import test from "node:test";
import { cellWidth, lineText, markdown, pad, plain, truncate, wrapLine } from "./text.js";

test("widths count wide characters and emoji as two cells", () => {
  assert.equal(cellWidth("abc"), 3);
  assert.equal(cellWidth("日本"), 4);
  assert.equal(cellWidth("✓"), 1);
  assert.equal(truncate("hello world", 6), "hello…");
  assert.equal(pad("ab", 4), "ab  ");
});

test("lines wrap at spaces, long words break, and indents carry", () => {
  const lines = wrapLine([{ text: "one two three four" }], 9).map(lineText);
  assert.deepEqual(lines, ["one two ", "three ", "four"]);
  assert.deepEqual(wrapLine([{ text: "abcdefghij" }], 5).map(lineText), ["abcde", "fghij"]);
});

test("markdown: headings, bullets, inline code and fenced code", () => {
  const lines = markdown("# Title\n- a **bold** `x`\n```ts\nconst a = 1;\n```", 40);
  assert.equal(lineText(lines[0]!), "Title");
  assert.equal(lines[0]![0]!.bold, true);
  assert.equal(lineText(lines[1]!), "• a bold x");
  assert.ok(lines[1]!.some((segment) => segment.bold && segment.text === "bold"));
  assert.ok(lines[1]!.some((segment) => segment.color === "cyan" && segment.text === "x"));
  assert.match(lineText(lines[2]!), /ts/);
  assert.equal(lineText(lines[3]!), "│ const a = 1;");
});

test("logs lose colour codes a tool printed", () => {
  assert.equal(lineText(plain("\u001B[32mok\u001B[0m done", 40)[0]!), "ok done");
});

test("markdown: record links show their title only; web links keep their address", () => {
  const text = markdown("Added [Ship the brief](ensemble://task/9b238e86-45bf-4e1a-bd26-5303de63da26), see [Board](/board) and [docs](https://example.com/a).", 200).map(lineText).join("\n");
  assert.equal(text, "Added Ship the brief, see Board and docs (https://example.com/a).");
});
