/**
 * Meeting-notes connectors without a database: calendar matching, action-item
 * parsing, whose item is it, identity normalisation, and each vendor's mapping
 * from its documented response shape. Fictional people at Fieldnote.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "../../runtime/test-env.js";
import { cleanIdentities, normaliseIdentity, parseHandle } from "../../people/identity.js";
import { containerKey } from "../../projects/links.js";
import { actionItemsFromMarkdown, decisionsFromMarkdown, isMine, itemKey, meFrom, parseActionItemsText, parseSpeakerBlocks, transcriptText, TRANSCRIPT_CAP } from "./actions.js";
import { fathomRecord } from "./fathom.js";
import { firefliesRecord } from "./fireflies.js";
import { granolaRecord } from "./granola.js";
import { jamieRecord } from "./jamie.js";
import { krispRecord } from "./krisp.js";
import { attendeeOverlap, pickEvent, timeFit, titleSimilarity, type EventCandidate } from "./match.js";
import { otterRecord } from "./otter.js";
import { tldvRecord } from "./tldv.js";

const at = (iso: string) => new Date(iso);
const ME = new Set(["mira@fieldnote.example"]);

function event(id: string, start: string, end: string, title: string, emails: string[] = []): EventCandidate {
  return { id, externalId: id, title, start: at(start), end: at(end), emails };
}

test("matcher: overlap of at least half, or a start within ten minutes, is required", () => {
  const meeting = { start: at("2026-10-06T10:02:00Z"), end: at("2026-10-06T10:31:00Z"), title: "Atlas design review", emails: ["arjun@fieldnote.example"] };
  const review = event("evt-review", "2026-10-06T10:00:00Z", "2026-10-06T10:30:00Z", "Atlas design review", ["arjun@fieldnote.example", "mira@fieldnote.example"]);
  assert.equal(timeFit(meeting, review).fits, true);
  assert.ok(timeFit(meeting, review).overlap > 0.9);
  const later = event("evt-later", "2026-10-06T10:25:00Z", "2026-10-06T11:25:00Z", "Atlas design review");
  assert.equal(timeFit(meeting, later).fits, false, "five minutes of overlap and a 23 minute gap is a different meeting");
  const result = pickEvent(meeting, [review, later], ME);
  assert.equal(result.event?.id, "evt-review");
  assert.equal(result.reason, "scored");
  // A recording that started 8 minutes late still matches on start time.
  const late = pickEvent({ ...meeting, start: at("2026-10-06T10:08:00Z"), end: null }, [review], ME);
  assert.equal(late.event?.id, "evt-review");
});

test("matcher: shared attendees break a tie between two events at the same time", () => {
  const meeting = { start: at("2026-10-06T14:00:00Z"), end: at("2026-10-06T14:30:00Z"), title: "Weekly sync", emails: ["sam@fieldnote.example", "mira@fieldnote.example"] };
  const team = event("evt-team", "2026-10-06T14:00:00Z", "2026-10-06T14:30:00Z", "Team sync", ["lee@fieldnote.example", "mira@fieldnote.example"]);
  const sam = event("evt-sam", "2026-10-06T14:00:00Z", "2026-10-06T14:30:00Z", "1:1", ["sam@fieldnote.example", "mira@fieldnote.example"]);
  const result = pickEvent(meeting, [team, sam], ME);
  assert.equal(result.event?.id, "evt-sam");
  assert.equal(attendeeOverlap(meeting.emails, team.emails, ME), 0, "my own address never counts as shared");
});

test("matcher: two equally good events leave the meeting unmatched", () => {
  const meeting = { start: at("2026-10-06T16:00:00Z"), end: at("2026-10-06T16:30:00Z"), title: "Planning", emails: [] };
  const a = event("evt-a", "2026-10-06T16:00:00Z", "2026-10-06T16:30:00Z", "Planning");
  const b = event("evt-b", "2026-10-06T16:00:00Z", "2026-10-06T16:30:00Z", "Planning");
  const result = pickEvent(meeting, [a, b], ME);
  assert.equal(result.event, null);
  assert.equal(result.reason, "ambiguous");
  // Time alone, with a title that has nothing in common, is not enough when other events compete.
  const none = pickEvent({ ...meeting, title: "Customer call" }, [a, event("evt-c", "2026-10-06T16:05:00Z", "2026-10-06T16:35:00Z", "Lunch")], ME);
  assert.equal(none.event, null);
});

test("matcher: the vendor's calendar event id wins, Google and Outlook alike", () => {
  const meeting = { start: at("2026-10-06T09:00:00Z"), end: null, title: "Anything", emails: [], calendarEventId: "AAMkAGI1" };
  const outlook: EventCandidate = { ...event("x", "2026-10-06T12:00:00Z", "2026-10-06T13:00:00Z", "Other"), externalId: "outlook:AAMkAGI1" };
  assert.deepEqual([pickEvent(meeting, [outlook]).event?.id, pickEvent(meeting, [outlook]).reason], ["x", "event-id"]);
  assert.ok(titleSimilarity("Atlas design review", "Design review: Atlas") > 0.9);
});

test("action items: Fireflies blocks group items under the person, with timestamps removed", () => {
  const items = parseActionItemsText("**Mira Chen**\nSend the onboarding deck to Arjun (05:12)\nBook the design review (12:40)\n\n**Arjun Rao**\nReview the API draft (20:01)\n\n**Unassigned**\nPick a launch date");
  assert.deepEqual(
    items.map((item) => [item.assignee?.name ?? null, item.text, item.at]),
    [
      ["Mira Chen", "Send the onboarding deck to Arjun", "05:12"],
      ["Mira Chen", "Book the design review", "12:40"],
      ["Arjun Rao", "Review the API draft", "20:01"],
      [null, "Pick a launch date", null],
    ],
  );
});

test("action items and decisions come out of Markdown summaries", () => {
  const summary = "## Overview\nWe reviewed Atlas.\n\n### Decisions\n- Ship the beta on Oct 20\n- Keep the old importer\n\n### Next steps\n- Mira Chen: send the pricing note\n- [ ] Arjun: fix the login bug\n- Book a retro\n\n## Notes\n- Something else";
  assert.deepEqual(decisionsFromMarkdown(summary), ["Ship the beta on Oct 20", "Keep the old importer"]);
  assert.deepEqual(
    actionItemsFromMarkdown(summary).map((item) => [item.assignee?.name ?? null, item.text]),
    [
      ["Mira Chen", "send the pricing note"],
      ["Arjun", "fix the login bug"],
      [null, "Book a retro"],
    ],
  );
});

test("whose item: my addresses, my full name, or my first name alone", () => {
  const me = meFrom(["Mira@Fieldnote.example", "you@ensemble.local"], ["Mira Chen"]);
  assert.equal(me.emails.has("you@ensemble.local"), false);
  assert.equal(isMine({ email: "mira@fieldnote.example" }, me), true);
  assert.equal(isMine({ name: "Mira Chen", email: null }, me), true);
  assert.equal(isMine({ name: "mira" }, me), true);
  assert.equal(isMine({ name: "Mira Patel" }, me), false);
  assert.equal(isMine({ name: "Mira Chen", email: "mira.chen@other.example" }, me), false, "an address that is not mine wins over the name");
  assert.equal(isMine(null, me), false);
  assert.equal(itemKey("Send the deck."), itemKey("send the  deck"));
});

test("transcripts keep speakers and timestamps and stop at the cap", () => {
  const text = transcriptText([{ speaker: "Mira Chen", text: "Hello   there", at: "00:01" }, { speaker: "Arjun Rao", text: "Hi" }], "Fathom");
  assert.equal(text, "[00:01] Mira Chen: Hello there\nArjun Rao: Hi");
  const long = transcriptText(Array.from({ length: 2000 }, (_, i) => ({ speaker: "Sam Rivera", text: `line ${i} ${"x".repeat(40)}` })), "Fireflies.ai");
  assert.ok(long.length <= TRANSCRIPT_CAP + 80);
  assert.match(long, /Transcript trimmed\. Open it in Fireflies\.ai/);
  assert.deepEqual(parseSpeakerBlocks("**Sarah Johnson**\nHi everyone!\n\n**Alex Chen**\nThanks."), [
    { speaker: "Sarah Johnson", text: "Hi everyone!", at: null },
    { speaker: "Alex Chen", text: "Thanks.", at: null },
  ]);
  assert.deepEqual(parseSpeakerBlocks("Jane Doe  00:00\nThanks for joining.\n\nAlex Taylor  00:07\nRight now we take notes."), [
    { speaker: "Jane Doe", text: "Thanks for joining.", at: "00:00" },
    { speaker: "Alex Taylor", text: "Right now we take notes.", at: "00:07" },
  ]);
});

test("identities are normalised per kind; handles parse from connector upns", () => {
  assert.equal(normaliseIdentity("email", " MAILTO:Sam@Fieldnote.Example "), "sam@fieldnote.example");
  assert.equal(normaliseIdentity("email", "not an address"), null);
  assert.equal(normaliseIdentity("github", "@MiraChen"), "mirachen");
  assert.equal(normaliseIdentity("phone", "+1 (555) 010-0100"), "+15550100100");
  assert.deepEqual(parseHandle("slack:U0ABC"), { kind: "slack", value: "u0abc" });
  assert.deepEqual(parseHandle("Arjun@Fieldnote.example"), { kind: "email", value: "arjun@fieldnote.example" });
  assert.equal(parseHandle("unknown:thing"), null);
  assert.deepEqual(
    cleanIdentities([{ kind: "slack", value: "U1" }, { kind: "email", value: "A@B.example" }, { kind: "email", value: "a@b.example" }]).map((row) => `${row.kind}:${row.value}`),
    ["email:a@b.example", "slack:u1"],
  );
  assert.equal(containerKey("github", "repo:Fieldnote/Atlas"), "fieldnote/atlas");
  assert.equal(containerKey("slack", "C0DESIGN"), "C0DESIGN");
});

test("Fireflies: sentences, attendees, summary and grouped action items", () => {
  const record = firefliesRecord({
    id: "ff-1",
    title: "Atlas design review",
    date: Date.parse("2026-10-06T10:00:00Z"),
    duration: 30,
    transcript_url: "https://app.fireflies.ai/view/ff-1",
    organizer_email: "mira@fieldnote.example",
    participants: ["arjun@fieldnote.example,sam@fieldnote.example"],
    calendar_id: "evt-review",
    meeting_attendees: [{ displayName: "Arjun Rao", email: "Arjun@fieldnote.example" }],
    sentences: [{ speaker_name: "Arjun Rao", text: "Let's ship it.", start_time: 65 }],
    summary: { overview: "We agreed to ship.", action_items: "**Mira Chen**\nSend the deck (01:05)" },
  })!;
  assert.equal(record.end?.toISOString(), "2026-10-06T10:30:00.000Z");
  assert.deepEqual(record.attendees.map((row) => row.email), ["arjun@fieldnote.example", "sam@fieldnote.example"]);
  assert.deepEqual(record.transcript, [{ speaker: "Arjun Rao", text: "Let's ship it.", at: "01:05" }]);
  assert.equal(record.calendarEventId, "evt-review");
  assert.deepEqual(record.actionItems[0], { text: "Send the deck", assignee: { name: "Mira Chen" }, at: "01:05" });
});

test("Fathom: recording times, invitees, speakers with matched emails, assigned action items", () => {
  const record = fathomRecord({
    title: "Fathom title",
    meeting_title: "Atlas design review",
    recording_id: 123456789,
    url: "https://fathom.video/calls/1",
    share_url: "https://fathom.video/share/1",
    recording_start_time: "2026-10-06T10:01:00Z",
    recording_end_time: "2026-10-06T10:29:00Z",
    calendar_invitees: [{ name: "Arjun Rao", email: "arjun@fieldnote.example" }],
    recorded_by: { name: "Mira Chen", email: "mira@fieldnote.example" },
    transcript: [{ speaker: { display_name: "Arjun Rao", matched_calendar_invitee_email: "arjun@fieldnote.example" }, text: "Ship it.", timestamp: "00:05:32" }],
    default_summary: { markdown_formatted: "## Summary\nShip it." },
    action_items: [{ description: "Email the revised plan", completed: false, recording_timestamp: "00:10:45", recording_playback_url: "https://fathom.video/calls/1?timestamp=645", assignee: { name: "Mira Chen", email: "mira@fieldnote.example" } }],
  })!;
  assert.equal(record.id, "123456789");
  assert.equal(record.title, "Atlas design review");
  assert.equal(record.url, "https://fathom.video/share/1");
  assert.deepEqual(record.speakers, [{ name: "Arjun Rao", email: "arjun@fieldnote.example" }]);
  assert.equal(record.transcript?.[0]?.at, "00:05:32");
  assert.equal(record.actionItems[0]?.assignee?.email, "mira@fieldnote.example");
  assert.equal(record.actionItems[0]?.url, "https://fathom.video/calls/1?timestamp=645");
});

test("Granola: calendar event id, invitees, speaker attribution and summary sections", () => {
  const record = granolaRecord({
    id: "not_1d3tmYTlCICgjy",
    title: "Atlas pricing",
    owner: { name: "Mira Chen", email: "mira@fieldnote.example" },
    created_at: "2026-10-06T11:05:00Z",
    web_url: "https://notes.granola.ai/d/not_1d3tmYTlCICgjy",
    calendar_event: { event_title: "Atlas pricing", invitees: [{ email: "sam@fieldnote.example" }], organiser: "mira@fieldnote.example", calendar_event_id: "evt-pricing", scheduled_start_time: "2026-10-06T11:00:00Z", scheduled_end_time: "2026-10-06T11:30:00Z" },
    attendees: [{ name: "Sam Rivera", email: "sam@fieldnote.example" }],
    summary_markdown: "## Decisions\n- Per-seat pricing\n\n## Next steps\n- Mira: draft the pricing page",
    transcript: [
      { speaker: { source: "microphone", attribution: "me" }, text: "Per seat?", start_time: "2026-10-06T11:00:10Z" },
      { speaker: { source: "speaker", attribution: "them" }, text: "Per seat.", start_time: "2026-10-06T11:01:20Z" },
    ],
  })!;
  assert.equal(record.start.toISOString(), "2026-10-06T11:00:00.000Z");
  assert.equal(record.calendarEventId, "evt-pricing");
  assert.deepEqual(record.transcript?.map((line) => [line.speaker, line.at]), [["Mira Chen", "00:00"], ["Them", "01:10"]]);
  assert.deepEqual(record.decisions, ["Per-seat pricing"]);
  assert.deepEqual(record.actionItems.map((item) => [item.assignee?.name, item.text]), [["Mira", "draft the pricing page"]]);
});

test("Krisp, Jamie, tl;dv and Otter map their documented shapes", () => {
  const krisp = krispRecord({
    id: "019a",
    title: "Q3 Planning",
    started_at: "2026-10-06T10:45:48+04:00",
    duration: 1800,
    participants: [{ email: "lee@fieldnote.example", first_name: "Lee", last_name: "Park" }],
    transcript: { speakers: { "1": { email: "lee@fieldnote.example", first_name: "Lee", last_name: "Park" } }, segments: [{ speaker: 1, text: "Roadmap first.", start: 0 }, { speaker: 2, text: "Agreed.", start: 5.2 }] },
    notes: { blocks: [{ type: "key_points", children: [{ type: "key_point", text: "Team approved the redesign. {{02:19}}" }] }, { type: "action_items", children: [{ type: "action_item", text: "Send the revised proposal", completed: false, assignee: { first_name: "Mira", last_name: "Chen" }, due_date: "2026-10-09" }] }] },
  })!;
  assert.equal(krisp.end!.getTime() - krisp.start.getTime(), 1_800_000);
  assert.deepEqual(krisp.transcript?.map((line) => line.speaker), ["Lee Park", "Speaker 2"]);
  assert.deepEqual(krisp.decisions, ["Team approved the redesign."]);
  assert.deepEqual(krisp.actionItems[0], { text: "Send the revised proposal", assignee: { name: "Mira Chen", email: null }, completed: false, due: "2026-10-09" });

  const jamie = jamieRecord({
    id: "789",
    title: "Q4 Planning",
    startTime: "2026-10-06T14:00:00.000Z",
    endTime: "2026-10-06T15:00:00.000Z",
    summary: { markdown: "# Summary" },
    transcript: "**Sam Rivera**\nHi everyone.",
    participants: [{ name: "Sam Rivera", email: "sam@fieldnote.example" }],
    tasks: [{ content: "Finalize the spec", completed: false, assignee: { name: "Sam Rivera", email: "sam@fieldnote.example" } }],
    event: { externalId: "AAMkAGI1", attendees: [{ name: "Mira Chen", email: "mira@fieldnote.example", organizer: true }] },
  })!;
  assert.equal(jamie.calendarEventId, "AAMkAGI1");
  assert.equal(jamie.organizer, "mira@fieldnote.example");
  assert.equal(jamie.transcript?.[0]?.speaker, "Sam Rivera");

  const tldv = tldvRecord(
    { id: "653663ac", name: "Standup", happenedAt: "2026-10-06T09:00:00Z", url: "https://tldv.io/app/meetings/653663ac", duration: 900, organizer: { name: "Mira Chen", email: "mira@fieldnote.example" }, invitees: [{ name: "Arjun Rao", email: "arjun@fieldnote.example" }] },
    { data: [{ speaker: "Arjun Rao", text: "Blocked on review.", startTime: 12 }] },
    { markdownContent: "## Action items\n- Mira Chen: review Arjun's PR" },
  )!;
  assert.equal(tldv.end?.toISOString(), "2026-10-06T09:15:00.000Z");
  assert.equal(tldv.transcript?.[0]?.at, "00:12");
  assert.equal(tldv.actionItems[0]?.assignee?.name, "Mira Chen");

  const otter = otterRecord({
    id: "conv-1",
    title: "ACME call",
    url: "https://otter.ai/u/conv-1",
    owner: { name: "Mira Chen", email: "mira@fieldnote.example" },
    created_at: "2026-10-06T12:00:00Z",
    calendar_guests: [{ name: "Alex Taylor", email: "alex@acme.example" }],
    abstract_summary: "Discussed pricing.",
    relationships: { action_items: [{ text: "Send pricing summary", assignee: { name: "Mira Chen", email: "mira@fieldnote.example" } }], transcript: { content: "Mira Chen  00:00\nThanks for joining." } },
  })!;
  assert.equal(otter.attendees.length, 2);
  assert.equal(otter.summary, "Discussed pricing.");
  assert.equal(otter.transcript?.[0]?.at, "00:00");
});
