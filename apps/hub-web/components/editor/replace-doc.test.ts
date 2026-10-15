import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { PageDocument } from "@ensemble/shared-types";
import { acceptsDocument, replaceDocument } from "./replace-doc";

const doc = (...texts: string[]): PageDocument => ({ type: "doc", content: texts.map((text) => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" })) });

function editorWith(content: PageDocument): { editor: Editor; updates: number[] } {
  const updates: number[] = [];
  const editor = new Editor({ extensions: [StarterKit], content, onUpdate: () => updates.push(Date.now()) });
  return { editor, updates };
}

/** Text before and after the caret in its paragraph. */
function aroundCaret(editor: Editor): [string, string] {
  const { $head } = editor.state.selection;
  const text = $head.parent.textContent;
  return [text.slice(0, $head.parentOffset), text.slice($head.parentOffset)];
}

test("text someone else added before the caret keeps the caret after your own words", () => {
  const { editor, updates } = editorWith(doc("Intro", "Plan the launch with Mira"));
  try {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    assert.ok(replaceDocument(editor, doc("Intro", "Plan the launch next week with Mira")));
    assert.deepEqual(aroundCaret(editor), ["Plan the launch next week with Mira", ""]);
    assert.equal(updates.length, 0, "taking in a version is not an edit to save");
  } finally {
    editor.destroy();
  }
});

test("text arriving exactly at the caret goes after it", () => {
  const { editor } = editorWith(doc("Plan the launch"));
  try {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    replaceDocument(editor, doc("Plan the launch next week"));
    assert.deepEqual(aroundCaret(editor), ["Plan the launch", " next week"]);
  } finally {
    editor.destroy();
  }
});

test("a paragraph added above moves the caret down with its paragraph", () => {
  const { editor } = editorWith(doc("First", "Second"));
  try {
    editor.commands.setTextSelection(editor.state.doc.content.size - 4);
    assert.deepEqual(aroundCaret(editor), ["Sec", "ond"]);
    replaceDocument(editor, doc("New", "First", "Second"));
    assert.deepEqual(aroundCaret(editor), ["Sec", "ond"]);
  } finally {
    editor.destroy();
  }
});

test("Undo takes back your typing, not the version that came in", () => {
  const { editor } = editorWith(doc("Hello"));
  try {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent(" world");
    replaceDocument(editor, doc("Hello world", "Their line"));
    assert.ok(editor.commands.undo());
    assert.deepEqual(editor.getJSON(), doc("Hello", "Their line"));
  } finally {
    editor.destroy();
  }
});

test("a document the editor cannot hold is refused and the editor is left alone", () => {
  const { editor } = editorWith(doc("Keep me"));
  try {
    const bad = { type: "doc", content: [{ type: "notABlock", content: [] }] } as unknown as PageDocument;
    assert.equal(acceptsDocument(editor, bad), false);
    assert.equal(replaceDocument(editor, bad), false);
    assert.deepEqual(editor.getJSON(), doc("Keep me"));
    assert.ok(acceptsDocument(editor, doc("Fine")));
  } finally {
    editor.destroy();
  }
});

test("a page whose marks the schema refuses (bold inline code from an import) still takes newer versions", () => {
  const boldCode = (text: string): PageDocument => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Run " }, { type: "text", text: "npm test", marks: [{ type: "bold" }, { type: "code" }] }, ...(text ? [{ type: "text", text }] : [])] }] });
  const { editor } = editorWith(boldCode(""));
  try {
    assert.ok(acceptsDocument(editor, boldCode(" now")));
    assert.ok(replaceDocument(editor, boldCode(" now")));
    assert.equal(editor.getText(), "Run npm test now");
    const code = editor.getJSON().content?.[0]?.content?.[1];
    assert.deepEqual(code?.marks?.map((mark) => mark.type), ["code"], "code keeps the marks it allows");
  } finally {
    editor.destroy();
  }
});
