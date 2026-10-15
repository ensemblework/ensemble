/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import { ToggleBlock } from "./toggle-block";
import { CommentMark } from "./comment-mark";
import { deleteBlock, duplicateBlock, moveBlock } from "./block-move";
import { applyBlock, blockKind, turnBlockInto } from "./editor-commands";

type Json = Record<string, unknown>;
const p = (text = ""): Json => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" });
const list = (type: string, ...items: string[]): Json => ({ type, content: items.map((text) => ({ type: "listItem", content: [p(text)] })) });
const toggle = (...content: Json[]): Json => ({ type: "toggleBlock", content });
const make = (...content: Json[]) => new Editor({ extensions: [StarterKit, ToggleBlock, CommentMark], content: { type: "doc", content } });
const press = (editor: Editor, key: string) => editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, new KeyboardEvent("keydown", { key, cancelable: true })));
const types = (editor: Editor) => editor.getJSON().content!.map((node) => node.type);
/** Puts the cursor at the start of the first textblock whose text is `text` (or the first empty one for ""). */
function cursorIn(editor: Editor, text: string, atEnd = false) {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0 || !node.isTextblock || node.textContent !== text) return at < 0;
    at = pos + 1 + (atEnd ? node.content.size : 0);
    return false;
  });
  assert.ok(at >= 0, `no line "${text}"`);
  editor.commands.setTextSelection(at);
}

test("dragging list items moves their nested code intact, retains numbering and undoes in one step", () => {
  const editor = new Editor({ extensions: [StarterKit], content: { type: "doc", content: [{ type: "orderedList", attrs: { start: 3 }, content: [
    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }, { type: "codeBlock", content: [{ type: "text", text: "print('hi')" }] }] },
    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Second" }] }] },
  ] }, { type: "paragraph", content: [{ type: "text", text: "Outside" }] }] } });
  try {
    let state = EditorState.create({ schema: editor.schema, doc: editor.state.doc, plugins: [history()] });
    const first = 1;
    const second = first + state.doc.nodeAt(first)!.nodeSize;
    const tr = moveBlock(state, first, second, true)!;
    state = state.apply(tr);
    const ordered = state.doc.firstChild!;
    assert.equal(ordered.attrs.start, 3);
    assert.equal(ordered.firstChild!.textContent, "Second");
    assert.equal(ordered.lastChild!.lastChild!.type.name, "codeBlock");
    const outside = state.doc.firstChild!.nodeSize;
    assert.equal(moveBlock(state, 1, outside, true), null, "a list item cannot corrupt a different parent");
    assert.ok(undo(state, (transaction) => { state = state.apply(transaction); }));
    assert.deepEqual(state.doc.toJSON(), editor.state.doc.toJSON());
  } finally { editor.destroy(); }
});

test("collapsing a block retains nested content and survives serialization", () => {
  const editor = new Editor({ extensions: [StarterKit, ToggleBlock], content: { type: "doc", content: [{ type: "toggleBlock", content: [{ type: "paragraph", content: [{ type: "text", text: "Details" }] }, { type: "codeBlock", content: [{ type: "text", text: "keep me" }] }] }] } });
  try {
    const button = editor.view.dom.querySelector<HTMLButtonElement>(".toggle-block-trigger")!;
    assert.equal(button.getAttribute("aria-expanded"), "true");
    button.click();
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(editor.getJSON().content![0]!.attrs!.collapsed, true);
    assert.equal(editor.getJSON().content![0]!.content![1]!.content![0]!.text, "keep me");
    editor.commands.setContent(editor.getJSON());
    assert.equal(editor.getJSON().content![0]!.attrs!.collapsed, true);
  } finally { editor.destroy(); }
});

test("a drag cannot put a code block in the summary slot of a collapsible block", () => {
  const editor = new Editor({ extensions: [StarterKit, ToggleBlock], content: { type: "doc", content: [{ type: "toggleBlock", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Summary" }] }, { type: "codeBlock", content: [{ type: "text", text: "keep me" }] }] }] } });
  try {
    const summary = 1;
    const code = summary + editor.state.doc.nodeAt(summary)!.nodeSize;
    assert.equal(moveBlock(editor.state, code, summary, false), null);
    assert.equal(editor.state.doc.firstChild!.firstChild!.type.name, "heading");
    assert.equal(editor.state.doc.firstChild!.lastChild!.textContent, "keep me");
  } finally { editor.destroy(); }
});

test("Backspace at the start of an empty collapsible block turns it into a line and leaves the blocks above alone", () => {
  const editor = make({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] }, p("Intro"), list("orderedList", "one", "two"), list("bulletList", "a", "b"), toggle(p(), p()));
  try {
    cursorIn(editor, "");
    assert.equal(editor.state.selection.$from.node(-1).type.name, "toggleBlock");
    assert.ok(press(editor, "Backspace"));
    assert.deepEqual(types(editor), ["heading", "paragraph", "orderedList", "bulletList", "paragraph"]);
    assert.equal(editor.state.doc.lastChild!.content.size, 0);
    assert.equal(editor.state.doc.child(2).childCount, 2);
    assert.equal(editor.state.doc.child(3).childCount, 2);
  } finally { editor.destroy(); }
});

test("Backspace at the start of a summary puts the summary and the body back as plain blocks", () => {
  const editor = make(p("Before"), { ...toggle({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Sum" }] }, p("child"), { type: "codeBlock", content: [{ type: "text", text: "x" }] }), attrs: { collapsed: true } });
  try {
    cursorIn(editor, "Sum");
    assert.ok(press(editor, "Backspace"));
    assert.deepEqual(types(editor), ["paragraph", "heading", "paragraph", "codeBlock"]);
    assert.equal(editor.state.selection.$from.parent.textContent, "Sum");
    assert.equal(editor.state.selection.$from.parentOffset, 0);
    assert.equal(editor.state.doc.child(0).textContent, "Before");
  } finally { editor.destroy(); }
});

test("a cleared collapsible block can be backspaced away line by line", () => {
  const editor = make(list("bulletList", "a", "b"), toggle(p("Title"), p("one"), p("two")));
  try {
    // Typing deletes characters natively; the editor's keymap only sees Backspace at the start of a line.
    const clear = (text: string) => {
      cursorIn(editor, text, true);
      const { from } = editor.state.selection;
      editor.commands.deleteRange({ from: from - text.length, to: from });
    };
    for (const text of ["two", "one"]) {
      clear(text);
      assert.ok(press(editor, "Backspace"), "the empty child line goes");
    }
    assert.equal(editor.state.doc.lastChild!.type.name, "toggleBlock");
    assert.equal(editor.state.doc.lastChild!.childCount, 1, "only the summary is left");
    clear("Title");
    assert.ok(press(editor, "Backspace"));
    assert.deepEqual(types(editor), ["bulletList", "paragraph"]);
    assert.equal(editor.state.doc.child(0).childCount, 2);
    assert.equal(JSON.stringify(editor.getJSON()).includes("toggleBlock"), false);
  } finally { editor.destroy(); }
});

test("a new collapsible block starts with an empty summary under a placeholder, and Enter after it starts the body", () => {
  const editor = make(p("/toggle"));
  try {
    applyBlock(editor, { from: 1, to: 8 }, "toggle");
    const block = editor.state.doc.firstChild!;
    assert.equal(block.type.name, "toggleBlock");
    assert.equal(block.childCount, 1);
    assert.equal(block.textContent, "");
    const summary = editor.view.dom.querySelector(".toggle-block-content > p");
    assert.equal(summary?.classList.contains("is-empty"), true);
    assert.equal(summary?.getAttribute("data-placeholder"), "Toggle");
    editor.commands.insertContent("Ttl");
    assert.equal(editor.state.doc.firstChild!.firstChild!.textContent, "Ttl");
    assert.equal(editor.view.dom.querySelector(".toggle-block-content > p.is-empty"), null);
    editor.commands.enter();
    editor.commands.insertContent("inside");
    assert.deepEqual(editor.state.doc.firstChild!.toJSON().content.map((node: Json) => node.type), ["paragraph", "paragraph"]);
    assert.equal(editor.state.doc.firstChild!.lastChild!.textContent, "inside");
  } finally { editor.destroy(); }
});

test("Enter in the summary of a collapsed block starts a line after the block, not a hidden one inside it", () => {
  const editor = make({ ...toggle(p("Summary"), p("hidden")), attrs: { collapsed: true } });
  try {
    cursorIn(editor, "Summary", true);
    editor.commands.setTextSelection(editor.state.selection.from - 3);
    assert.ok(press(editor, "Enter"));
    assert.deepEqual(types(editor), ["toggleBlock", "paragraph"]);
    assert.equal(editor.state.doc.firstChild!.firstChild!.textContent, "Summ");
    assert.equal(editor.state.doc.firstChild!.childCount, 2);
    assert.equal(editor.state.doc.lastChild!.textContent, "ary");
    assert.equal(editor.state.selection.$from.parent, editor.state.doc.lastChild);
  } finally { editor.destroy(); }
});

test("documents saved with the older two-line minimum still load unchanged", () => {
  const saved = { type: "doc", content: [{ type: "toggleBlock", attrs: { collapsed: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Details" }] }, { type: "paragraph" }] }] };
  const editor = new Editor({ extensions: [StarterKit, ToggleBlock], content: saved });
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(editor.getJSON())), saved);
  } finally { editor.destroy(); }
});

test("a slash command in a summary changes the summary in place; one that cannot be a summary leaves the block", () => {
  const editor = make(toggle(p("/h2"), p("body")));
  try {
    applyBlock(editor, { from: 2, to: 5 }, "h2");
    assert.deepEqual(types(editor), ["toggleBlock"]);
    assert.equal(editor.state.doc.firstChild!.firstChild!.type.name, "heading");
    editor.commands.insertContent("/quote");
    const { from } = editor.state.selection;
    applyBlock(editor, { from: from - 6, to: from }, "quote");
    assert.deepEqual(types(editor), ["blockquote", "paragraph"]);
  } finally { editor.destroy(); }
});

test("a slash command in a body line keeps the line inside its collapsible block", () => {
  const editor = make(toggle(p("Summary"), p("/h1"), p("last")));
  try {
    cursorIn(editor, "/h1", true);
    const { from } = editor.state.selection;
    applyBlock(editor, { from: from - 3, to: from }, "h1");
    assert.deepEqual(types(editor), ["toggleBlock"]);
    assert.deepEqual(editor.state.doc.firstChild!.toJSON().content.map((node: Json) => node.type), ["paragraph", "heading", "paragraph"]);
  } finally { editor.destroy(); }
});

test("Delete removes a block, and the list with it when it was the only item; the page keeps one line", () => {
  const editor = make(list("bulletList", "only"), p("keep"));
  try {
    editor.view.dispatch(deleteBlock(editor.state, 1)!);
    assert.deepEqual(types(editor), ["paragraph"]);
    editor.view.dispatch(deleteBlock(editor.state, 0)!);
    assert.deepEqual(editor.getJSON(), { type: "doc", content: [{ type: "paragraph" }] });
  } finally { editor.destroy(); }
});

test("Duplicate inserts a copy after the block without its comment highlight", () => {
  const editor = make(p("Note"), list("orderedList", "one", "two"));
  try {
    editor.chain().setTextSelection({ from: 1, to: 5 }).setMark("comment", { id: "m1", commentId: "c1" }).run();
    editor.view.dispatch(duplicateBlock(editor.state, 0)!);
    assert.deepEqual(types(editor), ["paragraph", "paragraph", "orderedList"]);
    assert.equal(editor.state.doc.child(1).textContent, "Note");
    assert.equal(editor.state.doc.child(0).firstChild!.marks.length, 1);
    assert.equal(editor.state.doc.child(1).firstChild!.marks.length, 0);
    const item = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize + 1;
    editor.view.dispatch(duplicateBlock(editor.state, item)!);
    assert.equal(editor.state.doc.child(2).childCount, 3);
  } finally { editor.destroy(); }
});

test("Turn into changes the block the handle stands for", () => {
  const editor = make(toggle(p("Sum"), p("child")), p("Line"), list("bulletList", "item"));
  try {
    assert.equal(blockKind(editor.state.doc, 0), "toggle");
    assert.ok(turnBlockInto(editor, 0, "h1"));
    assert.deepEqual(types(editor), ["heading", "paragraph", "paragraph", "bulletList"]);
    assert.equal(editor.state.doc.child(0).attrs.level, 1);
    const line = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize;
    assert.equal(blockKind(editor.state.doc, line), "text");
    assert.ok(turnBlockInto(editor, line, "toggle"));
    assert.equal(editor.state.doc.child(2).type.name, "toggleBlock");
    assert.equal(editor.state.doc.child(2).textContent, "Line");
    const item = line + editor.state.doc.child(2).nodeSize + 1;
    assert.equal(blockKind(editor.state.doc, item), "bullet-list");
    assert.equal(turnBlockInto(editor, item, "toggle"), false, "only a single line can become a summary");
    assert.ok(turnBlockInto(editor, item, "list"));
    assert.equal(editor.state.doc.lastChild!.type.name, "orderedList");
  } finally { editor.destroy(); }
});
