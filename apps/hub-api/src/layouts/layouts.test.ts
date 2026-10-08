import assert from "node:assert/strict";
import test from "node:test";
import { personaBlock, quickActions } from "@ensemble/shared-types";
import { templateByMarketId } from "@ensemble/shared-types/marketplace";
import { signupDeskId, TEMPLATES, templatesForRole } from "@ensemble/shared-types/templates";
import { TEMPLATE_CARDS, templateDeskLayout } from "@ensemble/shared-types/manifest";
import {
  findCollisions,
  moveByCell,
  moveToIndex,
  packPlacements,
  spanFor,
  validateLayout,
  withSize,
  type Placement,
} from "@ensemble/shared-types/widgets";
import { LayoutBody, parseLayout } from "./document.js";

const focus: Placement = { type: "focus", size: "l" };
const orbit: Placement = { type: "orbit", size: "m" };

test("pack stays inside the columns and does not overlap", () => {
  for (const [columns, phone] of [
    [12, false],
    [8, false],
    [4, false],
    [4, true],
  ] as const) {
    const packed = packPlacements([orbit, focus, { type: "reminders", size: "s" }, { type: "calendar", size: "m" }], columns, phone);
    assert.ok(packed);
    assert.equal(findCollisions(packed).length, 0);
    for (const rect of packed) {
      assert.ok(rect.x >= 0 && rect.y >= 0);
      assert.ok(rect.x + rect.w <= columns);
    }
  }
  assert.deepEqual(spanFor("xl", 12, false), { w: 12, h: 4 });
  assert.deepEqual(spanFor("l", 4, false), { w: 4, h: 3 });
  assert.deepEqual(spanFor("l", 4, true), { w: 4, h: 4 });
  assert.deepEqual(spanFor("xl", 4, true), { w: 4, h: 5 });
});

test("a size that cannot be packed is refused and the previous order stays", () => {
  const before: Placement[] = [focus, orbit];
  const packed = packPlacements(before, 0, false);
  assert.equal(packed, null);
  const same = withSize(before, "focus", "m", 12, false);
  assert.equal(same.find((row) => row.type === "focus")?.size, "m");
  const stuck = withSize(before, "orbit", "xl", 12, false);
  assert.equal(stuck.find((row) => row.type === "orbit")?.size, "m");
});

test("a second extra-large tile is refused and drag reorders by index", () => {
  const before: Placement[] = [
    { type: "focus", size: "xl" },
    { type: "reminders", size: "l" },
    orbit,
  ];
  const stuck = withSize(before, "reminders", "xl", 12, false);
  assert.equal(stuck.find((row) => row.type === "reminders")?.size, "l");
  const moved = moveToIndex(before, "orbit", 0);
  assert.deepEqual(
    moved.map((row) => row.type),
    ["orbit", "focus", "reminders"],
  );
  assert.deepEqual(moveToIndex(before, "orbit", 2), before);
  const row: Placement[] = [focus, { type: "deliverables", size: "l" }, { type: "calendar", size: "m" }, { type: "reminders", size: "s" }];
  assert.deepEqual(
    moveToIndex(row, "focus", 1).map((item) => item.type),
    ["deliverables", "focus", "calendar", "reminders"],
  );
  assert.deepEqual(
    moveToIndex(row, "focus", 3).map((item) => item.type),
    ["deliverables", "calendar", "focus", "reminders"],
  );
});

test("moving a tile swaps with the neighbour and does not invent coordinates", () => {
  const before: Placement[] = [orbit, focus];
  const next = moveByCell(before, "orbit", 1, 0, 12, false);
  assert.deepEqual(
    next.map((row) => row.type),
    ["focus", "orbit"],
  );
  assert.equal("x" in (next[0] as object), false);
});

test("zod and the registry reject illegal layouts", () => {
  const thirteen = {
    v: 1,
    placements: Array.from({ length: 13 }, (_, index) => ({ type: "focus", size: "m" as const, n: index })),
  };
  assert.equal(LayoutBody.safeParse(thirteen).success, false);
  assert.equal(validateLayout("today", { v: 1, placements: [{ type: "not-a-widget", size: "s" }] }).ok, false);
  assert.equal(validateLayout("today", { v: 1, placements: [{ type: "orbit", size: "xl" }] }).ok, false);
  assert.equal(
    validateLayout("today", {
      v: 1,
      placements: [
        { type: "focus", size: "m" },
        { type: "focus", size: "l" },
      ],
    }).ok,
    false,
  );
  assert.equal(
    validateLayout("today", {
      v: 1,
      placements: [
        { type: "focus", size: "xl" },
        { type: "deliverables", size: "xl" },
      ],
    }).ok,
    false,
  );
  assert.equal(validateLayout("today", { v: 1, placements: [{ type: "graph", size: "l" }] }).ok, false);
  const huge = { v: 1, placements: [], config: { note: "x".repeat(17_000) } };
  assert.throws(() => parseLayout("today", huge), /16 KB|unrecognized|unknown/i);
  assert.equal(validateLayout("board", { v: 1, placements: [] }).ok, true);
  const hand = [
    { x: 0, y: 0, w: 2, h: 2 },
    { x: 1, y: 1, w: 2, h: 2 },
  ];
  assert.equal(findCollisions(hand).length > 0, true);
});

test("templates match the cards and stay inside the registry", () => {
  assert.equal(TEMPLATES.length, 36);
  for (const role of ["student", "teacher", "lawyer", "engineer", "vibe", "manager"] as const) {
    assert.equal(templatesForRole(role).length, 6, role);
    const cards = TEMPLATE_CARDS.filter((card) => card.role === role);
    assert.equal(cards.length, 6, role);
    const shapes = new Set(cards.map((card) => card.tiles.map(([key, c, r]) => `${key}:${c}x${r}`).join(",")));
    assert.equal(shapes.size, 6, `${role} templates should not share a Today layout`);
    const heads = new Set(cards.map((card) => card.tiles[0]![0]));
    assert.ok(heads.size >= 5, `${role} templates should lead with different tiles`);
  }
  const ids = new Set(TEMPLATES.map((row) => row.id));
  assert.equal(ids.size, 36);
  assert.equal(TEMPLATE_CARDS.length, 36);
  for (const card of TEMPLATE_CARDS) {
    assert.ok(ids.has(card.id));
    assert.equal(TEMPLATES.find((row) => row.id === card.id)?.role, card.role, card.id);
    assert.equal(card.features.length, 3);
    for (const [key, c, r] of card.tiles) {
      assert.ok(key && c >= 3 && c <= 12 && r >= 2 && r <= 8, `${card.id} ${key}`);
    }
    assert.equal(new Set(card.tiles.map(([key]) => key)).size, card.tiles.length, `${card.id} repeats a tile`);
    assert.doesNotMatch(`${card.name} ${card.blurb} ${card.features.join(" ")}`, /—/);
  }
  for (const template of TEMPLATES) {
    assert.equal(validateLayout("today", template.today).ok, true, template.id);
    assert.equal(validateLayout("context", template.context).ok, true, template.id);
    if (template.board) assert.equal(validateLayout("board", template.board).ok, true, template.id);
    assert.ok(template.highlights.length <= 4);
    assert.equal(template.actAs, template.role === "vibe" ? "engineer" : template.role);
    for (const person of template.starter.people ?? []) {
      assert.equal("email" in person, false);
    }
  }
  const signature = (id: string) =>
    TEMPLATES.find((row) => row.id === id)
      ?.today.placements.map((item) => `${item.type}:${item.size}`)
      .join(",");
  assert.notEqual(signature("reading-pile"), signature("learn-by-shipping"));
  assert.notEqual(signature("partner-work"), signature("client-morning"));
  assert.equal(TEMPLATES.find((row) => row.id === "keep-it-small")?.board, null);
  assert.ok(TEMPLATES.find((row) => row.id === "branch-desk")?.board);
});

test("every signup template maps to a desk", () => {
  const ids = TEMPLATES.map((row) => row.id);
  assert.equal(new Set(ids).size, 36);
  for (const id of ids) {
    const desk = signupDeskId(id);
    assert.notEqual(desk, "default", `${id} should name a desk`);
    assert.ok(templateByMarketId(desk), desk);
  }
  assert.equal(signupDeskId("matter-desk"), "mkt.chambers");
  assert.equal(signupDeskId("exam-week"), "mkt.exam-season");
  assert.equal(signupDeskId("semester-desk"), "mkt.semester-desk");
  assert.equal(signupDeskId("reading-pile"), "mkt.literature-desk");
  assert.equal(signupDeskId("branch-desk"), "mkt.branch-desk");
  assert.equal(signupDeskId("one-idea"), "mkt.bench");
  assert.equal(signupDeskId("weeks-lessons"), "mkt.classes");
  assert.equal(signupDeskId("staff-week"), "mkt.staff-week");
  assert.equal(signupDeskId("one-on-ones"), "mkt.staff-week");
  assert.equal(signupDeskId("thesis-year"), "mkt.literature-desk");
  assert.equal(signupDeskId("nope"), "default");
  const layout = templateDeskLayout("exam-setter");
  assert.equal(layout?.key, "desk.layout.classes");
  assert.equal(layout?.value.exact, true);
  assert.deepEqual(layout?.value.tiles[0], { key: "countdown", c: 8, r: 4 });
  assert.equal(templateDeskLayout("nope"), null);
});

test("highlights stay suggestions and do not grant tools", () => {
  for (const actAs of ["general", "student", "engineer", "teacher", "lawyer"] as const) {
    assert.doesNotMatch(personaBlock(actAs), /Act as/);
    assert.doesNotMatch(personaBlock(actAs), /allowedWriteAreas|tool registry|permission/i);
  }
  const lines = quickActions("engineer", "today", ["One", "Two", "Three", "Four", "Five"]);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines, ["One", "Two", "Three", "Four"]);
  assert.ok(quickActions("student", "page").some((line) => /quiz/i.test(line)));
});
