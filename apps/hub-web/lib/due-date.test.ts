import assert from "node:assert/strict";
import test from "node:test";
import { dueDateProblem } from "./due-date";
import { isoDate } from "./format";

test("a due date keeps to years 1900-2200 and real days", () => {
  assert.equal(dueDateProblem(""), null, "empty clears the date");
  assert.equal(dueDateProblem("2026-10-16"), null);
  assert.equal(dueDateProblem("1900-01-01"), null);
  assert.equal(dueDateProblem("2200-12-31"), null);
  for (const slip of ["0201-10-16", "0002-10-16", "0020-10-16", "0202-10-16", "2201-01-01", "1899-12-31"]) {
    assert.match(dueDateProblem(slip) ?? "", /between 1900 and 2200/, slip);
  }
  assert.equal(dueDateProblem("2026-02-31"), "Pick a real date.");
  assert.equal(dueDateProblem("16/10/2026"), "Pick a real date.");
});

test("a stored three-digit year still fills the date field so it can be fixed", () => {
  const date = new Date(2026, 9, 16);
  date.setFullYear(201);
  assert.equal(isoDate(date), "0201-10-16");
  assert.equal(isoDate(new Date(2026, 9, 16)), "2026-10-16");
});
