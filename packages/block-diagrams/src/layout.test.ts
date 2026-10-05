import assert from "node:assert/strict";
import test from "node:test";
import { layoutDiagram } from "./layout.js";
import { parseDiagram } from "./parse.js";

test("reorganize keeps a locked block where it is", async () => {
  const parsed = parseDiagram(`direction down
node a "A" shape rectangle locked
node b "B" shape rectangle
node c "C" shape diamond
node d "D" shape cylinder
edge a > b
edge b > c
edge a > d
edge d > c

layout
  a 12 34 160 64 locked
  b 400 400 160 64
  c 20 400 150 100
  d 400 20 140 100
`);
  assert.equal(parsed.diagnostics.length, 0);
  const laid = await layoutDiagram(parsed.model);
  assert.equal(laid.layout.a?.x, 12);
  assert.equal(laid.layout.a?.y, 34);
  assert.equal(laid.nodes.a?.locked, true);
  const moved = ["b", "c", "d"].map((id) => laid.layout[id]!);
  assert.ok(moved.every((box) => Number.isFinite(box.x) && Number.isFinite(box.y)));
  const xs = new Set(moved.map((box) => Math.round(box.x)));
  const ys = new Set(moved.map((box) => Math.round(box.y)));
  assert.ok(xs.size > 1 || ys.size > 1);
  const locked = laid.layout.a!;
  for (const box of moved) {
    const gap = 8;
    const hits =
      box.x < locked.x + locked.w + gap &&
      box.x + box.w + gap > locked.x &&
      box.y < locked.y + locked.h + gap &&
      box.y + box.h + gap > locked.y;
    assert.equal(hits, false);
  }
});

test("a locked group keeps members that already have positions", async () => {
  const parsed = parseDiagram(`direction right
group team "Team" locked {
  node lead "Lead" shape actor
  node alex "Alex" shape actor
}
node extra "Extra" shape rectangle
edge lead > alex
edge alex > extra

layout
  lead 80 90 88 128
  alex 80 260 88 128
  extra 80 420 160 64
`);
  const laid = await layoutDiagram(parsed.model);
  assert.equal(laid.layout.lead?.x, 80);
  assert.equal(laid.layout.lead?.y, 90);
  assert.equal(laid.layout.alex?.x, 80);
  assert.equal(laid.layout.alex?.y, 260);
  assert.ok(laid.layout.extra);
  assert.ok(laid.layout.team);
  assert.ok(laid.layout.team!.w > 0 && laid.layout.team!.h > 0);
});
