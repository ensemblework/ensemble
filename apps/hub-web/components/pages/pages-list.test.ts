import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_STEP, isPageSort, parentTrail, searchPages, sortPages, titleMatches, type ListedPage } from "./pages-list.js";

const pages: ListedPage[] = [
  { id: "a", title: "Roadmap", updatedAt: "2026-10-10T10:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
  { id: "b", title: "apple notes", updatedAt: "2026-10-12T10:00:00Z", createdAt: "2026-03-01T00:00:00Z" },
  { id: "c", title: "Zebra", parentId: "a", updatedAt: "2026-10-11T10:00:00Z", createdAt: "2026-05-01T00:00:00Z" },
  { id: "d", title: "", parentId: "c", updatedAt: "2026-10-09T10:00:00Z", createdAt: "2026-02-01T00:00:00Z" },
];

test("pages sort by last edited, created, or title", () => {
  assert.deepEqual(sortPages(pages, "edited").map((page) => page.id), ["b", "c", "a", "d"]);
  assert.deepEqual(sortPages(pages, "created").map((page) => page.id), ["c", "b", "d", "a"]);
  assert.deepEqual(sortPages(pages, "title").map((page) => page.id), ["b", "a", "d", "c"]);
  assert.equal(pages[0]!.id, "a", "the input is not reordered");
});

test("a search lists title matches before pages that only match in their text", () => {
  const hits = new Map([["a", "…the zebra crossing…"], ["c", "zebra again"]]);
  const found = searchPages(pages, "ZEB", "edited", hits);
  assert.deepEqual(found.map((page) => page.id), ["c", "a"]);
  assert.equal(found[1]!.snippet, "…the zebra crossing…");
  assert.equal(found[0]!.snippet, undefined);
  assert.deepEqual(searchPages(pages, "  ", "title").map((page) => page.id), ["b", "a", "d", "c"]);
  assert.ok(titleMatches("", "untitled"));
  assert.ok(!titleMatches("Roadmap", "zebra"));
});

test("a nested page names its parents", () => {
  const byId = new Map(pages.map((page) => [page.id, page]));
  assert.equal(parentTrail(pages[3]!, byId), "Roadmap › Zebra");
  assert.equal(parentTrail(pages[0]!, byId), "");
  const loop = new Map<string, ListedPage>([
    ["x", { id: "x", title: "X", parentId: "y", updatedAt: "" }],
    ["y", { id: "y", title: "Y", parentId: "x", updatedAt: "" }],
  ]);
  assert.equal(parentTrail(loop.get("x")!, loop), "Y");
});

test("sort names from the address are checked", () => {
  assert.ok(isPageSort("title"));
  assert.ok(!isPageSort("size"));
  assert.ok(PAGE_STEP > 0);
});
