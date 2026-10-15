import assert from "node:assert/strict";
import test from "node:test";
import { editingLine, hrefOf, placeOf } from "./presence";

test("Go to uses where someone is, or the one shared item they opened", () => {
  assert.equal(hrefOf({ route: "/pages/p1?x=1", resource: { kind: "page", id: "p1" } }), "/pages/p1?x=1");
  assert.equal(hrefOf({ route: null, resource: { kind: "page", id: "p1" } }), "/pages/p1");
  assert.equal(hrefOf({ route: null, resource: { kind: "plot_space", id: "w 1" } }), "/plots/w%201");
  assert.equal(hrefOf({ route: null, resource: { kind: "board", id: "space-1" } }), "/board");
  assert.equal(hrefOf({ route: null, resource: { kind: "plot", id: "c1" } }), null);
  assert.equal(hrefOf({ route: null, resource: null }), null);
});

test("places read as words, and a one-item viewer is on the shared item", () => {
  assert.equal(placeOf({ route: "/board?peek=task:t1", resource: null }), "a task");
  assert.equal(placeOf({ route: "/diagrams/d1", resource: null }), "a diagram");
  assert.equal(placeOf({ route: null, resource: { kind: "plot_space", id: "w1" } }), "the shared plot space");
  assert.equal(placeOf({ route: "/somewhere", resource: null }), "this space");
});

test("the editing line names people in full", () => {
  assert.equal(editingLine(["Test One"]), "Test One is editing…");
  assert.equal(editingLine(["Test One", "Test Two"]), "Test One and Test Two are editing…");
  assert.equal(editingLine(["Test One", "Test Two", "Test 3"]), "Test One and 2 others are editing…");
});
