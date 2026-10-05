import assert from "node:assert/strict";
import test from "node:test";
import { MARKET_CARDS } from "@ensemble/shared-types/marketplace-manifest";
import { MARKETPLACE, modulesRemoved } from "@ensemble/shared-types/marketplace";
import { personaBlock, quickActions } from "@ensemble/shared-types";
import { validateLayout } from "@ensemble/shared-types/widgets";
import { LayoutBody } from "../layouts/document.js";
import { MarketplaceTemplate, Measure, CATALOG } from "./schema.js";

test("every launch template parses, stays small, and obeys the registry", () => {
  assert.equal(CATALOG.length, 8);
  assert.ok(CATALOG.length <= 32);
  const ids = new Set(CATALOG.map((row) => row.id));
  assert.equal(ids.size, 8);
  for (const template of CATALOG) {
    assert.ok(JSON.stringify(template).length <= 32 * 1024, template.id);
    assert.equal(validateLayout("today", template.layouts.today).ok, true, template.id);
    assert.equal(validateLayout("context", template.layouts.context).ok, true, template.id);
    if (template.layouts.board) assert.equal(validateLayout("board", template.layouts.board).ok, true, template.id);
    assert.ok(template.highlights.length <= 4);
    if (template.modules.includes("metrics")) {
      assert.ok(template.modules.includes("runs") || template.modules.includes("workspace"));
    }
    for (const project of template.starters) {
      for (const person of project.people ?? []) assert.equal("email" in person, false);
    }
  }
  assert.equal(CATALOG.find((row) => row.id === "mkt.branch-desk")?.modules.length, 6);
  assert.equal(modulesRemoved(CATALOG.find((row) => row.id === "mkt.chambers")!).length, 6);
  // Diagrams suit every role, so every launch template keeps them. Code stays with the engineering ones.
  for (const template of CATALOG) assert.ok(template.modules.includes("diagrams"), template.id);
  assert.equal(CATALOG.find((row) => row.id === "mkt.chambers")?.modules.includes("code"), false);
});

test("the manifest matches the catalog and carries no starter rows", () => {
  assert.equal(JSON.stringify(MARKET_CARDS).includes("starter"), false);
  assert.equal(MARKET_CARDS.length, MARKETPLACE.length);
  for (const card of MARKET_CARDS) {
    const template = MARKETPLACE.find((row) => row.id === card.id);
    assert.ok(template);
    assert.equal(card.name, template.name);
    assert.equal(card.blurb, template.blurb);
    assert.deepEqual(
      [...card.removes].sort(),
      [...modulesRemoved(template)].sort(),
    );
    const widgets = [
      ...template.layouts.today.placements.map((row) => row.type),
      ...template.layouts.context.placements.map((row) => row.type),
      ...(template.layouts.board?.placements.map((row) => row.type) ?? []),
    ];
    assert.deepEqual(card.widgets, [...new Set(widgets)]);
  }
});

test("zod rejects a bad template, a 13th tile, a huge config, and a wild measure", () => {
  const base = MARKETPLACE[0]!;
  assert.equal(MarketplaceTemplate.safeParse({ ...base, blurb: "<script>alert(1)</script>" }).success, false);
  assert.equal(MarketplaceTemplate.safeParse({ ...base, modules: ["not-a-module"] }).success, false);
  assert.equal(MarketplaceTemplate.safeParse({ ...base, modules: ["metrics"] }).success, false);
  const thirteen = {
    v: 1,
    placements: Array.from({ length: 13 }, () => ({ type: "focus", size: "m" as const })),
  };
  assert.equal(LayoutBody.safeParse(thirteen).success, false);
  const bulky = {
    v: 2,
    placements: [{ type: "countdown", size: "s", config: { title: "x".repeat(600) } }],
  };
  const checked = validateLayout("today", bulky);
  assert.equal(checked.ok, false);
  assert.equal(Measure.safeParse(100001).success, false);
  assert.equal(Measure.safeParse(-1).success, false);
  assert.equal(Measure.safeParse(42).success, true);
});

test("new act-as values stay tone, and highlights stay at four", () => {
  for (const actAs of ["researcher", "manager", "aspirant", "maker"] as const) {
    const block = personaBlock(actAs);
    assert.match(block, new RegExp(`Act as: ${actAs}`));
    assert.match(block, /does not change permissions/);
    assert.doesNotMatch(block, /allowedWriteAreas|tool registry/i);
    assert.equal(quickActions(actAs, "today").length <= 4, true);
  }
  const lines = quickActions("maker", "today", ["One", "Two", "Three", "Four", "Five"]);
  assert.equal(lines.length, 4);
});
