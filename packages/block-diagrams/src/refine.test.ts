import assert from "node:assert/strict";
import test from "node:test";
import { explainDiagram } from "./explain.js";
import { errorCount, parseDiagram } from "./parse.js";
import { applyDiagramEdits } from "./refine.js";
import { DIAGRAM_TEMPLATES } from "./templates.js";
import { looksLikeMermaid, toMermaid } from "./mermaid.js";

const SOURCE = `title Flow
direction down

node a "Alpha" shape rectangle locked
node b "Beta" shape rectangle

group box "Box" {
  node c "Gamma" shape server
}

edge a > b

layout
  a 10 20 120 48 locked
  b 10 100 120 48
  c 200 20 140 64
`;

test("edits keep ids, locks, and layout", () => {
  assert.throws(() => applyDiagramEdits(SOURCE, [{ op: "remove_node", id: "a" }]), /locked/);
  assert.throws(() => applyDiagramEdits(SOURCE, [{ op: "move_to_group", id: "a", group: "box" }]), /locked/);
  const edited = applyDiagramEdits(SOURCE, [
    { op: "rename_node", id: "b", label: "Beta two" },
    { op: "set_node", id: "b", shape: "cylinder", color: "teal" },
    { op: "add_node", id: "cache", label: "Redis", shape: "cylinder" },
    { op: "add_edge", from: "b", to: "cache", label: "uses" },
    { op: "set_curve", curve: "elbow" },
    { op: "move_to_group", id: "b", group: "box" },
  ]);
  assert.match(edited.source, /node b "Beta two" shape cylinder color teal/);
  assert.match(edited.source, /node a "Alpha" shape rectangle locked/);
  assert.match(edited.source, /node cache "Redis" shape cylinder/);
  assert.match(edited.source, /a 10 20 120 48/);
  assert.equal(edited.model.nodes.a?.locked, true);
  assert.equal(edited.model.nodes.b?.group, "box");
  assert.equal(edited.model.layout.a?.x, 10);
  assert.ok(edited.changes.some((line) => line.includes("Added block")));
  assert.ok(edited.changes.some((line) => line.includes("Changed")));
  assert.equal(errorCount(parseDiagram(edited.source).diagnostics), 0);
});

test("a line patch cannot drop a lock", () => {
  const edited = applyDiagramEdits(SOURCE, [{ op: "patch", find: 'node b "Beta" shape rectangle', replace: 'node b "Beta" shape server' }]);
  assert.match(edited.source, /node a "Alpha" shape rectangle locked/);
  assert.match(edited.source, /node b "Beta" shape server/);
  assert.equal(edited.model.nodes.a?.locked, true);
});

test("templates parse clean and explain in plain language", () => {
  assert.ok(DIAGRAM_TEMPLATES.length >= 10);
  for (const template of DIAGRAM_TEMPLATES) {
    const parsed = parseDiagram(template.source);
    assert.deepEqual(parsed.diagnostics, [], template.id);
    const prose = explainDiagram(parsed.model);
    assert.match(prose, /goes to|contains|is a|is an/);
    const mermaid = toMermaid(parsed.model);
    assert.equal(looksLikeMermaid(mermaid), true);
    assert.equal(errorCount(parseDiagram(mermaid).diagnostics), 0);
  }
});
