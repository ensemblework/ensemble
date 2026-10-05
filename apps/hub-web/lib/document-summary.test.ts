import assert from "node:assert/strict";
import test from "node:test";
import { documentSummaryLine, summaryTagTone } from "./document-summary.js";

test("a failed summary is shown, and a queued one is not left as if it never started", () => {
  assert.equal(
    documentSummaryLine({ enrichmentStatus: "failed", summary: null, enrichmentError: { message: "The model runtime is not running." } }),
    "The model runtime is not running.",
  );
  assert.equal(summaryTagTone("failed"), "red");
  assert.equal(documentSummaryLine({ enrichmentStatus: "queued", summary: null }), "Summarizing…");
  assert.equal(documentSummaryLine({ enrichmentStatus: "done", summary: "Launch is Friday." }), "Launch is Friday.");
  assert.equal(summaryTagTone("done"), "green");
});
