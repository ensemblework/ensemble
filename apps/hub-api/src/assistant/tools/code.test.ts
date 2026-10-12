import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://x";
const { codePreamble, codeTools, documentText, profileLine, readablePath } = await import("./code.js");
const { markdownToDocx } = await import("../../lib/office/docx.js");
const { quickRunProfile } = await import("@ensemble/shared-types");

/** A one-page PDF with real cross-reference offsets, saying `text`. */
function pdfSaying(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 18 Tf 20 100 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 18 Tf 20 100 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const folder = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-code-")));
mkdirSync(join(folder, "src"));
writeFileSync(join(folder, "src", "app.ts"), "export const answer = 42;\n// TODO: tidy\n");
const session = { folder };
const tool = (name: string) => codeTools.find((item) => item.name === name)!;
const ctx = { code: session } as never;

test("paths resolve from the launch folder; keys and app data are never readable", async () => {
  assert.equal(await readablePath(session, "src/app.ts"), join(folder, "src", "app.ts"));
  await assert.rejects(readablePath(session, "missing.txt"), /does not exist/);
  // Refused whether or not this computer has one: missing, or on the hard floor.
  await assert.rejects(readablePath(session, join(homedir(), ".ssh")));
});

test("list, read and search the folder", async () => {
  const listed = await tool("code_list_files").run(ctx, { depth: 2 });
  assert.match(String((listed.data as { entries: string }).entries), /src\/\n {2}app\.ts/);
  const read = await tool("code_read_file").run(ctx, { path: "src/app.ts" });
  assert.match(String((read.data as { text: string }).text), /^1: export const answer = 42;/);
  const found = await tool("code_search").run(ctx, { pattern: "todo", maxResults: 10 });
  assert.match(String((found.data as { matches: string }).matches), /src\/app\.ts:2: \/\/ TODO: tidy/);
  await assert.rejects(tool("code_search").run(ctx, { pattern: "(", maxResults: 5 }), /not a valid regular expression/);
});

test("documents: PDF, Word and plain text become text", async () => {
  writeFileSync(join(folder, "spec.pdf"), pdfSaying("Ship the CLI"));
  writeFileSync(join(folder, "notes.docx"), await markdownToDocx("# Plan\n\n- Read the spec\n- Write tests", "Plan"));
  writeFileSync(join(folder, "readme.md"), "Hello");
  assert.match(await documentText(join(folder, "spec.pdf")), /Page 1[\s\S]*Ship the CLI/);
  const word = await documentText(join(folder, "notes.docx"));
  assert.match(word, /Read the spec/);
  assert.match(word, /Write tests/);
  assert.equal(await documentText(join(folder, "readme.md")), "Hello");
  writeFileSync(join(folder, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(documentText(join(folder, "blob.bin")), /not a text file/);
  const viaTool = await tool("code_read_document").run(ctx, { path: "spec.pdf" });
  assert.match(String((viaTool.data as { text: string }).text), /Ship the CLI/);
});

test("the tools refuse to run outside Ensemble Code", async () => {
  await assert.rejects(tool("code_read_file").run({} as never, { path: "x" }), /only in Ensemble Code/);
});

test("Ensemble Code is told its folder, its engine and the run profile", () => {
  const profile = { ...quickRunProfile(), name: "Careful", mode: "review" as const, delivery: "local" as const };
  assert.equal(profileLine(profile), "Careful: Review only, local only, sandbox on, internet on");
  const preamble = codePreamble({ folder: "/work/app", engine: "codex" }, profile);
  assert.match(preamble, /opened in \/work\/app/);
  assert.match(preamble, /runs Codex in the folder under the profile Careful: Review only, local only/);
  assert.match(preamble, /never edit files or run commands yourself/);
});
