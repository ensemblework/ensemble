import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonc, ThemeSyntaxError } from "./jsonc.js";

test("jsonc strips comments and trailing commas", () => {
  const value = parseJsonc(`{
    // line comment
    "name": "Sample", /* block */
    "colors": {
      "editor.background": "#010203",
    },
    "list": ["a", "b",],
  }`) as { name: string; colors: { "editor.background": string }; list: string[] };
  assert.equal(value.name, "Sample");
  assert.equal(value.colors["editor.background"], "#010203");
  assert.deepEqual(value.list, ["a", "b"]);
});

test("jsonc does not treat comment markers inside strings as comments", () => {
  const value = parseJsonc(`{ "note": "https://example.com/a // not a comment" }`) as { note: string };
  assert.equal(value.note, "https://example.com/a // not a comment");
});

test("jsonc rejects a file that is not JSON", () => {
  assert.throws(() => parseJsonc("{"), ThemeSyntaxError);
});
