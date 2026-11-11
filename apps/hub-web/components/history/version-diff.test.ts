import assert from "node:assert/strict";
import test from "node:test";
import type { PageDocument } from "@ensemble/shared-types";
import { changeCount, diffPage, pageBlocks, wordDiff } from "./version-diff";

const p = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const doc = (...content: unknown[]) => ({ type: "doc", content }) as PageDocument;

test("a page reads as its blocks: headings, list items with depth, checklists, tables and embeds", () => {
  const blocks = pageBlocks(doc(
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Launch plan" }] },
    p(""),
    { type: "paragraph", content: [{ type: "text", text: "Ask " }, { type: "mention", attrs: { kind: "people", id: "p1", label: "Mira" } }, { type: "text", text: " today" }] },
    { type: "bulletList", content: [{ type: "listItem", content: [p("Docs"), { type: "bulletList", content: [{ type: "listItem", content: [p("API")] }] }] }] },
    { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [p("Third")] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p("Email Ben")] }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p("Owner")] }, { type: "tableCell", content: [p("Mira")] }] }] },
    { type: "paragraph", content: [{ type: "mention", attrs: { kind: "diagram", id: "d1", label: "Flow" } }] },
  ));
  assert.deepEqual(blocks, [
    { kind: "h1", text: "Launch plan", depth: 0 },
    { kind: "p", text: "Ask @Mira today", depth: 0 },
    { kind: "bullet", text: "Docs", depth: 0 },
    { kind: "bullet", text: "API", depth: 1 },
    { kind: "ordered", text: "Third", depth: 0, number: 3 },
    { kind: "task", text: "Email Ben", depth: 0, checked: true },
    { kind: "table", text: "Owner | Mira", depth: 0 },
    { kind: "p", text: "Diagram: Flow", depth: 0 },
  ]);
});

test("words that changed inside a block are marked, the page's words first", () => {
  assert.deepEqual(wordDiff("Ship the beta to twenty teams", "Ship the beta to forty teams"), [
    { text: "Ship the beta to " },
    { text: "twenty", change: "removed" },
    { text: "forty", change: "added" },
    { text: " teams" },
  ]);
  assert.deepEqual(wordDiff("the old plan", "a new plan"), [
    { text: "the old", change: "removed" },
    { text: "a new", change: "added" },
    { text: " plan" },
  ], "a space between two changed words joins the change");
  assert.deepEqual(wordDiff("Same", "Same"), [{ text: "Same" }]);
});

test("a saved version against the page now: kept, edited, only in the version, only on the page", () => {
  const version = pageBlocks(doc(p("Intro"), p("Ship the beta to twenty teams by Friday."), p("Pricing is final."), p("Outro")));
  const current = pageBlocks(doc(p("Intro"), p("Ship the beta to forty teams by Friday."), p("A paragraph typed since."), p("Outro")));
  const diff = diffPage(version, current);
  assert.deepEqual(diff.map((row) => [row.change, row.block.text]), [
    ["same", "Intro"],
    ["edited", "Ship the beta to twenty teams by Friday."],
    ["removed", "A paragraph typed since."],
    ["added", "Pricing is final."],
    ["same", "Outro"],
  ]);
  const edited = diff[1]!;
  assert.ok(edited.change === "edited");
  assert.deepEqual(edited.segments.filter((segment) => segment.change), [{ text: "forty", change: "removed" }, { text: "twenty", change: "added" }]);
  assert.equal(changeCount(diff), 1, "one changed stretch");
  assert.equal(changeCount(diffPage(current, current)), 0);
});

test("a checked box or a heading level counts as a change of its block", () => {
  const before = pageBlocks(doc({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [p("Email Ben")] }] }));
  const after = pageBlocks(doc({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p("Email Ben")] }] }));
  const diff = diffPage(before, after);
  assert.deepEqual(diff.map((row) => row.change), ["edited"]);
  assert.equal(diff[0]!.block.checked, false, "the version's own state shows");
});

test("a block reworded with a word's case changed still pairs with the page's block", () => {
  const heading = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
  const diff = diffPage(pageBlocks(doc(heading("Early results"), p("Body"))), pageBlocks(doc(heading("Results"), p("Body"))));
  assert.deepEqual(diff.map((row) => row.change), ["edited", "same"]);
});
