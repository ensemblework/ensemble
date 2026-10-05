import assert from "node:assert/strict";
import test from "node:test";
import { arrange, emptyOrder, LANE_CAP, OrderError, sanitizeOrder, type LaneId } from "./order.js";

function owned(extra: Partial<Record<LaneId, string[]>> = {}): Record<LaneId, Set<string>> {
  return {
    people: new Set(extra.people ?? []),
    projects: new Set(extra.projects ?? []),
    repos: new Set(extra.repos ?? []),
    meetings: new Set(extra.meetings ?? []),
    artifacts: new Set(extra.artifacts ?? []),
  };
}

const ada = "11111111-1111-4111-8111-111111111111";
const grace = "22222222-2222-4222-8222-222222222222";
const foreign = "33333333-3333-4333-8333-333333333333";

test("sanitizeOrder drops ids the user does not own and caps the lane", () => {
  const ids = Array.from({ length: LANE_CAP + 5 }, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`);
  const mine = new Set(ids);
  const doc = sanitizeOrder({ view: "grid", lanes: { people: [...ids, foreign, ada, ada] } }, owned({ people: [...mine] }));
  assert.equal(doc.view, "grid");
  assert.equal(doc.lanes.people.length, LANE_CAP);
  assert.equal(doc.lanes.people.includes(foreign), false);
  assert.equal(doc.lanes.people.includes(ada), false);
});

test("sanitizeOrder rejects an oversized body", () => {
  const huge = { lanes: { people: "x".repeat(9_000) } };
  assert.throws(() => sanitizeOrder(huge, owned()), OrderError);
});

test("arrange puts the saved order first and keeps new cards", () => {
  const cards = [{ id: ada }, { id: grace }, { id: "44444444-4444-4444-8444-444444444444" }];
  const next = arrange(cards, [grace, ada, foreign]);
  assert.deepEqual(next.map((card) => card.id), [grace, ada, cards[2]!.id]);
});

test("empty order is a board grouped by kind", () => {
  const doc = emptyOrder();
  assert.equal(doc.view, "board");
  assert.equal(doc.group, "kind");
  assert.deepEqual(doc.lanes.people, []);
});
