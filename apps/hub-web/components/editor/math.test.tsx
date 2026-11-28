/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { drawMath, loadKatex } from "@/lib/math";
import { editorExtensions } from "./extensions";
import { applyBlock } from "./editor-commands";
import { markdownFragment, plainTextOf } from "./clipboard";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

type Json = Record<string, unknown>;
const p = (text = ""): Json => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" });
const make = (editable: boolean, ...content: Json[]) => {
  const editor = new Editor({ editable, extensions: editorExtensions(() => [], ""), content: { type: "doc", content: content.length ? content : [p()] } });
  document.body.appendChild(editor.view.dom);
  return editor;
};
const done = (editor: Editor) => {
  editor.view.dom.remove();
  editor.destroy();
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Types text one character at a time, as the input rules see it. */
function type(editor: Editor, text: string) {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handle) => handle(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
  }
}
const json = (editor: Editor) => JSON.parse(JSON.stringify(editor.getJSON().content)) as Json[];
const field = (editor: Editor) => editor.view.dom.querySelector<HTMLTextAreaElement>(".page-math-source");
const key = (target: HTMLElement, name: string, shiftKey = false) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true }));
function typeTex(target: HTMLTextAreaElement, value: string) {
  target.value = value;
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

const ISSUE_EXAMPLE = String.raw`A colour image with height $H$, width $W$ and three channels can be represented as a vector:

$$ x_0 \in \mathbb{R}^{d}, \qquad d=H\times W\times 3. $$

For example, a $32\times32$ colour image has $3072$ coordinates.`;

test("KaTeX draws valid TeX, and invalid TeX shows its source quietly instead of failing", async () => {
  await loadKatex();
  const target = document.createElement("span");
  drawMath(target, String.raw`\frac{a}{b}`, false);
  assert.equal(target.dataset.math, "ok");
  assert.ok(target.querySelector(".katex"));
  drawMath(target, String.raw`\frac{a}{`, true);
  assert.equal(target.dataset.math, "error");
  assert.equal(target.textContent, String.raw`$$\frac{a}{$$`);
  assert.match(target.title, /^Not valid TeX: /);
  drawMath(target, String.raw`\href{https://example.com}{x}`, false);
  assert.equal(target.querySelector("a"), null, "no links from TeX");
  drawMath(target, "  ", false);
  assert.equal(target.dataset.math, "empty");
});

test("pasted Markdown with equations becomes math nodes that draw, and copies back as their source", async () => {
  await loadKatex();
  const editor = make(true);
  const fragment = markdownFragment(editor.schema, ISSUE_EXAMPLE);
  assert.ok(fragment);
  editor.commands.setContent({ type: "doc", content: fragment!.toJSON() });
  assert.deepEqual(json(editor).map((node) => node.type), ["paragraph", "blockMath", "paragraph"]);
  assert.equal(editor.view.dom.querySelectorAll(".page-math-inline .katex").length, 4);
  assert.ok(editor.view.dom.querySelector(".page-math-block .katex-display"));
  const all = editor.state.doc.slice(0, editor.state.doc.content.size);
  assert.equal(plainTextOf(all), ISSUE_EXAMPLE.replace("$$ x_0", () => "$$\nx_0").replace("3. $$", () => "3.\n$$"));
  done(editor);
});

test("typing $x$ makes an equation, $$x$$ alone on a line a display one, and prices stay text", () => {
  const editor = make(true);
  type(editor, "costs $5 and $10, area $\\pi r^2$ ok");
  const line = json(editor)[0]!.content as Json[];
  assert.deepEqual(line.map((node) => node.type), ["text", "inlineMath", "text"]);
  assert.equal(line[0]!.text, "costs $5 and $10, area ");
  assert.deepEqual(line[1]!.attrs, { latex: "\\pi r^2", display: false });
  editor.commands.setContent({ type: "doc", content: [p()] });
  type(editor, "$$E=mc^2$$");
  assert.deepEqual(json(editor)[0], { type: "blockMath", attrs: { latex: "E=mc^2" } });
  editor.commands.setContent({ type: "doc", content: [p()] });
  type(editor, "so $$a+b$$");
  assert.deepEqual((json(editor)[0]!.content as Json[])[1], { type: "inlineMath", attrs: { latex: "a+b", display: true } });
  done(editor);
});

test("click an equation to edit its TeX: it redraws as you type, Enter saves, Escape puts it back, empty removes it", async () => {
  await loadKatex();
  const editor = make(true, { type: "paragraph", content: [{ type: "text", text: "Area " }, { type: "inlineMath", attrs: { latex: "x" } }] });
  const equation = editor.view.dom.querySelector<HTMLElement>(".page-math-inline")!;
  equation.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const source = field(editor)!;
  assert.ok(source, "the TeX opens");
  assert.equal(source.value, "x");
  typeTex(source, "\\frac{1}{");
  assert.equal(equation.querySelector(".page-math-shown")!.getAttribute("data-math"), "error", "invalid TeX while typing is shown, not thrown");
  typeTex(source, "\\frac{1}{2}");
  key(source, "Enter");
  assert.equal(field(editor), null);
  assert.deepEqual((json(editor)[0]!.content as Json[])[1]!.attrs, { latex: "\\frac{1}{2}", display: false });

  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 6)));
  editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, new KeyboardEvent("keydown", { key: "Enter", cancelable: true })));
  typeTex(field(editor)!, "y");
  key(field(editor)!, "Escape");
  assert.deepEqual((json(editor)[0]!.content as Json[])[1]!.attrs, { latex: "\\frac{1}{2}", display: false }, "Escape keeps the saved TeX");

  editor.view.dom.querySelector<HTMLElement>(".page-math-inline")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  typeTex(field(editor)!, "  ");
  key(field(editor)!, "Enter");
  assert.deepEqual(json(editor)[0], p("Area "));
  done(editor);
});

test("/equation and $$ then a space start an equation with its TeX open; a read-only page never opens one", async () => {
  const editor = make(true, p("/equation"));
  applyBlock(editor, { from: 1, to: 10 }, "equation");
  await tick();
  assert.equal(json(editor)[0]!.type, "blockMath");
  assert.ok(field(editor), "the new equation's TeX is open");
  typeTex(field(editor)!, "a^2 + b^2 = c^2");
  key(field(editor)!, "Enter");
  assert.deepEqual(json(editor)[0], { type: "blockMath", attrs: { latex: "a^2 + b^2 = c^2" } });

  editor.commands.setContent({ type: "doc", content: [p()] });
  type(editor, "$$ ");
  await tick();
  assert.equal(json(editor)[0]!.type, "blockMath");
  key(field(editor)!, "Escape");
  assert.equal(json(editor).some((node) => node.type === "blockMath"), false, "an equation left empty is removed");
  done(editor);

  const reader = make(false, { type: "blockMath", attrs: { latex: "x" } });
  reader.view.dom.querySelector<HTMLElement>(".page-math-block")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(field(reader), null);
  done(reader);
});
