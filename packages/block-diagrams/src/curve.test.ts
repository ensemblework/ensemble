import assert from "node:assert/strict";
import test from "node:test";
import { parseDiagram } from "./parse.js";
import { printDiagram } from "./print.js";
import { renderDiagramSvg } from "./svg.js";
import { layoutDiagram } from "./layout.js";

const SAMPLE = `title Paths
direction right
curve elbow

node api "API" shape server
node db "Users DB" shape cylinder
node cache "Cache" shape cylinder

edge api > db
edge api > cache curve curved : "optional"
`;

test("a diagram curve is the default, and a line can override it", () => {
  const parsed = parseDiagram(SAMPLE);
  assert.equal(parsed.diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.equal(parsed.model.meta.curve, "elbow");
  const edges = Object.values(parsed.model.edges);
  assert.equal(edges.find((edge) => edge.to.node === "db")?.curve, "elbow");
  assert.equal(edges.find((edge) => edge.to.node === "cache")?.curve, "curved");
  const printed = printDiagram(parsed.model);
  assert.match(printed, /^curve elbow$/m);
  assert.match(printed, /edge api > cache : "optional" curve curved/);
  assert.doesNotMatch(printed, /edge api > db[^\n]*curve/);
  const again = parseDiagram(printed);
  assert.equal(again.model.meta.curve, "elbow");
  assert.equal(again.model.edges.e2?.curve, "curved");
});

test("an unknown curve warns and falls back to straight", () => {
  const parsed = parseDiagram(`curve wavy\nnode a "A" shape rectangle\nnode b "B" shape rectangle\nedge a > b curve spiral\n`);
  assert.equal(parsed.model.meta.curve, "straight");
  assert.equal(Object.values(parsed.model.edges)[0]?.curve, "straight");
  assert.ok(parsed.diagnostics.some((item) => item.message.includes("wavy")));
  assert.ok(parsed.diagnostics.some((item) => item.message.includes("spiral")));
});

test("a curve word inside a label is not a curve", () => {
  const parsed = parseDiagram(`node a "A" shape rectangle\nnode b "B" shape rectangle\nedge a > b : "curve elbow later"\n`);
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(Object.values(parsed.model.edges)[0]?.label, "curve elbow later");
  assert.equal(Object.values(parsed.model.edges)[0]?.curve, "straight");
});

test("svg export draws a curve, an elbow, and a straight line", () => {
  const parsed = parseDiagram(SAMPLE);
  parsed.model.layout = {
    api: { x: 20, y: 40, w: 140, h: 72 },
    db: { x: 240, y: 20, w: 120, h: 80 },
    cache: { x: 240, y: 140, w: 120, h: 64 },
  };
  const svg = renderDiagramSvg(parsed.model);
  assert.match(svg, /Q /);
  assert.match(svg, /L /);
  assert.doesNotMatch(svg, /<line /);
});

test("fit presets change direction and leave a locked block in place", async () => {
  const parsed = parseDiagram(`direction left
node a "A" shape rectangle locked
node b "B" shape rectangle
node c "C" shape rectangle
edge a > b
edge b > c

layout
  a 10 20 160 64 locked
  b 400 200 160 64
  c 40 300 160 64
`);
  const down = await layoutDiagram(parsed.model, "vertical");
  assert.equal(down.meta.direction, "down");
  assert.equal(down.layout.a?.x, 10);
  assert.equal(down.layout.a?.y, 20);
  const across = await layoutDiagram(parsed.model, "horizontal");
  assert.equal(across.meta.direction, "right");
  assert.equal(across.layout.a?.x, 10);
  assert.equal(across.layout.a?.y, 20);
  assert.ok(across.layout.b && across.layout.c);
  const spread = Math.abs((across.layout.b?.x ?? 0) - (across.layout.c?.x ?? 0));
  const drop = Math.abs((down.layout.b?.y ?? 0) - (down.layout.c?.y ?? 0));
  assert.ok(spread > 0 || drop > 0);
});
