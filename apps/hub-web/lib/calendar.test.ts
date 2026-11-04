import assert from "node:assert/strict";
import test from "node:test";
import type { CalendarEvent } from "./api.js";
import { conflicts, dayLabel, eventDays, eventPhase, eventsOn, sourceSummary } from "./calendar.js";

const event = (id: string, start: string, end: string | null, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({ id, title: id, start, end, allDay: false, joinUrl: null, location: null, ...extra });

test("an event lands on the person's days: timed by its zone, all-day by its own dates", () => {
  const late = event("late call", "2026-11-04T19:00:00Z", "2026-11-04T20:00:00Z");
  assert.deepEqual(eventDays(late, "UTC"), ["2026-11-04"]);
  assert.deepEqual(eventDays(late, "Asia/Kolkata"), ["2026-11-05"], "00:30 the next day in India");
  const overnight = event("flight", "2026-11-04T22:00:00Z", "2026-11-05T06:00:00Z");
  assert.deepEqual(eventDays(overnight, "UTC"), ["2026-11-04", "2026-11-05"]);
  const holiday = event("Diwali", "2026-11-08T00:00:00Z", "2026-11-09T00:00:00Z", { allDay: true, startDate: "2026-11-08", endDate: "2026-11-09" });
  assert.deepEqual(eventDays(holiday, "America/Los_Angeles"), ["2026-11-08"], "an all-day date never shifts with the zone");
  const trip = event("Offsite", "2026-11-09T00:00:00Z", null, { allDay: true, startDate: "2026-11-09", endDate: "2026-11-12" });
  assert.deepEqual(eventsOn([trip, holiday], "2026-11-11", "UTC").map((row) => row.id), ["Offsite"]);
});

test("overlapping timed events are marked; back-to-back and all-day ones are not", () => {
  const marked = conflicts([
    event("a", "2026-11-04T09:00:00Z", "2026-11-04T10:00:00Z"),
    event("b", "2026-11-04T09:30:00Z", "2026-11-04T10:30:00Z"),
    event("c", "2026-11-04T10:30:00Z", "2026-11-04T11:00:00Z"),
    event("d", "2026-11-04T00:00:00Z", "2026-11-05T00:00:00Z", { allDay: true }),
  ]);
  assert.deepEqual([...marked].sort(), ["a", "b"]);
});

test("sources read as one line, each calendar once; days read as Today and Tomorrow", () => {
  assert.equal(
    sourceSummary([
      { connector: "google_calendar", label: "Google", calendar: null, url: null },
      { connector: "outlook_calendar", label: "Outlook", calendar: null, url: null },
      { connector: "google_calendar", label: "Google", calendar: "Holidays", url: null },
    ]),
    "Google · Outlook",
  );
  assert.equal(dayLabel("2026-11-04", "2026-11-04"), "Today");
  assert.equal(dayLabel("2026-11-05", "2026-11-04"), "Tomorrow");
  assert.equal(dayLabel("2026-11-03", "2026-11-04"), "Yesterday");
  const now = Date.parse("2026-11-04T09:15:00Z");
  assert.equal(eventPhase(event("x", "2026-11-04T09:00:00Z", "2026-11-04T09:30:00Z"), now), "now");
  assert.equal(eventPhase(event("y", "2026-11-04T08:00:00Z", "2026-11-04T08:30:00Z"), now), "past");
});
