/**
 * Google Workspace tools: request shapes, previews and errors, against a mocked
 * fetch. Nothing here reaches Google.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import "../../runtime/test-env.js";
import { DEFAULT_SETTINGS, type Settings } from "@ensemble/shared-types";
import { ConnectorNotConnectedError } from "../../connectors/tokens.js";
import { markdownToDocx } from "../../lib/office/docx.js";
import type { ToolContext } from "../types.js";
import { AppRequestError, setAppTokenResolverForTests } from "./apps-common.js";
import { docsAppendRequests, googleWorkspaceTools, rangeFor } from "./google-workspace.js";

const G = "https://www.googleapis.com/auth/";
const ALL_SCOPES = [`${G}gmail.readonly`, `${G}calendar.events`, `${G}calendar.calendarlist.readonly`, `${G}drive.file`];
const TOKEN = "ya29.test-google-token";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  raw: unknown;
}

let seen: Seen[] = [];
let respond: (request: Seen) => Response | Promise<Response> = () => json({});
let scopes = ALL_SCOPES;
const originalFetch = globalThis.fetch;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  seen = [];
  scopes = ALL_SCOPES;
  setAppTokenResolverForTests(async () => ({ token: TOKEN, account: "mira@fieldnote.example", scopes }));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body;
    let body: unknown = raw;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const request = { method: init?.method ?? "GET", url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body, raw };
    seen.push(request);
    return respond(request);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setAppTokenResolverForTests(null);
});

function ctx(settings: Partial<Settings> = {}): ToolContext {
  const prisma = {
    user: { findUnique: async () => ({ name: "Mira Chen", onboardingRole: "lawyer" }) },
    authToken: { findUnique: async () => ({ account: "mira@fieldnote.example" }), findMany: async () => [] },
  };
  return {
    app: { log: { error() {} } } as never,
    prisma: prisma as never,
    userId: "user-mira",
    actor: "agent",
    settings: { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata", ...settings },
  };
}

function tool(name: string) {
  const found = googleWorkspaceTools.find((candidate) => candidate.name === name);
  assert.ok(found, name);
  return found;
}

async function preview(name: string, input: Record<string, unknown>): Promise<string> {
  const target = tool(name);
  assert.ok(target.preview, `${name} has a preview`);
  return target.preview(ctx(), target.input.parse(input));
}

async function run(name: string, input: Record<string, unknown>) {
  const target = tool(name);
  return target.run(ctx(), target.input.parse(input));
}

const b64url = (text: string) => Buffer.from(text).toString("base64url");

test("every Google tool is an app tool with a short description, and writes are marked", () => {
  const writes = googleWorkspaceTools.filter((candidate) => candidate.isWrite).map((candidate) => candidate.name).sort();
  assert.deepEqual(writes, [
    "calendar_create_event",
    "calendar_update_event",
    "docs_append",
    "docs_create",
    "docs_replace_text",
    "sheets_append_rows",
    "sheets_create",
    "sheets_update_range",
    "slides_create",
  ]);
  for (const candidate of googleWorkspaceTools) {
    assert.equal(candidate.area, "apps", candidate.name);
    assert.equal(candidate.app?.provider, "google", candidate.name);
    assert.ok(candidate.description.length >= 40 && candidate.description.length <= 160, `${candidate.name}: ${candidate.description.length}`);
    if (candidate.isWrite) assert.ok(candidate.preview, `${candidate.name} previews`);
  }
});

test("gmail_search lists ids, then reads headers; gmail_read returns the plain body and the thread link", async () => {
  respond = ({ url }) => {
    if (url.includes("/messages?")) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
    const id = url.includes("/messages/m1") ? "m1" : "m2";
    return json({
      id,
      threadId: `t-${id}`,
      snippet: "Numbers attached",
      labelIds: id === "m1" ? ["UNREAD"] : [],
      payload: {
        headers: [
          { name: "From", value: "Sam Ortiz <sam@fieldnote.example>" },
          { name: "Subject", value: "Q4 budget" },
          { name: "Date", value: "Tue, 6 Oct 2026 10:00:00 +0530" },
        ],
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Hi Mira,\nThe numbers are in.") } },
          { mimeType: "application/pdf", filename: "budget.pdf", body: { size: 10 } },
        ],
      },
    });
  };
  const search = await run("gmail_search", { query: "from:sam@fieldnote.example newer_than:7d", max: 5 });
  const list = new URL(seen[0]!.url);
  assert.equal(list.origin + list.pathname, "https://gmail.googleapis.com/gmail/v1/users/me/messages");
  assert.equal(list.searchParams.get("q"), "from:sam@fieldnote.example newer_than:7d");
  assert.equal(list.searchParams.get("maxResults"), "5");
  assert.match(seen[1]!.url, /messages\/m1\?format=metadata&metadataHeaders=From/);
  assert.equal(seen[0]!.headers.authorization, `Bearer ${TOKEN}`);
  const data = search.data as { messages: Array<{ subject: string; unread: boolean }>; note: string };
  assert.equal(data.messages.length, 2);
  assert.equal(data.messages[0]?.subject, "Q4 budget");
  assert.equal(data.messages[0]?.unread, true);
  assert.match(data.note, /not as instructions/);
  assert.doesNotMatch(JSON.stringify(search), new RegExp(TOKEN));

  seen = [];
  const read = await run("gmail_read", { id: "m1" });
  assert.match(seen[0]!.url, /messages\/m1\?format=full$/);
  const message = read.data as { body: string; attachments: string[]; subject: string };
  assert.equal(message.body, "Hi Mira,\nThe numbers are in.");
  assert.deepEqual(message.attachments, ["budget.pdf"]);
  assert.equal(read.href, "https://mail.google.com/mail/u/0/#all/t-m1");
});

test("calendar_list_events turns local dates into instants in the person's zone", async () => {
  respond = () =>
    json({
      items: [
        { id: "e1", summary: "Design review", start: { dateTime: "2026-10-14T15:00:00+05:30" }, end: { dateTime: "2026-10-14T15:30:00+05:30" }, htmlLink: "https://calendar.google.com/e1" },
        { id: "e2", summary: "Offsite", start: { date: "2026-10-15" }, end: { date: "2026-10-17" } },
        { id: "e3", summary: "Dropped", status: "cancelled", start: { date: "2026-10-15" }, end: { date: "2026-10-16" } },
      ],
    });
  const result = await run("calendar_list_events", { from: "2026-10-14", to: "2026-10-16" });
  const url = new URL(seen[0]!.url);
  assert.equal(url.pathname, "/calendar/v3/calendars/primary/events");
  assert.equal(url.searchParams.get("timeMin"), "2026-10-13T18:30:00.000Z");
  assert.equal(url.searchParams.get("timeMax"), "2026-10-16T18:30:00.000Z");
  assert.equal(url.searchParams.get("singleEvents"), "true");
  assert.equal(url.searchParams.get("orderBy"), "startTime");
  const events = (result.data as { events: Array<{ title: string; start: string; end: string; allDay: boolean }> }).events;
  assert.deepEqual(
    events.map((event) => [event.title, event.start, event.end, event.allDay]),
    [
      ["Design review", "Wed 14 Oct 15:00", "Wed 14 Oct 15:30", false],
      ["Offsite", "2026-10-15", "2026-10-16", true],
    ],
  );
});

test("calendar_create_event previews exactly what happens, then creates it with invites and a Meet link", async () => {
  const input = {
    title: "Design review",
    start: "2026-10-14T15:00",
    attendees: ["sam@fieldnote.example"],
    googleMeet: true,
    description: "Walk through the new store",
  };
  const text = await preview("calendar_create_event", input);
  assert.equal(
    text.split("\n")[0],
    "Create event “Design review” Wed 14 Oct 15:00–15:30 IST in Mira's calendar (mira@fieldnote.example) and email invites to sam@fieldnote.example.",
  );
  assert.match(text, /Adds a Google Meet link\./);
  assert.equal(seen.length, 0, "a preview makes no calls to Google");

  respond = () => json({ id: "evt1", htmlLink: "https://www.google.com/calendar/event?eid=evt1", hangoutLink: "https://meet.google.com/abc-defg-hij" });
  const result = await run("calendar_create_event", input);
  const request = seen[0]!;
  const url = new URL(request.url);
  assert.equal(request.method, "POST");
  assert.equal(url.pathname, "/calendar/v3/calendars/primary/events");
  assert.equal(url.searchParams.get("sendUpdates"), "all");
  assert.equal(url.searchParams.get("conferenceDataVersion"), "1");
  const body = request.body as Record<string, any>;
  assert.equal(body.summary, "Design review");
  assert.deepEqual(body.start, { dateTime: "2026-10-14T15:00:00", timeZone: "Asia/Kolkata" });
  assert.deepEqual(body.end, { dateTime: "2026-10-14T15:30:00", timeZone: "Asia/Kolkata" });
  assert.deepEqual(body.attendees, [{ email: "sam@fieldnote.example" }]);
  assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.ok(body.conferenceData.createRequest.requestId);
  assert.equal(result.href, "https://www.google.com/calendar/event?eid=evt1");
  assert.deepEqual(result.data, { id: "evt1", link: "https://www.google.com/calendar/event?eid=evt1", meetLink: "https://meet.google.com/abc-defg-hij" });

  seen = [];
  respond = () => json({ id: "evt2", htmlLink: "https://calendar.google.com/evt2" });
  await run("calendar_create_event", { title: "Offsite", start: "2026-10-20", end: "2026-10-21" });
  const allDay = seen[0]!;
  assert.equal(new URL(allDay.url).searchParams.get("sendUpdates"), "none");
  assert.deepEqual((allDay.body as Record<string, unknown>).start, { date: "2026-10-20" });
  assert.deepEqual((allDay.body as Record<string, unknown>).end, { date: "2026-10-22" }, "Google's all-day end is exclusive");
  await assert.rejects(() => preview("calendar_create_event", { title: "x", start: "2026-10-14T15:00", end: "2026-10-14T14:00" }), /ends before it starts/);
  assert.throws(() => tool("calendar_create_event").input.parse({ title: "x", start: "next Tuesday" }));
});

test("calendar_update_event keeps the length when only the start moves and merges guests", async () => {
  const current = {
    id: "evt1",
    summary: "Design review",
    start: { dateTime: "2026-10-14T15:00:00+05:30", timeZone: "Asia/Kolkata" },
    end: { dateTime: "2026-10-14T16:00:00+05:30", timeZone: "Asia/Kolkata" },
    attendees: [{ email: "sam@fieldnote.example" }, { email: "lee@fieldnote.example" }],
  };
  respond = ({ method }) => (method === "GET" ? json(current) : json({ ...current, htmlLink: "https://calendar.google.com/evt1" }));
  const input = { eventId: "evt1", start: "2026-10-15T11:00", addAttendees: ["ana@fieldnote.example"], removeAttendees: ["lee@fieldnote.example"] };
  const text = await preview("calendar_update_event", input);
  assert.match(text, /^Update “Design review” \(Wed 14 Oct 15:00\) in Mira's calendar \(mira@fieldnote.example\): move it to Thu 15 Oct 11:00–12:00 IST; add ana@fieldnote.example; remove lee@fieldnote.example\. Google emails the update to the guests\./);
  seen = [];
  const result = await run("calendar_update_event", input);
  const patch = seen.find((request) => request.method === "PATCH")!;
  assert.equal(new URL(patch.url).searchParams.get("sendUpdates"), "all");
  const body = patch.body as Record<string, unknown>;
  assert.deepEqual(body.start, { dateTime: "2026-10-15T11:00:00", timeZone: "Asia/Kolkata" });
  assert.deepEqual(body.end, { dateTime: "2026-10-15T12:00:00", timeZone: "Asia/Kolkata" });
  assert.deepEqual(body.attendees, [{ email: "sam@fieldnote.example" }, { email: "ana@fieldnote.example" }]);
  assert.equal(result.href, "https://calendar.google.com/evt1");
  assert.throws(() => tool("calendar_update_event").input.parse({ eventId: "evt1" }), /Say what to change/);
});

test("drive_list_files escapes the search and says when only Ensemble's own files are visible", async () => {
  respond = () => json({ files: [{ id: "f1", name: "Q4 plan", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/document/d/f1/edit" }] });
  const result = await run("drive_list_files", { query: "Mira's plan", kind: "document" });
  const url = new URL(seen[0]!.url);
  assert.equal(url.searchParams.get("q"), "trashed = false and mimeType = 'application/vnd.google-apps.document' and (name contains 'Mira\\'s plan' or fullText contains 'Mira\\'s plan')");
  assert.equal(url.searchParams.get("orderBy"), null, "Drive refuses to sort a full-text search");
  const data = result.data as { files: Array<{ kind: string }>; note?: string };
  assert.equal(data.files[0]?.kind, "Google Doc");
  assert.match(data.note ?? "", /created or that the person picked/);
  seen = [];
  scopes = [...ALL_SCOPES, `${G}drive.readonly`];
  const full = await run("drive_list_files", {});
  assert.equal(new URL(seen[0]!.url).searchParams.get("orderBy"), "modifiedTime desc");
  assert.equal((full.data as { note?: string }).note, undefined);
});

test("drive_read_file exports Docs as Markdown, reads Word files, and returns only details for a PDF", async () => {
  const docx = await markdownToDocx("# Brief\n\n- Scope\n- Budget", "Brief");
  respond = ({ url }) => {
    if (url.includes("/files/doc1?")) return json({ id: "doc1", name: "Plan", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/document/d/doc1/edit" });
    if (url.includes("/files/doc1/export")) return new Response("# Plan\n\nShip it.");
    if (url.includes("/files/word1?fields")) return json({ id: "word1", name: "Brief.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    if (url.includes("/files/word1?alt=media")) return new Response(docx);
    if (url.includes("/files/pdf1?")) return json({ id: "pdf1", name: "Contract.pdf", mimeType: "application/pdf", webViewLink: "https://drive.google.com/file/d/pdf1/view" });
    return json({ error: { message: "unexpected" } }, 500);
  };
  const doc = await run("drive_read_file", { fileId: "doc1" });
  assert.match(seen[1]!.url, /files\/doc1\/export\?mimeType=text%2Fmarkdown$/);
  assert.equal((doc.data as { text: string }).text, "# Plan\n\nShip it.");
  assert.equal(doc.href, "https://docs.google.com/document/d/doc1/edit");
  const word = await run("drive_read_file", { fileId: "word1" });
  assert.match((word.data as { text: string }).text, /# Brief\n- Scope\n- Budget/);
  seen = [];
  const pdf = await run("drive_read_file", { fileId: "pdf1" });
  assert.equal(seen.length, 1, "a PDF is not downloaded");
  assert.match(pdf.summary, /cannot read as text/);
  assert.equal((pdf.data as { text?: string }).text, undefined);
});

test("docs_create uploads HTML that Drive converts into a Google Doc, and previews the outline", async () => {
  const input = { title: "Launch plan", markdown: "# Launch plan\n\n## Steps\n\n- **Draft** the brief\n\n| A | B |\n| --- | --- |\n| 1 | 2 |" };
  const text = await preview("docs_create", input);
  assert.match(text, /^Create Google Doc “Launch plan” in Mira's Google Drive \(mira@fieldnote.example\) with \d+ words\. Only they can open it until it is shared\./);
  assert.match(text, /Outline:\n- Launch plan\n- Steps/);
  respond = () => json({ id: "doc9", name: "Launch plan", webViewLink: "https://docs.google.com/document/d/doc9/edit" });
  const result = await run("docs_create", input);
  const request = seen[0]!;
  assert.equal(request.method, "POST");
  assert.match(request.url, /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=multipart/);
  const boundary = /boundary=(\S+)/.exec(request.headers["content-type"] ?? "")?.[1];
  assert.ok(boundary && request.headers["content-type"]?.startsWith("multipart/related"));
  const body = Buffer.from(request.raw as Uint8Array).toString("utf8");
  assert.match(body, /"mimeType":"application\/vnd.google-apps.document"/);
  assert.match(body, /"name":"Launch plan"/);
  assert.match(body, /Content-Type: text\/html/);
  assert.match(body, /<h2>Steps<\/h2>/);
  assert.match(body, /<li><strong>Draft<\/strong> the brief<\/li>/);
  assert.match(body, /<table/);
  assert.ok(body.trimEnd().endsWith(`--${boundary}--`));
  assert.equal(result.href, "https://docs.google.com/document/d/doc9/edit");
});

test("docs_append inserts at the end with heading, bullet and link styles", async () => {
  const empty = docsAppendRequests("## Next\n\n- One\n  - Two", 2);
  assert.deepEqual(empty[0], { insertText: { location: { index: 1 }, text: "Next\nOne\n\tTwo" } });
  assert.ok(empty.some((request) => JSON.stringify(request).includes('"namedStyleType":"HEADING_2"')));
  assert.deepEqual(empty.at(-1), { createParagraphBullets: { range: { startIndex: 6, endIndex: 14 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });

  respond = ({ method }) => (method === "GET" ? json({ title: "Notes", body: { content: [{ endIndex: 1 }, { endIndex: 10 }] } }) : json({ replies: [] }));
  const text = await preview("docs_append", { documentId: "doc1", markdown: "See [the brief](https://fieldnote.example/brief)." });
  assert.match(text, /^Add 3 words to the end of the Google Doc “Notes”\. Nothing already in it changes\./);
  seen = [];
  const result = await run("docs_append", { documentId: "doc1", markdown: "See [the brief](https://fieldnote.example/brief)." });
  assert.match(seen[0]!.url, /documents\/doc1\?fields=title,body\/content\/endIndex$/);
  const update = seen[1]!;
  assert.match(update.url, /documents\/doc1:batchUpdate$/);
  const requests = (update.body as { requests: Array<Record<string, any>> }).requests;
  assert.deepEqual(requests[0], { insertText: { location: { index: 9 }, text: "\nSee the brief." } });
  const link = requests.find((request) => request.updateTextStyle?.textStyle?.link);
  assert.deepEqual(link?.updateTextStyle.range, { startIndex: 14, endIndex: 23 });
  assert.equal(link?.updateTextStyle.textStyle.link.url, "https://fieldnote.example/brief");
  assert.equal(result.href, "https://docs.google.com/document/d/doc1/edit");
});

test("docs_replace_text lists each replacement and reports how many changed", async () => {
  respond = ({ method }) => (method === "GET" ? json({ title: "Contract" }) : json({ replies: [{ replaceAllText: { occurrencesChanged: 3 } }] }));
  const text = await preview("docs_replace_text", { documentId: "doc1", replacements: [{ find: "Acme", replace: "Fieldnote" }] });
  assert.equal(text, "In the Google Doc “Contract”, replace:\n- every “Acme” → “Fieldnote”");
  seen = [];
  const result = await run("docs_replace_text", { documentId: "doc1", replacements: [{ find: "Acme", replace: "Fieldnote" }] });
  assert.deepEqual((seen[0]!.body as { requests: unknown[] }).requests, [{ replaceAllText: { containsText: { text: "Acme", matchCase: true }, replaceText: "Fieldnote" } }]);
  assert.equal(result.summary, "Replaced 3 occurrences in the Google Doc.");
});

test("sheets_create makes the tabs, writes the rows and bolds and freezes the header", async () => {
  respond = ({ url }) =>
    url === "https://sheets.googleapis.com/v4/spreadsheets"
      ? json({ spreadsheetId: "s1", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/s1/edit", sheets: [{ properties: { sheetId: 7, title: "Budget" } }] })
      : json({});
  const input = { title: "Q4 budget", sheets: [{ name: "Budget", headers: ["Item", "Cost"], rows: [["Venue", 1200], ["Total", "=SUM(B2)"]] }] };
  const text = await preview("sheets_create", input);
  assert.match(text, /^Create Google Sheet “Q4 budget” in Mira's Google Drive \(mira@fieldnote.example\) with 2 rows\.\n\| Item \| Cost \|/);
  const result = await run("sheets_create", input);
  assert.deepEqual(seen[0]!.body, { properties: { title: "Q4 budget" }, sheets: [{ properties: { title: "Budget" } }] });
  assert.match(seen[1]!.url, /spreadsheets\/s1\/values:batchUpdate$/);
  assert.deepEqual(seen[1]!.body, {
    valueInputOption: "USER_ENTERED",
    data: [{ range: "'Budget'!A1", majorDimension: "ROWS", values: [["Item", "Cost"], ["Venue", 1200], ["Total", "=SUM(B2)"]] }],
  });
  const formatting = (seen[2]!.body as { requests: Array<Record<string, any>> }).requests;
  assert.equal(formatting[0]?.repeatCell.range.sheetId, 7);
  assert.equal(formatting[1]?.updateSheetProperties.properties.gridProperties.frozenRowCount, 1);
  assert.equal(result.href, "https://docs.google.com/spreadsheets/d/s1/edit");
});

test("sheets_read defaults to the first tab; sheets_update_range sizes the range to the values; sheets_append_rows appends", async () => {
  respond = ({ url, method }) => {
    if (url.includes("?fields=")) return json({ spreadsheetUrl: "https://docs.google.com/spreadsheets/d/s1/edit", properties: { title: "Budget" }, sheets: [{ properties: { title: "Q4 'plan'" } }] });
    if (method === "GET") return json({ range: "'Q4 ''plan'''!A1:B3", values: [["Item", "Cost"], ["Venue", "1200"], ["Food", "300"]] });
    if (method === "PUT") return json({ updatedRange: "'Budget'!B2:D3", updatedCells: 6 });
    return json({ updates: { updatedRange: "'Budget'!A4:B4", updatedRows: 1 } });
  };
  const read = await run("sheets_read", { spreadsheetId: "s1", maxRows: 2 });
  assert.match(seen[1]!.url, /values\/'Q4%20''plan'''\?valueRenderOption=FORMATTED_VALUE$/);
  assert.deepEqual((read.data as { rows: unknown[][]; truncated?: boolean }).rows, [["Item", "Cost"], ["Venue", "1200"]]);
  assert.equal((read.data as { truncated?: boolean }).truncated, true);

  assert.deepEqual(rangeFor("Budget!B2", 2, 3), { sheet: "Budget", range: "'Budget'!B2:D3" });
  assert.deepEqual(rangeFor("Z9:AA10", 1, 3), { sheet: null, range: "Z9:AB9" });
  const update = { spreadsheetId: "s1", range: "Budget!B2:B2", values: [["a", 1, true], ["b", 2, null]] };
  const text = await preview("sheets_update_range", update);
  assert.match(text, /^In the Google Sheet “Budget”, overwrite 'Budget'!B2:D3 \(2 rows × 3 columns\) with:/);
  seen = [];
  await run("sheets_update_range", update);
  assert.equal(seen[0]!.method, "PUT");
  assert.match(seen[0]!.url, /values\/'Budget'!B2%3AD3\?valueInputOption=USER_ENTERED$/);
  assert.deepEqual((seen[0]!.body as { values: unknown[][] }).values, [["a", 1, true], ["b", 2, ""]]);

  seen = [];
  const appended = await run("sheets_append_rows", { spreadsheetId: "s1", sheet: "Budget", rows: [["Total", 1500]] });
  assert.match(seen[0]!.url, /values\/'Budget'%3Aappend\?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS$|values\/'Budget':append\?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS$/);
  assert.equal(appended.summary, "Added 1 row at 'Budget'!A4:B4.");
});

test("slides_create fills the cover, adds a slide per spec with bullets, then writes speaker notes", async () => {
  respond = ({ url, method }) => {
    if (method === "POST" && url.endsWith("/presentations")) {
      return json({
        presentationId: "p1",
        slides: [{ objectId: "cover", pageElements: [{ objectId: "t0", shape: { placeholder: { type: "CENTERED_TITLE" } } }, { objectId: "s0", shape: { placeholder: { type: "SUBTITLE" } } }] }],
      });
    }
    if (method === "GET") {
      return json({ slides: [{ objectId: "cover" }, { objectId: "ens_slide_0", slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: "notes0" } } } }] });
    }
    return json({ replies: [] });
  };
  const input = { title: "Q4 review", subtitle: "Fieldnote", slides: [{ title: "Wins", bullets: ["Imports", "  Notion"], notes: "Mention Sam" }] };
  assert.equal(await preview("slides_create", input), "Create Google Slides deck “Q4 review” in Mira's Google Drive (mira@fieldnote.example) with 2 slides:\n1. Title slide — Fieldnote\n2. Wins (with notes)");
  const result = await run("slides_create", input);
  const first = (seen[1]!.body as { requests: Array<Record<string, any>> }).requests;
  assert.deepEqual(first[0], { insertText: { objectId: "t0", text: "Q4 review" } });
  assert.deepEqual(first[1], { insertText: { objectId: "s0", text: "Fieldnote" } });
  assert.equal(first[2]?.createSlide.slideLayoutReference.predefinedLayout, "TITLE_AND_BODY");
  assert.deepEqual(first[4], { insertText: { objectId: "ens_body_0", text: "Imports\n\tNotion" } });
  assert.equal(first[5]?.createParagraphBullets.objectId, "ens_body_0");
  assert.deepEqual((seen[3]!.body as { requests: unknown[] }).requests, [{ insertText: { objectId: "notes0", text: "Mention Sam" } }]);
  assert.equal(result.href, "https://docs.google.com/presentation/d/p1/edit");
});

test("slides_read returns each slide's title, text and notes", async () => {
  const text = (content: string) => ({ text: { textElements: [{ textRun: { content } }] } });
  respond = () =>
    json({
      title: "Q4 review",
      slides: [
        {
          objectId: "a",
          pageElements: [{ shape: { placeholder: { type: "TITLE" }, ...text("Wins\n") } }, { shape: text("Imports shipped\n") }],
          slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: "n" }, pageElements: [{ objectId: "n", shape: text("Mention Sam\n") }] } },
        },
      ],
    });
  const result = await run("slides_read", { presentationId: "p1" });
  assert.deepEqual((result.data as { slides: unknown[] }).slides, [{ index: 1, title: "Wins", text: "Imports shipped", notes: "Mention Sam" }]);
});

test("missing access and refused calls come back as messages the person can act on, without the token", async () => {
  scopes = [`${G}gmail.readonly`, `${G}calendar.readonly`];
  await assert.rejects(
    () => run("calendar_create_event", { title: "Design review", start: "2026-10-14T15:00" }),
    (error: unknown) =>
      error instanceof ConnectorNotConnectedError &&
      error.statusCode === 409 &&
      error.message === "Google Calendar is connected without the access this needs. Turn it on in Settings → Connections and approve the new permission." &&
      error.missingScopes.includes(`${G}calendar.events`),
  );
  assert.equal(seen.length, 0, "nothing is sent without the scope");
  await run("calendar_list_events", {});
  assert.equal(seen.length, 1, "reading works with calendar.readonly");

  scopes = ALL_SCOPES;
  respond = () => json({ error: { code: 401, message: "Invalid Credentials" } }, 401);
  await assert.rejects(() => run("gmail_search", {}), (error: unknown) => error instanceof ConnectorNotConnectedError && /Reconnect it in Settings → Connections/.test(error.message));
  respond = () => json({ error: { code: 403, message: "Request had insufficient authentication scopes.", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403);
  await assert.rejects(() => run("docs_create", { title: "x", markdown: "y" }), ConnectorNotConnectedError);
  respond = () => json({ error: { code: 404, message: "File not found: zzz." } }, 404);
  await assert.rejects(
    () => run("drive_read_file", { fileId: "zzz" }),
    (error: unknown) => error instanceof AppRequestError && /Google Drive could not find that item \(with the basic Drive access Ensemble only sees files it created or that you picked\)/.test(error.message) && !error.message.includes(TOKEN),
  );
  respond = () => json({ error: { code: 500, message: `backend failed for ${TOKEN}` } }, 500);
  await assert.rejects(
    () => run("gmail_search", {}),
    (error: unknown) => error instanceof AppRequestError && error.statusCode === 424 && error.expose === true && !error.message.includes(TOKEN),
  );
});
