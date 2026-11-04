import assert from "node:assert/strict";
import test from "node:test";
import { dedupeEvents, findJoinUrl, holidayTitlesMatch, meetingKey, normalizeTitle, titlesMatch, type CalendarRecord } from "./dedupe.js";

let seq = 0;
const at = (iso: string) => new Date(iso);
function event(over: Partial<CalendarRecord> & Pick<CalendarRecord, "connector" | "title" | "start">): CalendarRecord {
  seq += 1;
  return {
    id: `e${String(seq).padStart(3, "0")}`,
    calendarId: over.connector,
    end: null,
    allDay: false,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
    ...over,
  };
}
const allDay = (connector: string, title: string, startDate: string, endDate: string, over: Partial<CalendarRecord> = {}) =>
  event({ connector, title, start: at(`${startDate}T00:00:00Z`), end: at(`${endDate}T00:00:00Z`), allDay: true, startDate, endDate, ...over });

const TEAMS = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NzQ1YjE4ZmQtMGI1Ny00ZjY5%40thread.v2/0?context=%7b%22Tid%22%3a%22abc%22%7d";
const TEAMS_DOUBLE = "https://teams.microsoft.com/l/meetup-join/19%253ameeting_NzQ1YjE4ZmQtMGI1Ny00ZjY5%2540thread.v2/0?context=other";

test("titles: prefixes, emoji, punctuation, width and case are ignored", () => {
  assert.equal(normalizeTitle("🎉 Fwd: Updated invitation: Sprint-Review!! "), "sprint review");
  assert.equal(normalizeTitle("Canceled: Ｓｐｒｉｎｔ　review"), "sprint review");
  assert.equal(normalizeTitle("Cancelled event: 1:1 · Mira"), "1 1 mira");
  assert.ok(titlesMatch("Fwd: Sprint review", "Sprint review"));
  assert.ok(titlesMatch("Sprint review", "Sprint review (Atlas)"), "one inside the other");
  assert.ok(titlesMatch("Atlas sprint review meeting", "Atlas sprint review"), "Jaccard 0.75");
  assert.ok(!titlesMatch("Sprint review", "Design critique"));
  assert.ok(!titlesMatch("Sprint planning", "Sprint review"), "Jaccard 1/3");
  assert.ok(!titlesMatch("QA", "QA review"), "a contained title needs three characters");
  assert.ok(!titlesMatch("", "Sprint review"));
});

test("holiday names: synonyms and filler words, but Eve is its own day", () => {
  assert.ok(holidayTitlesMatch("Christmas Day", "Christmas"));
  assert.ok(holidayTitlesMatch("Diwali/Deepavali", "Deepavali"));
  assert.ok(holidayTitlesMatch("New Year's Day", "New Year"));
  assert.ok(holidayTitlesMatch("Labour Day", "Labor Day (observed)"));
  assert.ok(holidayTitlesMatch("Gandhi Jayanti", "Mahatma Gandhi Jayanti"));
  assert.ok(!holidayTitlesMatch("Christmas Eve", "Christmas Day"));
  assert.ok(!holidayTitlesMatch("Holi", "Public holiday"));
});

test("meeting links normalize to the meeting they open", () => {
  assert.equal(meetingKey(TEAMS), "teams:19:meeting_nzq1yje4zmqtmgi1ny00zjy5@thread.v2");
  assert.equal(meetingKey(TEAMS_DOUBLE), meetingKey(TEAMS));
  assert.equal(meetingKey("https://meet.google.com/abc-defg-hij?authuser=1"), "meet:abc-defg-hij");
  assert.equal(meetingKey("https://acme.zoom.us/j/81234567890?pwd=xyz"), "zoom:81234567890");
  assert.equal(meetingKey("https://zoom.us/j/81234567890"), "zoom:81234567890");
  assert.equal(meetingKey("https://acme.zoom.us/my/mira"), "zoom:my:mira");
  assert.equal(meetingKey("https://acme.webex.com/acme/j.php?MTID=m123abc"), "webex:m123abc");
  assert.equal(meetingKey("https://calendar.google.com/event?eid=1"), null);
  assert.equal(meetingKey("not a url"), null);
  assert.equal(findJoinUrl("Room 4", "Join: https://meet.google.com/abc-defg-hij. Thanks"), "https://meet.google.com/abc-defg-hij");
  assert.equal(findJoinUrl("https://example.com/agenda"), null);
});

test("the same Teams meeting on Outlook and as a forwarded Google invite is one event", () => {
  const outlook = event({ connector: "outlook_calendar", title: "Sprint review", start: at("2026-11-04T04:30:00Z"), end: at("2026-11-04T05:00:00Z"), uid: "040000008200E00074C5B7101A82E008", joinUrl: TEAMS, location: "Microsoft Teams Meeting", attendees: [{ email: "Arjun@fieldnote.example", name: "Arjun" }] });
  const google = event({ connector: "google_calendar", calendarId: "mira@fieldnote.example", title: "Fwd: Sprint review", start: at("2026-11-04T10:00:00+05:30"), end: at("2026-11-04T10:30:00+05:30"), uid: "040000008200e00074c5b7101a82e008", attendees: [{ email: "arjun@fieldnote.example", name: null }, { email: "lee@fieldnote.example", name: "Lee" }], hasDescription: true });
  const [merged, ...rest] = dedupeEvents([google, outlook]);
  assert.equal(rest.length, 0);
  assert.equal(merged!.id, outlook.id, "the earliest-created copy keeps its id");
  assert.equal(merged!.title, "Sprint review", "the title without a forward prefix");
  assert.equal(merged!.joinUrl, TEAMS);
  assert.equal(merged!.location, "Microsoft Teams Meeting");
  assert.equal(merged!.hasDescription, true);
  assert.deepEqual(merged!.attendees.map((row) => row.email), ["arjun@fieldnote.example", "lee@fieldnote.example"]);
  assert.deepEqual(merged!.sources.map((row) => row.connector).sort(), ["google_calendar", "outlook_calendar"]);
  assert.deepEqual(merged!.memberIds.sort(), [outlook.id, google.id].sort());
});

test("without a shared UID, the same join link at overlapping times is one event", () => {
  const outlook = event({ connector: "outlook_calendar", title: "Sprint review", start: at("2026-11-04T04:30:00Z"), end: at("2026-11-04T05:00:00Z"), joinUrl: TEAMS });
  const copied = event({ connector: "google_calendar", title: "Busy", start: at("2026-11-04T04:30:00Z"), end: at("2026-11-04T05:00:00Z"), joinUrl: TEAMS_DOUBLE });
  const nextWeek = event({ connector: "google_calendar", calendarId: "team", title: "Sprint review", start: at("2026-11-11T04:30:00Z"), end: at("2026-11-11T05:00:00Z"), joinUrl: TEAMS });
  const out = dedupeEvents([outlook, copied, nextWeek]);
  assert.equal(out.length, 2, "next week's occurrence does not overlap");
  assert.equal(out.find((row) => row.memberIds.length === 2)?.title, "Sprint review");
});

test("a personal meeting room joins only events with matching titles", () => {
  const room = "https://acme.zoom.us/my/mira";
  const a = event({ connector: "google_calendar", title: "1:1 with Arjun", start: at("2026-11-04T09:00:00Z"), end: at("2026-11-04T09:30:00Z"), joinUrl: room });
  const b = event({ connector: "outlook_calendar", title: "Interview: backend", start: at("2026-11-04T09:00:00Z"), end: at("2026-11-04T10:00:00Z"), joinUrl: room });
  const c = event({ connector: "ics_calendar", title: "1:1 with Arjun", start: at("2026-11-04T09:00:00Z"), end: at("2026-11-04T09:45:00Z"), joinUrl: room });
  const out = dedupeEvents([a, b, c]);
  assert.equal(out.length, 2);
  assert.ok(out.some((row) => row.memberIds.length === 2 && row.title === "1:1 with Arjun"));
});

test("Christmas from Google's and Outlook's holiday calendars is one all-day event; Christmas Eve stays", () => {
  const google = allDay("google_calendar", "Christmas Day", "2026-12-25", "2026-12-26", { calendarId: "en.indian#holiday@group.v.calendar.google.com", calendarName: "Holidays in India" });
  const outlook = allDay("outlook_calendar", "Christmas", "2026-12-25", "2026-12-26", { calendarName: "India holidays" });
  const eve = allDay("outlook_calendar", "Christmas Eve", "2026-12-24", "2026-12-25");
  const deepavali = allDay("ics_calendar", "Deepavali", "2026-11-08", "2026-11-09");
  const diwali = allDay("google_calendar", "Diwali/Deepavali", "2026-11-08", "2026-11-09");
  const out = dedupeEvents([google, outlook, eve, deepavali, diwali]);
  assert.equal(out.length, 3);
  const christmas = out.find((row) => row.startDate === "2026-12-25")!;
  assert.equal(christmas.allDay, true);
  assert.equal(christmas.endDate, "2026-12-26");
  assert.deepEqual(christmas.sources.map((row) => row.calendarName).sort(), ["Holidays in India", "India holidays"]);
  assert.equal(out.find((row) => row.startDate === "2026-11-08")!.memberIds.length, 2);
});

test("an all-day event and a timed event with the same title are different", () => {
  const out = dedupeEvents([
    allDay("google_calendar", "Offsite", "2026-11-06", "2026-11-07"),
    event({ connector: "outlook_calendar", title: "Offsite", start: at("2026-11-06T00:00:00Z"), end: at("2026-11-07T00:00:00Z") }),
  ]);
  assert.equal(out.length, 2);
});

test("same title at different times stays separate; different titles at the same time stay separate", () => {
  const out = dedupeEvents([
    event({ connector: "google_calendar", title: "Standup", start: at("2026-11-04T09:00:00Z"), end: at("2026-11-04T09:15:00Z") }),
    event({ connector: "outlook_calendar", title: "Standup", start: at("2026-11-04T09:30:00Z"), end: at("2026-11-04T09:45:00Z") }),
    event({ connector: "outlook_calendar", title: "Design critique", start: at("2026-11-04T09:00:00Z"), end: at("2026-11-04T09:15:00Z") }),
  ]);
  assert.equal(out.length, 3);
});

test("time zone offsets are compared as instants, within two minutes", () => {
  const india = event({ connector: "google_calendar", title: "Roadmap", start: at("2026-11-04T15:30:00+05:30"), end: at("2026-11-04T16:30:00+05:30") });
  const utc = event({ connector: "outlook_calendar", title: "Roadmap", start: at("2026-11-04T10:01:00Z"), end: at("2026-11-04T11:00:00Z") });
  const pacific = event({ connector: "ics_calendar", title: "roadmap!", start: at("2026-11-04T02:00:00-08:00"), end: at("2026-11-04T03:00:00-08:00") });
  assert.equal(dedupeEvents([india, utc, pacific]).length, 1);
  const late = event({ connector: "ics_calendar", calendarId: "other", title: "Roadmap", start: at("2026-11-04T10:03:00Z"), end: at("2026-11-04T11:00:00Z") });
  assert.equal(dedupeEvents([india, late]).length, 2, "three minutes apart is a different event");
  const longer = event({ connector: "ics_calendar", calendarId: "other", title: "Roadmap", start: at("2026-11-04T10:00:00Z"), end: at("2026-11-04T11:30:00Z") });
  assert.equal(dedupeEvents([india, longer]).length, 2, "the ends must agree too");
});

test("a recurring series merges occurrence by occurrence, including a moved one", () => {
  const uid = "weekly-standup@fieldnote.example";
  const days = ["2026-11-02", "2026-11-03", "2026-11-04"];
  const google = days.map((day) => event({ connector: "google_calendar", title: "Standup", uid, start: at(`${day}T09:00:00Z`), end: at(`${day}T09:15:00Z`), instanceStart: at(`${day}T09:00:00Z`) }));
  const outlook = days.map((day) => event({ connector: "outlook_calendar", title: "Daily standup", uid, start: at(`${day}T09:00:00Z`), end: at(`${day}T09:15:00Z`) }));
  // Wednesday's occurrence moved to 11:00 in Google; Outlook still has it at 09:00 as its original start.
  google[2] = { ...google[2]!, start: at("2026-11-04T11:00:00Z"), end: at("2026-11-04T11:15:00Z") };
  outlook[2] = { ...outlook[2]!, start: at("2026-11-04T11:00:00Z"), end: at("2026-11-04T11:15:00Z"), instanceStart: at("2026-11-04T09:00:00Z") };
  const out = dedupeEvents([...google, ...outlook]);
  assert.equal(out.length, 3);
  assert.ok(out.every((row) => row.memberIds.length === 2));
});

test("a cancelled copy never merges with the active one: the active one is shown", () => {
  const active = event({ connector: "outlook_calendar", title: "Budget review", uid: "budget-1", start: at("2026-11-05T12:00:00Z"), end: at("2026-11-05T13:00:00Z") });
  const cancelled = event({ connector: "google_calendar", title: "Canceled: Budget review", uid: "budget-1", start: at("2026-11-05T12:00:00Z"), end: at("2026-11-05T13:00:00Z"), cancelled: true });
  const out = dedupeEvents([cancelled, active]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, active.id);
  assert.equal(out[0]!.cancelled, false);
  assert.deepEqual(out[0]!.sources.map((row) => row.connector), ["outlook_calendar"]);
  const alone = dedupeEvents([cancelled]);
  assert.equal(alone[0]!.cancelled, true, "a cancelled event with no active copy is kept, marked cancelled");
});

test("three sources chain into one event: UID, then time and title", () => {
  const google = event({ connector: "google_calendar", title: "Sprint review", uid: "sprint-42", start: at("2026-11-04T04:30:00Z"), end: at("2026-11-04T05:00:00Z") });
  const outlook = event({ connector: "outlook_calendar", title: "Sprint review 🚀", uid: "sprint-42", start: at("2026-11-04T04:30:00Z"), end: at("2026-11-04T05:00:00Z") });
  const ics = event({ connector: "ics_calendar", calendarId: "feed-1", title: "Updated invitation: Sprint review", start: at("2026-11-04T04:31:00Z"), end: at("2026-11-04T05:00:00Z") });
  const out = dedupeEvents([ics, outlook, google]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.sources.length, 3);
  assert.equal(out[0]!.id, google.id);
});

test("the provider's copy decides the time and title, whichever copy was saved first", () => {
  const ics = event({ connector: "ics_calendar", calendarId: "feed-1", title: "Roadmap planning (Zoom)", start: at("2026-11-05T05:31:00Z"), end: at("2026-11-05T06:30:00Z") });
  const google = event({ connector: "google_calendar", title: "Roadmap planning", uid: "roadmap@google.com", joinUrl: "https://fieldnote.zoom.us/j/84512345678", start: at("2026-11-05T05:30:00Z"), end: at("2026-11-05T06:30:00Z") });
  const [merged] = dedupeEvents([ics, google]);
  assert.equal(merged!.id, ics.id, "the id stays the earliest-created copy's");
  assert.equal(merged!.title, "Roadmap planning");
  assert.equal(merged!.start.toISOString(), "2026-11-05T05:30:00.000Z");
  assert.deepEqual(merged!.sources.map((row) => row.connector), ["google_calendar", "ics_calendar"], "best copy first");
});

test("duplicates inside one ICS feed merge only by UID", () => {
  const a = event({ connector: "ics_calendar", calendarId: "feed-1", title: "Team lunch", uid: "lunch@x", start: at("2026-11-06T12:00:00Z"), end: at("2026-11-06T13:00:00Z") });
  const b = event({ connector: "ics_calendar", calendarId: "feed-1", title: "Team lunch", uid: "LUNCH@X", start: at("2026-11-06T12:00:00Z"), end: at("2026-11-06T13:00:00Z") });
  const c = event({ connector: "ics_calendar", calendarId: "feed-1", title: "Team lunch", uid: "lunch-2@x", start: at("2026-11-06T12:00:00Z"), end: at("2026-11-06T13:00:00Z") });
  const out = dedupeEvents([a, b, c]);
  assert.equal(out.length, 2, "same UID merges; two UIDs in one feed stay two events");
  // A copy from another calendar joins one of them, never both.
  const other = event({ connector: "google_calendar", title: "Team lunch", start: at("2026-11-06T12:00:00Z"), end: at("2026-11-06T13:00:00Z") });
  const joined = dedupeEvents([a, c, other]);
  assert.equal(joined.length, 2);
});

test("many events stay fast", () => {
  const records: CalendarRecord[] = [];
  const base = Date.UTC(2026, 10, 1);
  for (let i = 0; i < 6000; i++) {
    const start = new Date(base + (i % 3000) * 15 * 60_000);
    records.push(event({ connector: i < 3000 ? "google_calendar" : "outlook_calendar", title: `Meeting ${i % 3000}`, start, end: new Date(start.getTime() + 30 * 60_000) }));
  }
  const began = performance.now();
  const out = dedupeEvents(records);
  assert.equal(out.length, 3000);
  assert.ok(performance.now() - began < 2000);
});
