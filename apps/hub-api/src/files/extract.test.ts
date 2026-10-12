/**
 * Reading files for agents: text formats decode in place, PDF and Office files are read in a
 * worker thread, other formats say plainly why agents cannot read them. Cell edits keep the
 * workbook's formatting and move formulas the way Excel does. Fictional data: Mira Chen at Fieldnote.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { markdownToDocx } from "../lib/office/docx.js";
import { slidesToPptx } from "../lib/office/pptx.js";
import { contentHasFile } from "../sharing/gate.js";
import { decodeText, finishText, MAX_TEXT_CHARS, patchWorkbook, readFileText } from "./extract.js";
import { partsCellEditsWouldLose, shiftFormula } from "./extract-worker.js";
import { pageFromFile, pageTitle, serverPageFormat } from "./page.js";
import { makePdf } from "./testing.js";
import { filenameProblem, mediaTypeFor, safeFilename } from "./store.js";

async function budget(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Budget");
  sheet.addRow(["Item", "Cost", "Ordered"]);
  sheet.addRow(["Paper", 12, new Date(Date.UTC(2026, 9, 1))]);
  sheet.addRow(["Ink", 30, new Date(Date.UTC(2026, 9, 2))]);
  sheet.addRow(["Tape", 4, new Date(Date.UTC(2026, 9, 3))]);
  sheet.getCell("B5").value = { formula: "SUM(B2:B4)", result: 46 };
  sheet.getCell("A1").font = { bold: true, color: { argb: "FF1F6FEB" } };
  sheet.getCell("B3").numFmt = "$#,##0.00";
  const summary = workbook.addWorksheet("Summary");
  summary.getCell("A1").value = { formula: "Budget!B5", result: 46 };
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

test("text decodes with or without a byte order mark", () => {
  assert.equal(decodeText(strToU8("plain")), "plain");
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8("bom")])), "bom");
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, ...Buffer.from("Mira", "utf16le")])), "Mira");
  const be = Buffer.from("Chen", "utf16le").swap16();
  assert.equal(decodeText(new Uint8Array([0xfe, 0xff, ...be])), "Chen");
});

test("agent text is redacted and cut at the limit with a warning", () => {
  assert.equal(finishText("key sk-abcdefghijklmnopqrstuvwxyz1234 here").text, "key [redacted] here");
  const long = finishText("x".repeat(MAX_TEXT_CHARS + 10));
  assert.equal(long.text.length, MAX_TEXT_CHARS);
  assert.match(long.warnings[0]!, /first 400,000 characters/);
});

test("text, Markdown, code and CSV are ready at once; images, audio and video have no text", async () => {
  const markdown = await readFileText("Field notes.md", strToU8("# Fieldnote visit\nMira Chen met the team."));
  assert.deepEqual([markdown.status, markdown.text, markdown.pageCount], ["ready", "# Fieldnote visit\nMira Chen met the team.", null]);
  assert.equal((await readFileText("budget.csv", strToU8("item,cost\npaper,12"))).text, "item,cost\npaper,12");
  assert.equal((await readFileText("Dockerfile", strToU8("FROM node:22"))).status, "ready");
  for (const name of ["photo.png", "call.mp3", "walkthrough.mov", "archive.zip"]) {
    assert.deepEqual(await readFileText(name, new Uint8Array([1, 2, 3])), { status: "none", text: "", pageCount: null, warnings: [] }, name);
  }
});

test("formats agents cannot read say which format would work", async () => {
  const sheet = await readFileText("old budget.xls", new Uint8Array([1]));
  assert.equal(sheet.status, "none");
  assert.match(sheet.warnings[0]!, /\.xlsx and \.csv/);
  assert.match((await readFileText("brief.doc", new Uint8Array([1]))).warnings[0]!, /\.docx/);
  assert.match((await readFileText("deck.key", new Uint8Array([1]))).warnings[0]!, /\.pptx/);
});

test("PDF text is read page by page in a worker; scanned and damaged PDFs say so", { timeout: 60_000 }, async () => {
  const pdf = await readFileText("Fieldnote brief.pdf", makePdf(["Mira Chen at Fieldnote", "Second page"]));
  assert.equal(pdf.status, "ready");
  assert.equal(pdf.pageCount, 2);
  assert.equal(pdf.text, "--- Page 1 ---\nMira Chen at Fieldnote\n\n--- Page 2 ---\nSecond page");
  const scanned = await readFileText("scan.pdf", makePdf(["", ""]));
  assert.deepEqual([scanned.status, scanned.pageCount], ["none", 2]);
  assert.match(scanned.warnings[0]!, /no text layer/);
  const broken = await readFileText("broken.pdf", strToU8("not a pdf"));
  assert.equal(broken.status, "failed");
  assert.match(broken.warnings[0]!, /agents cannot read it/);
});

test("Word, PowerPoint and Excel files are read with slide and sheet markers", { timeout: 60_000 }, async () => {
  const docx = await readFileText("brief.docx", await markdownToDocx("# Visit plan\n\nMira Chen meets the Fieldnote team."));
  assert.equal(docx.status, "ready");
  assert.match(docx.text, /# Visit plan/);
  assert.match(docx.text, /Mira Chen meets the Fieldnote team\./);

  const pptx = await readFileText("deck.pptx", await slidesToPptx({ title: "Fieldnote", slides: [{ title: "Goals", bullets: ["Ship the brief"], notes: "Ask Mira" }] }));
  assert.equal(pptx.status, "ready");
  assert.equal(pptx.pageCount, 2);
  assert.match(pptx.text, /--- Slide 2: Goals ---\n- Ship the brief\nNotes: Ask Mira/);

  const xlsx = await readFileText("budget.xlsx", await budget());
  assert.equal(xlsx.status, "ready");
  assert.equal(xlsx.pageCount, 2);
  assert.match(xlsx.text, /^--- Sheet 1: Budget ---\nItem,Cost,Ordered\nPaper,12,2026-10-01\n/);
  assert.match(xlsx.text, /\nTape,4,2026-10-03\n,46\n\n--- Sheet 2: Summary ---\n46$/);
});

test("long sheets keep their first 2,000 rows for agents", { timeout: 60_000 }, async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Log");
  for (let index = 1; index <= 2100; index += 1) sheet.addRow([index, `Entry ${index}`]);
  const result = await readFileText("log.xlsx", new Uint8Array(await workbook.xlsx.writeBuffer()));
  assert.match(result.warnings[0]!, /first 2,000 rows/);
  assert.match(result.text, /\n2000,Entry 2000$/);
});

test("removing rows rewrites formulas the way Excel does", () => {
  assert.equal(shiftFormula('SUM(B2:B4)+B5*$B$4+Other!B4+"B4"+LOG10(B6)', "Budget", true, [4]), 'SUM(B2:B3)+B4*#REF!+Other!B4+"B4"+LOG10(B5)');
  assert.equal(shiftFormula("Budget!A5+'Mira''s'!A5+A5", "Budget", false, [4]), "Budget!A4+'Mira''s'!A5+A5");
  assert.equal(shiftFormula("SUM(A4:A4)", "Budget", true, [4]), "SUM(#REF!)");
  assert.equal(shiftFormula("SUM(A2:A9)", "Budget", true, [2, 3, 9]), "SUM(A2:A6)");
});

test("cell edits keep formatting and other cells, and move formulas when rows go", { timeout: 60_000 }, async () => {
  const saved = await patchWorkbook(await budget(), { sheets: [{ name: "Budget", set: [{ row: 2, col: 2, value: 15 }, { row: 6, col: 1, value: "=B5*2" }], deleteRows: [4] }] });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(saved) as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Budget")!;
  assert.deepEqual(sheet.getCell("A1").font, { bold: true, color: { argb: "FF1F6FEB" } });
  assert.equal(sheet.getCell("B3").numFmt, "$#,##0.00");
  assert.equal(sheet.getCell("B2").value, 15);
  assert.equal(sheet.getCell("A3").value, "Ink");
  assert.equal(sheet.getCell("A4").formula, undefined, "Tape's row is gone; the total moved up");
  assert.equal(sheet.getCell("B4").formula, "SUM(B2:B3)");
  assert.equal(sheet.getCell("A5").formula, "B4*2");
  assert.equal(workbook.getWorksheet("Summary")!.getCell("A1").formula, "Budget!B4");
  await assert.rejects(patchWorkbook(await budget(), { sheets: [{ name: "Missing", set: [{ row: 1, col: 1, value: 1 }] }] }), { statusCode: 400, message: /no sheet named “Missing”/ });
});

test("workbooks with parts exceljs would drop are refused instead of damaged", { timeout: 60_000 }, async () => {
  const files = unzipSync(await budget());
  files["xl/vbaProject.bin"] = strToU8("macro project");
  files["xl/comments1.xml"] = strToU8("<comments/>");
  const bytes = zipSync(files);
  assert.deepEqual(partsCellEditsWouldLose(bytes).sort(), ["comments", "macros"]);
  await assert.rejects(patchWorkbook(bytes, { sheets: [{ name: "Budget", set: [{ row: 1, col: 1, value: "x" }] }] }), { statusCode: 400, message: /drop this workbook's (macros and comments|comments and macros)/ });
});

test("text, Markdown, code and CSV files become pages on the server", () => {
  assert.equal(serverPageFormat("notes.md"), true);
  assert.equal(serverPageFormat("budget.csv"), true);
  assert.equal(serverPageFormat("brief.pdf"), false);
  assert.equal(serverPageFormat("photo.png"), false);
  assert.equal(pageTitle("Q3 field notes.md"), "Q3 field notes");

  const markdown = pageFromFile("notes.md", strToU8("# Visit\n\n- Meet Mira"));
  assert.deepEqual(markdown.content.map((node) => node.type), ["heading", "bulletList"]);
  const code = pageFromFile("tool.py", strToU8("print('Fieldnote')\n"));
  assert.deepEqual(code.content, [{ type: "codeBlock", attrs: { language: "python" }, content: [{ type: "text", text: "print('Fieldnote')\n" }] }]);
  const text = pageFromFile("notes.txt", strToU8("Line one\nLine two\n\nNext paragraph"));
  assert.deepEqual(text.content, [
    { type: "paragraph", content: [{ type: "text", text: "Line one" }, { type: "hardBreak" }, { type: "text", text: "Line two" }] },
    { type: "paragraph", content: [{ type: "text", text: "Next paragraph" }] },
  ]);
  const rows = ["item,cost", ...Array.from({ length: 250 }, (_, index) => `row ${index},${index}`), ""].join("\n");
  const table = pageFromFile("budget.csv", strToU8(rows));
  assert.equal(table.content[0]!.type, "table");
  assert.equal(table.content[0]!.content!.length, 201, "the header and 200 rows");
  assert.equal(table.content[0]!.content![0]!.content![0]!.type, "tableHeader");
  assert.match(JSON.stringify(table.content[1]), /first 200 rows/);
  const tsv = pageFromFile("people.tsv", strToU8("name\trole\nMira Chen\t"));
  assert.deepEqual(tsv.content[0]!.content![1]!.content![1], { type: "tableCell", content: [{ type: "paragraph" }] }, "empty cells have no empty text node");
});

test("file names are checked for uploads and made safe for imports", () => {
  assert.equal(filenameProblem("Field notes.pdf"), null);
  assert.match(filenameProblem("a/b.pdf")!, /cannot contain/);
  assert.match(filenameProblem("bad\u0001.txt")!, /control characters/);
  assert.match(filenameProblem("CON.txt")!, /Windows keeps/);
  assert.match(filenameProblem("  ")!, /Give the file a name/);
  assert.equal(safeFilename("Q3/Q4 plan.pdf"), "Q3-Q4 plan.pdf");
  assert.equal(safeFilename("nul"), "_nul");
  assert.equal(safeFilename(`${"a".repeat(300)}.pdf`).length, 255);
  assert.ok(safeFilename(`${"a".repeat(300)}.pdf`).endsWith(".pdf"));
  assert.equal(mediaTypeFor("page.html", "text/html"), "text/plain", "the format table wins over what the sender said");
  assert.equal(mediaTypeFor("image.svg", "text/html"), "image/svg+xml");
  assert.equal(mediaTypeFor("data.xyz", "Application/X-Custom; charset=utf-8"), "application/x-custom");
  assert.equal(mediaTypeFor("data.xyz", "<script>"), "application/octet-stream");
});

test("a page places a file through an @ mention or an embedded file block", () => {
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { kind: "file", id: "file-a", label: "brief.pdf" } }] }, { type: "fileEmbed", attrs: { fileId: "file-b" } }] };
  assert.equal(contentHasFile(doc, "file-a"), true);
  assert.equal(contentHasFile(doc, "file-b"), true);
  assert.equal(contentHasFile(doc, "file-c"), false);
  assert.equal(contentHasFile({ type: "doc", content: [{ type: "mention", attrs: { kind: "people", id: "file-a" } }] }, "file-a"), false);
});
