import assert from "node:assert/strict";
import test from "node:test";
import { blocksFromMarkdown } from "./document";
import { fileSlug, pdfCanDraw } from "./formats";

test("download names keep letters in any script and emoji, and drop only what file systems refuse", () => {
  assert.equal(fileSlug("नोट्स 2026"), "नोट्स-2026");
  assert.equal(fileSlug("🚀"), "🚀");
  assert.equal(fileSlug("👍🏽 Done!"), "👍🏽-done");
  assert.equal(fileSlug("日本語のメモ"), "日本語のメモ");
  assert.equal(fileSlug("Q3: plan/review? <draft> \"v2\" | final*"), "q3-plan-review-draft-v2-final");
  assert.equal(fileSlug("  "), "untitled");
  assert.equal(fileSlug("My Plan"), "my-plan");
  assert.equal(Array.from(fileSlug("😀".repeat(100))).length, 80);
});

test("a PDF is drawn here only when the built-in fonts have every character", () => {
  assert.equal(pdfCanDraw({ title: "Plan “Q3” – café", blocks: blocksFromMarkdown("- ship • now") }), true);
  assert.equal(pdfCanDraw({ title: "नोट्स", blocks: [] }), false);
  assert.equal(pdfCanDraw({ title: "Plan", blocks: blocksFromMarkdown("Launch 🚀") }), false);
  assert.equal(pdfCanDraw({ title: "Plan", meta: [["Owner", "Łukasz"]], blocks: [] }), false);
});
