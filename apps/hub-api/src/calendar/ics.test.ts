import assert from "node:assert/strict";
import test from "node:test";
import { expandWall, parseIcs, parseRule, unescapeText } from "./ics.js";

const window = (from: string, to: string) => ({ from: new Date(from), to: new Date(to), defaultTimeZone: "Asia/Kolkata" });
const feed = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fieldnote//Test//EN", ...lines, "END:VCALENDAR"].join("\r\n");
const iso = (date: Date | null) => date?.toISOString() ?? null;

test("holiday feed: all-day dates stay calendar dates, with the feed's name", () => {
  const out = parseIcs(
    feed(
      "X-WR-CALNAME:Holidays in India",
      "BEGIN:VEVENT", "UID:20261225_christmas@google.com", "DTSTART;VALUE=DATE:20261225", "DTEND;VALUE=DATE:20261226", "SUMMARY:Christmas", "END:VEVENT",
      "BEGIN:VEVENT", "UID:20261108_diwali@google.com", "DTSTART;VALUE=DATE:20261108", "SUMMARY:Diwali/Deepavali", "END:VEVENT",
      "BEGIN:VEVENT", "UID:old@google.com", "DTSTART;VALUE=DATE:20250101", "SUMMARY:Out of range", "END:VEVENT",
    ),
    window("2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z"),
  );
  assert.equal(out.name, "Holidays in India");
  assert.deepEqual(out.events.map((row) => [row.title, row.startDate, row.endDate, row.allDay]), [
    ["Christmas", "2026-12-25", "2026-12-26", true],
    ["Diwali/Deepavali", "2026-11-08", "2026-11-09", true],
  ]);
});

test("time zones: IANA, Windows names, a VTIMEZONE with only rules, UTC and floating", () => {
  const out = parseIcs(
    feed(
      "X-WR-TIMEZONE:Europe/Berlin",
      "BEGIN:VTIMEZONE", "TZID:Customized Time Zone",
      "BEGIN:STANDARD", "DTSTART:16011104T020000", "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "END:STANDARD",
      "BEGIN:DAYLIGHT", "DTSTART:16010311T020000", "RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "END:DAYLIGHT",
      "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:ny", "DTSTART;TZID=America/New_York:20261104T090000", "DTEND;TZID=America/New_York:20261104T093000", "SUMMARY:NY standup", "END:VEVENT",
      "BEGIN:VEVENT", "UID:win", "DTSTART;TZID=India Standard Time:20261104T150000", "DURATION:PT1H", "SUMMARY:Roadmap", "END:VEVENT",
      "BEGIN:VEVENT", "UID:custom-winter", "DTSTART;TZID=Customized Time Zone:20261110T100000", "SUMMARY:Winter", "END:VEVENT",
      "BEGIN:VEVENT", "UID:custom-summer", "DTSTART;TZID=Customized Time Zone:20260610T100000", "SUMMARY:Summer", "END:VEVENT",
      "BEGIN:VEVENT", "UID:utc", "DTSTART:20261104T120000Z", "DTEND:20261104T130000Z", "SUMMARY:UTC", "END:VEVENT",
      "BEGIN:VEVENT", "UID:floating", "DTSTART:20261104T100000", "SUMMARY:Floating", "END:VEVENT",
      "BEGIN:VEVENT", "UID:mozilla", 'DTSTART;TZID="/mozilla.org/20070129_1/Asia/Tokyo":20261104T090000', "SUMMARY:Tokyo", "END:VEVENT",
    ),
    window("2026-06-01T00:00:00Z", "2026-12-01T00:00:00Z"),
  );
  const by = Object.fromEntries(out.events.map((row) => [row.uid, row]));
  assert.equal(iso(by.ny!.start), "2026-11-04T14:00:00.000Z", "New York is UTC−5 after the November change");
  assert.equal(iso(by.ny!.end), "2026-11-04T14:30:00.000Z");
  assert.equal(iso(by.win!.start), "2026-11-04T09:30:00.000Z");
  assert.equal(iso(by.win!.end), "2026-11-04T10:30:00.000Z");
  assert.equal(iso(by["custom-winter"]!.start), "2026-11-10T15:00:00.000Z");
  assert.equal(iso(by["custom-summer"]!.start), "2026-06-10T14:00:00.000Z");
  assert.equal(iso(by.utc!.start), "2026-11-04T12:00:00.000Z");
  assert.equal(iso(by.floating!.start), "2026-11-04T09:00:00.000Z", "floating times use the feed's X-WR-TIMEZONE");
  assert.equal(by.floating!.end, null);
  assert.equal(iso(by.mozilla!.start), "2026-11-04T00:00:00.000Z");
});

test("weekly series: COUNT, EXDATE, a moved occurrence and a cancelled one", () => {
  const out = parseIcs(
    feed(
      "BEGIN:VEVENT", "UID:standup@fieldnote", "DTSTART;TZID=Europe/London:20261026T093000", "DTEND;TZID=Europe/London:20261026T094500",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=8", "EXDATE;TZID=Europe/London:20261028T093000", "SUMMARY:Standup", "END:VEVENT",
      "BEGIN:VEVENT", "UID:standup@fieldnote", "RECURRENCE-ID;TZID=Europe/London:20261030T093000", "DTSTART;TZID=Europe/London:20261030T110000", "DTEND;TZID=Europe/London:20261030T111500", "SUMMARY:Standup (moved)", "END:VEVENT",
      "BEGIN:VEVENT", "UID:standup@fieldnote", "RECURRENCE-ID;TZID=Europe/London:20261102T093000", "DTSTART;TZID=Europe/London:20261102T093000", "STATUS:CANCELLED", "SUMMARY:Standup", "END:VEVENT",
    ),
    window("2026-10-26T00:00:00Z", "2026-11-30T00:00:00Z"),
  );
  const rows = out.events.map((row) => [row.title, iso(row.start), iso(row.instanceStart), row.cancelled]);
  assert.deepEqual(rows, [
    ["Standup", "2026-10-26T09:30:00.000Z", "2026-10-26T09:30:00.000Z", false],
    ["Standup", "2026-11-04T09:30:00.000Z", "2026-11-04T09:30:00.000Z", false],
    ["Standup", "2026-11-06T09:30:00.000Z", "2026-11-06T09:30:00.000Z", false],
    ["Standup", "2026-11-09T09:30:00.000Z", "2026-11-09T09:30:00.000Z", false],
    ["Standup", "2026-11-11T09:30:00.000Z", "2026-11-11T09:30:00.000Z", false],
    ["Standup (moved)", "2026-10-30T11:00:00.000Z", "2026-10-30T09:30:00.000Z", false],
    ["Standup", "2026-11-02T09:30:00.000Z", "2026-11-02T09:30:00.000Z", true],
  ]);
});

test("monthly and yearly rules: last Friday, BYSETPOS, a birthday from long ago, UNTIL", () => {
  const out = parseIcs(
    feed(
      "BEGIN:VEVENT", "UID:retro", "DTSTART:20260130T150000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYDAY=-1FR", "SUMMARY:Retro", "END:VEVENT",
      "BEGIN:VEVENT", "UID:payday", "DTSTART;VALUE=DATE:20260130", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "SUMMARY:Payday", "END:VEVENT",
      "BEGIN:VEVENT", "UID:birthday", "DTSTART;VALUE=DATE:19900312", "RRULE:FREQ=YEARLY", "SUMMARY:Arjun's birthday", "END:VEVENT",
      "BEGIN:VEVENT", "UID:sprint", "DTSTART:20261101T100000Z", "RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261107T100000Z", "SUMMARY:Pairing", "END:VEVENT",
    ),
    window("2026-11-01T00:00:00Z", "2027-04-01T00:00:00Z"),
  );
  const of = (uid: string) => out.events.filter((row) => row.uid === uid);
  assert.deepEqual(of("retro").slice(0, 3).map((row) => iso(row.start)), ["2026-11-27T15:00:00.000Z", "2026-12-25T15:00:00.000Z", "2027-01-29T15:00:00.000Z"]);
  assert.deepEqual(of("payday").slice(0, 2).map((row) => row.startDate), ["2026-11-30", "2026-12-31"]);
  assert.deepEqual(of("birthday").map((row) => row.startDate), ["2027-03-12"]);
  assert.deepEqual(of("sprint").map((row) => iso(row.start)), ["2026-11-01T10:00:00.000Z", "2026-11-03T10:00:00.000Z", "2026-11-05T10:00:00.000Z", "2026-11-07T10:00:00.000Z"]);
});

test("folded lines, escaped text, meeting links and generated UIDs", () => {
  const out = parseIcs(
    feed(
      "BEGIN:VEVENT", "UID:teams-1", "DTSTART:20261104T043000Z", "DTEND:20261104T050000Z", "SUMMARY:Sprint review\\, Atlas", "DESCRIPTION:Agenda:\\n1. Demo\\n2. Q",
      " uestions", "X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0", "ORGANIZER;CN=Mira Chen:mailto:Mira@Fieldnote.example",
      'ATTENDEE;CN="Rao, Arjun";PARTSTAT=ACCEPTED:mailto:arjun@fieldnote.example', "END:VEVENT",
      "BEGIN:VEVENT", "DTSTART:20261105T090000Z", "DTEND:20261105T093000Z", "SUMMARY:Coffee", "LOCATION:https://meet.google.com/abc-defg-hij", "END:VEVENT",
    ),
    window("2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z"),
  );
  const [teams, coffee] = out.events;
  assert.equal(teams!.title, "Sprint review, Atlas");
  assert.equal(teams!.description, "Agenda:\n1. Demo\n2. Questions");
  assert.equal(teams!.joinUrl, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0");
  assert.equal(teams!.organizer, "mira@fieldnote.example");
  assert.deepEqual(teams!.attendees, [{ email: "arjun@fieldnote.example", name: "Rao, Arjun" }]);
  assert.equal(coffee!.joinUrl, "https://meet.google.com/abc-defg-hij");
  assert.match(coffee!.uid, /^generated-[0-9a-f]{24}$/);
  const again = parseIcs(feed("BEGIN:VEVENT", "DTSTART:20261105T090000Z", "DTEND:20261105T093000Z", "SUMMARY:Coffee", "END:VEVENT"), window("2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z"));
  assert.equal(again.events[0]!.uid, coffee!.uid, "the same event gets the same generated UID");
  assert.equal(unescapeText("a\\;b\\\\c"), "a;b\\c");
});

test("a feed with too many events is cut at the cap", () => {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) lines.push("BEGIN:VEVENT", `UID:e${i}`, `DTSTART:202611${String(1 + (i % 28)).padStart(2, "0")}T090000Z`, "SUMMARY:Busy", "END:VEVENT");
  const out = parseIcs(feed(...lines), { ...window("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"), maxEvents: 10 });
  assert.equal(out.events.length, 10);
  assert.equal(out.truncated, true);
  const daily = parseRule("FREQ=DAILY")!;
  assert.equal(expandWall(Date.UTC(2000, 0, 1, 9), daily, Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 8), 100).length, 7, "a series from 2000 jumps ahead to the window");
});
