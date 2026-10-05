import assert from "node:assert/strict";
import test from "node:test";
import { ensembleSlice } from "./ensemble-prompt";

test("mid-paragraph @ensemble keeps the text after the caret", () => {
  const block = "Alpha @ensemble explain thisbeta gamma delta epsilon.";
  const caret = "Alpha @ensemble explain this".length;
  const slice = ensembleSlice(block, caret);
  assert.ok(slice);
  assert.equal(slice.prompt, "explain this");
  assert.equal(block.slice(0, slice.at), "Alpha ");
  assert.equal(block.slice(slice.caret), "beta gamma delta epsilon.");
  assert.equal(block.slice(slice.at, slice.caret).replace(/^@ensemble\s*/i, ""), "explain this");
});

test("a prompt that reaches the end of the paragraph still works", () => {
  const block = "Alpha @ensemble explain this";
  const slice = ensembleSlice(block, block.length);
  assert.equal(slice?.prompt, "explain this");
  assert.equal(slice?.caret, block.length);
});

test("text after the caret is not part of the prompt", () => {
  const block = "Keep @ensemble the question and also this tail";
  const caret = "Keep @ensemble the question".length;
  const slice = ensembleSlice(block, caret);
  assert.equal(slice?.prompt, "the question");
  assert.equal(slice?.prompt.includes("tail"), false);
});

test("enter with no prompt does not match", () => {
  assert.equal(ensembleSlice("Alpha @ensemble ", "Alpha @ensemble ".length), null);
  assert.equal(ensembleSlice("Alpha beta", 5), null);
});
