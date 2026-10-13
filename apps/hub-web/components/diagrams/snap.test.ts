import assert from "node:assert/strict";
import test from "node:test";
import { snapMove, snapResize } from "./snap.js";

const others = [
  { x: 0, y: 0, w: 120, h: 50 },
  { x: 300, y: 200, w: 80, h: 80 },
];

test("a dragged block snaps its edges and centre to other blocks and shows the guide", () => {
  const near = snapMove({ x: 4, y: 120, w: 100, h: 40 }, others, 6);
  assert.equal(near.x, 0, "left edges line up");
  assert.deepEqual(near.guides.filter((guide) => guide.kind === "x").map((guide) => guide.kind === "x" && guide.at), [0]);
  const centred = snapMove({ x: 13, y: 120, w: 100, h: 40 }, others, 6);
  assert.equal(centred.x + 50, 60, "centres line up");
  const middle = snapMove({ x: 500, y: 217, w: 60, h: 40 }, others, 6);
  assert.equal(middle.y + 20, 240, "middles line up across");
  const far = snapMove({ x: 40, y: 120, w: 100, h: 40 }, others, 6);
  assert.deepEqual([far.x, far.guides.length], [40, 0], "nothing in reach, nothing moves");
});

test("a resized block snaps the edge being dragged, or matches another block's width", () => {
  const before = { x: 0, y: 120, w: 100, h: 40 };
  const edge = snapResize(before, { ...before, w: 117 }, others, 6, { w: 40, h: 20 });
  assert.equal(edge.box.w, 120, "the right edge meets the other block's right edge");
  assert.ok(edge.guides.some((guide) => guide.kind === "width"), "and both are as wide");
  const left = snapResize({ x: 200, y: 400, w: 100, h: 40 }, { x: 222, y: 400, w: 78, h: 40 }, others, 6, { w: 40, h: 20 });
  assert.deepEqual([left.box.x, left.box.w], [220, 80], "dragging the left edge keeps the right edge put and matches the 80 wide block");
  const tiny = snapResize(before, { ...before, w: 44 }, [{ x: 600, y: 0, w: 38, h: 30 }], 8, { w: 42, h: 20 });
  assert.equal(tiny.box.w, 44, "never below the size the text needs");
});
