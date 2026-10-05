import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { placeAnchoredPanel, placeCenteredPanel } from "./place-layer";

describe("placeCenteredPanel", () => {
  it("prefers 18vh when the panel fits", () => {
    const placed = placeCenteredPanel({ width: 1440, height: 900 }, 346);
    assert.equal(placed.width, 420);
    assert.equal(placed.left, (1440 - 420) / 2);
    assert.equal(placed.top, 900 * 0.18);
    assert.ok(placed.top + 346 <= 900 - 16);
  });

  it("pulls the panel up so the bottom margin stays clear", () => {
    const placed = placeCenteredPanel({ width: 800, height: 400 }, 346);
    assert.equal(placed.top, 400 - 16 - 346);
    assert.ok(placed.top + 346 <= 400 - 16);
  });

  it("keeps a narrow viewport inset and scrollable", () => {
    const placed = placeCenteredPanel({ width: 390, height: 844 }, 346);
    assert.equal(placed.width, 390 - 32);
    assert.equal(placed.left, 16);
    assert.ok(placed.top >= 16);
    assert.ok(placed.top + Math.min(346, placed.maxHeight) <= 844 - 16);
  });
});

describe("placeAnchoredPanel", () => {
  const anchor = { top: 100, right: 220, bottom: 132, left: 80 };

  it("opens below the anchor when there is room", () => {
    const placed = placeAnchoredPanel({
      anchor,
      panelWidth: 240,
      panelHeight: 180,
      viewport: { width: 1280, height: 800 },
    });
    assert.equal(placed.side, "below");
    assert.equal(placed.top, 136);
    assert.equal(placed.left, 80);
  });

  it("opens above when below cannot hold the panel", () => {
    const placed = placeAnchoredPanel({
      anchor: { top: 640, right: 220, bottom: 672, left: 80 },
      panelWidth: 240,
      panelHeight: 200,
      viewport: { width: 1280, height: 720 },
    });
    assert.equal(placed.side, "above");
    assert.ok(placed.top + 200 <= 640);
    assert.ok(placed.top >= 8);
  });

  it("keeps the previous side when the other side is only slightly larger", () => {
    const anchorBox = { top: 300, right: 200, bottom: 332, left: 40 };
    const first = placeAnchoredPanel({
      anchor: anchorBox,
      panelWidth: 200,
      panelHeight: 400,
      viewport: { width: 800, height: 640 },
    });
    const again = placeAnchoredPanel({
      anchor: anchorBox,
      panelWidth: 200,
      panelHeight: 401,
      viewport: { width: 800, height: 640 },
      previousSide: first.side,
    });
    assert.equal(again.side, first.side);
  });

  it("flips once when the current side cannot fit and the other side can", () => {
    const low = { top: 620, right: 200, bottom: 652, left: 40 };
    const placed = placeAnchoredPanel({
      anchor: low,
      panelWidth: 200,
      panelHeight: 180,
      viewport: { width: 800, height: 700 },
      previousSide: "below",
    });
    assert.equal(placed.side, "above");
  });

  it("clamps a right-aligned panel inside the viewport", () => {
    const placed = placeAnchoredPanel({
      anchor: { top: 40, right: 1270, bottom: 72, left: 1100 },
      panelWidth: 240,
      panelHeight: 120,
      viewport: { width: 1280, height: 800 },
      align: "right",
    });
    assert.ok(placed.left >= 8);
    assert.ok(placed.left + placed.width <= 1280 - 8);
  });
});
