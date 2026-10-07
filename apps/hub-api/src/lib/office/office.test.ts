/**
 * Office round trips: what Ensemble writes (docx, xlsx, pptx) reads back as the
 * same text, and the Markdown reader keeps the structure the writers rely on.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { markdownToDocx } from "./docx.js";
import { docxText, docxXmlToText, officeKind, officeText, pptxSlides, slidesToText } from "./extract.js";
import { markdownToHtml } from "./html.js";
import { markdownToPlain, outline, parseInline, parseMarkdown, wordCount } from "./markdown.js";
import { slidesToPptx } from "./pptx.js";
import { clip, htmlToText } from "./text.js";
import { rowsToCsv, rowsToXlsx, safeSheetName, xlsxToRows } from "./xlsx.js";

const PLAN = [
  "# Launch plan",
  "",
  "Intro with **bold**, *italic*, a [link](https://fieldnote.example/brief) and `code`.",
  "",
  "## Steps",
  "",
  "- Draft the brief",
  "  - Ask Sam for numbers",
  "- Book the room",
  "",
  "1. First",
  "2. Second",
  "",
  "| Name | Owner |",
  "| --- | --- |",
  "| Brief | Mira |",
  "",
  "> Keep it short.",
].join("\n");

test("the Markdown reader keeps headings, nested lists, tables and inline styles", () => {
  const blocks = parseMarkdown(PLAN);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "paragraph", "heading", "list", "list", "table", "quote"],
  );
  const list = blocks[3];
  assert.ok(list?.kind === "list");
  assert.deepEqual(list.items.map((item) => item.depth), [0, 1, 0]);
  const inline = parseInline("a **b** *c* [d](https://e.example) [x](javascript:alert(1)) `f`");
  assert.ok(inline.some((piece) => piece.text === "b" && piece.bold));
  assert.ok(inline.some((piece) => piece.text === "c" && piece.italic));
  assert.ok(inline.some((piece) => piece.text === "d" && piece.link === "https://e.example"));
  assert.ok(!inline.some((piece) => piece.link?.startsWith("javascript")), "only http(s) and mailto links become links");
  assert.ok(inline.some((piece) => piece.text === "f" && piece.code));
  assert.equal(parseInline("snake_case_name stays")[0]?.text, "snake_case_name stays");
  assert.deepEqual(outline(PLAN), ["Launch plan", "  Steps"]);
  assert.ok(wordCount(PLAN) > 15);
  assert.match(markdownToPlain(PLAN), /Brief \| Mira/);
});

test("Markdown becomes HTML Google Docs can import, with unsafe text escaped", () => {
  const html = markdownToHtml(`${PLAN}\n\n<script>alert(1)</script>`, "Plan <1>");
  assert.match(html, /<title>Plan &lt;1&gt;<\/title>/);
  assert.match(html, /<h1>Launch plan<\/h1>/);
  assert.match(html, /<ul><li>Draft the brief<ul><li>Ask Sam for numbers<\/li><\/ul><\/li><li>Book the room<\/li><\/ul>/);
  assert.match(html, /<ol><li>First<\/li><li>Second<\/li><\/ol>/);
  assert.match(html, /<th>Name<\/th>/);
  assert.match(html, /<a href="https:\/\/fieldnote.example\/brief">link<\/a>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.doesNotMatch(html, /<script>/);
});

test("a .docx made from Markdown reads back with its structure", async () => {
  const bytes = await markdownToDocx(PLAN, "Launch plan");
  assert.equal(officeKind("Plan.docx"), "docx");
  const text = docxText(bytes);
  assert.match(text, /^# Launch plan$/m);
  assert.match(text, /^## Steps$/m);
  assert.match(text, /^- Draft the brief$/m);
  assert.match(text, /^ {2}- Ask Sam for numbers$/m);
  assert.match(text, /^\| Brief \| Mira \|$/m);
  assert.match(text, /Intro with bold, italic, a link and code\./);
  const xml = strFromU8(unzipSync(bytes)["word/document.xml"]!);
  assert.match(xml, /w:hyperlink/);
  assert.match(xml, /Heading1/);
  assert.equal(docxXmlToText('<w:p><w:r><w:t>a &amp; b</w:t></w:r></w:p>'), "a & b");
});

test("rows go into an .xlsx and come back out, formulas included", async () => {
  const bytes = await rowsToXlsx(
    [
      { name: "Budget", headers: ["Item", "Cost"], rows: [["Venue", 1200], ["Food", 300.5], ["Total", "=SUM(B2:B3)"]] },
      { name: "Notes/2026", rows: [["ok", true, null, "x"]] },
    ],
    "Budget",
  );
  const sheets = await xlsxToRows(bytes);
  assert.deepEqual(sheets[0], { name: "Budget", rows: [["Item", "Cost"], ["Venue", 1200], ["Food", 300.5], ["Total", "=SUM(B2:B3)"]] });
  assert.equal(sheets[1]?.name, "Notes 2026");
  assert.deepEqual(sheets[1]?.rows, [["ok", true, null, "x"]]);
  assert.match(await officeText("xlsx", bytes), /## Budget\nItem,Cost\nVenue,1200/);
  assert.equal(rowsToCsv([["a,b", 'say "hi"', null]]), '"a,b","say ""hi""",');
  const taken = new Set<string>();
  assert.equal(safeSheetName("Q4: plan", 0, taken), "Q4  plan");
  assert.equal(safeSheetName("q4  PLAN", 1, taken), "q4  PLAN (2)");
  assert.equal(safeSheetName("", 2, taken), "Sheet3");
});

test("a .pptx made from slide specs reads back titles, bullets and speaker notes in order", async () => {
  const bytes = await slidesToPptx({
    title: "Q4 review",
    subtitle: "Fieldnote",
    slides: [
      { title: "Wins", bullets: ["Shipped **imports**", "  Notion and Linear"], notes: "Mention Sam" },
      { title: "Next", bullets: ["Calendar invites"] },
    ],
  });
  const slides = pptxSlides(bytes);
  assert.deepEqual(
    slides.map((slide) => [slide.title, slide.body, slide.notes]),
    [
      ["Q4 review", ["Fieldnote"], ""],
      ["Wins", ["Shipped imports", "  Notion and Linear"], "Mention Sam"],
      ["Next", ["Calendar invites"], ""],
    ],
  );
  const text = slidesToText(slides);
  assert.match(text, /## Slide 2: Wins\n- Shipped imports\n {2}- Notion and Linear\nNotes: Mention Sam/);
});

test("HTML mail becomes plain text and long text is read in windows", () => {
  assert.equal(htmlToText("<p>Hi&nbsp;Mira,</p><ul><li>One</li><li>Two &amp; three</li></ul><style>x{}</style>"), "Hi Mira,\n\n- One\n- Two & three");
  const long = Array.from({ length: 200 }, (_unused, index) => `line ${index}`).join("\n");
  const first = clip(long, 0, 100);
  assert.ok(first.text.endsWith("\n"));
  assert.equal(first.offset, 0);
  assert.ok(first.nextOffset && first.nextOffset <= 100);
  const next = clip(long, first.nextOffset!, 100);
  assert.equal(long.startsWith(first.text + next.text), true);
  assert.equal(clip("short", 0, 100).nextOffset, undefined);
});
