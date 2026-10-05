import assert from "node:assert/strict";
import test from "node:test";
import { hexColor, seriesSwatchColor } from "./theme.js";

const theme = { accent: "#c2185b", dark: false };

test("the swatch for the first accent series is the accent the chart draws", () => {
  assert.equal(seriesSwatchColor({ palette: "accent", series: [{ y: "loss" }], colors: {} } as never, 0, theme), "#c2185b");
});

test("a single series takes the accent even on another palette", () => {
  assert.equal(seriesSwatchColor({ palette: "okabe-ito", series: [{ y: "loss" }], colors: {} } as never, 0, theme), "#c2185b");
});

test("an explicit series colour wins", () => {
  assert.equal(seriesSwatchColor({ palette: "accent", series: [{ y: "loss", color: "#00AA11" }], colors: {} } as never, 0, theme), "#00aa11");
});

test("colour inputs always get #rrggbb", () => {
  assert.equal(hexColor("#abc"), "#aabbcc");
  assert.equal(hexColor("rgb(12, 34, 255)"), "#0c22ff");
  assert.equal(hexColor("var(--accent)", "#123456"), "#123456");
});
