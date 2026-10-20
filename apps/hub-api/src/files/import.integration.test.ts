/**
 * Bringing files in from connected apps over HTTP: which apps a person can use and what to do
 * when one is missing, importing a Drive file and a Gmail attachment (and the same item again),
 * refusals for bad input, another person's connection, and unverified hosted accounts. Every
 * vendor call is answered by a mocked fetch.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import type { FileImportSource, FileRecord } from "@ensemble/shared-types";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { fileImportRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

const originalEnv = { ...process.env };
process.env.NODE_ENV = "test";
process.env.HUB_WEB_ORIGIN = "http://hub.example.test";
process.env.HUB_API_PUBLIC_URL = "http://api.example.test";
for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "AUTH_GOOGLE_CLIENT_ID", "AUTH_GOOGLE_CLIENT_SECRET", "DROPBOX_CLIENT_ID", "DROPBOX_CLIENT_SECRET", "BOX_CLIENT_ID", "BOX_CLIENT_SECRET", "AUTH_MICROSOFT_CLIENT_ID", "AUTH_MICROSOFT_CLIENT_SECRET", "GOOGLE_PICKER_API_KEY", "GOOGLE_PROJECT_NUMBER"]) {
  delete process.env[name];
}
process.env.MICROSOFT_CLIENT_ID = "fieldnote-microsoft-app";
process.env.MICROSOFT_CLIENT_SECRET = "fieldnote-microsoft-secret";

const harness: HttpHarness = await createHttpHarness();
const { saveAccount } = await import("../connectors/accounts.js");
const { fileTextSettled } = await import("./extract.js");
const covered = new Map<string, Set<RouteCheck>>();

const SECRET = "ya29.mira_google_secret_0123456789";
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const calls: Array<{ url: string; init?: RequestInit }> = [];
const handlers: Array<{ match: (url: string) => boolean; reply: Handler }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init);
  calls.push({ url, init });
  const handler = handlers.find((row) => row.match(url));
  if (!handler) return new Response(JSON.stringify({ message: `unmocked ${url}` }), { status: 599 });
  return handler.reply(url, init);
}) as typeof fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mock(prefix: string, reply: Handler): void {
  handlers.unshift({ match: (url) => url.startsWith(prefix), reply });
}

function resetMocks(): void {
  handlers.length = 0;
  calls.length = 0;
}

after(async () => {
  try {
    for (const [route, checks] of Object.entries(fileImportRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted file-import coverage claim: ${check} ${route}`);
    }
  } finally {
    globalThis.fetch = realFetch;
    await harness.close();
    process.env = originalEnv;
  }
});

async function call(user: HttpUser, method: InjectOptions["method"], url: string, check: RouteCheck, payload?: unknown) {
  const response = await user.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as InjectOptions["payload"] }) });
  const key = `${method} ${url}`;
  const checks = covered.get(key) ?? new Set<RouteCheck>();
  checks.add(check);
  covered.set(key, checks);
  return response;
}

async function verified(email: string): Promise<HttpUser> {
  const user = await harness.asUser(email);
  await harness.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  return user;
}

const LATER = new Date(Date.now() + 30 * 86_400_000);
const G = "https://www.googleapis.com/auth/";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

async function connectGoogle(user: HttpUser, scopes: string[]) {
  await saveAccount(user.id, "google", { accessToken: SECRET, expiresAt: LATER, scopes: ["openid", "email", ...scopes], account: "mira@fieldnote.example", meta: { via: "oauth" } });
}

const byId = (sources: FileImportSource[]) => new Map(sources.map((row) => [row.id, row]));

test("import sources say what is ready and, in plain words, what to do for the rest", async () => {
  resetMocks();
  const mira = await verified("mira.files@fieldnote.example");
  const arjun = await verified("arjun.files@fieldnote.example");
  await connectGoogle(mira, [`${G}drive.file`, `${G}gmail.readonly`]);
  await saveAccount(mira.id, "microsoft", { accessToken: "ms_mira_secret", expiresAt: LATER, scopes: ["openid", "User.Read", "Mail.Read"], account: "mira@fieldnote.example", meta: { via: "oauth" } });
  await saveAccount(mira.id, "dropbox", { accessToken: "sl.mira_dropbox_secret", expiresAt: LATER, scopes: ["account_info.read", "files.metadata.read"], account: "mira@fieldnote.example", meta: { via: "oauth" } });
  await saveAccount(mira.id, "box", { accessToken: "box_mira_secret", expiresAt: LATER, scopes: [], account: "mira@fieldnote.example", meta: { via: "oauth" } });
  process.env.GOOGLE_PICKER_API_KEY = "picker-key";
  process.env.GOOGLE_PROJECT_NUMBER = "123456789012";

  const mine = await call(mira, "GET", "/api/documents/import-sources", "happy-path");
  assert.equal(mine.statusCode, 200, mine.body);
  const sources = byId(mine.json<{ sources: FileImportSource[] }>().sources);
  assert.deepEqual([...sources.keys()], ["google_drive", "gmail", "onedrive", "outlook", "dropbox", "box"]);
  const drive = sources.get("google_drive")!;
  assert.equal(drive.state, "ready");
  assert.equal(drive.itemSource, "google_workspace");
  assert.equal(drive.kind, "file");
  assert.equal(drive.logo, "googledrive");
  assert.equal(drive.picker, true);
  assert.match(drive.message, /only the Drive files it created or that you picked/);
  assert.equal(drive.action?.href, "/settings?tab=connections&connector=google_workspace");
  assert.equal(sources.get("gmail")!.state, "ready");
  assert.equal(sources.get("gmail")!.kind, "attachment");
  const onedrive = sources.get("onedrive")!;
  assert.equal(onedrive.state, "needs_permission");
  assert.match(onedrive.message, /Microsoft 365 is connected, but OneDrive is switched off/);
  assert.ok(onedrive.steps?.some((step) => step.includes("Switch on “OneDrive”")));
  assert.equal(sources.get("outlook")!.state, "ready");
  assert.equal(sources.get("dropbox")!.state, "needs_permission");
  assert.equal(sources.get("box")!.state, "ready");
  assert.ok(!mine.body.includes(SECRET), "no token in the answer");

  const theirs = await call(arjun, "GET", "/api/documents/import-sources", "isolation");
  const others = byId(theirs.json<{ sources: FileImportSource[] }>().sources);
  assert.equal(others.get("google_drive")!.state, "not_set_up");
  assert.match(others.get("google_drive")!.message, /not set up on this Ensemble server yet/);
  const outlook = others.get("outlook")!;
  assert.equal(outlook.state, "not_connected");
  assert.equal(outlook.message, "Connect Microsoft 365, keep Outlook mail switched on, and approve on Microsoft's page. Then search files attached to your email here.");
  assert.equal(outlook.action?.href, "/settings?tab=connections&connector=microsoft_365");
  assert.ok((outlook.steps ?? []).length >= 3);
  assert.equal(others.get("box")!.state, "not_set_up");
  assert.equal(calls.length, 0, "listing sources never calls an app");
  delete process.env.GOOGLE_PICKER_API_KEY;
  delete process.env.GOOGLE_PROJECT_NUMBER;
});

function mockDrive() {
  mock(`${DRIVE}/1DocFieldnote01?fields=`, () => json({ id: "1DocFieldnote01", name: "Field guide.md", mimeType: "text/markdown", size: "40", webViewLink: "https://drive.google.com/file/d/1DocFieldnote01/view" }));
  mock(`${DRIVE}/1DocFieldnote01?alt=media`, () => new Response("# Field guide\n\nCalibrate the sensor first.", { status: 200 }));
  mock(`${DRIVE}/1BigFieldnote01?fields=`, () => json({ id: "1BigFieldnote01", name: "Scan.pdf", mimeType: "application/pdf", size: String(26 * 1024 * 1024) }));
}

test("a Drive file comes in once; bringing it in again returns the same file", async () => {
  resetMocks();
  mockDrive();
  const mira = await verified("mira.drive@fieldnote.example");
  await connectGoogle(mira, [`${G}drive.readonly`]);

  const first = await call(mira, "POST", "/api/documents/import", "happy-path", { source: "google_workspace", kind: "file", id: "1DocFieldnote01" });
  assert.equal(first.statusCode, 201, first.body);
  const file = first.json<{ file: FileRecord }>().file;
  assert.equal(file.filename, "Field guide.md");
  assert.equal(file.textStatus, "ready");
  assert.deepEqual(file.source, { app: "google_drive", label: "Google Drive", url: "https://drive.google.com/file/d/1DocFieldnote01/view" });
  assert.equal(file.byteSize, Buffer.byteLength("# Field guide\n\nCalibrate the sensor first."));
  const row = await harness.prisma.document.findUniqueOrThrow({ where: { id: file.id }, select: { userId: true, original: true, source: true } });
  assert.equal(row.userId, mira.id);
  assert.equal(Buffer.from(row.original!).toString("utf8"), "# Field guide\n\nCalibrate the sensor first.");
  assert.equal((row.source as { externalId?: string }).externalId, "google_workspace:file:1DocFieldnote01");
  const download = calls.find((row) => row.url.includes("alt=media"))!;
  assert.equal(new Headers(download.init?.headers).get("authorization"), `Bearer ${SECRET}`);
  await fileTextSettled(file.id);

  const before = calls.length;
  const again = await call(mira, "POST", "/api/documents/import", "happy-path", { source: "google_workspace", kind: "file", id: "1DocFieldnote01" });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json<{ file: FileRecord }>().file.id, file.id);
  assert.equal(calls.length, before, "the kept file is returned without downloading again");
  assert.equal(await harness.prisma.document.count({ where: { userId: mira.id } }), 1);

  const big = await call(mira, "POST", "/api/documents/import", "happy-path", { source: "google_workspace", kind: "file", id: "1BigFieldnote01" });
  assert.equal(big.statusCode, 413, big.body);
  assert.match(big.json<{ error: string }>().error, /larger than 25 MB/);
});

test("a Gmail attachment comes in with its name and where it came from", async () => {
  resetMocks();
  const message = {
    id: "18f2a3b4c5d6e7f8",
    threadId: "18f2a3b4c5d6e000",
    payload: {
      partId: "",
      mimeType: "multipart/mixed",
      headers: [{ name: "Subject", value: "Sensor notes" }, { name: "From", value: "Arjun Rao <arjun@fieldnote.example>" }],
      parts: [{ partId: "1", mimeType: "text/csv", filename: "readings.csv", body: { attachmentId: "ANGjdJ_readings", size: 24 } }],
    },
  };
  mock(`${GMAIL}/messages/18f2a3b4c5d6e7f8?format=full`, () => json(message));
  mock(`${GMAIL}/messages/18f2a3b4c5d6e7f8/attachments/ANGjdJ_readings`, () => json({ size: 24, data: Buffer.from("site,ph\nNorth,7.1\n").toString("base64url") }));
  const mira = await verified("mira.gmail@fieldnote.example");
  await connectGoogle(mira, [`${G}gmail.readonly`]);

  const response = await call(mira, "POST", "/api/documents/import", "happy-path", { source: "google_workspace", kind: "attachment", id: "18f2a3b4c5d6e7f8:1" });
  assert.equal(response.statusCode, 201, response.body);
  const file = response.json<{ file: FileRecord }>().file;
  assert.equal(file.filename, "readings.csv");
  assert.equal(file.kind, "sheet");
  assert.deepEqual(file.source, { app: "gmail", label: "Gmail", url: "https://mail.google.com/mail/u/0/#all/18f2a3b4c5d6e000" });
  await fileTextSettled(file.id);
});

test("bad input, a missing connection and another person's file are refused", async () => {
  resetMocks();
  mockDrive();
  const mira = await verified("mira.refusals@fieldnote.example");
  const arjun = await verified("arjun.refusals@fieldnote.example");
  await connectGoogle(mira, [`${G}drive.readonly`]);
  const kept = await call(mira, "POST", "/api/documents/import", "happy-path", { source: "google_workspace", kind: "file", id: "1DocFieldnote01" });
  assert.equal(kept.statusCode, 201, kept.body);
  await fileTextSettled(kept.json<{ file: FileRecord }>().file.id);

  for (const payload of [
    { source: "google_workspace", kind: "page", id: "1DocFieldnote01" },
    { source: "Google Drive", kind: "file", id: "1DocFieldnote01" },
    { source: "google_workspace", kind: "file" },
    { source: "github", kind: "file", id: "fieldnote/atlas" },
    { source: "google_workspace", kind: "file", id: "../../users/me" },
  ]) {
    const response = await call(mira, "POST", "/api/documents/import", "invalid-input", payload);
    assert.equal(response.statusCode, 400, `${JSON.stringify(payload)}: ${response.body}`);
  }

  const before = calls.length;
  const notConnected = await call(arjun, "POST", "/api/documents/import", "isolation", { source: "google_workspace", kind: "file", id: "1DocFieldnote01" });
  assert.equal(notConnected.statusCode, 409, notConnected.body);
  assert.match(notConnected.json<{ error: string }>().error, /not connected/);
  assert.equal(calls.length, before, "nothing is fetched without the person's own connection");
  assert.equal(await harness.prisma.document.count({ where: { userId: arjun.id } }), 0, "Mira's kept copy is not handed to Arjun");

  await connectGoogle(arjun, [`${G}drive.readonly`]);
  const own = await call(arjun, "POST", "/api/documents/import", "isolation", { source: "google_workspace", kind: "file", id: "1DocFieldnote01" });
  assert.equal(own.statusCode, 201, "Arjun gets his own copy, not Mira's");
  assert.notEqual(own.json<{ file: FileRecord }>().file.id, kept.json<{ file: FileRecord }>().file.id);
  await fileTextSettled(own.json<{ file: FileRecord }>().file.id);
});

test("hosted: unverified people cannot bring files in", async (t) => {
  resetMocks();
  const unverified = await harness.asUser("new.files@fieldnote.example");
  process.env.NODE_ENV = "production";
  t.after(() => {
    process.env.NODE_ENV = "test";
  });
  const sources = await call(unverified, "GET", "/api/documents/import-sources", "hosted-verification");
  assert.equal(sources.statusCode, 403, sources.body);
  const imported = await call(unverified, "POST", "/api/documents/import", "hosted-verification", { source: "google_workspace", kind: "file", id: "1DocFieldnote01" });
  assert.equal(imported.statusCode, 403, imported.body);
  assert.equal(calls.length, 0);
});
