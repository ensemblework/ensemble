import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EnsembleAsk } from "./ensemble-ask";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

test("@ensemble reads as a request while it is typed: chip, tinted question, and Enter's hint", () => {
  let active = true;
  const editor = new Editor({
    extensions: [StarterKit, EnsembleAsk.configure({ active: () => active })],
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Notes @ensemble" }] }] },
  });
  document.body.appendChild(editor.view.dom);
  const dom = editor.view.dom as HTMLElement;
  const text = (selector: string) => dom.querySelector(selector)?.textContent ?? null;
  try {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    assert.equal(text(".ensemble-ask-token"), "@ensemble");
    assert.match(text(".ensemble-ask-placeholder") ?? "", /Ask about this page/, "an empty request says what it can do");
    assert.equal(dom.querySelector(".ensemble-ask-send"), null);

    editor.commands.insertContent(" summarise this");
    assert.equal(text(".ensemble-ask-prompt"), " summarise this");
    assert.match(text(".ensemble-ask-send") ?? "", /Ask Ensemble/);
    assert.equal(dom.querySelector(".ensemble-ask-placeholder"), null);
    assert.equal(editor.getText(), "Notes @ensemble summarise this", "decorations only: the text is as typed");

    editor.commands.setTextSelection(3);
    assert.equal(dom.querySelector(".ensemble-ask-token"), null, "a caret before @ensemble is not a request");

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    active = false;
    editor.view.dispatch(editor.state.tr);
    assert.equal(dom.querySelector(".ensemble-ask-token"), null, "off where Enter would not ask");
  } finally {
    editor.view.dom.remove();
    editor.destroy();
  }
});
