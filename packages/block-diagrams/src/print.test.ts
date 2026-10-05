import assert from "node:assert/strict";
import test from "node:test";
import { parseDiagram } from "./parse.js";
import { printDiagram } from "./print.js";
import type { DiagramModel } from "./model.js";

function semantic(model: DiagramModel) {
  const sort = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  return {
    meta: model.meta,
    nodes: sort(model.nodes),
    groups: sort(model.groups),
    edges: sort(model.edges),
    texts: sort(model.texts),
    layout: sort(model.layout),
  };
}

const SAMPLE = `title Checkout
direction right

node web "Web" shape rounded
text note "Draft"

group backend "Backend" {
  node api "API" shape server locked
  node db "Orders" shape cylinder color blue
}

edge web > api : "calls"
edge api --> db : "writes"

layout
  web 20 40 160 64
  api 240 40 160 80 locked
  db 460 40 140 100
  note 20 160 120 40
`;

test("printing and parsing returns the same diagram", () => {
  const first = parseDiagram(SAMPLE);
  assert.equal(first.diagnostics.length, 0);
  const printed = printDiagram(first.model);
  const second = parseDiagram(printed);
  assert.equal(second.diagnostics.length, 0);
  assert.deepEqual(semantic(second.model), semantic(first.model));
  assert.equal(printDiagram(second.model), printed);
});

test("canvas-style edits survive a round trip", () => {
  const parsed = parseDiagram(`title Boxes\ndirection down\n\nnode a "A" shape rectangle\nnode b "B" shape diamond\n\nedge a > b\n`);
  parsed.model.nodes.a!.locked = true;
  parsed.model.layout.a = { x: 12, y: 34, w: 160, h: 64 };
  parsed.model.layout.b = { x: 12, y: 160, w: 150, h: 100 };
  parsed.model.texts.caption = { text: "Hello", group: null, locked: false };
  parsed.model.layout.caption = { x: 200, y: 20, w: 120, h: 40 };
  const again = parseDiagram(printDiagram(parsed.model));
  assert.equal(again.diagnostics.length, 0);
  assert.equal(again.model.nodes.a?.locked, true);
  assert.equal(again.model.layout.a?.x, 12);
  assert.equal(again.model.layout.a?.y, 34);
  assert.equal(again.model.texts.caption?.text, "Hello");
  assert.equal(again.model.edges.e1?.to.node, "b");
});
