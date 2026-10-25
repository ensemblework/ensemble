/**
 * Files over HTTP: upload, list with usage, read text in pages, download the original safely,
 * replace bytes, save cells into a workbook, make pages, remove, the hosted caps, and the files
 * a shared page or public link may open. Fictional data: Mira Chen at Fieldnote.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import ExcelJS from "exceljs";
import type { FileRecord, FileUsage } from "@ensemble/shared-types";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { fileRouteCoverage, type RouteCheck } from "../test/route-coverage.js";
import { MISSING_ID } from "../lib/route-inventory.js";
import { makePdf } from "../files/testing.js";
import { testJpeg, testPng } from "@ensemble/shared-types/page-images-testing";

const harness: HttpHarness = await createHttpHarness();
const db = harness.prisma;
const { fileTextSettled } = await import("../files/extract.js");

const covered = new Map<string, Set<RouteCheck>>();
function claim(route: string, ...checks: RouteCheck[]): void {
  const set = covered.get(route) ?? new Set<RouteCheck>();
  for (const check of checks) set.add(check);
  covered.set(route, set);
}

after(async () => {
  try {
    for (const [route, checks] of Object.entries(fileRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted file coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness.close();
  }
});

async function person(name: string): Promise<HttpUser> {
  const user = await harness.asUser();
  await db.user.update({ where: { id: user.id }, data: { name, onboardingRole: "student", onboardingCompletedAt: new Date(), emailVerifiedAt: new Date() } });
  return user;
}

async function ok<T>(res: Promise<{ statusCode: number; body: string; json: () => unknown }>, status = 200): Promise<T> {
  const done = await res;
  assert.equal(done.statusCode, status, done.body);
  return (status === 204 || status === 304 ? undefined : done.json()) as T;
}

function upload(user: HttpUser, filename: string, bytes: Uint8Array | string, mediaType = "application/octet-stream", headers: Record<string, string> = {}) {
  const data = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return user.inject({ method: "POST", url: "/api/documents", headers, payload: { filename, mediaType, dataBase64: data.toString("base64"), summarize: false } });
}

async function uploaded(user: HttpUser, filename: string, bytes: Uint8Array | string, mediaType?: string): Promise<FileRecord> {
  const body = await ok<{ file: FileRecord; document: { id: string; filename: string; parseStatus: string } }>(upload(user, filename, bytes, mediaType), 201);
  assert.equal(body.document.id, body.file.id);
  return body.file;
}

async function settled(user: HttpUser, id: string): Promise<FileRecord> {
  await fileTextSettled(id);
  return (await ok<{ file: FileRecord }>(user.inject({ method: "GET", url: `/api/documents/${id}` }))).file;
}

async function budget(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Budget");
  sheet.addRow(["Item", "Cost"]);
  sheet.addRow(["Paper", 12]);
  sheet.addRow(["Ink", 30]);
  sheet.addRow(["Tape", 4]);
  sheet.getCell("B5").value = { formula: "SUM(B2:B4)", result: 46 };
  sheet.getCell("A1").font = { bold: true, color: { argb: "FF1F6FEB" } };
  sheet.getCell("B3").numFmt = "$#,##0.00";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const mira = await person("Mira Chen");
const dev = await person("Dev Patel");

test("uploads keep the format's media type, read text right away, and list with usage", async () => {
  const notes = await uploaded(mira, "Fieldnote visit.md", "# Visit\n\nMira Chen met the Fieldnote team.");
  assert.deepEqual([notes.format, notes.kind, notes.mediaType, notes.textStatus], ["md", "text", "text/markdown", "ready"]);
  assert.equal(notes.textCharacters, "# Visit\n\nMira Chen met the Fieldnote team.".length);
  assert.equal(notes.hasStyle, false);
  const photo = await uploaded(mira, "team.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png");
  assert.deepEqual([photo.kind, photo.textStatus, photo.warnings], ["image", "none", []]);
  const legacy = await uploaded(mira, "old budget.xls", new Uint8Array([0xd0, 0xcf]));
  assert.equal(legacy.textStatus, "none");
  assert.match(legacy.warnings[0]!, /\.xlsx and \.csv/);

  const list = await ok<{ files: FileRecord[]; usage: FileUsage }>(mira.inject({ method: "GET", url: "/api/documents" }));
  assert.deepEqual(list.files.slice(0, 3).map((file) => file.filename), ["old budget.xls", "team.png", "Fieldnote visit.md"], "newest first");
  assert.equal(list.usage.maxCount, null, "no caps off the hosted plan");
  assert.equal(list.usage.maxBytes, null);
  assert.equal(list.usage.maxFileBytes, 100 * 1024 * 1024);
  assert.equal(list.usage.count, list.files.length);
  assert.equal(list.usage.bytes, list.files.reduce((sum, file) => sum + file.byteSize, 0));
  const search = await ok<{ files: FileRecord[] }>(mira.inject({ method: "GET", url: "/api/documents?q=VISIT" }));
  assert.deepEqual(search.files.map((file) => file.id), [notes.id]);
  assert.ok(!(await ok<{ files: FileRecord[] }>(dev.inject({ method: "GET", url: "/api/documents" }))).files.some((file) => file.id === notes.id));

  const one = await ok<{ file: FileRecord }>(mira.inject({ method: "GET", url: `/api/documents/${notes.id}` }));
  assert.equal(one.file.sha256, notes.sha256);
  claim("GET /api/documents/:id", "happy-path");
  assert.equal((await dev.inject({ method: "GET", url: `/api/documents/${notes.id}` })).statusCode, 404);
  claim("GET /api/documents/:id", "isolation");
  assert.equal((await mira.inject({ method: "GET", url: `/api/documents/${MISSING_ID}` })).statusCode, 404);
  claim("GET /api/documents/:id", "unknown-id");

  for (const bad of ["a/b.md", "CON.txt", "  ", "tab\there.txt"]) {
    const refused = await upload(mira, bad, "x");
    assert.equal(refused.statusCode, 400, `${bad}: ${refused.body}`);
  }
});

test("text is read in windows; the agents' copy has secrets redacted", async () => {
  const lines = Array.from({ length: 2000 }, (_, index) => `Line ${index} of the Fieldnote log`).join("\n");
  const log = await uploaded(mira, "field.log", `${lines}\ntoken: abcdefghijklmnop`);
  const first = await ok<{ text: string; offset: number; total: number; nextOffset?: number }>(mira.inject({ method: "GET", url: `/api/documents/${log.id}/text` }));
  assert.equal(first.offset, 0);
  assert.ok(first.text.length <= 6000 && first.text.length > 3000);
  assert.equal(first.nextOffset, first.text.length);
  const next = await ok<{ text: string; offset: number; nextOffset?: number }>(mira.inject({ method: "GET", url: `/api/documents/${log.id}/text?offset=${first.nextOffset}&limit=100000` }));
  assert.equal(next.offset, first.nextOffset);
  assert.ok(next.text.length <= 20_000, "at most 20,000 characters at a time");
  const total = first.total;
  const tail = await ok<{ text: string; nextOffset?: number }>(mira.inject({ method: "GET", url: `/api/documents/${log.id}/text?offset=${total - 40}` }));
  assert.equal(tail.nextOffset, undefined);
  assert.match(tail.text, /\[redacted\]$/);
});

test("originals download as attachments with the format's type, an ETag and ranges", async () => {
  const notes = await uploaded(mira, "Résumé notes.md", "# Mira Chen\n");
  const res = await mira.inject({ method: "GET", url: `/api/documents/${notes.id}/original` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/markdown");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["cache-control"], "private, no-cache");
  assert.equal(res.headers.etag, `"${notes.sha256}"`);
  assert.equal(res.headers["content-disposition"], `attachment; filename="R_sum_ notes.md"; filename*=UTF-8''R%C3%A9sum%C3%A9%20notes.md`);
  assert.match(String(res.headers["content-security-policy"]), /sandbox/);
  assert.equal(res.body, "# Mira Chen\n");
  const cached = await mira.inject({ method: "GET", url: `/api/documents/${notes.id}/original`, headers: { "if-none-match": `"${notes.sha256}"` } });
  assert.equal(cached.statusCode, 304);
  assert.equal(cached.body, "");
  const part = await mira.inject({ method: "GET", url: `/api/documents/${notes.id}/original`, headers: { range: "bytes=2-5" } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers["content-range"], `bytes 2-5/${notes.byteSize}`);
  assert.equal(part.body, "Mira");

  const page = await uploaded(mira, "invite.html", "<script>alert(1)</script>", "text/html");
  assert.equal(page.mediaType, "text/plain");
  const html = await mira.inject({ method: "GET", url: `/api/documents/${page.id}/original` });
  assert.equal(html.headers["content-type"], "text/plain", "HTML is never served as HTML");
  const unknown = await uploaded(mira, "payload.xyz", "<script>alert(1)</script>", "text/html");
  assert.equal(unknown.mediaType, "text/html");
  const raw = await mira.inject({ method: "GET", url: `/api/documents/${unknown.id}/original` });
  assert.equal(raw.headers["content-type"], "application/octet-stream", "an unknown format is never served with the sender's type");
  assert.equal((await dev.inject({ method: "GET", url: `/api/documents/${notes.id}/original` })).statusCode, 404);
});

test("replacing bytes re-reads the text, and an .xls made into .xlsx changes format", async () => {
  const csv = await uploaded(mira, "orders.csv", "item,count\npaper,2\n");
  const replaced = await ok<{ file: FileRecord }>(
    mira.inject({ method: "PUT", url: `/api/documents/${csv.id}/content`, payload: { dataBase64: Buffer.from("item,count\npaper,3\nink,1\n").toString("base64") } }),
  );
  assert.notEqual(replaced.file.sha256, csv.sha256);
  assert.equal(replaced.file.filename, "orders.csv");
  assert.ok(Date.parse(replaced.file.updatedAt) >= Date.parse(csv.updatedAt));
  assert.equal((await ok<{ text: string }>(mira.inject({ method: "GET", url: `/api/documents/${csv.id}/text` }))).text, "item,count\npaper,3\nink,1\n");
  claim("PUT /api/documents/:id/content", "happy-path");

  const legacy = await uploaded(mira, "Q3 budget.xls", new Uint8Array([0xd0, 0xcf, 0x11]));
  const converted = await ok<{ file: FileRecord }>(
    mira.inject({ method: "PUT", url: `/api/documents/${legacy.id}/content`, payload: { dataBase64: (await budget()).toString("base64"), filename: "Q3 budget.xlsx" } }),
  );
  assert.deepEqual([converted.file.format, converted.file.mediaType, converted.file.textStatus], ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "queued"]);
  const read = await settled(mira, legacy.id);
  assert.deepEqual([read.textStatus, read.pageCount, read.warnings], ["ready", 1, []]);
  assert.match((await ok<{ text: string }>(mira.inject({ method: "GET", url: `/api/documents/${legacy.id}/text` }))).text, /^--- Sheet 1: Budget ---\nItem,Cost/);

  assert.equal((await mira.inject({ method: "PUT", url: `/api/documents/${csv.id}/content`, payload: { filename: "x.csv" } })).statusCode, 400);
  assert.equal((await mira.inject({ method: "PUT", url: `/api/documents/${csv.id}/content`, payload: { dataBase64: "eA==", filename: "../x.csv" } })).statusCode, 400);
  claim("PUT /api/documents/:id/content", "invalid-input");
  assert.equal((await dev.inject({ method: "PUT", url: `/api/documents/${csv.id}/content`, payload: { dataBase64: "eA==" } })).statusCode, 404);
  claim("PUT /api/documents/:id/content", "isolation");
  assert.equal((await mira.inject({ method: "PUT", url: `/api/documents/${MISSING_ID}/content`, payload: { dataBase64: "eA==" } })).statusCode, 404);
  claim("PUT /api/documents/:id/content", "unknown-id");
  assert.equal(await db.auditLedger.count({ where: { userId: mira.id, action: "document.update" } }), 2);
});

test("cell edits save into the workbook and keep its formatting", async () => {
  const file = await uploaded(mira, "Fieldnote budget.xlsx", await budget());
  await settled(mira, file.id);
  const saved = await ok<{ file: FileRecord }>(
    mira.inject({ method: "POST", url: `/api/documents/${file.id}/cells`, payload: { sheets: [{ name: "Budget", set: [{ row: 2, col: 2, value: 15 }, { row: 2, col: 1, value: "Notebooks" }], deleteRows: [4] }] } }),
  );
  claim("POST /api/documents/:id/cells", "happy-path");
  assert.notEqual(saved.file.sha256, file.sha256);
  const original = await mira.inject({ method: "GET", url: `/api/documents/${file.id}/original` });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(original.rawPayload as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Budget")!;
  assert.deepEqual(sheet.getCell("A1").font, { bold: true, color: { argb: "FF1F6FEB" } }, "another cell's formatting stays");
  assert.equal(sheet.getCell("B3").numFmt, "$#,##0.00");
  assert.deepEqual([sheet.getCell("A2").value, sheet.getCell("B2").value, sheet.getCell("A3").value], ["Notebooks", 15, "Ink"]);
  assert.equal(sheet.getCell("B4").formula, "SUM(B2:B3)");
  const text = (await settled(mira, file.id)).textStatus;
  assert.equal(text, "ready");
  assert.equal(await db.auditLedger.count({ where: { userId: mira.id, action: "document.cells" } }), 1);

  const csv = await uploaded(mira, "plain.csv", "a,b\n1,2\n");
  for (const [id, payload] of [
    [csv.id, { sheets: [{ name: "Sheet1", set: [{ row: 1, col: 1, value: 1 }] }] }],
    [file.id, { sheets: [{ name: "Budget", set: [{ row: 0, col: 1, value: 1 }] }] }],
    [file.id, { sheets: [] }],
    [file.id, { sheets: [{ name: "Missing", set: [{ row: 1, col: 1, value: 1 }] }] }],
    [file.id, { sheets: [{ name: "Budget", set: Array.from({ length: 20_001 }, (_, index) => ({ row: index + 1, col: 1, value: index })) }] }],
  ] as const) {
    const refused = await mira.inject({ method: "POST", url: `/api/documents/${id}/cells`, payload: payload as unknown as InjectOptions["payload"] });
    assert.equal(refused.statusCode, 400, refused.body);
  }
  claim("POST /api/documents/:id/cells", "invalid-input");
  const patch = { sheets: [{ name: "Budget", set: [{ row: 1, col: 1, value: "x" }] }] };
  assert.equal((await dev.inject({ method: "POST", url: `/api/documents/${file.id}/cells`, payload: patch })).statusCode, 404);
  claim("POST /api/documents/:id/cells", "isolation");
  assert.equal((await mira.inject({ method: "POST", url: `/api/documents/${MISSING_ID}/cells`, payload: patch })).statusCode, 404);
  claim("POST /api/documents/:id/cells", "unknown-id");
});

test("files become pages: Markdown, code and CSV on the server, PDF from the browser with its style", async () => {
  type Page = { id: string; title: string; content: { content: Array<{ type: string; attrs?: Record<string, unknown>; content?: unknown[] }> }; sourceFile: { id: string; filename: string; format: string; hasStyle: boolean } | null };
  const notes = await uploaded(mira, "Visit notes.md", "# Fieldnote visit\n\n- Meet Mira\n");
  const made = await ok<{ pageId: string }>(mira.inject({ method: "POST", url: `/api/documents/${notes.id}/page`, payload: {} }), 201);
  claim("POST /api/documents/:id/page", "happy-path");
  const page = await ok<Page>(mira.inject({ method: "GET", url: `/api/pages/${made.pageId}` }));
  assert.equal(page.title, "Visit notes");
  assert.deepEqual(page.content.content.map((node) => node.type), ["heading", "bulletList"]);
  assert.deepEqual(page.sourceFile, { id: notes.id, filename: "Visit notes.md", format: "md", hasStyle: false });
  assert.equal((await db.taskPage.findUniqueOrThrow({ where: { id: made.pageId } })).sourceFileId, notes.id);

  const code = await uploaded(mira, "sync.py", "print('Fieldnote')\n");
  const codePage = await ok<{ pageId: string }>(mira.inject({ method: "POST", url: `/api/documents/${code.id}/page`, payload: { title: "Sync script" } }), 201);
  const codeDoc = await ok<Page>(mira.inject({ method: "GET", url: `/api/pages/${codePage.pageId}` }));
  assert.equal(codeDoc.title, "Sync script");
  assert.deepEqual(codeDoc.content.content[0]!.attrs, { language: "python" });

  const csv = await uploaded(mira, "people.csv", "name,team\nMira Chen,Research\n");
  const csvPage = await ok<{ pageId: string }>(mira.inject({ method: "POST", url: `/api/documents/${csv.id}/page` }), 201);
  assert.equal((await ok<Page>(mira.inject({ method: "GET", url: `/api/pages/${csvPage.pageId}` }))).content.content[0]!.type, "table");

  const pdf = await uploaded(mira, "Fieldnote brief.pdf", makePdf(["Mira Chen at Fieldnote"]));
  assert.equal(pdf.textStatus, "queued");
  const read = await settled(mira, pdf.id);
  assert.deepEqual([read.textStatus, read.pageCount], ["ready", 1]);
  const refused = await mira.inject({ method: "POST", url: `/api/documents/${pdf.id}/page`, payload: {} });
  assert.equal(refused.statusCode, 400, "a PDF needs the content the browser converted");
  const style = { source: "pdf", page: { width: 612, height: 792, margins: { top: 72, right: 72, bottom: 72, left: 72 } }, body: { font: "Helvetica", size: 12, color: "#1f2328" }, headings: { "1": { size: 20, color: "#0b3d91", bold: true } } };
  const content = { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Fieldnote brief" }] }, { type: "paragraph", content: [{ type: "mention", attrs: { kind: "people", id: "p1", label: "Mira Chen" } }] }] };
  const pdfPage = await ok<{ pageId: string }>(mira.inject({ method: "POST", url: `/api/documents/${pdf.id}/page`, payload: { content, style } }), 201);
  const pdfDoc = await ok<Page & { mentions: Array<{ kind: string; id: string }> }>(mira.inject({ method: "GET", url: `/api/pages/${pdfPage.pageId}` }));
  assert.equal(pdfDoc.title, "Fieldnote brief");
  assert.deepEqual(pdfDoc.sourceFile, { id: pdf.id, filename: "Fieldnote brief.pdf", format: "pdf", hasStyle: true });
  assert.deepEqual(pdfDoc.mentions.map((mention) => [mention.kind, mention.id]), [["people", "p1"]]);
  assert.deepEqual((await ok<{ style: unknown }>(mira.inject({ method: "GET", url: `/api/documents/${pdf.id}/style` }))).style, style);
  claim("GET /api/documents/:id/style", "happy-path");
  assert.equal((await settled(mira, pdf.id)).hasStyle, true);
  assert.equal((await ok<{ style: unknown }>(mira.inject({ method: "GET", url: `/api/documents/${notes.id}/style` }))).style, null);

  const converted = await ok<{ kind: string; id: string }>(mira.inject({ method: "POST", url: `/api/pages/page/${pdfPage.pageId}/convert`, payload: { revision: 1 } }));
  assert.equal(converted.kind, "task");
  const taskPage = await ok<{ sourceFile: unknown }>(mira.inject({ method: "GET", url: `/api/tasks/${converted.id}/page` }));
  assert.deepEqual(taskPage.sourceFile, { id: pdf.id, filename: "Fieldnote brief.pdf", format: "pdf", hasStyle: true }, "a task page keeps the file it came from");

  const photo = await uploaded(mira, "badge.png", new Uint8Array([1, 2]));
  for (const [id, payload] of [
    [photo.id, {}],
    [pdf.id, { content, style: { ...style, body: { font: "Helvetica", size: 12, color: "blue" } } }],
    [notes.id, { style }],
    [notes.id, { content: { type: "page" } }],
  ] as const) {
    const bad = await mira.inject({ method: "POST", url: `/api/documents/${id}/page`, payload: payload as unknown as InjectOptions["payload"] });
    assert.equal(bad.statusCode, 400, bad.body);
  }
  claim("POST /api/documents/:id/page", "invalid-input");
  assert.equal((await dev.inject({ method: "POST", url: `/api/documents/${notes.id}/page`, payload: {} })).statusCode, 404);
  assert.equal((await dev.inject({ method: "GET", url: `/api/documents/${pdf.id}/style` })).statusCode, 404);
  claim("POST /api/documents/:id/page", "isolation");
  claim("GET /api/documents/:id/style", "isolation");
  assert.equal((await mira.inject({ method: "POST", url: `/api/documents/${MISSING_ID}/page`, payload: {} })).statusCode, 404);
  assert.equal((await mira.inject({ method: "GET", url: `/api/documents/${MISSING_ID}/style` })).statusCode, 404);
  claim("POST /api/documents/:id/page", "unknown-id");
  claim("GET /api/documents/:id/style", "unknown-id");

  const entities = await ok<{ entities: Array<{ kind: string; id: string; label: string; detail: string }> }>(mira.inject({ method: "GET", url: "/api/entities" }));
  assert.deepEqual(entities.entities.find((row) => row.id === pdf.id), { kind: "file", id: pdf.id, label: "Fieldnote brief.pdf", detail: `PDF · ${pdf.byteSize} bytes` });
  assert.ok(!(await ok<{ entities: Array<{ id: string }> }>(dev.inject({ method: "GET", url: "/api/entities" }))).entities.some((row) => row.id === pdf.id));
});

test("removing a file hides its text from agents; restoring brings it back; emptying the trash erases both", async () => {
  const file = await uploaded(mira, "Interview notes.txt", "Mira Chen asked about the Fieldnote rollout.");
  const artifactId = (await db.document.findUniqueOrThrow({ where: { id: file.id } })).artifactId!;
  assert.ok(artifactId);
  await ok(mira.inject({ method: "DELETE", url: `/api/documents/${file.id}` }), 204);
  assert.notEqual((await db.artifact.findUniqueOrThrow({ where: { id: artifactId } })).deletedAt, null);
  assert.equal((await mira.inject({ method: "GET", url: `/api/documents/${file.id}` })).statusCode, 404);
  const artifacts = await ok<{ artifacts: Array<{ id: string }> }>(mira.inject({ method: "GET", url: "/api/artifacts?kind=file" }));
  assert.ok(!artifacts.artifacts.some((row) => row.id === artifactId));
  assert.equal(await db.auditLedger.count({ where: { userId: mira.id, action: "document.delete" } }), 1);

  await ok(mira.inject({ method: "POST", url: "/api/deleted/restore", payload: { kind: "document", id: file.id } }));
  assert.equal((await db.artifact.findUniqueOrThrow({ where: { id: artifactId } })).deletedAt, null);
  assert.equal((await mira.inject({ method: "GET", url: `/api/documents/${file.id}` })).statusCode, 200);

  await ok(mira.inject({ method: "DELETE", url: `/api/documents/${file.id}` }), 204);
  await ok(mira.inject({ method: "POST", url: "/api/deleted/empty" }));
  assert.equal(await db.document.count({ where: { id: file.id } }), 0);
  assert.equal(await db.artifact.count({ where: { id: artifactId } }), 0);
});

test("a shared page or public link opens the files placed on it, read-only, and no others", async () => {
  const owner = await person("Mira Chen");
  const cara = await person("Cara Diaz");
  const placed = await uploaded(owner, "Placed brief.md", "# Placed");
  const elsewhere = await uploaded(owner, "Private plan.md", "# Private");
  const page = await ok<{ page: { id: string } }>(owner.inject({ method: "POST", url: "/api/pages" }), 201);
  const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "See " }, { type: "mention", attrs: { kind: "file", id: placed.id, label: placed.filename } }] }] };
  await ok(owner.inject({ method: "PUT", url: `/api/pages/${page.page.id}`, payload: { revision: 1, content } }));
  const shares = await ok<{ shares: Array<{ id: string }> }>(
    owner.inject({ method: "POST", url: "/api/sharing/items", payload: { kind: "page", resourceId: page.page.id, personId: cara.id, role: "edit" } }),
    201,
  );
  const share = { "x-ensemble-share": shares.shares[0]!.id };
  const asCara = (request: InjectOptions) => cara.inject({ ...request, headers: { ...(request.headers as Record<string, string>), ...share } });

  assert.equal((await ok<{ file: FileRecord }>(asCara({ method: "GET", url: `/api/documents/${placed.id}` }))).file.filename, "Placed brief.md");
  assert.equal((await asCara({ method: "GET", url: `/api/documents/${placed.id}/original` })).body, "# Placed");
  assert.equal((await ok<{ text: string }>(asCara({ method: "GET", url: `/api/documents/${placed.id}/text` }))).text, "# Placed");
  for (const url of [`/api/documents/${elsewhere.id}`, `/api/documents/${elsewhere.id}/original`, `/api/documents/${placed.id}/style`, "/api/documents"]) {
    assert.equal((await asCara({ method: "GET", url })).statusCode, 403, url);
  }
  const edit = await asCara({ method: "PUT", url: `/api/documents/${placed.id}/content`, payload: { dataBase64: "eA==" } });
  assert.equal(edit.statusCode, 403, "editing the page does not mean editing its files");
  assert.equal((await upload(cara, "mine.md", "x", "text/markdown", share)).statusCode, 403);
  assert.equal((await asCara({ method: "DELETE", url: `/api/documents/${placed.id}` })).statusCode, 403);

  const link = await ok<{ link: { token: string } }>(owner.inject({ method: "POST", url: "/api/links", payload: { kind: "page", resourceId: page.page.id, role: "view" } }), 201);
  const anon = (url: string) => harness.app.inject({ method: "GET", url, headers: { "x-ensemble-link": link.link.token, "x-ensemble-visitor": "visitor-files-123" } });
  assert.equal((await anon(`/api/documents/${placed.id}/original`)).body, "# Placed");
  assert.equal((await anon(`/api/documents/${elsewhere.id}/original`)).statusCode, 403);

  await ok(owner.inject({ method: "PUT", url: `/api/pages/${page.page.id}`, payload: { revision: 2, content: { type: "doc", content: [{ type: "paragraph" }] } } }));
  assert.equal((await asCara({ method: "GET", url: `/api/documents/${placed.id}` })).statusCode, 403, "taking the file off the page closes it again");
  assert.equal((await anon(`/api/documents/${placed.id}`)).statusCode, 403);
});

function pageImage(user: HttpUser, filename: string, bytes: Uint8Array, mediaType = "image/png", headers: Record<string, string> = {}) {
  return user.inject({ method: "POST", url: "/api/documents", headers, payload: { filename, mediaType, dataBase64: Buffer.from(bytes).toString("base64"), purpose: "page-image" } });
}

const imageNode = (fileId: string, more: Record<string, unknown> = {}) => ({ type: "image", attrs: { src: null, alt: "", fileId, ...more } });

test("page images: exactly 2 MiB is kept with its size; one byte more, a damaged header, an SVG or a wrong name is refused", async () => {
  const owner = await person("Mira Chen");
  const count = async () => (await ok<{ usage: FileUsage }>(owner.inject({ method: "GET", url: "/api/documents" }))).usage.count;
  const kept = await ok<{ file: FileRecord; image: { format: string; width: number; height: number } }>(pageImage(owner, "site.png", testPng(1200, 800, 2_097_152)), 201);
  assert.equal(kept.file.byteSize, 2_097_152);
  assert.deepEqual(kept.image, { format: "png", width: 1200, height: 800 });
  assert.equal(kept.file.kind, "image");
  const row = await db.document.findUniqueOrThrow({ where: { id: kept.file.id }, select: { enrichmentStatus: true } });
  assert.equal(row.enrichmentStatus, "skipped", "page images are not summarised");
  const before = await count();

  const over = await pageImage(owner, "site.png", testPng(1200, 800, 2_097_153));
  assert.equal(over.statusCode, 413, over.body);
  assert.equal(over.json<{ error: string }>().error, "site.png is just over 2 MB. Images in pages can be up to 2 MB: make it smaller, or attach it as a file with /file.");
  const huge = await pageImage(owner, "scan.png", testPng(10, 10, 6 * 1024 * 1024));
  assert.equal(huge.statusCode, 413);
  assert.match(huge.json<{ error: string }>().error, /^scan\.png is 6\.0 MB\./);
  const plain = await upload(owner, "big as a file.png", testPng(10, 10, 2_097_153), "image/png");
  assert.equal(plain.statusCode, 201, "the limit is for images in pages; Files keeps larger ones");

  const png = testPng(40, 30);
  const damaged = png.slice(0, png.length - 12);
  const corrupt = await pageImage(owner, "cut.png", damaged);
  assert.equal(corrupt.statusCode, 400, corrupt.body);
  assert.match(corrupt.json<{ error: string }>().error, /cut\.png looks damaged/);
  const svg = await pageImage(owner, "logo.svg", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml");
  assert.equal(svg.statusCode, 415);
  assert.match(svg.json<{ error: string }>().error, /SVG files can carry scripts/);
  const renamed = await pageImage(owner, "photo.png", testJpeg(20, 10), "image/png");
  assert.equal(renamed.statusCode, 415);
  assert.match(renamed.json<{ error: string }>().error, /photo\.png is named \.png but holds a JPEG image/);
  const zero = await pageImage(owner, "zero.png", testPng(0, 10));
  assert.equal(zero.statusCode, 400);
  assert.equal(await count(), before + 1, "only the plain file upload was kept");

  const unnamed = await ok<{ file: FileRecord }>(pageImage(owner, "Screenshot", testJpeg(20, 10), "application/octet-stream"), 201);
  assert.equal(unnamed.file.filename, "Screenshot.jpg");
  assert.equal(unnamed.file.mediaType, "image/jpeg");
});

test("a shared page's viewers and its public link open the images placed on it, and no other image", async () => {
  const owner = await person("Mira Chen");
  const cara = await person("Cara Diaz");
  const placed = (await ok<{ file: FileRecord }>(pageImage(owner, "placed.png", testPng(8, 8)), 201)).file;
  const other = (await ok<{ file: FileRecord }>(pageImage(owner, "other.png", testPng(9, 9)), 201)).file;
  const page = await ok<{ page: { id: string } }>(owner.inject({ method: "POST", url: "/api/pages" }), 201);
  const content = { type: "doc", content: [imageNode(placed.id, { width: 50, align: "left" }), { type: "paragraph" }] };
  await ok(owner.inject({ method: "PUT", url: `/api/pages/${page.page.id}`, payload: { revision: 1, content } }));
  const shares = await ok<{ shares: Array<{ id: string }> }>(
    owner.inject({ method: "POST", url: "/api/sharing/items", payload: { kind: "page", resourceId: page.page.id, personId: cara.id, role: "view" } }),
    201,
  );
  const share = { "x-ensemble-share": shares.shares[0]!.id };
  const asCara = (url: string) => cara.inject({ method: "GET", url, headers: share });
  const seen = await asCara(`/api/documents/${placed.id}/original`);
  assert.equal(seen.statusCode, 200, seen.body);
  assert.equal(seen.headers["content-type"], "image/png");
  assert.deepEqual(new Uint8Array(seen.rawPayload), testPng(8, 8));
  assert.equal((await asCara(`/api/documents/${other.id}/original`)).statusCode, 403);
  assert.equal((await pageImage(cara, "mine.png", testPng(), "image/png", share)).statusCode, 403, "a viewer adds no images");

  const link = await ok<{ link: { token: string } }>(owner.inject({ method: "POST", url: "/api/links", payload: { kind: "page", resourceId: page.page.id, role: "view" } }), 201);
  const anon = (url: string) => harness.app.inject({ method: "GET", url, headers: { "x-ensemble-link": link.link.token, "x-ensemble-visitor": "visitor-images-123" } });
  assert.equal((await anon(`/api/documents/${placed.id}/original`)).statusCode, 200);
  assert.equal((await anon(`/api/documents/${other.id}/original`)).statusCode, 403);
});

test("page writes refuse new images over the limit or of non-images, and old pages still save", async () => {
  const owner = await person("Mira Chen");
  const page = await ok<{ page: { id: string } }>(owner.inject({ method: "POST", url: "/api/pages" }), 201);
  const save = (revision: number, ...content: unknown[]) => owner.inject({ method: "PUT", url: `/api/pages/${page.page.id}`, payload: { revision, content: { type: "doc", content } } });
  const big = (await uploaded(owner, "poster.png", testPng(10, 10, 3 * 1024 * 1024), "image/png"));
  const pdf = await uploaded(owner, "brief.pdf", makePdf(["Brief"]), "application/pdf");
  const fine = (await ok<{ file: FileRecord }>(pageImage(owner, "fine.png", testPng(10, 10)), 201)).file;

  const tooBig = await save(1, imageNode(big.id));
  assert.equal(tooBig.statusCode, 413, tooBig.body);
  assert.match(tooBig.json<{ error: string }>().error, /^poster\.png is 3\.0 MB, over the 2 MB limit for images in pages\. Attach it as a file instead: \[@poster\.png\]\(ensemble:\/\/file\//);
  assert.equal((await save(1, imageNode(pdf.id))).statusCode, 415);
  const pasted = `data:image/png;base64,${Buffer.from(testPng(10, 10, 2_097_153)).toString("base64")}`;
  const data = await save(1, { type: "image", attrs: { src: pasted, alt: "Pasted chart" } });
  assert.equal(data.statusCode, 413);
  assert.match(data.json<{ error: string }>().error, /^Pasted chart is just over 2 MB/);
  await ok(save(1, imageNode(fine.id), { type: "image", attrs: { src: "data:image/png;base64,iVBORw0KGgo=", alt: "" } }));

  // A page that already holds an oversized pasted image (from before the limit) keeps saving.
  await db.taskPage.update({ where: { id: page.page.id }, data: { content: { type: "doc", content: [{ type: "image", attrs: { src: pasted, alt: "Old" } }] } } });
  await ok(save(2, { type: "image", attrs: { src: pasted, alt: "Old" } }, { type: "paragraph", content: [{ type: "text", text: "Edited" }] }));
});

test("hosted accounts keep ten files in 50 MB; removing one frees room; the server has a total", { timeout: 120_000 }, async (t) => {
  const before = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  });
  process.env.NODE_ENV = "production";
  process.env.ENSEMBLE_DESKTOP = "0";
  process.env.ENSEMBLE_SERVER_RUNNER = "off";
  const hosted = await person("Mira Chen");
  const ids: string[] = [];
  for (let index = 1; index <= 10; index += 1) ids.push((await uploaded(hosted, `note ${index}.txt`, `Fieldnote note ${index}`)).id);
  const eleventh = await upload(hosted, "note 11.txt", "one too many");
  assert.equal(eleventh.statusCode, 429);
  assert.equal(eleventh.json<{ error: string }>().error, "You can keep 10 files on the hosted plan. Remove one to add another.");
  const usage = (await ok<{ usage: FileUsage }>(hosted.inject({ method: "GET", url: "/api/documents" }))).usage;
  assert.deepEqual([usage.count, usage.maxCount, usage.maxBytes, usage.maxFileBytes], [10, 10, 50 * 1024 * 1024, 25 * 1024 * 1024]);
  await ok(hosted.inject({ method: "DELETE", url: `/api/documents/${ids[0]}` }), 204);
  await uploaded(hosted, "note 11.txt", "room again");

  process.env.ENSEMBLE_MAX_DOCUMENTS = "50";
  process.env.ENSEMBLE_MAX_DOCUMENT_BYTES = "300";
  const used = (await ok<{ usage: FileUsage }>(hosted.inject({ method: "GET", url: "/api/documents" }))).usage.bytes;
  const big = await upload(hosted, "big.txt", "x".repeat(300 - used + 12));
  assert.equal(big.statusCode, 429);
  assert.equal(big.json<{ error: string }>().error, "Files can use 300 bytes together on the hosted plan; this one needs 12 bytes more.");
  const target = ids[1]!;
  const grow = await hosted.inject({ method: "PUT", url: `/api/documents/${target}/content`, payload: { dataBase64: Buffer.from("y".repeat(400)).toString("base64") } });
  assert.equal(grow.statusCode, 429, "a replacement counts its size change");
  delete process.env.ENSEMBLE_MAX_DOCUMENT_BYTES;

  const tooLarge = await upload(hosted, "scan.pdf", new Uint8Array(25 * 1024 * 1024 + 1));
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.json<{ error: string }>().error, "Files can be up to 25 MB on the hosted plan.");

  const stored = (await db.document.aggregate({ _sum: { byteSize: true } }))._sum.byteSize ?? 0;
  process.env.ENSEMBLE_FILES_TOTAL_MAX_BYTES = String(stored + 5);
  const full = await upload(hosted, "late.txt", "more than five bytes");
  assert.equal(full.statusCode, 507);
  assert.equal(full.json<{ error: string }>().error, "File storage on this server is full right now.");
});

test("an empty file, a program, and a body over the size limit are refused with a reason, and nothing is kept", async () => {
  const before = (await ok<{ usage: FileUsage }>(mira.inject({ method: "GET", url: "/api/documents" }))).usage.count;
  const empty = await upload(mira, "blank.txt", "");
  assert.equal(empty.statusCode, 400, empty.body);
  assert.equal(empty.json<{ error: string }>().error, "This file is empty, so there is nothing to keep.");
  for (const name of ["setup.exe", "firmware.BIN"]) {
    const refused = await upload(mira, name, "MZ");
    assert.equal(refused.statusCode, 415, `${name}: ${refused.body}`);
    assert.match(refused.json<{ error: string }>().error, /programs or raw binary data/);
  }
  const archive = await uploaded(mira, "Fieldnote photos.zip", "PK");
  assert.equal(archive.kind, "other", "formats Ensemble cannot show are still kept");
  const renamed = await mira.inject({ method: "PUT", url: `/api/documents/${archive.id}/content`, payload: { dataBase64: Buffer.from("MZ").toString("base64"), filename: "photos.exe" } });
  assert.equal(renamed.statusCode, 415, "a replacement cannot turn a file into a program");

  // The Content-Length alone is over the route's limit: refused before the body is read.
  const huge = await mira.inject({
    method: "POST",
    url: "/api/documents",
    headers: { "content-type": "application/json", "content-length": String(200 * 1024 * 1024) },
    payload: JSON.stringify({ filename: "scan.pdf", mediaType: "application/pdf", dataBase64: "JVBERi0=", summarize: false }),
  });
  assert.equal(huge.statusCode, 413, huge.body);
  assert.equal(huge.json<{ error: string }>().error, "Files can be up to 100 MB.");
  const after = (await ok<{ usage: FileUsage }>(mira.inject({ method: "GET", url: "/api/documents" }))).usage.count;
  assert.equal(after, before + 1, "only the archive was kept");
});
