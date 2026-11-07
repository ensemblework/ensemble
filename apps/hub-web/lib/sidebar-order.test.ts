import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SIDEBAR_ORDER, arrangeSidebar, moveSidebarTab, stepSidebarTab } from "./sidebar-order";

test("a stored order keeps known tabs once and brings back missing ones", () => {
  assert.deepEqual(arrangeSidebar(null), DEFAULT_SIDEBAR_ORDER);
  const arranged = arrangeSidebar([["/plots", "/board", "/plots", "/nope"], ["/context"]]);
  assert.deepEqual(arranged[0], ["/plots", "/board", "/needs-me", "/marketplace"]);
  assert.equal(arranged.flat().length, DEFAULT_SIDEBAR_ORDER.flat().length);
  assert.ok(!arranged[3]!.includes("/plots"), "a moved tab is not added back to its old group");
});

test("a tab moves within its group and into another one", () => {
  const order = arrangeSidebar(null);
  assert.deepEqual(moveSidebarTab(order, "/board", 0, 2)[0], ["/needs-me", "/board", "/marketplace"], "down by one");
  assert.deepEqual(moveSidebarTab(order, "/marketplace", 0, 0)[0], ["/marketplace", "/board", "/needs-me"]);
  const across = moveSidebarTab(order, "/plots", 0, 1);
  assert.deepEqual(across[0], ["/board", "/plots", "/needs-me", "/marketplace"]);
  assert.ok(!across[3]!.includes("/plots"));
});

test("Move up and Move down skip hidden tabs and cross a group's edge", () => {
  const order = arrangeSidebar(null);
  const shown = (href: string) => href !== "/marketplace";
  assert.deepEqual(stepSidebarTab(order, "/context", -1, shown)[0], ["/board", "/needs-me", "/context", "/marketplace"]);
  assert.deepEqual(stepSidebarTab(order, "/board", -1, shown), order, "the first stays first");
  assert.deepEqual(stepSidebarTab(order, "/board", 1, shown)[0], ["/needs-me", "/board", "/marketplace"]);
});
