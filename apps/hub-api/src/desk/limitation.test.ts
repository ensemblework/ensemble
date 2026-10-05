import assert from "node:assert/strict";
import test from "node:test";
import { daysBetween, limitationDue } from "./limitation.js";

test("s.4 carries Gandhi Jayanti across the weekend", () => {
  const hit = limitationDue("2026-09-02", "30d", [{ day: "2026-10-02", name: "Gandhi Jayanti" }], "2026-09-30");
  assert.equal(hit.raw, "2026-10-02");
  assert.equal(hit.due, "2026-10-05");
  assert.equal(hit.shifted, true);
  assert.equal(hit.days, 5);
  assert.match(hit.note ?? "", /s\.4/);
  assert.match(hit.note ?? "", /Gandhi Jayanti/);
});

test("a clear weekday is not moved", () => {
  const hit = limitationDue("2026-09-01", "30d", [], "2026-09-30");
  assert.equal(hit.due, "2026-10-01");
  assert.equal(hit.shifted, false);
  assert.equal(hit.note, null);
  assert.equal(hit.days, daysBetween("2026-09-30", "2026-10-01"));
});

test("a Sunday last day moves to Monday", () => {
  const hit = limitationDue("2026-09-04", "30d", [], "2026-09-30");
  assert.equal(hit.raw, "2026-10-04");
  assert.equal(hit.due, "2026-10-05");
  assert.match(hit.note ?? "", /court is closed/);
});

test("45 days lands on a Saturday holiday and names it", () => {
  const hit = limitationDue("2026-09-02", "45d", [{ day: "2026-10-17", name: "Dussehra" }], "2026-09-30");
  assert.equal(hit.raw, "2026-10-17");
  assert.equal(hit.due, "2026-10-19");
  assert.equal(hit.shifted, true);
  assert.match(hit.note ?? "", /Dussehra/);
  assert.match(hit.note ?? "", /s\.4/);
});

test("90 days moves off a named holiday", () => {
  const hit = limitationDue("2026-09-02", "90d", [{ day: "2026-12-01", name: "Foundation Day" }], "2026-09-30");
  assert.equal(hit.raw, "2026-12-01");
  assert.equal(hit.due, "2026-12-02");
  assert.match(hit.note ?? "", /Foundation Day/);
});

test("120 days moves off a named holiday", () => {
  const hit = limitationDue("2026-09-02", "120d", [{ day: "2026-12-31", name: "Court vacation" }], "2026-09-30");
  assert.equal(hit.raw, "2026-12-31");
  assert.equal(hit.due, "2027-01-01");
  assert.match(hit.note ?? "", /Court vacation/);
});

test("3 months moves off a named holiday", () => {
  const hit = limitationDue("2026-09-02", "3m", [{ day: "2026-12-02", name: "Local holiday" }], "2026-09-30");
  assert.equal(hit.raw, "2026-12-02");
  assert.equal(hit.due, "2026-12-03");
  assert.match(hit.note ?? "", /Local holiday/);
});

test("6 months moves off a named holiday", () => {
  const hit = limitationDue("2026-09-02", "6m", [{ day: "2027-03-02", name: "Holi" }], "2026-09-30");
  assert.equal(hit.raw, "2027-03-02");
  assert.equal(hit.due, "2027-03-03");
  assert.match(hit.note ?? "", /Holi/);
});

test("s.4 stops after 21 closed days", () => {
  const raw = "2026-10-05";
  const holidays = [];
  const cursor = new Date(Date.UTC(2026, 9, 5));
  for (let i = 0; i < 30; i += 1) {
    const day = cursor.toISOString().slice(0, 10);
    holidays.push({ day, name: "Long vacation" });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const hit = limitationDue("2026-09-05", "30d", holidays, "2026-09-30");
  assert.equal(hit.raw, raw);
  assert.equal(hit.due, "2026-10-26");
  assert.equal(daysBetween(raw, hit.due), 21);
  assert.equal(hit.shifted, true);
  assert.match(hit.note ?? "", /Long vacation/);
});
