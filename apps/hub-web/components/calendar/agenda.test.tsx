import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { CalendarEvent, CalendarSourceState } from "../../lib/api.js";
import { CalendarStatus, ConnectCalendar, DayAgenda } from "./agenda.js";

// next/link schedules its viewport prefetch through `self`, which jsdom leaves off the global scope.
(globalThis as { self?: unknown }).self ??= window;

const GOOGLE = { connector: "google_calendar", label: "Google", calendar: "Mira", url: "https://calendar.google.com/event?eid=1" };
const OUTLOOK = { connector: "outlook_calendar", label: "Outlook", calendar: "Calendar", url: null };
const TEAMS = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0";

async function render(node: React.ReactNode): Promise<{ host: HTMLElement; done: () => Promise<void> }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("a day shows all-day events on top, one row per merged event with its sources, Join for meetings and a mark on overlaps", async () => {
  const events: CalendarEvent[] = [
    { id: "lunch", title: "Team lunch", start: "2026-11-04T07:45:00Z", end: "2026-11-04T08:45:00Z", allDay: false, joinUrl: null, location: "Café Mira", sources: [GOOGLE] },
    { id: "sprint", title: "Sprint review", start: "2026-11-04T07:30:00Z", end: "2026-11-04T08:00:00Z", allDay: false, joinUrl: TEAMS, meetingUrl: TEAMS, location: "Microsoft Teams Meeting", sources: [GOOGLE, OUTLOOK], url: GOOGLE.url },
    { id: "xmas", title: "Christmas", start: "2026-11-04T00:00:00Z", end: "2026-11-05T00:00:00Z", allDay: true, startDate: "2026-11-04", endDate: "2026-11-05", joinUrl: null, location: null, sources: [GOOGLE, OUTLOOK] },
  ];
  const view = await render(<DayAgenda events={events} day="2026-11-04" zone="UTC" now={Date.parse("2026-11-04T06:00:00Z")} />);
  try {
    const { host } = view;
    const strip = host.querySelector('[aria-label="All day"]')!;
    assert.ok(strip, "all-day strip");
    assert.ok(strip.compareDocumentPosition(host.querySelector('[aria-label="Events"]')!) & Node.DOCUMENT_POSITION_FOLLOWING, "all-day events come first");
    const rows = [...host.querySelectorAll<HTMLElement>(".cal-row")];
    assert.deepEqual(rows.map((row) => row.dataset.event), ["sprint", "lunch"], "timed events in time order, each once");
    const sprint = rows[0]!;
    assert.equal(sprint.querySelector(".cal-dots")?.getAttribute("title"), "Google · Outlook");
    assert.equal(sprint.querySelector(".cal-dots")?.getAttribute("aria-label"), "From Google · Outlook");
    const join = sprint.querySelector<HTMLAnchorElement>(".cal-join")!;
    assert.equal(join.getAttribute("href"), TEAMS);
    assert.equal(join.getAttribute("aria-label"), "Join Sprint review");
    assert.equal(sprint.querySelector(".cal-place"), null, "Outlook's 'Microsoft Teams Meeting' place is not repeated beside Join");
    assert.ok(rows.every((row) => row.classList.contains("cal-row-conflict")), "the two overlapping meetings are marked");
    assert.equal(rows[1]!.querySelector(".cal-join"), null, "no Join without an online meeting");
    assert.match(rows[1]!.textContent ?? "", /Café Mira/);
  } finally {
    await view.done();
  }
});

test("an empty day says so; no calendar asks to connect one; a failing source points to Settings", async () => {
  const empty = await render(<DayAgenda events={[]} day="2026-11-04" zone="UTC" />);
  assert.match(empty.host.textContent ?? "", /Nothing scheduled/);
  await empty.done();

  const connect = await render(<ConnectCalendar />);
  const links = [...connect.host.querySelectorAll("a")].map((link) => [link.textContent?.trim(), link.getAttribute("href")]);
  assert.deepEqual(links, [["Connect a calendar", "/settings?tab=connections&store=suites"], ["Add by link", "/settings?tab=connections#calendars"]]);
  await connect.done();

  const sources: CalendarSourceState[] = [
    { connector: "google_calendar", id: null, label: "Google", lastSyncAt: new Date().toISOString(), lastError: null },
    { connector: "ics_calendar", id: "f1", label: "Holidays", lastSyncAt: null, lastError: "That link answered 404." },
  ];
  const status = await render(<CalendarStatus sources={sources} />);
  assert.match(status.host.textContent ?? "", /Google · Holidays/);
  const warning = status.host.querySelector<HTMLAnchorElement>(".cal-status-error")!;
  assert.match(warning.textContent ?? "", /Holidays needs attention/);
  assert.equal(warning.getAttribute("title"), "That link answered 404.");
  await status.done();
});
