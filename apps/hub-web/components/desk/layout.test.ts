import assert from "node:assert/strict";
import test from "node:test";
import {
  arrange,
  clampSize,
  hiddenTilesFor,
  hideTile,
  isDefaultLayout,
  moveTile,
  readLayout,
  resizeTile,
  showTile,
  sizeFromDrag,
  stepTile,
  tileLimits,
} from "./layout";

const defaults = [
  { key: "week", c: 12, r: 4, hero: true },
  { key: "deadlines", c: 4, r: 4 },
  { key: "courses", c: 8, r: 2 },
];
const pool = new Map([...defaults, { key: "decisions", c: 6, r: 3 }].map((spec) => [spec.key, spec]));

test("tile limits keep heroes and timelines readable", () => {
  assert.deepEqual(tileLimits({ key: "week", c: 12, r: 4, hero: true }), { minC: 6, minR: 3, maxC: 12, maxR: 8 });
  assert.deepEqual(tileLimits({ key: "pipeline", c: 6, r: 3 }), { minC: 4, minR: 3, maxC: 12, maxR: 8 });
  assert.deepEqual(tileLimits({ key: "notes", c: 4, r: 2 }), { minC: 3, minR: 2, maxC: 12, maxR: 8 });
  assert.deepEqual(clampSize({ c: 1, r: 20 }, tileLimits({ key: "notes", c: 4, r: 2 })), { c: 3, r: 8 });
});

test("no saved layout draws the desk as designed", () => {
  assert.equal(arrange(defaults, pool, null), defaults);
  assert.equal(isDefaultLayout(null, defaults, defaults), true);
});

test("saved layout orders, sizes, borrows, hides, and appends new desk tiles", () => {
  const layout = readLayout({
    tiles: [
      { key: "deadlines", c: 6, r: 3 },
      { key: "decisions", c: 5, r: 2 },
      { key: "gone", c: 4, r: 2 },
      { key: "week", c: 2, r: 1 },
    ],
    hidden: ["courses"],
  });
  const shown = arrange(defaults, pool, layout);
  assert.deepEqual(
    shown.map((spec) => [spec.key, spec.c, spec.r]),
    [
      ["deadlines", 6, 3],
      ["decisions", 5, 2],
      ["week", 6, 3],
    ],
  );
  const newer = [...defaults, { key: "streak", c: 5, r: 2 }];
  assert.deepEqual(arrange(newer, pool, layout).map((spec) => spec.key), ["deadlines", "decisions", "week", "streak"]);
  assert.deepEqual(hiddenTilesFor(defaults, shown).map((spec) => spec.key), ["courses"]);
});

test("readLayout drops junk and duplicates", () => {
  assert.equal(readLayout(null), null);
  assert.equal(readLayout({ tiles: "x" }), null);
  assert.deepEqual(readLayout({ tiles: [{ key: "a", c: 4, r: 2 }, { key: "a", c: 5, r: 2 }, { key: 3 }, null], hidden: ["a", "b", "b", 4] }), {
    v: 1,
    tiles: [{ key: "a", c: 4, r: 2 }],
    hidden: ["b"],
  });
});

test("resize, hide, show, move, and step write a full layout", () => {
  const current = { shown: defaults, hidden: [] as string[] };
  assert.deepEqual(resizeTile(current, "courses", { c: 1, r: 9 }).tiles[2], { key: "courses", c: 3, r: 8 });
  const hidden = hideTile(current, "deadlines");
  assert.deepEqual(hidden.tiles.map((tile) => tile.key), ["week", "courses"]);
  assert.deepEqual(hidden.hidden, ["deadlines"]);
  const back = showTile({ shown: arrange(defaults, pool, hidden), hidden: hidden.hidden }, defaults[1]!);
  assert.deepEqual(back.tiles.map((tile) => tile.key), ["week", "courses", "deadlines"]);
  assert.deepEqual(back.hidden, []);
  assert.deepEqual(moveTile(current, "courses", "week").tiles.map((tile) => tile.key), ["courses", "week", "deadlines"]);
  assert.deepEqual(moveTile(current, "week", null).tiles.map((tile) => tile.key), ["deadlines", "courses", "week"]);
  assert.deepEqual(stepTile(current, "deadlines", -1).tiles.map((tile) => tile.key), ["deadlines", "week", "courses"]);
  assert.deepEqual(stepTile(current, "week", -1).tiles.map((tile) => tile.key), ["week", "deadlines", "courses"]);
  assert.equal(isDefaultLayout(stepTile(current, "week", -1), defaults, defaults), true);
  assert.equal(isDefaultLayout(hidden, arrange(defaults, pool, hidden), defaults), false);
});

test("dragging the corner snaps to whole grid cells within limits", () => {
  const grid = { column: 80, row: 72, gap: 12 };
  const limits = tileLimits({ key: "notes", c: 4, r: 2 });
  assert.deepEqual(sizeFromDrag({ c: 4, r: 2 }, { dx: 0, dy: 0 }, grid, limits), { c: 4, r: 2 });
  assert.deepEqual(sizeFromDrag({ c: 4, r: 2 }, { dx: 95, dy: 40 }, grid, limits), { c: 5, r: 2 });
  assert.deepEqual(sizeFromDrag({ c: 4, r: 2 }, { dx: 180, dy: 170 }, grid, limits), { c: 6, r: 4 });
  assert.deepEqual(sizeFromDrag({ c: 4, r: 2 }, { dx: -900, dy: -900 }, grid, limits), { c: 3, r: 2 });
  assert.deepEqual(sizeFromDrag({ c: 4, r: 2 }, { dx: 5000, dy: 5000 }, grid, limits), { c: 12, r: 8 });
});

test("an exact template layout draws only its tiles until the first edit", () => {
  const layout = readLayout({ v: 1, exact: true, tiles: [{ key: "courses", c: 6, r: 2 }, { key: "decisions", c: 6, r: 2 }], hidden: [] });
  assert.equal(layout?.exact, true);
  const shown = arrange(defaults, pool, layout);
  assert.deepEqual(shown.map((spec) => spec.key), ["courses", "decisions"]);
  const hidden = hiddenTilesFor(defaults, shown).map((spec) => spec.key);
  assert.deepEqual(hidden, ["week", "deadlines"]);
  const edited = resizeTile({ shown, hidden }, "courses", { c: 8, r: 2 });
  assert.equal(edited.exact, undefined);
  assert.deepEqual(arrange(defaults, pool, edited).map((spec) => spec.key), ["courses", "decisions"]);
});

test("desk extras follow their switch even with a saved or template layout", () => {
  const concepts = { key: "concepts", c: 6, r: 3 };
  const withExtras = new Map([...pool, ["concepts", concepts]]);
  const saved = readLayout({ v: 1, tiles: [{ key: "week", c: 12, r: 4 }, { key: "concepts", c: 6, r: 3 }], hidden: [] });
  // Switched off: not borrowed back from the pool.
  assert.deepEqual(arrange(defaults, withExtras, saved, { blocked: new Set(["concepts"]) }).map((spec) => spec.key), ["week", "deadlines", "courses"]);
  // Switched on under an exact template layout: appended.
  const exact = readLayout({ v: 1, exact: true, tiles: [{ key: "courses", c: 6, r: 2 }], hidden: [] });
  assert.deepEqual(arrange([...defaults, concepts], withExtras, exact, { extras: new Set(["concepts"]) }).map((spec) => spec.key), ["courses", "concepts"]);
  assert.deepEqual(arrange([...defaults, concepts], withExtras, exact).map((spec) => spec.key), ["courses"]);
});
