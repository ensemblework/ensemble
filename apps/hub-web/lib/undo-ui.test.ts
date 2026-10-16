import "../components/ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { editingText, undoButtonLabel } from "./undo-ui.js";

test("the top bar says what Undo and Redo will do", () => {
  assert.equal(undoButtonLabel("Undo", "Deleted “Roadmap”"), "Undo: Deleted “Roadmap”");
  assert.equal(undoButtonLabel("Redo", null), "Redo");
  assert.equal(undoButtonLabel("Undo", "x".repeat(200)).length, "Undo: ".length + 80);
});

test("Ctrl/Cmd+Z in a field or editor is left to that editor", () => {
  document.body.innerHTML = `<input id="field"><div contenteditable="true"><p id="para">Hi</p></div><div contenteditable="false"><span id="locked">x</span></div><button id="button">Go</button><div class="cm-editor"><span id="code">x</span></div>`;
  for (const id of ["field", "para", "code"]) assert.equal(editingText(document.getElementById(id)), true, id);
  for (const id of ["locked", "button"]) assert.equal(editingText(document.getElementById(id)), false, id);
  assert.equal(editingText(null), false);
  document.body.innerHTML = "";
});
