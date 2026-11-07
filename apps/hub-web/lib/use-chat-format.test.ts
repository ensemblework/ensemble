import "../components/ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { applyEdit } from "./use-chat-format";

test("an edit replaces only what changed, tells the page it changed, and puts the caret back", () => {
  const field = document.createElement("textarea");
  document.body.appendChild(field);
  field.value = "1. Milk";
  let heard = 0;
  field.addEventListener("input", () => (heard += 1));
  applyEdit(field, { value: "1. Milk\n2. ", start: 11, end: 11 });
  assert.equal(field.value, "1. Milk\n2. ");
  assert.equal(heard, 1);
  assert.equal(field.selectionStart, 11);
  applyEdit(field, { value: "1. Milk\n2. ", start: 3, end: 7 });
  assert.equal(heard, 1, "nothing changed: no input event");
  assert.deepEqual([field.selectionStart, field.selectionEnd], [3, 7]);
  field.remove();
});
