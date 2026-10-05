import assert from "node:assert/strict";
import test from "node:test";
import { errorCount, parseDiagram } from "./parse.js";

test("parses a canonical diagram with no diagnostics", () => {
  const parsed = parseDiagram(`title Login flow
direction down

node start "Start" shape circle
node check "Valid?" shape diamond
edge start > check : "go"
`);
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.model.meta.title, "Login flow");
  assert.equal(parsed.model.meta.direction, "down");
  assert.equal(parsed.model.nodes.start?.shape, "circle");
  assert.equal(parsed.model.nodes.check?.shape, "diamond");
  assert.equal(parsed.model.edges.e1?.label, "go");
  assert.equal(parsed.model.edges.e1?.arrow.end, "arrow");
});

test("tolerates a missing bracket and a missing colon", () => {
  const parsed = parseDiagram(`node start "Start" (circle
edge start > next yes
`);
  assert.equal(errorCount(parsed.diagnostics), 0);
  assert.equal(parsed.model.nodes.start?.shape, "circle");
  assert.equal(parsed.model.edges.e1?.label, "yes");
  assert.ok(parsed.diagnostics.some((item) => /missing/i.test(item.message) && item.line === 1));
  assert.ok(parsed.diagnostics.some((item) => /colon/i.test(item.message)));
});

test("unknown shapes become rectangles and close typos map to a real shape", () => {
  const parsed = parseDiagram(`node blob "Blob" shape notashape
node check "Check" shape dimond
node db "Users" shape db
`);
  assert.equal(errorCount(parsed.diagnostics), 0);
  assert.equal(parsed.model.nodes.blob?.shape, "rectangle");
  assert.equal(parsed.model.nodes.check?.shape, "diamond");
  assert.equal(parsed.model.nodes.db?.shape, "cylinder");
  assert.equal(parsed.diagnostics.filter((item) => item.line === 3).length, 0);
});

test("a bad line is skipped and the rest of the diagram remains", () => {
  const parsed = parseDiagram(`node start "Start" shape circle
this is not a diagram !!!
node next "Next" shape rectangle
edge start > next
`);
  assert.ok(errorCount(parsed.diagnostics) >= 1);
  assert.equal(parsed.diagnostics.find((item) => item.severity === "error")?.line, 2);
  assert.equal(parsed.model.nodes.start?.label, "Start");
  assert.equal(parsed.model.nodes.next?.label, "Next");
  assert.equal(parsed.model.edges.e1?.from.node, "start");
  assert.equal(parsed.model.edges.e1?.to.node, "next");
});

test("accepts aliases, short forms, chains, and one-to-many lines", () => {
  const parsed = parseDiagram(`start "Start" (circle)
home "Home" [rounded]
start > check > home
check > a, b : "fan"
`);
  assert.equal(errorCount(parsed.diagnostics), 0);
  assert.equal(parsed.model.nodes.start?.shape, "circle");
  assert.equal(parsed.model.nodes.home?.shape, "rounded");
  assert.equal(parsed.model.edges.e1?.to.node, "check");
  assert.equal(parsed.model.edges.e2?.to.node, "home");
  assert.equal(Object.keys(parsed.model.edges).length, 4);
});

test("reads groups, locked blocks, text boxes, ports, and layout", () => {
  const parsed = parseDiagram(`group backend "Backend" {
  node db "Users DB" shape cylinder
  group data "Data" locked {
    node cache "Cache" shape cylinder
  }
}
text caption "Rotate keys"
edge api.e > db.w : "query"

layout
  db 10 20 140 90
  caption 10 200 180 40 locked
`);
  assert.equal(errorCount(parsed.diagnostics), 0);
  assert.equal(parsed.model.nodes.db?.group, "backend");
  assert.equal(parsed.model.nodes.cache?.group, "data");
  assert.equal(parsed.model.groups.data?.parent, "backend");
  assert.equal(parsed.model.groups.data?.locked, true);
  assert.equal(parsed.model.texts.caption?.text, "Rotate keys");
  assert.equal(parsed.model.texts.caption?.locked, true);
  assert.equal(parsed.model.edges.e1?.from.port, "e");
  assert.equal(parsed.model.edges.e1?.to.port, "w");
  assert.deepEqual(parsed.model.layout.db, { x: 10, y: 20, w: 140, h: 90 });
});

test("keywords are case-insensitive and dashed arrows keep their style", () => {
  const parsed = parseDiagram(`TITLE Night
DIRECTION left
NODE a "A" SHAPE server
NODE b "B" SHAPE cloud
EDGE a --> b : "hop"
`);
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.model.meta.direction, "left");
  assert.equal(parsed.model.nodes.a?.shape, "server");
  assert.equal(parsed.model.edges.e1?.line, "dashed");
});
