import assert from "node:assert/strict";
import test from "node:test";
import { isListedArtifact } from "./artifacts.js";

test("the artifacts list keeps files and pull requests, not task-shaped rows", () => {
  assert.equal(isListedArtifact({ kind: "pr", title: "chambers/rao-sunrise #12 · vakalatnama" }), true);
  assert.equal(isListedArtifact({ kind: "file", title: "HC order dt. 8 Jul 2026 · certified copy.pdf" }), true);
  assert.equal(isListedArtifact({ kind: "task", title: "Read the draft" }), false);
  assert.equal(isListedArtifact({ kind: "file", title: "   " }), false);
});
