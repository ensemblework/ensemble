import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Block } from "@/lib/export/document";
import { pdfFontFor, pdfLayout } from "@/lib/export/formats";
import { readStyleIds, rebuildDocx } from "./docx-template.js";
import { downloadName, exportBackFormats } from "./export-back.js";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const SECT =
  '<w:sectPr w:rsidR="00A1"><w:headerReference w:type="default" r:id="rId7"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/></w:sectPr>';

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>
<w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Titel"><w:name w:val="Title"/><w:basedOn w:val="Standard"/></w:style>
<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="Listenabsatz"><w:name w:val="List Paragraph"/></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/></w:style>
<w:style w:type="table" w:styleId="Tabellenraster"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>
<w:p><w:pPr><w:pStyle w:val="Titel"/></w:pPr><w:r><w:t>Contract</w:t></w:r></w:p>
<w:p><w:r><w:t>Old clause</w:t></w:r></w:p>
<w:p><w:pPr><w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr></w:pPr><w:r><w:t>Old landscape part</w:t></w:r></w:p>
${SECT}</w:body></w:document>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>`;
const TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const HEADER = `<?xml version="1.0"?><w:hdr ${W}><w:p><w:r><w:t>Fieldnote Ltd · Confidential</w:t></w:r></w:p></w:hdr>`;

function original(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(TYPES),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(DOCUMENT),
    "word/styles.xml": strToU8(STYLES),
    "word/_rels/document.xml.rels": strToU8(RELS),
    "word/header1.xml": strToU8(HEADER),
  });
}

const BLOCKS: Block[] = [
  { type: "heading", level: 1, runs: [{ text: "Contract" }] },
  { type: "heading", level: 2, runs: [{ text: "Terms & conditions" }] },
  { type: "paragraph", runs: [{ text: "Read the " }, { text: "full terms", href: "https://example.com/terms" }, { text: " and " }, { text: "sign", bold: true }, { text: " here.", italic: true }] },
  { type: "paragraph", runs: [{ text: "Not a link", href: "javascript:alert(1)" }] },
  { type: "list", ordered: false, items: [[{ text: "First" }], [{ text: "Second" }]] },
  { type: "list", ordered: true, items: [[{ text: "Step one" }]] },
  { type: "table", rows: [[[{ text: "Name" }], [{ text: "Amount" }]], [[{ text: "Mira Chen", italic: true }], [{ text: "£1,200" }]]] },
  { type: "code", text: "total = 1200\nprint(total)" },
];

function rebuilt() {
  const files = unzipSync(rebuildDocx(original(), BLOCKS));
  return { files, doc: strFromU8(files["word/document.xml"]!), rels: strFromU8(files["word/_rels/document.xml.rels"]!) };
}

test("the original's style ids are found by their built-in names, whatever the language", () => {
  const ids = readStyleIds(STYLES);
  assert.deepEqual(ids, {
    normal: "Standard",
    title: "Titel",
    headings: { 1: "berschrift1", 2: "berschrift2", 3: undefined },
    listParagraph: "Listenabsatz",
    listBullet: undefined,
    listNumber: undefined,
    quote: undefined,
    tableGrid: "Tabellenraster",
    hyperlink: "Hyperlink",
  });
});

test("the body is rebuilt from the page and the original's final section (page size, margins, header) stays", () => {
  const { doc, files } = rebuilt();
  assert.ok(doc.endsWith(`${SECT}</w:body></w:document>`), "the document's own sectPr closes the body unchanged");
  assert.ok(!doc.includes("Old clause") && !doc.includes("Old landscape part"), "the old body is gone");
  assert.ok(!doc.includes('w:orient="landscape"'), "section breaks inside the old body go with it");
  assert.ok(doc.includes("xmlns:wp="), "the root element keeps its namespaces");
  assert.equal(strFromU8(files["word/header1.xml"]!), HEADER);
  assert.equal(strFromU8(files["word/styles.xml"]!), STYLES);
});

test("paragraphs use the original's own styles: Title first, headings, list paragraphs and the table grid", () => {
  const { doc } = rebuilt();
  assert.match(doc, /<w:p><w:pPr><w:pStyle w:val="Titel"\/><\/w:pPr><w:r><w:t xml:space="preserve">Contract<\/w:t><\/w:r><\/w:p>/);
  assert.match(doc, /<w:pStyle w:val="berschrift2"\/><\/w:pPr><w:r><w:t xml:space="preserve">Terms &amp; conditions<\/w:t>/);
  assert.equal((doc.match(/<w:pStyle w:val="Listenabsatz"\/><w:numPr>/g) ?? []).length, 3);
  assert.match(doc, /<w:tblStyle w:val="Tabellenraster"\/>/);
  assert.match(doc, /<w:tr><w:trPr><w:tblHeader\/><\/w:trPr><w:tc><w:tcPr><w:tcW w:w="\d+" w:type="dxa"\/><\/w:tcPr><w:p><w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">Name<\/w:t><\/w:r>/);
  assert.match(doc, /<w:r><w:rPr><w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">Mira Chen<\/w:t><\/w:r>/, "table cells keep their formatting");
  assert.match(doc, /<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"\/><w:sz w:val="20"\/>/);
  assert.match(doc, /<w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">sign<\/w:t>/);
  assert.match(doc, /<w:rPr><w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve"> here.<\/w:t>/);
});

test("links become hyperlink relationships; unsafe links stay plain text", () => {
  const { doc, rels } = rebuilt();
  assert.match(doc, /<w:hyperlink r:id="rIdEnsemble1" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t xml:space="preserve">full terms<\/w:t><\/w:r><\/w:hyperlink>/);
  assert.match(rels, /<Relationship Id="rIdEnsemble1" Type="[^"]+\/hyperlink" Target="https:\/\/example.com\/terms" TargetMode="External"\/>/);
  assert.ok(!rels.includes("javascript"));
  assert.match(doc, /<w:t xml:space="preserve">Not a link<\/w:t>/);
});

test("lists get numbering definitions, added to the package when the original had none", () => {
  const { files, rels, doc } = rebuilt();
  const numbering = strFromU8(files["word/numbering.xml"]!);
  assert.match(numbering, /<w:abstractNum w:abstractNumId="1">[\s\S]*<w:numFmt w:val="bullet"\/>/);
  assert.match(numbering, /<w:numFmt w:val="decimal"\/>/);
  assert.match(numbering, /<w:num w:numId="2"><w:abstractNumId w:val="2"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"\/><\/w:lvlOverride><\/w:num>/);
  assert.ok(numbering.indexOf("<w:abstractNum ") < numbering.indexOf("<w:num "), "abstract definitions come before the numbers that use them");
  assert.match(rels, /Type="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships\/numbering" Target="numbering.xml"/);
  assert.match(strFromU8(files["[Content_Types].xml"]!), /<Override PartName="\/word\/numbering.xml" ContentType="application\/vnd.openxmlformats-officedocument.wordprocessingml.numbering\+xml"\/>/);
  assert.match(doc, /<w:numId w:val="1"\/>[\s\S]*<w:numId w:val="2"\/>/);
});

test("a PDF profile becomes the page size, margins, nearest standard fonts and colours", () => {
  const layout = pdfLayout({
    source: "pdf",
    page: { width: 612, height: 792, margins: { top: 54, right: 60, bottom: 50, left: 72 } },
    body: { font: "Times New Roman", size: 11.5, color: "#1a1a1a", lineHeight: 1.3 },
    headings: { "1": { font: "Arial", size: 22, color: "#1f3864", bold: true }, "2": { size: 15, color: "#2f5496" } },
  });
  assert.deepEqual(layout.format, [612, 792]);
  assert.deepEqual(layout.margins, { top: 54, right: 60, bottom: 50, left: 72 });
  assert.deepEqual(layout.body, { font: "times", size: 11.5, color: [26, 26, 26], lineHeight: 1.3 });
  assert.deepEqual(layout.headings[1], { font: "helvetica", size: 22, color: [31, 56, 100], bold: true });
  assert.deepEqual(layout.headings[2], { font: "times", size: 15, color: [47, 84, 150], bold: true });
  assert.deepEqual(layout.headings[3], { font: "times", size: 12.5, color: [26, 26, 26], bold: true }, "a missing heading level is scaled from the body");
  assert.equal(layout.title, false, "exporting back does not add Ensemble's title block");
});

test("without a profile the PDF keeps Ensemble's own A4 look", () => {
  const layout = pdfLayout();
  assert.equal(layout.format, null);
  assert.deepEqual(layout.margins, { top: 56, right: 56, bottom: 56, left: 56 });
  assert.equal(layout.body.size, 11);
  assert.equal(layout.title, true);
});

test("font families map to the nearest standard PDF font", () => {
  assert.equal(pdfFontFor("Times New Roman"), "times");
  assert.equal(pdfFontFor("Georgia"), "times");
  assert.equal(pdfFontFor("Garamond"), "times");
  assert.equal(pdfFontFor("Calibri"), "helvetica");
  assert.equal(pdfFontFor("Arial"), "helvetica");
  assert.equal(pdfFontFor("sans-serif"), "helvetica");
  assert.equal(pdfFontFor("Courier New"), "courier");
  assert.equal(pdfFontFor("Consolas"), "courier");
  assert.equal(pdfFontFor(undefined), "helvetica");
});

test("export back is offered for Word always and for PDF when its formatting was read", () => {
  assert.deepEqual(exportBackFormats({ format: "docx", hasStyle: false }), ["docx"]);
  assert.deepEqual(exportBackFormats({ format: "pdf", hasStyle: true }), ["pdf"]);
  assert.deepEqual(exportBackFormats({ format: "pdf", hasStyle: false }), []);
  assert.deepEqual(exportBackFormats({ format: "txt", hasStyle: false }), []);
  assert.equal(downloadName("Lease: Unit 4/B", "docx"), "Lease- Unit 4-B.docx");
  assert.equal(downloadName("   ", "pdf"), "Untitled.pdf");
});
