import assert from "node:assert/strict";
import test from "node:test";
import { compact, findGap, moveItem, placeNew, resizeItem, stagePercent } from "./plots-pack.js";

test("vertical compact closes a gap and keeps the column", () => {
  const packed = compact([
    { id: "a", x: 0, y: 0, w: 6, h: 4 },
    { id: "b", x: 6, y: 8, w: 6, h: 4 },
  ]);
  const b = packed.find((item) => item.id === "b");
  assert.equal(b?.x, 6);
  assert.equal(b?.y, 0);
});

test("a new tile lands in the first gap and does not overlap", () => {
  const first = placeNew([], "a", 6, 4);
  const both = placeNew(first, "b", 6, 4);
  const a = both.find((item) => item.id === "a")!;
  const b = both.find((item) => item.id === "b")!;
  assert.equal(a.x, 0);
  assert.equal(b.x, 6);
  assert.equal(b.y, 0);
  const gap = findGap(both, 6, 4);
  assert.equal(gap.y > 0 || gap.x === 0, true);
});

test("dropping a tile on the right keeps that column, and an overlap is pushed down", () => {
  const parked = moveItem([{ id: "a", x: 0, y: 0, w: 6, h: 4 }], "a", 6, 3);
  assert.equal(parked[0]?.x, 6);
  assert.equal(parked[0]?.y, 0);
  const start = [
    { id: "a", x: 0, y: 0, w: 6, h: 4 },
    { id: "b", x: 6, y: 0, w: 6, h: 4 },
  ];
  const moved = moveItem(start, "b", 0, 0);
  const b = moved.find((item) => item.id === "b")!;
  const a = moved.find((item) => item.id === "a")!;
  assert.equal(b.x, 0);
  assert.ok(a.y >= b.y + b.h || b.y >= a.y + a.h);
});

test("resize respects the minimum and still packs", () => {
  const items = placeNew(placeNew([], "a", 6, 4), "b", 6, 4);
  const resized = resizeItem(items, "a", 1, 1);
  const a = resized.find((item) => item.id === "a")!;
  assert.ok(a.w >= 3);
  assert.ok(a.h >= 3);
});

test("upload percent follows bytes read, rows scanned, and bytes sent", () => {
  assert.equal(stagePercent("read", 0.5), 18);
  assert.equal(stagePercent("scan", 1), 50);
  assert.equal(stagePercent("upload", 1), 95);
  assert.equal(stagePercent("done", 0), 100);
  assert.equal(stagePercent("upload", Number.NaN), 50);
});
