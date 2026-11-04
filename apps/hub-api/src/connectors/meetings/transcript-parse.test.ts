/**
 * Transcript files and copies as meeting apps produce them (docs/03 §2.4): Teams .vtt, .docx
 * and transcript-panel copies, Zoom .vtt and saved .txt, Google Meet's Docs transcript, Otter
 * .txt and .srt, Fireflies and tl;dv JSON, and plain "Speaker: text" lines.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "../../runtime/test-env.js";
import { markdownToDocx } from "../../lib/office/docx.js";
import { readFileText } from "../../files/extract.js";
import { fromFilename, parseTranscript, readTranscript, spokenItems, transcriptDocument, writtenTime } from "./transcript-parse.js";

const TEAMS_VTT = `WEBVTT

0f5a7ce8-2d7b-4a3e-9d0c-6f3a9e1b2c44/12-0
00:00:03.120 --> 00:00:05.430
<v Mira Chen>Okay, let's get started with the</v>

0f5a7ce8-2d7b-4a3e-9d0c-6f3a9e1b2c44/12-1
00:00:05.430 --> 00:00:07.900
<v Mira Chen>Atlas launch review.</v>

0f5a7ce8-2d7b-4a3e-9d0c-6f3a9e1b2c44/18-0
00:00:08.200 --> 00:00:12.050
<v Arjun Rao>Thanks. The CSV import is fixed &amp; deployed to staging.</v>

0f5a7ce8-2d7b-4a3e-9d0c-6f3a9e1b2c44/23-0
00:01:14.000 --> 00:01:19.300
<v Mira Chen>Great. We agreed to ship on Friday. I'll send the release note to the team.</v>
`;

test("Teams .vtt: voice tags, merged turns, timestamps, decisions and commitments", () => {
  const parsed = parseTranscript(TEAMS_VTT, "Atlas launch review-20261103_150302-Meeting Transcript.vtt");
  assert.equal(parsed.format, "teams-vtt");
  assert.deepEqual(parsed.lines.map((line) => [line.speaker, line.at]), [["Mira Chen", "00:03"], ["Arjun Rao", "00:08"], ["Mira Chen", "01:14"]]);
  assert.equal(parsed.lines[0]!.text, "Okay, let's get started with the Atlas launch review.");
  assert.match(parsed.lines[1]!.text, /fixed & deployed/);
  assert.equal(parsed.title, "Atlas launch review");
  assert.deepEqual(parsed.when, { date: "2026-11-03", time: "15:03", zone: null });
  assert.equal(parsed.suggested, true);
  assert.deepEqual(parsed.actionItems.map((item) => [item.text, item.assignee?.name]), [["I'll send the release note to the team.", "Mira Chen"]]);
  assert.match(parsed.decisions[0]!, /We agreed to ship on Friday/);
  assert.equal(parsed.durationSeconds, 74);
});

test("Zoom .vtt: numbered cues with Speaker: text", () => {
  const parsed = parseTranscript(`WEBVTT

1
00:00:01.010 --> 00:00:04.200
Mira Chen: Can everyone hear me?

2
00:00:04.900 --> 00:00:06.000
Arjun Rao: Yes, loud and clear.

3
00:00:06.300 --> 00:00:09.000
Arjun Rao: Let's start with the roadmap.
`);
  assert.equal(parsed.format, "zoom-vtt");
  assert.deepEqual(parsed.lines, [
    { speaker: "Mira Chen", text: "Can everyone hear me?", at: "00:01" },
    { speaker: "Arjun Rao", text: "Yes, loud and clear. Let's start with the roadmap.", at: "00:04" },
  ]);
});

test("SubRip (.srt) from Otter with speaker prefixes", () => {
  const parsed = parseTranscript(`1
00:00:00,000 --> 00:00:04,500
Mira Chen: Morning, everyone.

2
00:00:05,100 --> 00:00:09,800
Speaker 2: Morning. Quick update on hiring.
`);
  assert.equal(parsed.format, "srt");
  assert.deepEqual(parsed.lines.map((line) => line.speaker), ["Mira Chen", "Speaker 2"]);
  assert.equal(parsed.lines[1]!.at, "00:05");
});

test("Teams .docx download: title, date, duration and speaker blocks", async () => {
  const docx = await markdownToDocx(
    [
      "Atlas launch review-20261103_150302-Meeting Recording",
      "",
      "November 3, 2026, 3:03PM",
      "",
      "32m 15s",
      "",
      "Mira Chen started transcription",
      "",
      "Mira Chen   0:03",
      "",
      "Okay, let's get started.",
      "",
      "Arjun Rao   0:10",
      "",
      "The CSV import is fixed.",
      "",
      "Arjun Rao   0:14",
      "",
      "It's on staging now.",
    ].join("\n"),
  );
  const text = await readFileText("Atlas launch review.docx", docx);
  const parsed = parseTranscript(text.text, "Atlas launch review.docx");
  assert.equal(parsed.format, "teams-docx");
  assert.equal(parsed.title, "Atlas launch review");
  assert.deepEqual(parsed.when, { date: "2026-11-03", time: "15:03", zone: null });
  assert.equal(parsed.durationSeconds, 32 * 60 + 15);
  assert.deepEqual(parsed.lines, [
    { speaker: "Mira Chen", text: "Okay, let's get started.", at: "00:03" },
    { speaker: "Arjun Rao", text: "The CSV import is fixed. It's on staging now.", at: "00:10" },
  ]);
});

test("Copied from the Teams transcript panel: inline and stacked forms", () => {
  const inline = parseTranscript("Mira Chen  0:03 Okay, let's get started.\nArjun Rao  0:10 The CSV import is fixed.\nArjun Rao  0:14 It's on staging now.\n");
  assert.equal(inline.format, "teams-copy");
  assert.deepEqual(inline.lines.map((line) => [line.speaker, line.at, line.text]), [
    ["Mira Chen", "00:03", "Okay, let's get started."],
    ["Arjun Rao", "00:10", "The CSV import is fixed. It's on staging now."],
  ]);
  const stacked = parseTranscript("Mira Chen\n0:03\nOkay, let's get started.\nArjun Rao\n1:02:10\nThe CSV import is fixed.\n");
  assert.equal(stacked.format, "teams-copy");
  assert.deepEqual(stacked.lines.map((line) => [line.speaker, line.at]), [["Mira Chen", "00:03"], ["Arjun Rao", "1:02:10"]]);
  assert.equal(stacked.title, null, "a speaker's name is not the meeting title");
});

test("Zoom saved transcript (.txt): [Speaker] 00:00:01", () => {
  const parsed = parseTranscript("[Mira Chen] 00:00:01\nWelcome, everyone.\n\n[Arjun Rao] 00:00:06\nThanks for having me.\nShall we look at the numbers?\n");
  assert.equal(parsed.format, "zoom-txt");
  assert.deepEqual(parsed.lines, [
    { speaker: "Mira Chen", text: "Welcome, everyone.", at: "00:01" },
    { speaker: "Arjun Rao", text: "Thanks for having me. Shall we look at the numbers?", at: "00:06" },
  ]);
});

test("Google Meet transcript (Docs export): attendees, five-minute marks, Gemini next steps", () => {
  const parsed = parseTranscript(`Atlas weekly sync - 2026/11/02 10:00 PST - Transcript
Attendees
Mira Chen, Arjun Rao, Lena Ortiz
Suggested next steps
[Arjun Rao] Fix the CSV edge case before Friday.
[Mira Chen] Send the release note.
Transcript
This editable transcript was computer generated and might contain errors. People can also change the text after it was created.
00:00:00

Mira Chen: Morning. Let's go through the launch list.
Arjun Rao: The import is done.
00:05:00

Lena Ortiz: Docs are ready too.
`);
  assert.equal(parsed.format, "google-meet");
  assert.equal(parsed.title, "Atlas weekly sync");
  assert.deepEqual(parsed.when, { date: "2026-11-02", time: "10:00", zone: "GMT-08:00" });
  assert.deepEqual(parsed.attendees, ["Mira Chen", "Arjun Rao", "Lena Ortiz"]);
  assert.deepEqual(parsed.lines.map((line) => [line.speaker, line.at]), [["Mira Chen", "00:00"], ["Arjun Rao", null], ["Lena Ortiz", "05:00"]]);
  assert.deepEqual(parsed.actionItems.map((item) => [item.assignee?.name, item.text]), [["Arjun Rao", "Fix the CSV edge case before Friday."], ["Mira Chen", "Send the release note."]]);
  assert.equal(parsed.suggested, false);
});

test("Otter .txt export: header, speakers list and footer", () => {
  const parsed = parseTranscript(`Atlas design review
Tue, Nov 3, 2026 9:30AM • 41:07

SUMMARY KEYWORDS
import, csv, release

SPEAKERS
Mira Chen, Arjun Rao

Mira Chen  00:02
Let's look at the design.

Arjun Rao  00:09
Sure. The table view needs work.
I can take that.

Transcribed by https://otter.ai
`);
  assert.equal(parsed.format, "otter");
  assert.equal(parsed.title, "Atlas design review");
  assert.deepEqual(parsed.when, { date: "2026-11-03", time: "09:30", zone: null });
  assert.equal(parsed.durationSeconds, 41 * 60 + 7);
  assert.deepEqual(parsed.attendees, ["Mira Chen", "Arjun Rao"]);
  assert.deepEqual(parsed.lines.map((line) => line.text), ["Let's look at the design.", "Sure. The table view needs work. I can take that."]);
});

test("Fireflies JSON export: sentences, title, date, summary and action items", () => {
  const parsed = parseTranscript(
    JSON.stringify({
      title: "Atlas launch review",
      date: Date.UTC(2026, 10, 3, 15, 0),
      duration: 32,
      sentences: [
        { index: 0, speaker_name: "Mira Chen", speaker_id: 0, text: "Let's start.", raw_text: "Let's start.", start_time: 1.2, end_time: 2 },
        { index: 1, speaker_name: "Mira Chen", speaker_id: 0, text: "First, the import.", raw_text: "First, the import.", start_time: 2.4, end_time: 4 },
        { index: 2, speaker_name: "Arjun Rao", speaker_id: 1, text: "It's fixed.", raw_text: "It's fixed.", start_time: 65.5, end_time: 67 },
      ],
      summary: { overview: "Import fixed; launch Friday.", action_items: "**Arjun Rao**\nDeploy the import fix (01:05)" },
    }),
    "atlas.json",
  );
  assert.equal(parsed.format, "fireflies-json");
  assert.equal(parsed.title, "Atlas launch review");
  assert.equal(parsed.startedAt?.toISOString(), "2026-11-03T15:00:00.000Z");
  assert.equal(parsed.durationSeconds, 32 * 60);
  assert.deepEqual(parsed.lines.map((line) => [line.speaker, line.at, line.text]), [["Mira Chen", "00:01", "Let's start. First, the import."], ["Arjun Rao", "01:05", "It's fixed."]]);
  assert.equal(parsed.summary, "Import fixed; launch Friday.");
  assert.deepEqual(parsed.actionItems.map((item) => [item.assignee?.name, item.text, item.at]), [["Arjun Rao", "Deploy the import fix", "01:05"]]);
});

test("tl;dv JSON and millisecond offsets", () => {
  const tldv = parseTranscript(JSON.stringify({ id: "t1", meetingId: "m1", data: [{ speaker: "Arjun Rao", text: "Ready.", startTime: 30, endTime: 32 }, { speaker: "Mira Chen", text: "Go.", startTime: 35, endTime: 36 }] }));
  assert.equal(tldv.format, "tldv-json");
  assert.deepEqual(tldv.lines.map((line) => line.at), ["00:30", "00:35"]);
  const ms = parseTranscript(JSON.stringify({ utterances: [{ speaker: "A", text: "Hello there.", start: 1200 }, { speaker: "B", text: "Hi.", start: 3_725_000 }] }));
  assert.equal(ms.format, "json");
  assert.deepEqual(ms.lines.map((line) => line.at), ["00:01", "1:02:05"]);
});

test("Speaker: text lines, wrapped lines, and plain text without speakers", () => {
  const lines = parseTranscript("Mira Chen: We should cut scope.\nIt keeps the date.\nArjun Rao: Agreed.\n");
  assert.equal(lines.format, "speaker-lines");
  assert.deepEqual(lines.lines.map((line) => line.text), ["We should cut scope. It keeps the date.", "Agreed."]);
  const plain = parseTranscript("Notes from the hallway.\n\nWe talked about the launch.");
  assert.equal(plain.format, "plain");
  assert.equal(plain.lines.length, 2);
  assert.ok(plain.warnings.some((warning) => /No speakers/.test(warning)));
  assert.equal(parseTranscript("").lines.length, 0);
  assert.equal(parseTranscript("{not json").format, "plain");
});

test("our own text form reads back exactly, and dates and file names are understood", () => {
  const parsed = parseTranscript(TEAMS_VTT);
  const text = transcriptDocument(parsed.lines);
  assert.deepEqual(readTranscript(text), parsed.lines);
  assert.deepEqual(parseTranscript(text).lines, parsed.lines, "pasting Ensemble's own transcript text parses it again");
  assert.deepEqual(writtenTime("2026-11-02 10:00 GMT-05:00"), { date: "2026-11-02", time: "10:00", zone: "GMT-05:00" });
  assert.deepEqual(writtenTime("Mon, Jan 15, 2024 1:03PM"), { date: "2024-01-15", time: "13:03", zone: null });
  assert.deepEqual(fromFilename("Weekly sync - 2026-11-02 - Transcript.txt"), { title: "Weekly sync", when: { date: "2026-11-02", time: null, zone: null } });
});

test("spoken commitments and decisions stay literal and bounded", () => {
  const found = spokenItems([
    { speaker: "Mira Chen", text: "Thanks all. I’ll draft the launch email tonight. Nice weather.", at: "02:00" },
    { speaker: "Arjun Rao", text: "Could you review the migration plan? We decided to keep Postgres.", at: "03:10" },
    { speaker: "Lena Ortiz", text: "Action item: update the docs.", at: null },
  ]);
  assert.deepEqual(found.actionItems.map((item) => [item.text, item.assignee?.name ?? null]), [
    ["I’ll draft the launch email tonight.", "Mira Chen"],
    ["Could you review the migration plan?", null],
    ["update the docs.", null],
  ]);
  assert.deepEqual(found.decisions, ["We decided to keep Postgres. (Arjun Rao)"]);
});
