/**
 * Downloads from connected apps for Files: Drive (Google's own formats exported to Office
 * files, everything else as stored), Gmail and Outlook attachments (search and download),
 * OneDrive, Dropbox and Box, the size cap, redirects that never carry the token, and errors
 * that never contain it. No network: ctx.fetch is mocked with vendor-shaped answers.
 */
import "../../runtime/test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderToken } from "../tokens.js";
import { itemFetchBytes } from "./http.js";
import { boxItems } from "./sources/box.js";
import { dropboxItems } from "./sources/dropbox.js";
import { gmailAttachments, googleItems } from "./sources/google.js";
import { attachmentKey, microsoftItems } from "./sources/microsoft.js";
import { ItemError, MAX_DOWNLOAD_BYTES, type ItemContext } from "./types.js";

const SECRET = "fieldnote_SECRET_token_5b7d0e";
const G = "https://www.googleapis.com/auth/";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: RequestInit["redirect"];
}

type Route = [method: string, match: RegExp, reply: (call: Call) => Response];

function mockFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: typeof init.body === "string" ? init.body : undefined, redirect: init.redirect };
    calls.push(call);
    const route = routes.find(([method, match]) => method === call.method && match.test(call.url));
    if (!route) return new Response(JSON.stringify({ message: `unmatched ${call.method} ${call.url}` }), { status: 418 });
    return route[2](call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function context(fetch: typeof globalThis.fetch, scopes: string[] = []): ItemContext {
  const token: ProviderToken = { token: SECRET, account: "mira@fieldnote.example", scopes, extra: {}, meta: {} };
  return { userId: "user-mira", token, fetch, signal: AbortSignal.timeout(5000) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bytes = (text: string, headers: Record<string, string> = {}) => new Response(new TextEncoder().encode(text), { status: 200, headers: { "content-type": "application/octet-stream", ...headers } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const textOf = (data: Uint8Array) => new TextDecoder().decode(data);

async function refused(promise: Promise<unknown>, pattern: RegExp, status?: number): Promise<ItemError> {
  let caught: unknown;
  await assert.rejects(promise, (error: unknown) => {
    caught = error;
    return true;
  });
  assert.ok(caught instanceof ItemError, `expected ItemError, got ${String(caught)}`);
  assert.match(caught.message, pattern);
  assert.ok(!caught.message.includes(SECRET), "the token never appears in the error");
  if (status) assert.equal(caught.statusCode, status);
  return caught;
}

// Google Drive ------------------------------------------------------------------

test("Drive: a Google Doc comes in as a Word file, a PDF as itself", async () => {
  const { fetch, calls } = mockFetch([
    ["GET", /\/files\/1DocFieldnote01\?fields=/, () => json({ id: "1DocFieldnote01", name: "Launch brief", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/document/d/1DocFieldnote01/edit" })],
    ["GET", /\/files\/1DocFieldnote01\/export\?mimeType=/, () => bytes("docx bytes")],
    ["GET", /\/files\/1PdfFieldnote01\?fields=/, () => json({ id: "1PdfFieldnote01", name: "Site survey.pdf", mimeType: "application/pdf", size: "2048", webViewLink: "https://drive.google.com/file/d/1PdfFieldnote01/view" })],
    ["GET", /\/files\/1PdfFieldnote01\?alt=media/, () => bytes("%PDF-1.7 survey")],
  ]);
  const ctx = context(fetch, [`${G}drive.file`]);
  const doc = await googleItems.download!(ctx, { kind: "file", id: "1DocFieldnote01" });
  assert.equal(doc.filename, "Launch brief.docx");
  assert.equal(doc.mediaType, DOCX);
  assert.equal(textOf(doc.bytes), "docx bytes");
  assert.equal(doc.url, "https://docs.google.com/document/d/1DocFieldnote01/edit");
  assert.equal(new URL(calls[1]!.url).searchParams.get("mimeType"), DOCX);

  const pdf = await googleItems.download!(ctx, { kind: "file", id: "1PdfFieldnote01" });
  assert.equal(pdf.filename, "Site survey.pdf");
  assert.equal(pdf.mediaType, "application/pdf");
  assert.equal(textOf(pdf.bytes), "%PDF-1.7 survey");
  const media = calls.find((call) => call.url.includes("alt=media"))!;
  assert.equal(media.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(media.redirect, "manual");
});

test("Drive: Sheets, Slides and Drawings export to xlsx, pptx and pdf; folders and Forms are refused", async () => {
  const kinds: Record<string, [string, string]> = {
    "1SheetFieldnote": ["application/vnd.google-apps.spreadsheet", "Budget"],
    "1SlidesFieldnot": ["application/vnd.google-apps.presentation", "Kickoff.pptx"],
    "1DrawFieldnote1": ["application/vnd.google-apps.drawing", "Site map"],
    "1FolderFieldnot": ["application/vnd.google-apps.folder", "Clients"],
    "1FormFieldnote1": ["application/vnd.google-apps.form", "Survey"],
  };
  const { fetch, calls } = mockFetch([
    ["GET", /\/export\?mimeType=/, () => bytes("exported")],
    ["GET", /\/files\/[A-Za-z0-9]+\?fields=/, (call) => {
      const id = /\/files\/([A-Za-z0-9]+)\?/.exec(call.url)![1]!;
      return json({ id, name: kinds[id]![1], mimeType: kinds[id]![0] });
    }],
  ]);
  const ctx = context(fetch, [`${G}drive.readonly`]);
  assert.equal((await googleItems.download!(ctx, { kind: "file", id: "1SheetFieldnote" })).filename, "Budget.xlsx");
  assert.equal((await googleItems.download!(ctx, { kind: "file", id: "1SlidesFieldnot" })).filename, "Kickoff.pptx");
  const drawing = await googleItems.download!(ctx, { kind: "file", id: "1DrawFieldnote1" });
  assert.equal(drawing.filename, "Site map.pdf");
  assert.equal(drawing.mediaType, "application/pdf");
  await refused(googleItems.download!(ctx, { kind: "file", id: "1FolderFieldnot" }), /folder/, 400);
  await refused(googleItems.download!(ctx, { kind: "file", id: "1FormFieldnote1" }), /Google Form cannot be downloaded/, 422);
  assert.equal(calls.filter((call) => call.url.includes("/export?")).length, 3);
});

test("Drive is refused without Drive access, and Gmail attachments without Gmail access", async () => {
  const { fetch, calls } = mockFetch([]);
  await refused(googleItems.download!(context(fetch, [`${G}gmail.readonly`]), { kind: "file", id: "1PdfFieldnote01" }), /Drive is switched off/, 403);
  await refused(googleItems.download!(context(fetch, [`${G}drive.file`]), { kind: "attachment", id: "18f2a3b4c5d6e7f8:1" }), /Gmail is switched off/, 403);
  await refused(googleItems.search(context(fetch, [`${G}drive.file`]), { q: "budget", kind: "attachment", limit: 5 }), /Gmail is switched off/, 403);
  assert.equal(calls.length, 0);
});

// Gmail attachments ---------------------------------------------------------------

const B64 = (text: string) => Buffer.from(text).toString("base64url");
const MESSAGE = {
  id: "18f2a3b4c5d6e7f8",
  threadId: "18f2a3b4c5d6e000",
  internalDate: "1791626400000",
  payload: {
    partId: "",
    mimeType: "multipart/mixed",
    headers: [
      { name: "Subject", value: "Q3 budget" },
      { name: "From", value: "Arjun Rao <arjun@fieldnote.example>" },
    ],
    parts: [
      {
        partId: "0",
        mimeType: "multipart/related",
        parts: [
          { partId: "0.0", mimeType: "text/html", body: { data: B64("<p>Numbers attached.</p>"), size: 24 } },
          { partId: "0.1", mimeType: "image/png", filename: "logo.png", headers: [{ name: "Content-ID", value: "<logo>" }], body: { attachmentId: "ANGjdJ_logo", size: 900 } },
        ],
      },
      { partId: "1", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "Q3 budget.xlsx", headers: [{ name: "Content-Disposition", value: 'attachment; filename="Q3 budget.xlsx"' }], body: { attachmentId: "ANGjdJ_budget_long_and_changing", size: 2048 } },
      { partId: "2", mimeType: "image/jpeg", filename: "site.jpg", headers: [{ name: "Content-Disposition", value: "attachment" }], body: { attachmentId: "ANGjdJ_site", size: 4096 } },
    ],
  },
};

test("Gmail: an attachment search lists each attached file, not pictures inside the email", async () => {
  const { fetch, calls } = mockFetch([
    ["GET", /\/users\/me\/messages\?/, () => json({ messages: [{ id: MESSAGE.id }] })],
    ["GET", /\/messages\/18f2a3b4c5d6e7f8\?format=full$/, () => json(MESSAGE)],
  ]);
  const items = await googleItems.search(context(fetch, [`${G}gmail.readonly`]), { q: "budget", kind: "attachment", limit: 5 });
  assert.deepEqual(
    items.map((item) => [item.kind, item.id, item.title]),
    [
      ["attachment", "18f2a3b4c5d6e7f8:1", "Q3 budget.xlsx"],
      ["attachment", "18f2a3b4c5d6e7f8:2", "site.jpg"],
    ],
  );
  assert.equal(items[0]!.subtitle, "Attachment in “Q3 budget” from Arjun Rao · 2 KB");
  assert.equal(items[0]!.url, "https://mail.google.com/mail/u/0/#all/18f2a3b4c5d6e000");
  assert.equal(new URL(calls[0]!.url).searchParams.get("q"), "has:attachment budget");
  assert.equal(gmailAttachments(MESSAGE.payload).length, 2);
});

test("Gmail: a free search stays files and emails, without attachments", async () => {
  const { fetch, calls } = mockFetch([
    ["GET", /\/drive\/v3\/files\?/, () => json({ files: [] })],
    ["GET", /\/users\/me\/threads\?/, () => json({ threads: [] })],
  ]);
  await googleItems.search(context(fetch, [`${G}drive.readonly`, `${G}gmail.readonly`]), { q: "budget", limit: 5 });
  assert.ok(calls.every((call) => !call.url.includes("/messages")), "no attachment search");
});

test("Gmail: an attachment downloads by message and part, with Gmail's current attachment id", async () => {
  const { fetch, calls } = mockFetch([
    ["GET", /\/messages\/18f2a3b4c5d6e7f8\?format=full$/, () => json(MESSAGE)],
    ["GET", /\/messages\/18f2a3b4c5d6e7f8\/attachments\/ANGjdJ_budget_long_and_changing$/, () => json({ size: 11, data: B64("PK budget!!") })],
  ]);
  const ctx = context(fetch, [`${G}gmail.readonly`]);
  const file = await googleItems.download!(ctx, { kind: "attachment", id: "18f2a3b4c5d6e7f8:1" });
  assert.equal(file.filename, "Q3 budget.xlsx");
  assert.equal(file.mediaType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(textOf(file.bytes), "PK budget!!");
  assert.equal(file.url, "https://mail.google.com/mail/u/0/#all/18f2a3b4c5d6e000");
  assert.equal(calls[1]!.headers.authorization, `Bearer ${SECRET}`);
  const read = await googleItems.read(ctx, { kind: "attachment", id: "18f2a3b4c5d6e7f8:1" });
  assert.match(read.text, /Bring it into Files/);
  await refused(googleItems.download!(ctx, { kind: "attachment", id: "18f2a3b4c5d6e7f8:9" }), /no longer on the email/, 404);
  await refused(googleItems.download!(ctx, { kind: "attachment", id: "not-an-attachment" }), /not a Gmail attachment id/, 400);
});

// Microsoft ---------------------------------------------------------------------

test("OneDrive: the download follows Graph's redirect without sending the token there", async () => {
  const { fetch, calls } = mockFetch([
    ["GET", /\/me\/drive\/items\/01FIELDNOTE1\?/, () => json({ id: "01FIELDNOTE1", name: "Launch plan.docx", size: 5, webUrl: "https://fieldnote-my.sharepoint.com/launch", file: { mimeType: DOCX } })],
    ["GET", /\/me\/drive\/items\/01FIELDNOTE1\/content$/, () => redirect("https://fieldnote-my.sharepoint.com/_layouts/15/download.aspx?UniqueId=abc&tempauth=short-lived")],
    ["GET", /^https:\/\/fieldnote-my\.sharepoint\.com\/_layouts/, () => bytes("PK docx")],
    ["GET", /\/me\/drive\/items\/01FOLDER01\?/, () => json({ id: "01FOLDER01", name: "Plans", folder: { childCount: 2 } })],
  ]);
  const ctx = context(fetch, ["Files.Read"]);
  const file = await microsoftItems.download!(ctx, { kind: "file", id: "01FIELDNOTE1" });
  assert.equal(file.filename, "Launch plan.docx");
  assert.equal(file.mediaType, DOCX);
  assert.equal(textOf(file.bytes), "PK docx");
  assert.equal(file.url, "https://fieldnote-my.sharepoint.com/launch");
  assert.equal(calls[1]!.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(calls[2]!.headers.authorization, undefined, "the download host never gets the token");
  await refused(microsoftItems.download!(ctx, { kind: "file", id: "01FOLDER01" }), /folder/, 400);
  await refused(microsoftItems.download!(context(fetch, ["Mail.Read"]), { kind: "file", id: "01FIELDNOTE1" }), /OneDrive is switched off/, 403);
});

const OUTLOOK_MESSAGE = "AAMkAD1fieldnote=";
const OUTLOOK_FILE = "AAMkAD1fieldnote=AAABEgAQ/budget+xlsx=";
const OUTLOOK_ITEM = "AAMkAD1fieldnote=AAABEgAQ/forwarded=";

test("Outlook: an attachment search lists file attachments only, and downloads one", async () => {
  const listing = {
    value: [
      { "@odata.type": "#microsoft.graph.fileAttachment", id: OUTLOOK_FILE, name: "Q3 budget.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 2048, isInline: false },
      { "@odata.type": "#microsoft.graph.itemAttachment", id: OUTLOOK_ITEM, name: "Fwd: numbers", size: 900, isInline: false },
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "AAMkAD1fieldnote=AAABEgAQ/logo=", name: "image001.png", contentType: "image/png", size: 300, isInline: true },
    ],
  };
  const message = { id: OUTLOOK_MESSAGE, subject: "Q3 budget", from: { emailAddress: { name: "Arjun Rao", address: "arjun@fieldnote.example" } }, receivedDateTime: "2026-10-09T10:00:00Z", webLink: "https://outlook.office365.com/owa/?ItemID=x", hasAttachments: true };
  const { fetch, calls } = mockFetch([
    ["GET", /\/me\/messages\?\$search=/, () => json({ value: [message] })],
    ["GET", /\/me\/messages\/AAMkAD1fieldnote%3D\/attachments\?/, () => json(listing)],
    ["GET", /\/me\/messages\/AAMkAD1fieldnote%3D\?/, () => json(message)],
    ["GET", /\/me\/messages\/AAMkAD1fieldnote%3D\/attachments\/AAMkAD1fieldnote%3DAAABEgAQ%2Fbudget%2Bxlsx%3D$/, () => json({ "@odata.type": "#microsoft.graph.fileAttachment", id: OUTLOOK_FILE, name: "Q3 budget.xlsx", contentBytes: Buffer.from("PK outlook").toString("base64") })],
  ]);
  const ctx = context(fetch, ["Mail.Read"]);
  const items = await microsoftItems.search(ctx, { q: "budget", kind: "attachment", limit: 5 });
  assert.deepEqual(items.map((item) => [item.kind, item.id, item.title]), [["attachment", `${OUTLOOK_MESSAGE}:${attachmentKey(OUTLOOK_FILE)}`, "Q3 budget.xlsx"]]);
  assert.equal(items[0]!.subtitle, "Attachment in “Q3 budget” from Arjun Rao · 2 KB");
  assert.equal(new URL(calls[0]!.url).searchParams.get("$search"), '"hasAttachments:true budget"');
  assert.ok(items[0]!.id.length < 300, "the id fits an item id");

  const file = await microsoftItems.download!(ctx, { kind: "attachment", id: items[0]!.id });
  assert.equal(file.filename, "Q3 budget.xlsx");
  assert.equal(textOf(file.bytes), "PK outlook");
  assert.equal(file.url, message.webLink);
  await refused(microsoftItems.download!(ctx, { kind: "attachment", id: `${OUTLOOK_MESSAGE}:${attachmentKey(OUTLOOK_ITEM)}` }), /attached email or a link/, 422);
  await refused(microsoftItems.download!(ctx, { kind: "attachment", id: `${OUTLOOK_MESSAGE}:0123456789abcdef` }), /no longer on the email/, 404);
  await refused(microsoftItems.search(context(fetch, ["Files.Read"]), { q: "budget", kind: "attachment", limit: 5 }), /Outlook mail is switched off/, 403);
});

test("Outlook: with no words, the newest emails with attachments", async () => {
  const { fetch, calls } = mockFetch([["GET", /\/me\/messages\?\$filter=/, () => json({ value: [] })]]);
  assert.deepEqual(await microsoftItems.search(context(fetch, ["Mail.ReadWrite"]), { q: "", kind: "attachment", limit: 5 }), []);
  assert.equal(new URL(calls[0]!.url).searchParams.get("$filter"), "hasAttachments eq true");
});

// Dropbox and Box -------------------------------------------------------------------

test("Dropbox: a file downloads as it is, a Paper doc is exported as Markdown", async () => {
  const { fetch, calls } = mockFetch([
    ["POST", /\/2\/files\/get_metadata$/, (call) => {
      const path = (JSON.parse(call.body ?? "{}") as { path: string }).path;
      return path === "id:paperdoc01"
        ? json({ ".tag": "file", id: "id:paperdoc01", name: "Retro notes.paper", path_display: "/Team/Retro notes.paper", is_downloadable: false, export_info: { export_as: "markdown", export_options: ["markdown", "html", "plain_text"] } })
        : json({ ".tag": "file", id: "id:budgetx01", name: "Budget.xlsx", path_display: "/Team/Budget.xlsx", size: 12, is_downloadable: true });
    }],
    ["POST", /content\.dropboxapi\.com\/2\/files\/download$/, () => bytes("PK dropbox", { "dropbox-api-result": JSON.stringify({ name: "Budget.xlsx" }) })],
    ["POST", /content\.dropboxapi\.com\/2\/files\/export$/, () => bytes("# Retro", { "dropbox-api-result": JSON.stringify({ export_metadata: { name: "Retro notes.md" } }) })],
  ]);
  const ctx = context(fetch);
  const file = await dropboxItems.download!(ctx, { kind: "file", id: "id:budgetx01" });
  assert.equal(file.filename, "Budget.xlsx");
  assert.equal(textOf(file.bytes), "PK dropbox");
  assert.equal(file.url, "https://www.dropbox.com/home/Team?preview=Budget.xlsx");
  const download = calls.find((call) => call.url.endsWith("/files/download"))!;
  assert.equal(download.headers["dropbox-api-arg"], '{"path":"id:budgetx01"}');
  assert.equal(download.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(download.body, undefined, "a content call sends no body");

  const paper = await dropboxItems.download!(ctx, { kind: "file", id: "id:paperdoc01" });
  assert.equal(paper.filename, "Retro notes.md");
  assert.equal(textOf(paper.bytes), "# Retro");
  assert.equal(JSON.parse(calls.find((call) => call.url.endsWith("/files/export"))!.headers["dropbox-api-arg"]!).export_format, "markdown");
});

test("Box: the download follows Box's redirect to its own download host only, without the token", async () => {
  const { fetch, calls } = mockFetch([
    ["GET", /api\.box\.com\/2\.0\/files\/12345\?fields=/, () => json({ type: "file", id: "12345", name: "Contract.pdf", size: 9 })],
    ["GET", /api\.box\.com\/2\.0\/files\/12345\/content$/, () => redirect("https://dl.boxcloud.com/d/1/abc/download")],
    ["GET", /^https:\/\/dl\.boxcloud\.com\//, () => bytes("%PDF box", { "content-type": "application/pdf" })],
    ["GET", /api\.box\.com\/2\.0\/files\/67890\?fields=/, () => json({ type: "file", id: "67890", name: "Other.pdf", size: 9 })],
    ["GET", /api\.box\.com\/2\.0\/files\/67890\/content$/, () => redirect("https://files.example.net/steal")],
  ]);
  const ctx = context(fetch);
  const file = await boxItems.download!(ctx, { kind: "file", id: "12345" });
  assert.equal(file.filename, "Contract.pdf");
  assert.equal(file.mediaType, "application/pdf");
  assert.equal(textOf(file.bytes), "%PDF box");
  assert.equal(file.url, "https://app.box.com/file/12345");
  assert.equal(calls[1]!.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(calls[2]!.headers.authorization, undefined);
  await refused(boxItems.download!(ctx, { kind: "file", id: "67890" }), /does not download from/, 502);
  assert.ok(!calls.some((call) => call.url.startsWith("https://files.example.net")), "an unknown host is never fetched");
});

// The cap and the token ---------------------------------------------------------------

test("files over the cap are refused before or while downloading", async () => {
  const big = String(MAX_DOWNLOAD_BYTES + 1);
  const { fetch, calls } = mockFetch([
    ["GET", /\/files\/1BigFieldnote01\?fields=/, () => json({ id: "1BigFieldnote01", name: "Scan.pdf", mimeType: "application/pdf", size: big })],
    ["GET", /\/declared$/, () => new Response("x", { status: 200, headers: { "content-length": big } })],
    ["GET", /\/streamed$/, () => {
      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      return new Response(new ReadableStream({ pull(controller) {
        sent += 1;
        if (sent > 30) controller.close();
        else controller.enqueue(chunk);
      } }), { status: 200 });
    }],
  ]);
  const ctx = context(fetch, [`${G}drive.readonly`]);
  await refused(googleItems.download!(ctx, { kind: "file", id: "1BigFieldnote01" }), /larger than 25 MB/, 413);
  assert.equal(calls.length, 1, "the bytes were never asked for");
  await refused(itemFetchBytes(ctx, "google", "Google Drive", "https://www.googleapis.com/declared"), /larger than 25 MB/, 413);
  await refused(itemFetchBytes(ctx, "google", "Google Drive", "https://www.googleapis.com/streamed"), /larger than 25 MB/, 413);
});

test("a refused download never puts the token in the error", async () => {
  const echo = () => json({ error: { message: `invalid credentials ${SECRET}` } }, 403);
  const { fetch } = mockFetch([
    ["GET", /./, echo],
    ["POST", /./, echo],
  ]);
  const all = [`${G}drive.readonly`, `${G}gmail.readonly`, "Files.Read", "Mail.Read"];
  const error = await refused(googleItems.download!(context(fetch, all), { kind: "file", id: "1PdfFieldnote01" }), /refused access/, 403);
  assert.match(error.message, /\[token\]/);
  await refused(googleItems.download!(context(fetch, all), { kind: "attachment", id: "18f2a3b4c5d6e7f8:1" }), /refused access/);
  await refused(microsoftItems.download!(context(fetch, all), { kind: "file", id: "01FIELDNOTE1" }), /refused access/);
  await refused(microsoftItems.download!(context(fetch, all), { kind: "attachment", id: `${OUTLOOK_MESSAGE}:${attachmentKey(OUTLOOK_FILE)}` }), /refused access/);
  await refused(dropboxItems.download!(context(fetch), { kind: "file", id: "id:budgetx01" }), /refused access/);
  await refused(boxItems.download!(context(fetch), { kind: "file", id: "12345" }), /refused access/);
  const offline = (async () => {
    throw new Error(`connect ECONNREFUSED ${SECRET}`);
  }) as typeof globalThis.fetch;
  await refused(itemFetchBytes(context(offline), "box", "Box", "https://api.box.com/2.0/files/12345/content"), /Could not reach Box/, 502);
});
