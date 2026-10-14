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
import { moveBlock } from "./block-move";

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
