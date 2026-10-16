import assert from "node:assert/strict";
import test from "node:test";
import { checkDeskFields, parseClock, type DeskField } from "./form-check";

const CLASS: DeskField[] = [
  { key: "title", label: "Class" },
  { key: "weekday", label: "Day", input: "select", options: [["1", "Mon"]] },
  { key: "start", label: "Start", placeholder: "09:00" },
  { key: "end", label: "End", placeholder: "10:15" },
  { key: "course", label: "Course", optional: true },
];

test("class times parse as a clock and reject 25:99", () => {
  assert.equal(parseClock("09:00"), 540);
  assert.equal(parseClock("9:05"), 545);
  assert.equal(parseClock("0905"), 545);
  assert.equal(parseClock("23:59"), 1439);
  for (const bad of ["25:99", "24:00", "12:60", "noon", "9", ""]) assert.equal(parseClock(bad), null, bad);
});

test("a class is checked before it is sent and keeps what was typed", () => {
  const ok = checkDeskFields(CLASS, { title: "Maths", weekday: "1", start: "9:00", end: "10:15" });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.start, "09:00", "times go to the API as HH:MM");
  const backwards = checkDeskFields(CLASS, { title: "Maths", weekday: "1", start: "11:00", end: "10:00" });
  assert.deepEqual(backwards.errors, { end: "End has to be after Start." });
  assert.equal(backwards.values.title, "Maths");
  const bad = checkDeskFields(CLASS, { title: "Maths", weekday: "1", start: "25:99", end: "10:00" });
  assert.deepEqual(bad.errors, { start: "Use a time like 09:00." });
  const empty = checkDeskFields(CLASS, {});
  assert.deepEqual(Object.keys(empty.errors), ["title", "weekday", "start", "end"]);
  assert.equal(empty.errors.weekday, "Choose a day.");
  assert.equal(empty.errors.title, "Class is required.");
});

test("attendance needs a status, and dates keep to a sane year", () => {
  const attendance: DeskField[] = [{ key: "name", label: "Name" }, { key: "present", label: "Status", input: "select", options: [["yes", "Present"], ["no", "Absent"]] }];
  assert.deepEqual(checkDeskFields(attendance, { name: "Asha" }).errors, { present: "Choose a status." });
  const reading: DeskField[] = [{ key: "title", label: "Title" }, { key: "day", label: "Date", input: "date", optional: true }];
  assert.deepEqual(checkDeskFields(reading, { title: "Ch. 3" }).errors, {});
  assert.match(checkDeskFields(reading, { title: "Ch. 3", day: "0201-10-16" }).errors.day ?? "", /between 1900 and 2200/);
});
