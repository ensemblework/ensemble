import assert from "node:assert/strict";
import test from "node:test";
import { dayKey, parseDay, parseTime } from "./date-time.js";

// Thursday 12 November 2026.
const now = new Date(2026, 10, 12, 10, 0);
const day = (text: string) => {
  const found = parseDay(text, now);
  return found ? dayKey(found) : null;
};

test("a typed day reads words, weekdays, offsets, month names and ISO dates", () => {
  assert.equal(day("today"), "2026-11-12");
  assert.equal(day("Tomorrow"), "2026-11-13");
  assert.equal(day("fri"), "2026-11-13");
  assert.equal(day("thu"), "2026-11-19", "today's weekday is next week's");
  assert.equal(day("next week"), "2026-11-16", "the coming Monday");
  assert.equal(day("in 3 days"), "2026-11-15");
  assert.equal(day("2w"), "2026-11-26");
  assert.equal(day("14 nov"), "2026-11-14");
  assert.equal(day("Mar 3"), "2027-03-03", "a day already past this year is next year's");
  assert.equal(day("2026-02-30"), null, "no such day");
  assert.equal(day("soon"), null);
});

test("a typed time reads 24-hour, am/pm and words", () => {
  assert.equal(parseTime("9"), "09:00");
  assert.equal(parseTime("930"), "09:30");
  assert.equal(parseTime("9:30pm"), "21:30");
  assert.equal(parseTime("12am"), "00:00");
  assert.equal(parseTime("noon"), "12:00");
  assert.equal(parseTime("25:00"), null);
  assert.equal(parseTime("13pm"), null);
});
