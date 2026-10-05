import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandGraph, presentDevGraph, readGraphDevQuery, seedGraph } from "./graph-fixture";
import {
  boxesIntersect,
  collisionRadius,
  countBoxOverlaps,
  directNeighbourIds,
  eligibleLabelIds,
  filterByNodeType,
  fitGraphView,
  footprintFor,
  footprintsOverlap,
  labelPriority,
  measureLabelBox,
  resolveOverlaps,
  truncateLabel,
  visibleLabelIds,
} from "./graph-readability";

describe("label truncation", () => {
  it("leaves short labels alone and ellipsizes long ones", () => {
    assert.equal(truncateLabel("Priya Nair", 18), "Priya Nair");
    const long = "Reply to Priya with the latency numbers";
    const cut = truncateLabel(long, 18);
    assert.ok(cut.endsWith("…"));
    assert.ok(cut.length < long.length);
    assert.equal([...cut].length, 18);
  });

  it("does not split Hindi, Japanese, or emoji graphemes", () => {
    const hindi = "प्रिया नायर";
    const japanese = "レイテンシ";
    const emoji = "Ship 🚀✨";
    for (const label of [hindi, japanese, emoji]) {
      const cut = truncateLabel(label, 4);
      assert.ok(cut.endsWith("…"));
      assert.equal(cut.includes("\uFFFD"), false);
    }
    assert.equal(truncateLabel("🚀✨🎯", 3), "🚀✨🎯");
    assert.equal(truncateLabel("🚀✨🎯", 2), "🚀…");
  });
});

describe("label priority and level of detail", () => {
  const nodes = [
    { id: "hub", kind: "project", degree: 8 },
    { id: "priya", kind: "people", degree: 4 },
    { id: "reply", kind: "task", degree: 2 },
    { id: "note", kind: "artifact", degree: 0 },
  ];

  it("ranks the selection, then the hover, then neighbours, then important hubs", () => {
    assert.ok(labelPriority({ kind: "task", degree: 0, selected: true }) < labelPriority({ kind: "project", degree: 12, hovered: true }));
    assert.ok(labelPriority({ kind: "task", degree: 0, hovered: true }) < labelPriority({ kind: "project", degree: 12, neighbor: true }));
    assert.ok(labelPriority({ kind: "artifact", degree: 0, neighbor: true }) < labelPriority({ kind: "project", degree: 9 }));
    assert.ok(labelPriority({ kind: "project", degree: 8 }) < labelPriority({ kind: "artifact", degree: 0 }));
    assert.ok(labelPriority({ kind: "task", degree: 6 }) < labelPriority({ kind: "task", degree: 1 }));
  });

  it("hides low-priority labels when zoomed out and reveals them as you zoom in", () => {
    const far = eligibleLabelIds(nodes, 0.4);
    assert.ok(far.includes("hub"));
    assert.equal(far.includes("note"), false);
    const near = eligibleLabelIds(nodes, 1.5);
    assert.deepEqual(new Set(near), new Set(nodes.map((node) => node.id)));
  });

  it("keeps the selected node, the hovered node, and their neighbours even when zoomed out", () => {
    const ids = eligibleLabelIds(
      [
        { id: "hub", kind: "project", degree: 1, selected: true },
        { id: "reply", kind: "task", degree: 0, neighbor: true },
        { id: "note", kind: "artifact", degree: 0, hovered: true },
        { id: "other", kind: "artifact", degree: 0 },
      ],
      0.35,
    );
    assert.ok(ids.includes("hub"));
    assert.ok(ids.includes("reply"));
    assert.ok(ids.includes("note"));
    assert.equal(ids.includes("other"), false);
    assert.equal(ids[0], "hub");
  });

  it("drops the lower-priority label when two chips collide", () => {
    const boxes = new Map([
      ["hub", { x: 0, y: 0, width: 80, height: 18 }],
      ["task", { x: 40, y: 4, width: 80, height: 18 }],
      ["free", { x: 200, y: 0, width: 40, height: 18 }],
    ]);
    const keep = visibleLabelIds(["hub", "task", "free"], boxes, 2);
    assert.equal(keep.has("hub"), true);
    assert.equal(keep.has("task"), false);
    assert.equal(keep.has("free"), true);
    assert.equal(countBoxOverlaps([boxes.get("hub")!, boxes.get("free")!]), 0);
    assert.equal(boxesIntersect(boxes.get("hub")!, boxes.get("task")!), true);
  });
});

describe("collision radius from the label box", () => {
  it("grows with label width and height, past the node radius", () => {
    const small = measureLabelBox("Hi", { maxChars: 28, fontSize: 12 });
    const wide = measureLabelBox("Reply to Priya with the latency numbers", { maxChars: 48, fontSize: 12 });
    const tall = { width: small.width, height: small.height * 3 };
    assert.ok(wide.width > small.width);
    assert.ok(collisionRadius(wide, 8) > collisionRadius(small, 8));
    assert.ok(collisionRadius(tall, 8) > collisionRadius(small, 8));
    assert.ok(collisionRadius(small, 8) > 8);
    const foot = footprintFor(wide, 8, 4);
    assert.ok(foot.right > foot.left);
    assert.ok(foot.top >= wide.height / 2);
  });

  it("separates two long labels so their footprints do not overlap", () => {
    const wide = measureLabelBox("Proposed: follow up with Shachee on the empty-state copy", { maxChars: 48 });
    const foot = footprintFor(wide, 8, 6);
    const points = resolveOverlaps([
      { id: "a", x: 0, y: 0, foot },
      { id: "b", x: 10, y: 4, foot },
      { id: "c", x: 6, y: 12, foot },
    ]);
    const placed = new Map(points.map((point) => [point.id, point]));
    for (const [left, right] of [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ] as const) {
      assert.equal(footprintsOverlap(placed.get(left)!, foot, placed.get(right)!, foot), false, `${left} overlaps ${right}`);
    }
  });
});

describe("neighbour highlight and type filter", () => {
  const edges = [
    { source: "hub", target: "priya", kind: "member" },
    { source: "priya", target: "reply", kind: "person" },
    { source: "hub", target: "adr", kind: "project" },
  ];

  it("highlights only the node and its direct neighbours", () => {
    const keep = directNeighbourIds("priya", edges);
    assert.deepEqual([...keep].sort(), ["hub", "priya", "reply"]);
    assert.equal(keep.has("adr"), false);
  });

  it("toggles node types off without touching the rest", () => {
    const nodes = [
      { id: "priya", kind: "people" },
      { id: "hub", kind: "project" },
      { id: "reply", kind: "task" },
    ];
    assert.deepEqual(
      filterByNodeType(nodes, ["task", "people"]).map((node) => node.id),
      ["hub"],
    );
    assert.equal(filterByNodeType(nodes, []).length, 3);
  });
});

describe("fit and synthetic scale", () => {
  it("caps zoom on a single node and still fits a wide graph", () => {
    const one = fitGraphView([{ x: 0, y: 0, width: 40, height: 20 }], { width: 1000, height: 600 }, { maxZoom: 1.2 });
    assert.ok(one.zoom <= 1.2);
    assert.ok(one.zoom > 1);
    const wide = fitGraphView([{ x: 0, y: 0, width: 4000, height: 2000 }], { width: 800, height: 500 }, { maxZoom: 1.2 });
    assert.ok(wide.zoom < 0.3);
    assert.ok(wide.zoom > 0);
  });

  it("builds about three copies and keeps the stress labels", () => {
    const nodes = [
      { id: "hub", kind: "project", label: "Ensemble Hub" },
      { id: "priya", kind: "people", label: "Priya Nair" },
    ];
    const edges = [{ source: "priya", target: "hub", kind: "member" }];
    const scaled = expandGraph(nodes, edges, 3);
    assert.ok(scaled.nodes.length >= nodes.length * 3);
    assert.ok(scaled.nodes.length < nodes.length * 3 + 8);
    assert.ok(scaled.nodes.some((node) => node.label.includes("प्रिया")));
    assert.ok(scaled.nodes.some((node) => node.label.includes("レイテンシ")));
    assert.ok(scaled.nodes.some((node) => node.label.includes("🚀")));
    assert.equal(expandGraph(nodes, edges, 1).nodes.length, 2);
    assert.equal(expandGraph(nodes, edges, 9).nodes.length, expandGraph(nodes, edges, 6).nodes.length);
  });

  it("loads the seed sample and triples it from the dev query", () => {
    const seed = seedGraph();
    assert.ok(seed.nodes.length >= 20);
    assert.equal(readGraphDevQuery("?tab=graph&graphScale=3").scale, 3);
    assert.equal(readGraphDevQuery("?graphScale=9").scale, 6);
    assert.equal(readGraphDevQuery("?graphFixture=seed").forceSeed, true);
    const scaled = presentDevGraph([], [], 3, false);
    assert.ok(scaled.nodes.length >= seed.nodes.length * 3);
    assert.ok(scaled.nodes.length < seed.nodes.length * 3 + 8);
    assert.equal(presentDevGraph(seed.nodes, seed.edges, 1, false).nodes.length, seed.nodes.length);
  });
});
