import assert from "node:assert/strict";
import test from "node:test";
import { PORTS, SHAPE_IDS } from "./model.js";
import { closestPorts, nodeSize, outlineSize, shapeGeometry, textFrame, wrapLabel } from "./shapes.js";

test("every shape exposes eight ports, and rectangle and cylinder sit on the outline", () => {
  for (const shape of SHAPE_IDS) {
    const geometry = shapeGeometry(shape, 160, 100);
    for (const port of PORTS) {
      const point = geometry.ports[port];
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `${shape}.${port}`);
      assert.ok(point.x >= -1 && point.x <= 161, `${shape}.${port} x ${point.x}`);
      assert.ok(point.y >= -1 && point.y <= 101, `${shape}.${port} y ${point.y}`);
    }
  }
  const rect = shapeGeometry("rectangle", 160, 80);
  assert.deepEqual(rect.ports.n, { x: 80, y: 1 });
  assert.deepEqual(rect.ports.e, { x: 159, y: 40 });
  assert.deepEqual(rect.ports.s, { x: 80, y: 79 });
  assert.deepEqual(rect.ports.w, { x: 1, y: 40 });
  assert.deepEqual(rect.ports.ne, { x: 159, y: 1 });
  assert.deepEqual(rect.ports.nw, { x: 1, y: 1 });
  assert.deepEqual(rect.ports.se, { x: 159, y: 79 });
  assert.deepEqual(rect.ports.sw, { x: 1, y: 79 });

  const cylinder = shapeGeometry("cylinder", 140, 100);
  assert.ok(cylinder.ports.n.y < cylinder.ports.e.y);
  assert.ok(cylinder.ports.e.y < cylinder.ports.s.y);
  assert.ok(cylinder.ports.e.x > cylinder.ports.n.x);
  assert.ok(cylinder.ports.w.x < cylinder.ports.n.x);
  assert.equal(cylinder.ports.n.x, cylinder.ports.s.x);

  const hex = shapeGeometry("hexagon", 160, 100);
  assert.equal(hex.ports.e.x, 159);
  assert.ok(hex.ports.e.y > hex.ports.ne.y && hex.ports.e.y < hex.ports.se.y);
  const para = shapeGeometry("parallelogram", 160, 80);
  assert.ok(para.ports.e.x < 159);
  assert.ok(para.ports.e.x > para.ports.w.x);
  const cloud = shapeGeometry("cloud", 160, 100);
  assert.ok(cloud.ports.e.x > cloud.ports.n.x);
  assert.ok(cloud.ports.n.y < cloud.ports.e.y);
  assert.ok(cloud.ports.s.y > cloud.ports.e.y);
  assert.ok(cloud.ports.w.x < cloud.ports.n.x);

  const diamond = shapeGeometry("diamond", 100, 80);
  assert.deepEqual(diamond.ports.ne, { x: 74.5, y: 20.5 });
  assert.deepEqual(diamond.ports.n, { x: 50, y: 1 });
  assert.deepEqual(diamond.ports.e, { x: 99, y: 40 });
});

test("an unnamed line uses the facing side, not the corners", () => {
  const above = { shape: "rectangle" as const, x: 10, y: 10, w: 120, h: 46 };
  const below = { shape: "rectangle" as const, x: 10, y: 72, w: 120, h: 46 };
  assert.deepEqual(closestPorts(above, below), { from: "s", to: "n" });
  assert.deepEqual(closestPorts(below, above), { from: "n", to: "s" });
  const left = { shape: "rectangle" as const, x: 10, y: 10, w: 120, h: 46 };
  const right = { shape: "rectangle" as const, x: 180, y: 10, w: 120, h: 46 };
  assert.deepEqual(closestPorts(left, right), { from: "e", to: "w" });
});

test("blocks grow so a label fits inside the outline on at most two lines", () => {
  const samples: Array<[Parameters<typeof nodeSize>[0], string]> = [
    ["cloud", "Email provider"],
    ["hexagon", "Gateway"],
    ["parallelogram", "Enter login"],
    ["diamond", "Valid?"],
    ["actor", "Customer"],
    ["server", "Billing API"],
    ["rounded", "Billing site"],
    ["circle", "Start"],
  ];
  for (const [shape, label] of samples) {
    const size = nodeSize(shape, label);
    const frame = textFrame(shape, size.w, size.h);
    const lines = wrapLabel(label, frame.w);
    assert.ok(lines.length <= 2, `${shape} wrapped to ${lines.length}`);
    assert.ok(lines.length * 16 <= frame.h + 1, `${shape} label is taller than the inner frame`);
    for (const line of lines) {
      assert.ok(line.length * 7.5 + 4 <= frame.w + 1, `${shape} line “${line}” is wider than the inner frame`);
    }
    if (shape === "actor") {
      const figure = outlineSize(shape, size.w, size.h);
      const geometry = shapeGeometry(shape, figure.w, figure.h);
      const lowest = Math.max(...PORTS.map((port) => geometry.ports[port].y));
      assert.ok(lowest < frame.y, `actor ports reach the label (${lowest} vs ${frame.y})`);
    }
  }
  const server = shapeGeometry("server", 140, 90);
  assert.match(server.details, /M 10 /);
  assert.equal(server.details.split("M").length - 1, 2);
});
