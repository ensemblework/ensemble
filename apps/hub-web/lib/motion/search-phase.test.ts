import assert from "node:assert/strict";
import { test } from "node:test";
import { searchPhase } from "./search-phase";

test("typing is focus only, and a cached query never shows a loader", () => {
  assert.equal(searchPhase({ focused: true, query: "mail", pending: false, showLoader: false, count: null, list: false }), "typing");
  assert.equal(searchPhase({ focused: true, query: "mail", pending: false, showLoader: true, count: 2, list: true }), "results");
  assert.equal(searchPhase({ focused: false, query: "", pending: true, showLoader: false, count: null, list: false }), "idle");
});

test("searching waits for the shared delay, and empty waits until the query has settled", () => {
  assert.equal(searchPhase({ focused: true, query: "mail", pending: true, showLoader: false, count: 0, list: true }), "typing");
  assert.equal(searchPhase({ focused: true, query: "mail", pending: true, showLoader: true, count: 0, list: true }), "searching");
  assert.equal(searchPhase({ focused: true, query: "mail", pending: false, showLoader: false, count: 0, list: true }), "empty");
  assert.equal(searchPhase({ focused: true, query: "mail", pending: false, showLoader: false, count: 3, list: true }), "results");
});
