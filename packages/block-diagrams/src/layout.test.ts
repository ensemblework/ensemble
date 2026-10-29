import assert from "node:assert/strict";
import test from "node:test";
import { moveItems } from "./edit.js";
import { edgeLabelSize, groupMinWidth, layoutDiagram, layoutOverlaps, refitGroups, withoutOverlappingLayout } from "./layout.js";
import type { DiagramModel, LayoutBox } from "./model.js";
import { parseDiagram } from "./parse.js";
import { edgeEnds, edgeRoute } from "./route.js";

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

const GROUPED = `title Order pipeline
direction right
curve elbow

node shop "Storefront" shape browser
group intake "Intake" {
  node cart "Cart service" shape rectangle
  node checkout "Checkout" shape rectangle
  group fraud "Fraud checks with a title wider than its only block" {
    node score "Risk score" shape diamond
  }
}
group billing "Billing" {
  node invoice "Invoice" shape document
  node ledger "Ledger" shape cylinder
}
group shipping "Shipping" {
  node pick "Pick and pack" shape rectangle
  node label "Shipping label" shape rectangle
}
text caption "Every order passes fraud checks first."

edge shop > cart : "adds items"
edge cart > checkout : "submits"
edge checkout > score : "asks"
edge score > invoice : "approved"
edge invoice > ledger : "posts"
edge checkout > pick : "paid orders"
edge pick > label
edge ledger > label : "settled"
`;

function inside(inner: LayoutBox, outer: LayoutBox): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

function labelBoxes(model: DiagramModel): LayoutBox[] {
  return Object.values(model.edges).flatMap((edge) => {
    if (!edge.label) return [];
    const from = model.nodes[edge.from.node]!;
    const to = model.nodes[edge.to.node]!;
    const ends = edgeEnds({ shape: from.shape, box: model.layout[edge.from.node]!, port: edge.from.port }, { shape: to.shape, box: model.layout[edge.to.node]!, port: edge.to.port });
    const route = edgeRoute({ ...ends, curve: edge.curve, bend: edge.bend, arrows: edge.arrow });
    const size = edgeLabelSize(edge.label, edge.font);
    return [{ x: route.label.x - size.w / 2, y: route.label.y - size.h / 2, w: size.w, h: size.h }];
  });
}

test("groups are laid out as frames: siblings never overlap, members and nested groups sit inside, labels clear the blocks", async () => {
  const parsed = parseDiagram(GROUPED);
  assert.equal(parsed.diagnostics.length, 0);
  for (const fit of [undefined, "vertical", "horizontal"] as const) {
    const laid = await layoutDiagram(parsed.model, fit);
    assert.deepEqual(layoutOverlaps(laid), [], `overlaps after ${fit ?? "reorganize"}`);
    for (const [id, node] of Object.entries(laid.nodes)) {
      if (node.group) assert.ok(inside(laid.layout[id]!, laid.layout[node.group]!), `${id} inside ${node.group}`);
    }
    assert.ok(inside(laid.layout.fraud!, laid.layout.intake!), "nested group inside its parent");
    assert.ok(laid.layout.fraud!.w >= groupMinWidth(laid.groups.fraud!.label), "frame fits its title");
    const blocks = [...Object.keys(laid.nodes), ...Object.keys(laid.texts)].map((id) => laid.layout[id]!);
    const covered = labelBoxes(laid).filter((label) => blocks.some((box) => label.x < box.x + box.w && label.x + label.w > box.x && label.y < box.y + box.h && label.y + label.h > box.y));
    assert.ok(covered.length <= 1, `${covered.length} line labels on blocks after ${fit ?? "reorganize"}`);
  }
});

test("a saved layout with overlapping frames is reported, and dropped except for locked positions", () => {
  const parsed = parseDiagram(`direction right
group a "A" {
  node a1 "A one" shape rectangle
  node a2 "A two" shape rectangle
}
group b "B" {
  node b1 "B one" shape rectangle locked
}
node loose "Loose" shape rectangle
edge a1 > b1

layout
  a1 0 0 160 64
  a2 400 0 160 64
  b1 200 20 160 64 locked
  loose 900 0 160 64
`);
  const pairs = layoutOverlaps(parsed.model);
  assert.deepEqual(pairs, [["a", "b"]]);
  const dropped = withoutOverlappingLayout(parsed.model);
  assert.deepEqual(Object.keys(dropped.layout), ["b1"]);
  const clean = parseDiagram(`node x "X" shape rectangle
node y "Y" shape rectangle
layout
  x 0 0 160 64
  y 200 0 160 64
`).model;
  assert.equal(withoutOverlappingLayout(clean), clean);
});

test("moving a group carries everything inside it; a dropped block stays exactly where it lands", () => {
  const parsed = parseDiagram(`direction down
group outer "Outer" {
  node o1 "Outer one" shape rectangle
  group inner "Inner" {
    node i1 "Inner one" shape rectangle
  }
}
group fixed "Fixed" locked {
  node f1 "Fixed one" shape rectangle
}
group holder "Holder" {
  node h1 "Held" shape rectangle locked
}
node free "Free" shape rectangle

layout
  o1 40 60 160 64
  i1 40 200 160 64
  f1 400 60 160 64
  h1 700 60 160 64
  free 40 600 160 64
`);
  const model = parsed.model;
  const frame = refitGroups(model).layout.outer!;
  const moved = moveItems(model, [{ id: "outer", x: frame.x + 120, y: frame.y + 80 }]);
  assert.deepEqual([moved.layout.o1!.x, moved.layout.o1!.y], [160, 140]);
  assert.deepEqual([moved.layout.i1!.x, moved.layout.i1!.y], [160, 280]);
  assert.equal(moved.layout.outer!.x, frame.x + 120);
  assert.ok(inside(moved.layout.inner!, moved.layout.outer!));

  // Dropped on top of another block: it stays there, and nothing else is pushed.
  const dropped = moveItems(model, [{ id: "free", x: 50, y: 70 }]);
  assert.deepEqual([dropped.layout.free!.x, dropped.layout.free!.y], [50, 70]);
  assert.deepEqual([dropped.layout.o1!.x, dropped.layout.o1!.y], [40, 60]);

  // A locked group, its members, and a group holding a locked block stay put.
  assert.equal(moveItems(model, [{ id: "f1", x: 0, y: 0 }]), model);
  const fixed = refitGroups(model).layout.fixed!;
  assert.equal(moveItems(model, [{ id: "fixed", x: fixed.x + 50, y: fixed.y }]), model);
  const holder = refitGroups(model).layout.holder!;
  assert.equal(moveItems(model, [{ id: "holder", x: holder.x + 50, y: holder.y }]), model);
});
