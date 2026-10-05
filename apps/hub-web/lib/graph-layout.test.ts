import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layoutGraph, partitionGraph } from "./graph-layout";
import { footprintFor, footprintsOverlap, measureLabelBox } from "./graph-readability";

describe("graph layout", () => {
  it("splits isolated nodes from the connected graph", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const parts = partitionGraph(nodes, [{ source: "a", target: "b" }]);
    assert.deepEqual(parts.linked.map((node) => node.id), ["a", "b"]);
    assert.deepEqual(parts.isolated.map((node) => node.id), ["c"]);
  });

  it("does not park a chain on a fixed ring", () => {
    const nodes = Array.from({ length: 6 }, (_, index) => ({ id: `n${index}` }));
    const edges = nodes.slice(1).map((node, index) => ({ source: nodes[index]!.id, target: node.id }));
    const pos = layoutGraph(nodes, edges, {});
    const points = [...pos.values()];
    assert.equal(points.length, 6);
    const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const radii = points.map((point) => Math.hypot(point.x - cx, point.y - cy));
    const mean = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
    const spread = Math.sqrt(radii.reduce((sum, radius) => sum + (radius - mean) ** 2, 0) / radii.length);
    assert.ok(spread > 20, `ring spread ${spread}`);
    const ends = Math.hypot(pos.get("n0")!.x - pos.get("n5")!.x, pos.get("n0")!.y - pos.get("n5")!.y);
    const step = Math.hypot(pos.get("n0")!.x - pos.get("n1")!.x, pos.get("n0")!.y - pos.get("n1")!.y);
    assert.ok(ends > step, "the chain should stretch past one hop");
  });

  it("keeps a connected graph finite and free of label overlap", () => {
    const nodes = [
      { id: "matter", label: "Ensemble Hub" },
      { id: "rao", label: "Priya Nair" },
      { id: "sen", label: "Rahul Mehta" },
      { id: "task", label: "Reply to Priya with the latency numbers" },
      { id: "filing", label: "प्रिया नायर के साथ विलंबता की समीक्षा" },
    ];
    const edges = [
      { source: "rao", target: "matter" },
      { source: "sen", target: "matter" },
      { source: "task", target: "matter" },
      { source: "task", target: "rao" },
      { source: "filing", target: "task" },
    ];
    const pos = layoutGraph(nodes, edges, {});
    const feet = new Map(nodes.map((node) => [node.id, footprintFor(measureLabelBox(node.label), 8, 8)]));
    for (const point of pos.values()) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    }
    const ids = nodes.map((node) => node.id);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i]!;
        const b = ids[j]!;
        assert.equal(footprintsOverlap(pos.get(a)!, feet.get(a)!, pos.get(b)!, feet.get(b)!), false, `${a} overlaps ${b}`);
      }
    }
  });

  it("groups an edgeless set as a cluster instead of a ring", () => {
    const nodes = Array.from({ length: 8 }, (_, index) => ({ id: `u${index}` }));
    const pos = layoutGraph(nodes, [], {});
    const points = [...pos.values()];
    const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const radii = points.map((point) => Math.hypot(point.x - cx, point.y - cy));
    const mean = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
    const unique = new Set(radii.map((radius) => Math.round(radius)));
    assert.ok(unique.size > 1 || mean < 80, "isolates should not share one orbit");
    const maxX = Math.max(...points.map((point) => point.x));
    const minX = Math.min(...points.map((point) => point.x));
    assert.ok(maxX - minX < 700);
  });
});
