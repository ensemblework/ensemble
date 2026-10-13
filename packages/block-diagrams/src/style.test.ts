import assert from "node:assert/strict";
import test from "node:test";
import { alignItems, connectBlocks, distributeItems, minItemSize, renameItem, resizeItem, setColor, setEdgeLook, setTextStyle } from "./edit.js";
import { SHAPE_IDS } from "./model.js";
import { errorCount, parseDiagram } from "./parse.js";
import { printDiagram } from "./print.js";
import { bendFromPoint, edgeRoute } from "./route.js";
import { minNodeSize, nodeSize, shapeGeometry } from "./shapes.js";
import { renderDiagramSvg } from "./svg.js";

const SOURCE = `title Styles
node a "Alpha" shape rectangle color blue font 16 bold
node b "Beta" shape queue italic underline
node bold "Bold block" shape browser
text t "Hello" font 18 bold

edge a > b : "uses" curve curved width 2.5 head 14 bend -30 font 12 italic
edge a > bold
`;

test("text size and emphasis, line width, arrowhead and bend read, print and read back the same", () => {
  const parsed = parseDiagram(SOURCE);
  assert.equal(errorCount(parsed.diagnostics), 0);
  assert.deepEqual(parsed.model.nodes.a!.font, { size: 16, bold: true, italic: false, underline: false });
  assert.deepEqual(parsed.model.nodes.b!.font, { size: null, bold: false, italic: true, underline: true });
  assert.equal(parsed.model.nodes.bold!.label, "Bold block", "a block named bold stays a block, not a style");
  assert.equal(parsed.model.nodes.bold!.font, undefined);
  assert.equal(parsed.model.texts.t!.font!.size, 18);
  const edge = parsed.model.edges.e1!;
  assert.deepEqual([edge.width, edge.head, edge.bend, edge.font?.size, edge.font?.italic, edge.label], [2.5, 14, -30, 12, true, "uses"]);
  const printed = printDiagram(parsed.model);
  assert.match(printed, /node a "Alpha" shape rectangle color blue font 16 bold/);
  assert.match(printed, /edge a > b : "uses" curve curved width 2.5 head 14 bend -30 font 12 italic/);
  assert.equal(printDiagram(parseDiagram(printed).model), printed);
  const unquoted = parseDiagram(`node a "A"\nnode b "B"\nedge a > b : make it bold\n`);
  assert.equal(unquoted.model.edges.e1!.label, "make it bold", "words in an unquoted label stay words");
  const clamped = parseDiagram(`node a "A" font 90\n`);
  assert.equal(clamped.model.nodes.a!.font!.size, 48);
  assert.match(clamped.diagnostics[0]!.message, /Text sizes go from 8 to 48/);
});

test("two blocks have one line between them: repeats fold into the first, reversed ones make it two-way", () => {
  const parsed = parseDiagram(`node a "A"\nnode b "B"\n\nedge a > b : "asks"\nedge a > b\nedge b > a : "answers"\n`);
  assert.equal(Object.keys(parsed.model.edges).length, 1);
  const edge = parsed.model.edges.e1!;
  assert.deepEqual(edge.arrow, { start: "arrow", end: "arrow" });
  assert.equal(edge.label, "asks / answers");
  assert.deepEqual(parsed.diagnostics.map((item) => [item.line, item.severity]), [[5, "info"], [6, "info"]]);
  const fix = parsed.diagnostics[0]!.fixes![0]!;
  assert.equal(fix.title, "Remove this line");
  const source = `node a "A"\nnode b "B"\n\nedge a > b : "asks"\nedge a > b\nedge b > a : "answers"\n`;
  assert.equal(source.slice(fix.from, fix.to), "edge a > b\n");
  assert.equal(printDiagram(parsed.model).match(/^edge /gm)?.length, 1);
  assert.equal(connectBlocks(parsed.model, { node: "b", port: null }, { node: "a", port: null }), null, "the canvas does not draw a second one");
  const mermaid = parseDiagram("flowchart LR\n  A --> B\n  A --> B\n  B --> A\n");
  assert.equal(Object.keys(mermaid.model.edges).length, 1);
});

test("a block resizes down only as far as its text allows, keeps its size on rename, and grows when the text needs it", () => {
  const model = parseDiagram(`node a "Payments service" shape rectangle\n\nlayout\n  a 0 0 200 80\n`).model;
  const min = minItemSize(model, "a");
  assert.ok(min.w < nodeSize("rectangle", "Payments service").w, "smaller than the default fit");
  assert.ok(min.w >= 7.5 * "Payments".length, "but never narrower than the longest word");
  const shrunk = resizeItem(model, "a", { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual([shrunk.layout.a!.w, shrunk.layout.a!.h], [min.w, min.h]);
  const wide = resizeItem(model, "a", { x: 0, y: 0, w: 320, h: 120 });
  assert.equal(renameItem(wide, "a", "Payments").layout.a!.w, 320, "a size the person chose stays");
  const tiny = resizeItem(model, "a", { x: 0, y: 0, w: min.w, h: min.h });
  const long = renameItem(tiny, "a", "Payments service with retries and a dead letter queue");
  assert.ok(long.layout.a!.w > min.w, "a label that no longer fits grows the block");
  const bigger = setTextStyle(tiny, ["a"], [], { size: 24, bold: true });
  assert.ok(bigger.layout.a!.w >= minNodeSize("rectangle", "Payments service", { size: 24, bold: true, italic: false, underline: false }).w);
  assert.equal(setTextStyle(bigger, ["a"], [], { size: null, bold: false }).nodes.a!.font, undefined, "back to plain drops the style");
  const circle = parseDiagram(`node c "Go" shape circle\n\nlayout\n  c 0 0 80 80\n`).model;
  const resized = resizeItem(circle, "c", { x: 0, y: 0, w: 140, h: 90 });
  assert.equal(resized.layout.c!.w, resized.layout.c!.h, "a circle stays round");
});

test("colour, line look, align and distribute", () => {
  const model = parseDiagram(`node a "A"\nnode b "B"\nnode c "C"\nedge a > b\n\nlayout\n  a 0 0 100 40\n  b 150 100 100 60\n  c 400 30 80 40\n`).model;
  assert.equal(setColor(model, ["a", "b"], "green").nodes.b!.color, "green");
  assert.equal(setColor(model, ["a"], null), model, "no change, same model");
  const look = setEdgeLook(model, ["e1"], { width: 3, head: 18, line: "dashed", bend: 40, label: "calls" });
  assert.deepEqual([look.edges.e1!.width, look.edges.e1!.head, look.edges.e1!.line, look.edges.e1!.bend, look.edges.e1!.label], [3, 18, "dashed", 40, "calls"]);
  const reset = setEdgeLook(look, ["e1"], { width: null, head: 10, curve: "elbow" });
  assert.deepEqual([reset.edges.e1!.width, reset.edges.e1!.head, reset.edges.e1!.bend], [undefined, undefined, undefined], "defaults and a new curve clear them");
  const left = alignItems(model, ["a", "b", "c"], "left");
  assert.deepEqual(["a", "b", "c"].map((id) => left.layout[id]!.x), [0, 0, 0]);
  const middle = alignItems(model, ["a", "b"], "middle");
  assert.equal(middle.layout.a!.y + middle.layout.a!.h / 2, middle.layout.b!.y + middle.layout.b!.h / 2);
  const spread = distributeItems(model, ["a", "b", "c"], "horizontal");
  const gaps = [spread.layout.b!.x - (spread.layout.a!.x + spread.layout.a!.w), spread.layout.c!.x - (spread.layout.b!.x + spread.layout.b!.w)];
  assert.ok(Math.abs(gaps[0]! - gaps[1]!) <= 1, `even gaps ${gaps.join(", ")}`);
});

test("routes: the stroke stops under each arrowhead, a bend moves the middle, and the handle point gives the bend back", () => {
  const base = { from: { x: 0, y: 0 }, to: { x: 200, y: 0 }, fromPort: "e" as const, toPort: "w" as const, arrows: { start: "none" as const, end: "arrow" as const } };
  const straight = edgeRoute({ ...base, curve: "straight", head: 20 });
  assert.equal(straight.heads.length, 1);
  assert.match(straight.d, /^M 0 0 L 184 0$/, "pulled back 0.8 × the head");
  const bent = edgeRoute({ ...base, curve: "straight", bend: 40 });
  assert.deepEqual(bent.label, { x: 100, y: 40 });
  assert.equal(bendFromPoint({ ...base, curve: "straight" }, { x: 100, y: 40 }), 40);
  assert.equal(bendFromPoint({ ...base, curve: "straight" }, { x: 100, y: 3 }), 0, "close to straight snaps straight");
  const curved = edgeRoute({ ...base, curve: "curved", bend: -30 });
  assert.ok(Math.abs(curved.label.y + 30) < 0.5);
  const elbow = edgeRoute({ ...base, to: { x: 200, y: 120 }, curve: "elbow", bend: 30 });
  assert.equal(elbow.label.x, 130);
  assert.equal(bendFromPoint({ ...base, to: { x: 200, y: 120 }, curve: "elbow" }, { x: 130, y: 60 }), 30);
  const corner = edgeRoute({ ...base, toPort: "n", to: { x: 200, y: 120 }, curve: "elbow" });
  assert.equal(corner.bendable, false);
  const svg = renderDiagramSvg(parseDiagram(SOURCE).model);
  assert.match(svg, /stroke-width="2.5"/);
  assert.match(svg, /font-size="16" font-weight="700"/);
  assert.match(svg, /font-style="italic"/);
  assert.match(svg, /text-decoration="underline"/);
});

test("the new shapes have outlines, ports on them, and room for a label", () => {
  for (const shape of ["queue", "subroutine", "browser", "delay"] as const) {
    assert.ok((SHAPE_IDS as readonly string[]).includes(shape));
    const size = nodeSize(shape, "Orders stream");
    const geometry = shapeGeometry(shape, size.w, size.h);
    assert.match(geometry.outline, /^M /);
    for (const port of Object.values(geometry.ports)) {
      assert.ok(port.x >= 0 && port.x <= size.w && port.y >= 0 && port.y <= size.h, `${shape} port inside its box`);
    }
  }
  const parsed = parseDiagram(`node q "Events" shape kafka\nnode w "Site" shape web\nnode s "Charge" shape subprocess\nnode d "Wait a day" shape wait\n`);
  assert.deepEqual(Object.values(parsed.model.nodes).map((node) => node.shape), ["queue", "browser", "subroutine", "delay"]);
  assert.equal(parsed.diagnostics.length, 0);
});
