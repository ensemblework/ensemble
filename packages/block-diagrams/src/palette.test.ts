import assert from "node:assert/strict";
import test from "node:test";
import { COLORS, SHAPE_IDS } from "./model.js";
import { PALETTE, SHAPE_COLOR, paintFor } from "./palette.js";
import { parseDiagram } from "./parse.js";
import { renderDiagramSvg } from "./svg.js";

test("every shape has its own soft default, and a named color overrides it", () => {
  for (const shape of SHAPE_IDS) {
    const light = paintFor(shape, null, "light");
    const dark = paintFor(shape, null, "dark");
    assert.equal(light.fill, PALETTE.light[SHAPE_COLOR[shape]].fill);
    assert.notEqual(light.fill, light.stroke);
    assert.notEqual(dark.fill, light.fill);
    assert.match(light.text, /^#[0-9a-f]{6}$/);
    assert.match(dark.text, /^#[0-9a-f]{6}$/);
  }
  for (const name of COLORS) {
    assert.notEqual(PALETTE.light[name].fill, PALETTE.dark[name].fill);
  }
  const overridden = paintFor("rectangle", "red", "light");
  assert.equal(overridden.fill, PALETTE.light.red.fill);
  assert.notEqual(overridden.fill, paintFor("rectangle", null, "light").fill);
});

test("svg export uses the shape palette, thin strokes, and a color override", () => {
  const parsed = parseDiagram(`title Palette
node start "Start" shape circle
node stop "Stop" shape rectangle color red
edge start > stop : "go"
`);
  const light = renderDiagramSvg(parsed.model, { theme: "light" });
  const dark = renderDiagramSvg(parsed.model, { theme: "dark" });
  assert.match(light, new RegExp(PALETTE.light.green.fill));
  assert.match(light, new RegExp(PALETTE.light.red.fill));
  assert.match(light, /stroke-width="1.35"/);
  assert.match(dark, new RegExp(PALETTE.dark.green.fill));
  assert.doesNotMatch(dark, new RegExp(PALETTE.light.green.fill));
});
