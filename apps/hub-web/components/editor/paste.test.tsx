/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "./extensions";
import { plainTextHtml } from "./clipboard";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });
setGlobal("DOMParser", window.DOMParser);
setGlobal("ClipboardEvent", window.Event);

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

type Json = Record<string, unknown>;
const p = (text = ""): Json => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" });
const make = (...content: Json[]) => {
  const editor = new Editor({ extensions: editorExtensions(() => [], ""), content: { type: "doc", content: content.length ? content : [p()] } });
  document.body.appendChild(editor.view.dom);
  return editor;
};
const done = (editor: Editor) => {
  editor.view.dom.remove();
  editor.destroy();
};
const json = (editor: Editor) => JSON.parse(JSON.stringify(editor.getJSON().content)) as Json[];
const types = (editor: Editor) => json(editor).map((node) => node.type);
function paste(editor: Editor, data: Record<string, string>) {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => data[type] ?? "", types: Object.keys(data), files: [] } });
  editor.view.dom.dispatchEvent(event);
}
function type(editor: Editor, text: string) {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handle) => handle(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
  }
}

const EQUATION = String.raw`$$ x_0 \in \mathbb{R}^{d}, \qquad d=H\times W\times 3. $$`;
const TEX = String.raw`x_0 \in \mathbb{R}^{d}, \qquad d=H\times W\times 3.`;
/** How VS Code puts copied text on the clipboard: the text in styled boxes. */
const editorHtml = (text: string) => `<meta charset="utf-8"><div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Menlo;">${text.split("\n").map((line) => `<div><span style="color: #d4d4d4;">${line.replace(/&/g, "&amp;").replace(/</g, "&lt;") || "<br>"}</span></div>`).join("")}</div>`;

test("pasting the issue's equation as plain text makes an equation at once", () => {
  const editor = make();
  editor.commands.focus("end");
  paste(editor, { "text/plain": EQUATION });
  assert.ok(json(editor).some((node) => node.type === "blockMath" && (node.attrs as Json).latex === TEX), JSON.stringify(json(editor)));
  done(editor);
});

test("inline math in pasted plain text joins the line, and prices stay text", () => {
  const editor = make(p("Start  end"));
  editor.commands.setTextSelection(7);
  paste(editor, { "text/plain": "the coordinate $x_0$ is" });
  assert.deepEqual(json(editor), [{ type: "paragraph", content: [{ type: "text", text: "Start the coordinate " }, { type: "inlineMath", attrs: { latex: "x_0", display: false } }, { type: "text", text: " is end" }] }]);
  editor.commands.setContent({ type: "doc", content: [p()] });
  editor.commands.focus("end");
  paste(editor, { "text/plain": "It costs $5 and $10, PATH=$PATH:$HOME" });
  assert.deepEqual(json(editor), [p("It costs $5 and $10, PATH=$PATH:$HOME")]);
  done(editor);
});

test("Markdown and equations copied from a code editor (HTML that only wraps text) become blocks", () => {
  const markdown = `## What it is\nA recap tool.\n\n## Repositories\n- ensemble\n- docs\n\n${EQUATION}`;
  assert.equal(plainTextHtml(editorHtml(markdown)), true);
  const editor = make();
  editor.commands.focus("end");
  paste(editor, { "text/plain": markdown, "text/html": editorHtml(markdown) });
  assert.deepEqual(types(editor).slice(0, 5), ["heading", "paragraph", "heading", "bulletList", "blockMath"]);
  done(editor);
});

test("formatted HTML pastes as it is, and math drawn by KaTeX keeps its TeX", () => {
  assert.equal(plainTextHtml("<p><strong>Hi</strong> there</p>"), false);
  const editor = make();
  editor.commands.focus("end");
  paste(editor, { "text/plain": "Hi there $x$", "text/html": "<p><strong>Hi</strong> there $x$</p>" });
  assert.deepEqual((json(editor)[0]!.content as Json[])[0], { type: "text", text: "Hi", marks: [{ type: "bold" }] });
  editor.commands.setContent({ type: "doc", content: [p()] });
  editor.commands.focus("end");
  const katex = (tex: string) => `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x0</span></span>`;
  paste(editor, { "text/plain": "x0", "text/html": `<p>Let ${katex("x_0")} be the vector.</p><p><span class="katex-display">${katex("\\sum_i x_i")}</span></p>` });
  const content = json(editor);
  assert.deepEqual(((content[0]!.content as Json[])[1]), { type: "inlineMath", attrs: { latex: "x_0", display: false } });
  assert.ok(content.some((node) => node.type === "blockMath" && (node.attrs as Json).latex === "\\sum_i x_i"), JSON.stringify(content));
  done(editor);
});

test("a pasted LaTeX document becomes headings, lists and equations", () => {
  const editor = make();
  editor.commands.focus("end");
  paste(editor, { "text/plain": "\\section{Intro}\nA \\textbf{bold} start.\n\\begin{itemize}\n\\item One\n\\end{itemize}\n\\begin{equation}\nE = mc^2\n\\end{equation}" });
  assert.deepEqual(types(editor).slice(0, 4), ["heading", "paragraph", "bulletList", "blockMath"]);
  done(editor);
});

test("typing $$ x $$ with spaces inside makes display math when it holds TeX", () => {
  const editor = make();
  type(editor, "so $$ x^2 $$");
  assert.deepEqual((json(editor)[0]!.content as Json[])[1], { type: "inlineMath", attrs: { latex: "x^2", display: true } });
  editor.commands.setContent({ type: "doc", content: [p()] });
  type(editor, "echo $$ and kill $$");
  assert.deepEqual(json(editor), [p("echo $$ and kill $$")]);
  done(editor);
});

test("TeX in the text of formatted HTML (a web page showing $x$) becomes equations, code stays", () => {
  const editor = make();
  editor.commands.focus("end");
  paste(editor, { "text/plain": "Let $x_0$ be. Run `$x$`.", "text/html": "<p>Let <em>$x_0$</em> be. Run <code>$x$</code>.</p>" });
  const content = json(editor)[0]!.content as Json[];
  assert.deepEqual(content.map((node) => node.type), ["text", "inlineMath", "text", "text", "text"]);
  assert.deepEqual(content[3], { type: "text", text: "$x$", marks: [{ type: "code" }] });
  done(editor);
});

const vscode = (mode: string) => JSON.stringify({ version: 1, isFromEmptySelection: false, multicursorText: null, mode });

test("Cmd/Ctrl+Shift+V, a copy from this editor and a block drag keep the text as typed", () => {
  const editor = make();
  editor.commands.focus("end");
  const input = (editor.view as unknown as { input: { shiftKey: boolean } }).input;
  input.shiftKey = true;
  paste(editor, { "text/plain": "the $x$ value", "text/html": editorHtml("the $x$ value"), "vscode-editor-data": vscode("markdown") });
  input.shiftKey = false;
  assert.deepEqual(json(editor), [p("the $x$ value")]);
  editor.commands.setContent({ type: "doc", content: [p()] });
  editor.commands.focus("end");
  paste(editor, { "text/plain": "copied $y$ here", "text/html": '<p data-pm-slice="1 1 []">copied $y$ here</p>' });
  assert.deepEqual(json(editor), [p("copied $y$ here")]);
  const slice = editor.state.doc.slice(1, editor.state.doc.content.size - 1);
  (editor.view as unknown as { dragging: unknown }).dragging = { slice, move: true };
  const dragged = editor.view.someProp("transformPasted", (transform) => transform(slice, editor.view, false));
  (editor.view as unknown as { dragging: unknown }).dragging = null;
  assert.equal(dragged, slice, "a dragged block is not changed");
  done(editor);
});

test("code copied from VS Code pastes as a code block; its Markdown and plain text are read as text", () => {
  const code = "# Load data\nrows = load(*args, **kwargs)";
  const editor = make();
  editor.commands.focus("end");
  paste(editor, { "text/plain": code, "text/html": editorHtml(code), "vscode-editor-data": vscode("python") });
  assert.deepEqual(json(editor).find((node) => node.type === "codeBlock"), { type: "codeBlock", attrs: { language: "python" }, content: [{ type: "text", text: code }] });
  editor.commands.setContent({ type: "doc", content: [p("Use  here")] });
  editor.commands.setTextSelection(5);
  paste(editor, { "text/plain": "load_rows", "text/html": editorHtml("load_rows"), "vscode-editor-data": vscode("python") });
  assert.deepEqual(json(editor), [p("Use load_rows here")], "one line of code joins the sentence");
  editor.commands.setContent({ type: "doc", content: [p()] });
  editor.commands.focus("end");
  paste(editor, { "text/plain": "## Plan\n- one", "text/html": editorHtml("## Plan\n- one"), "vscode-editor-data": vscode("markdown") });
  assert.deepEqual(types(editor).slice(0, 2), ["heading", "bulletList"]);
  done(editor);
});

test("HTML that is only a <pre> pastes as a code block", () => {
  assert.equal(plainTextHtml("<pre># Load data\nf(**kwargs)</pre>"), false);
  const editor = make();
  editor.commands.focus("end");
  paste(editor, { "text/plain": "# Load data\nf(**kwargs)", "text/html": "<pre># Load data\nf(**kwargs)</pre>" });
  assert.ok(json(editor).some((node) => node.type === "codeBlock"), JSON.stringify(json(editor)));
  done(editor);
});
