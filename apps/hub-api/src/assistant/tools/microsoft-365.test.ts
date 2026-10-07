/**
 * Microsoft 365 tools: Graph request shapes, previews, Office files and
 * errors, against a mocked fetch. Nothing here reaches Microsoft.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import "../../runtime/test-env.js";
import { DEFAULT_SETTINGS } from "@ensemble/shared-types";
import { ConnectorNotConnectedError } from "../../connectors/tokens.js";
import { markdownToDocx } from "../../lib/office/docx.js";
import { docxText, pptxSlides } from "../../lib/office/extract.js";
import { xlsxToRows } from "../../lib/office/xlsx.js";
import type { ToolContext } from "../types.js";
import { setAppTokenResolverForTests } from "./apps-common.js";
import { microsoft365Tools, odata } from "./microsoft-365.js";

const TOKEN = "eyJ.test-graph-token";
const GRAPH = "https://graph.microsoft.com/v1.0";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  raw: unknown;
}

let seen: Seen[] = [];
let respond: (request: Seen) => Response | Promise<Response> = () => json({});
let scopes: string[] = [];
const originalFetch = globalThis.fetch;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  seen = [];
  scopes = ["openid", "User.Read", "Mail.Read", "Calendars.ReadWrite", "Chat.Read", "Files.ReadWrite"];
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

function ctx(): ToolContext {
  const prisma = {
    user: { findUnique: async () => ({ name: "Mira Chen" }) },
    authToken: { findUnique: async () => ({ account: "mira@fieldnote.example" }), findMany: async () => [] },
  };
  return {
    app: { log: { error() {} } } as never,
    prisma: prisma as never,
    userId: "user-mira",
    actor: "agent",
    settings: { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata" },
  };
}

function tool(name: string) {
  const found = microsoft365Tools.find((candidate) => candidate.name === name);
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

const bytesOf = (request: Seen) => Buffer.from(request.raw as Uint8Array);

test("every Microsoft tool is an app tool with a short description, and writes are marked", () => {
  const writes = microsoft365Tools.filter((candidate) => candidate.isWrite).map((candidate) => candidate.name).sort();
  assert.deepEqual(writes, ["excel_create", "excel_update_range", "outlook_calendar_create_event", "powerpoint_create", "word_create", "word_update"]);
  for (const candidate of microsoft365Tools) {
    assert.equal(candidate.area, "apps", candidate.name);
    assert.equal(candidate.app?.provider, "microsoft", candidate.name);
    assert.ok(candidate.description.length >= 40 && candidate.description.length <= 160, `${candidate.name}: ${candidate.description.length}`);
    if (candidate.isWrite) assert.ok(candidate.preview, `${candidate.name} previews`);
  }
  assert.equal(odata({ $top: 5, $search: '"q4 budget"', skip: undefined }), "?$top=5&$search=%22q4%20budget%22");
});

test("outlook_search_mail searches with $search, or reads the inbox newest first; outlook_read_message asks for text", async () => {
  respond = () => json({ value: [{ id: "m1", subject: "Q4 budget", from: { emailAddress: { name: "Sam Ortiz", address: "sam@fieldnote.example" } }, receivedDateTime: "2026-10-06T04:30:00Z", isRead: false, webLink: "https://outlook.office.com/m1" }] });
  const found = await run("outlook_search_mail", { query: 'budget "Q4"', max: 5 });
  assert.equal(seen[0]!.url, `${GRAPH}/me/messages?$search=%22budget%20%20Q4%22&$top=5&$select=id%2Csubject%2Cfrom%2CtoRecipients%2CreceivedDateTime%2CbodyPreview%2CisRead%2CwebLink`);
  assert.equal(seen[0]!.headers.authorization, `Bearer ${TOKEN}`);
  const message = (found.data as { messages: Array<{ from: string; received: string; unread: boolean }> }).messages[0]!;
  assert.deepEqual([message.from, message.received, message.unread], ["Sam Ortiz <sam@fieldnote.example>", "Tue 6 Oct 10:00", true]);
  seen = [];
  await run("outlook_search_mail", {});
  assert.match(seen[0]!.url, /\/me\/mailFolders\/inbox\/messages\?\$top=10&\$orderby=receivedDateTime%20desc/);

  respond = () => json({ id: "m1", subject: "Q4 budget", from: { emailAddress: { address: "sam@fieldnote.example" } }, body: { contentType: "text", content: "Hi Mira,\r\nNumbers attached." }, webLink: "https://outlook.office.com/m1" });
  seen = [];
  const read = await run("outlook_read_message", { id: "AAMk/1=" });
  assert.match(seen[0]!.url, /\/me\/messages\/AAMk%2F1%3D\?\$select=/);
  assert.equal(seen[0]!.headers.prefer, 'outlook.body-content-type="text"');
  assert.equal((read.data as { body: string }).body, "Hi Mira,\nNumbers attached.");
  assert.equal(read.href, "https://outlook.office.com/m1");
});

test("outlook_calendar_list_events asks Graph for UTC instants and shows them in the person's zone", async () => {
  respond = () =>
    json({
      value: [
        { id: "e1", subject: "Design review", start: { dateTime: "2026-10-14T09:30:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-14T10:00:00.0000000", timeZone: "UTC" }, onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/x" } },
        { id: "e2", subject: "Offsite", isAllDay: true, start: { dateTime: "2026-10-15T00:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-16T00:00:00.0000000", timeZone: "UTC" } },
        { id: "e3", subject: "Gone", isCancelled: true, start: { dateTime: "2026-10-15T00:00:00.0000000", timeZone: "UTC" } },
      ],
    });
  const result = await run("outlook_calendar_list_events", { from: "2026-10-14", to: "2026-10-15" });
  const url = new URL(seen[0]!.url);
  assert.equal(url.pathname, "/v1.0/me/calendarView");
  assert.equal(url.searchParams.get("startDateTime"), "2026-10-13T18:30:00.000Z");
  assert.equal(url.searchParams.get("endDateTime"), "2026-10-15T18:30:00.000Z");
  assert.equal(seen[0]!.headers.prefer, undefined);
  const events = (result.data as { events: Array<{ title: string; start: string; end: string; teamsLink?: string }> }).events;
  assert.deepEqual(
    events.map((event) => [event.title, event.start, event.end]),
    [
      ["Design review", "Wed 14 Oct 15:00", "Wed 14 Oct 15:30"],
      ["Offsite", "2026-10-15", "2026-10-15"],
    ],
  );
  assert.equal(events[0]?.teamsLink, "https://teams.microsoft.com/l/x");
});

test("outlook_calendar_create_event previews the invite, then posts it with a Teams meeting", async () => {
  const input = { title: "Design review", start: "2026-10-14T15:00", end: "2026-10-14T15:45", attendees: ["sam@fieldnote.example"], teamsMeeting: true, location: "Room 4" };
  const text = await preview("outlook_calendar_create_event", input);
  assert.equal(
    text,
    "Create event “Design review” Wed 14 Oct 15:00–15:45 IST in Mira's Outlook calendar (mira@fieldnote.example) and Outlook emails invites to sam@fieldnote.example.\nAdds a Microsoft Teams meeting link.\nLocation: Room 4",
  );
  respond = () => json({ id: "evt1", webLink: "https://outlook.office.com/calendar/item/evt1", onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup" } });
  const result = await run("outlook_calendar_create_event", input);
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.url, `${GRAPH}/me/events`);
  assert.deepEqual(seen[0]!.body, {
    subject: "Design review",
    start: { dateTime: "2026-10-14T15:00:00", timeZone: "Asia/Kolkata" },
    end: { dateTime: "2026-10-14T15:45:00", timeZone: "Asia/Kolkata" },
    isAllDay: false,
    location: { displayName: "Room 4" },
    attendees: [{ emailAddress: { address: "sam@fieldnote.example" }, type: "required" }],
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
  });
  assert.equal(result.href, "https://outlook.office.com/calendar/item/evt1");
  assert.equal((result.data as { teamsLink: string }).teamsLink, "https://teams.microsoft.com/l/meetup");
});

test("teams_list_chats names untitled chats by member; teams_read_chat returns messages oldest first as text", async () => {
  respond = ({ url }) =>
    url.includes("/messages")
      ? json({
          value: [
            { id: "2", messageType: "message", createdDateTime: "2026-10-06T05:00:00Z", from: { user: { displayName: "Sam Ortiz" } }, body: { contentType: "html", content: "<p>Shipped &amp; done</p>" } },
            { id: "x", messageType: "systemEventMessage", createdDateTime: "2026-10-06T04:59:00Z", body: { content: "<systemEvent/>" } },
            { id: "1", messageType: "message", createdDateTime: "2026-10-06T04:00:00Z", from: { user: { displayName: "Mira Chen" } }, body: { contentType: "text", content: "Status?" } },
          ],
        })
      : json({
          value: [
            { id: "c1", topic: null, chatType: "oneOnOne", lastUpdatedDateTime: "2026-10-05T00:00:00Z", members: [{ displayName: "Sam Ortiz" }] },
            { id: "c2", topic: "Launch", chatType: "group", lastUpdatedDateTime: "2026-10-06T00:00:00Z", members: [] },
          ],
        });
  const chats = await run("teams_list_chats", {});
  assert.equal(seen[0]!.url, `${GRAPH}/me/chats?$top=20&$expand=members`);
  assert.deepEqual((chats.data as { chats: Array<{ topic: string }> }).chats.map((chat) => chat.topic), ["Launch", "Sam Ortiz"]);
  const read = await run("teams_read_chat", { chatId: "19:abc@thread.v2" });
  assert.equal(seen[1]!.url, `${GRAPH}/me/chats/19%3Aabc%40thread.v2/messages?$top=30`);
  assert.deepEqual((read.data as { messages: unknown[] }).messages, [
    { from: "Mira Chen", at: "Tue 6 Oct 09:30", text: "Status?" },
    { from: "Sam Ortiz", at: "Tue 6 Oct 10:30", text: "Shipped & done" },
  ]);
});

test("onedrive_search and onedrive_read_file find files and read Word documents; PDFs and folders are not downloaded", async () => {
  const docx = await markdownToDocx("# Brief\n\nScope and budget.", "Brief");
  respond = ({ url }) => {
    if (url.includes("/search(")) return json({ value: [{ id: "i1", name: "Brief.docx", webUrl: "https://onedrive.example/i1", file: {}, parentReference: { path: "/drive/root:/Ensemble" } }] });
    if (url.includes("/items/i1?")) return json({ id: "i1", name: "Brief.docx", size: docx.length, file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, webUrl: "https://onedrive.example/i1" });
    if (url.includes("/items/i1/content")) return new Response(docx);
    if (url.includes("/items/pdf1?")) return json({ id: "pdf1", name: "Contract.pdf", size: 1000, file: { mimeType: "application/pdf" }, webUrl: "https://onedrive.example/pdf1" });
    if (url.includes("/items/dir1?")) return json({ id: "dir1", name: "Ensemble", folder: { childCount: 1 } });
    if (url.includes("/items/dir1/children")) return json({ value: [{ id: "i1", name: "Brief.docx", file: {} }] });
    return json({ error: { message: "unexpected" } }, 500);
  };
  const found = await run("onedrive_search", { query: "Mira's brief" });
  assert.equal(seen[0]!.url, `${GRAPH}/me/drive/root/search(q='Mira''s%20brief')?$top=20`);
  assert.equal((found.data as { files: Array<{ path: string }> }).files[0]?.path, "/Ensemble");
  const read = await run("onedrive_read_file", { itemId: "i1" });
  assert.match((read.data as { text: string }).text, /# Brief\nScope and budget\./);
  seen = [];
  const pdf = await run("onedrive_read_file", { itemId: "pdf1" });
  assert.equal(seen.length, 1);
  assert.match(pdf.summary, /cannot be read as text/);
  const folder = await run("onedrive_read_file", { itemId: "dir1" });
  assert.equal((folder.data as { children: unknown[] }).children.length, 1);
});

test("word_create uploads a real .docx to OneDrive/Ensemble; word_update overwrites only a .docx and says so", async () => {
  respond = () => json({ id: "w1", name: "Launch plan.docx", webUrl: "https://onedrive.example/w1" });
  const input = { title: "Launch plan", markdown: "# Launch plan\n\n- Draft the brief" };
  assert.match(await preview("word_create", input), /^Create Word document “Launch plan\.docx” in Mira's OneDrive \(mira@fieldnote.example\), folder Ensemble, with \d+ words\./);
  seen = [];
  const created = await run("word_create", input);
  assert.equal(seen[0]!.method, "PUT");
  assert.equal(seen[0]!.url, `${GRAPH}/me/drive/root:/Ensemble/Launch%20plan.docx:/content?@microsoft.graph.conflictBehavior=rename`);
  assert.equal(seen[0]!.headers["content-type"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.match(docxText(bytesOf(seen[0]!)), /^# Launch plan\n- Draft the brief$/);
  assert.equal(created.href, "https://onedrive.example/w1");

  respond = ({ method, url }) => {
    if (url.includes("/items/x1?")) return json({ id: "x1", name: "Budget.xlsx", file: {} });
    if (method === "GET") return json({ id: "w1", name: "Plan.docx", eTag: '"{ABC},2"', file: {}, webUrl: "https://onedrive.example/w1" });
    return json({ id: "w1", name: "Plan.docx", webUrl: "https://onedrive.example/w1" });
  };
  const text = await preview("word_update", { itemId: "w1", markdown: "# Plan v2" });
  assert.match(text, /^Overwrite the Word document “Plan\.docx” in OneDrive with new content \(2 words\)\. Everything in it now is replaced/);
  seen = [];
  await run("word_update", { itemId: "w1", markdown: "# Plan v2" });
  const put = seen.find((request) => request.method === "PUT")!;
  assert.equal(put.url, `${GRAPH}/me/drive/items/w1/content`);
  assert.equal(put.headers["if-match"], '"{ABC},2"');
  assert.equal(docxText(bytesOf(put)), "# Plan v2");
  await assert.rejects(() => run("word_update", { itemId: "x1", markdown: "nope" }), /not a Word \(\.docx\) document/);
});

test("excel_create uploads an .xlsx; excel_read_range and excel_update_range use the workbook API", async () => {
  respond = () => json({ id: "b1", name: "Q4 budget.xlsx", webUrl: "https://onedrive.example/b1" });
  await run("excel_create", { title: "Q4 budget", headers: ["Item", "Cost"], rows: [["Venue", 1200]] });
  assert.equal(seen[0]!.url, `${GRAPH}/me/drive/root:/Ensemble/Q4%20budget.xlsx:/content?@microsoft.graph.conflictBehavior=rename`);
  const sheets = await xlsxToRows(bytesOf(seen[0]!));
  assert.deepEqual(sheets[0]?.rows, [["Item", "Cost"], ["Venue", 1200]]);

  respond = ({ url, method }) => {
    if (url.includes("/worksheets?")) return json({ value: [{ name: "Notes", position: 1 }, { name: "Budget", position: 0 }] });
    if (method === "PATCH") return json({ address: "Budget!B2:C3" });
    if (url.includes("/items/b1?")) return json({ id: "b1", name: "Q4 budget.xlsx", webUrl: "https://onedrive.example/b1" });
    return json({ address: "Budget!A1:B2", values: [["Item", "Cost"], ["Venue", 1200]] });
  };
  seen = [];
  const read = await run("excel_read_range", { itemId: "b1", address: "A1:B2" });
  assert.equal(seen[1]!.url, `${GRAPH}/me/drive/items/b1/workbook/worksheets/Budget/range(address='A1:B2')?$select=address%2Cvalues`);
  assert.deepEqual((read.data as { rows: unknown[] }).rows, [["Item", "Cost"], ["Venue", 1200]]);
  seen = [];
  await run("excel_read_range", { itemId: "b1", sheet: "Notes" });
  assert.equal(seen[0]!.url, `${GRAPH}/me/drive/items/b1/workbook/worksheets/Notes/usedRange(valuesOnly=true)?$select=address%2Cvalues`);

  const update = { itemId: "b1", address: "Budget!B2", values: [["Venue", 1300], ["Food"]] };
  assert.match(await preview("excel_update_range", update), /^In the Excel workbook “Q4 budget\.xlsx”, overwrite Budget!B2:C3 \(2 rows × 2 columns\) with:/);
  seen = [];
  const updated = await run("excel_update_range", update);
  const patch = seen.find((request) => request.method === "PATCH")!;
  assert.equal(patch.url, `${GRAPH}/me/drive/items/b1/workbook/worksheets/Budget/range(address='B2:C3')`);
  assert.deepEqual(patch.body, { values: [["Venue", 1300], ["Food", ""]] });
  assert.equal(updated.href, "https://onedrive.example/b1");
});

test("powerpoint_create uploads a .pptx with the slides and notes", async () => {
  respond = () => json({ id: "d1", name: "Q4 review.pptx", webUrl: "https://onedrive.example/d1" });
  const input = { title: "Q4 review", slides: [{ title: "Wins", bullets: ["Imports"], notes: "Mention Sam" }] };
  assert.equal(
    await preview("powerpoint_create", input),
    "Create PowerPoint deck “Q4 review.pptx” in Mira's OneDrive (mira@fieldnote.example), folder Ensemble, with 2 slides:\n1. Title slide\n2. Wins (with notes)",
  );
  seen = [];
  const result = await run("powerpoint_create", input);
  assert.equal(seen[0]!.url, `${GRAPH}/me/drive/root:/Ensemble/Q4%20review.pptx:/content?@microsoft.graph.conflictBehavior=rename`);
  const slides = pptxSlides(bytesOf(seen[0]!));
  assert.deepEqual(slides.map((slide) => [slide.title, slide.notes]), [["Q4 review", ""], ["Wins", "Mention Sam"]]);
  assert.equal(result.href, "https://onedrive.example/d1");
});

test("Graph scopes match with or without the resource prefix, and a missing one stops the call", async () => {
  scopes = ["https://graph.microsoft.com/files.readwrite.all"];
  respond = () => json({ id: "w1", name: "x.docx", webUrl: "https://onedrive.example/w1" });
  await run("word_create", { title: "x", markdown: "y" });
  assert.equal(seen.length, 1);
  scopes = ["Files.Read", "Mail.Read"];
  seen = [];
  await assert.rejects(
    () => run("word_create", { title: "x", markdown: "y" }),
    (error: unknown) => error instanceof ConnectorNotConnectedError && error.statusCode === 409 && /^Word is connected without the access this needs\./.test(error.message),
  );
  await assert.rejects(() => run("teams_list_chats", {}), /Microsoft Teams is connected without the access this needs/);
  assert.equal(seen.length, 0);
  await run("onedrive_search", {});
  assert.equal(seen.length, 1, "reading OneDrive works with Files.Read");
});
