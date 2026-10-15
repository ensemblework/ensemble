import assert from "node:assert/strict";
import test from "node:test";
import { searchSnippet } from "./store.js";

test("a page search snippet shows the words around the match, without the title", () => {
  const text = "Roadmap\nWe will ship the zebra crossing in March after the city signs off on the plans for the crossing.";
  assert.equal(searchSnippet(text, "Roadmap", "ZEBRA"), "We will ship the zebra crossing in March after the city signs off on the plans for the…");
  assert.equal(searchSnippet(text, "Roadmap", "roadmap"), "");
  const long = `${"a ".repeat(60)}needle${" b".repeat(60)}`;
  const snippet = searchSnippet(long, "", "needle");
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…") && snippet.includes("needle"));
});
