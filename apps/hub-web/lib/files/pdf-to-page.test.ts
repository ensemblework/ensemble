import assert from "node:assert/strict";
import test from "node:test";
import type { PageNode } from "@ensemble/shared-types";
import { cleanFontName, colorItems, convertPdfText, dropRepeats, itemsToLines, textColors, type PdfPageText, type PdfTextItem } from "./pdf-to-page.js";

const BODY = "ABCDEF+TimesNewRomanPSMT";
const BOLD = "ABCDEF+TimesNewRomanPS-BoldMT";
const HEAD = "GHIJKL+Arial-BoldMT";

/** One line of text; `width` is a rough 0.5em per character. */
function line(text: string, y: number, options: Partial<PdfTextItem> = {}): PdfTextItem {
  const size = options.size ?? 11;
  return { str: text, x: 72, y, width: text.length * size * 0.5, size, font: BODY, color: "#000000", ...options };
}

function words(node: PageNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(words).join(node.type === "bulletList" || node.type === "orderedList" ? " | " : "");
}

function report(): PdfPageText[] {
  const header = (y = 770) => line("ACME Confidential", y, { size: 9, color: "#666666" });
  const first: PdfTextItem[] = [
    header(),
    line("Annual Report", 720, { size: 24, font: HEAD, bold: true, color: "#1f3864" }),
    line("Overview", 690, { size: 16, font: HEAD, bold: true, color: "#2f5496" }),
    line("This is the first paragraph that wraps across the whole width of the", 660),
    line("page and ends here.", 646.8),
    line("Second paragraph starts here and keeps going until the hyphen-", 633.6),
    line("ated word ends on the next line with a", 620.4),
    { ...line("bold", 620.4, { bold: true, font: BOLD }), x: 72 + 38 * 5.5 + 3 },
    { ...line("word.", 620.4), x: 72 + 38 * 5.5 + 3 + 4 * 5.5 + 3 },
    line("• First item", 596),
    line("• Second item that wraps", 582.8),
    { ...line("onto another line", 569.6), x: 84 },
    line("1. Step one", 548),
    line("2. Step two", 534.8),
    line("Key terms", 510, { bold: true, font: BOLD }),
    line("A short closing paragraph that does not end its sentence on this", 490),
    line("1", 40, { size: 9 }),
  ];
  const second: PdfTextItem[] = [header(), line("page, so it carries on over the page break.", 720), line("2", 40, { size: 9 })];
  const third: PdfTextItem[] = [header(), line("Overview", 720, { size: 16, font: HEAD, bold: true, color: "#2f5496" }), line("Last words.", 700), line("Page 3 of 3", 40, { size: 9 })];
  return [first, second, third].map((items, index) => ({ page: index + 1, width: 612, height: 792, items }));
}

test("items on one baseline become a line, with a space where the gap is wide and runs keeping bold", () => {
  const lines = itemsToLines(
    [
      { str: "Hello", x: 72, y: 700, width: 25, size: 10, font: BODY },
      { str: "world", x: 100, y: 700.2, width: 25, size: 10, font: BOLD, bold: true },
      { str: "Next", x: 72, y: 686, width: 20, size: 10, font: BODY },
    ],
    1,
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.text, "Hello world");
  assert.deepEqual(lines[0]!.runs, [{ text: "Hello " }, { text: "world", bold: true }]);
  assert.equal(lines[0]!.bold, false);
  assert.equal(lines[1]!.text, "Next");
});

test("running headers and page numbers are dropped", () => {
  const pages = report().map((page) => ({ height: page.height, lines: itemsToLines(page.items, page.page) }));
  const kept = dropRepeats(pages).flat().map((entry) => entry.text);
  assert.ok(!kept.includes("ACME Confidential"));
  assert.ok(!kept.includes("1") && !kept.includes("2") && !kept.includes("Page 3 of 3"));
  assert.ok(kept.includes("Overview"), "a heading that repeats in the body is kept");
});

test("lines become headings by size, paragraphs by spacing, and lists by their markers", () => {
  const { content } = convertPdfText(report());
  const nodes = content.content;
  assert.deepEqual(
    nodes.map((node) => [node.type, node.attrs?.level ?? null]),
    [
      ["heading", 1],
      ["heading", 2],
      ["paragraph", null],
      ["paragraph", null],
      ["bulletList", null],
      ["orderedList", null],
      ["heading", 3],
      ["paragraph", null],
      ["heading", 2],
      ["paragraph", null],
    ],
  );
  assert.equal(words(nodes[0]), "Annual Report");
  assert.equal(words(nodes[2]), "This is the first paragraph that wraps across the whole width of the page and ends here.");
  assert.equal(words(nodes[3]), "Second paragraph starts here and keeps going until the hyphenated word ends on the next line with a bold word.");
  const bold = nodes[3]!.content!.find((node) => node.marks?.some((mark) => mark.type === "bold"));
  assert.equal(bold?.text, "bold");
  assert.equal(words(nodes[4]), "First item | Second item that wraps onto another line");
  assert.equal(words(nodes[5]), "Step one | Step two");
  assert.equal(words(nodes[7]), "A short closing paragraph that does not end its sentence on this page, so it carries on over the page break.");
  assert.ok(!nodes[0]!.content!.some((node) => node.marks), "headings carry no bold marks of their own");
});

test("the formatting to keep: page size, margins, body font and heading sizes and colours", () => {
  const { style } = convertPdfText(report());
  assert.equal(style.source, "pdf");
  assert.deepEqual(style.page && { width: style.page.width, height: style.page.height }, { width: 612, height: 792 });
  assert.equal(style.page?.margins.left, 72);
  assert.ok(style.page && style.page.margins.top >= 50 && style.page.margins.top <= 60, `top margin ${style.page?.margins.top}`);
  assert.deepEqual(style.body, { font: "Times New Roman", size: 11, color: "#000000", lineHeight: 1.2 });
  assert.deepEqual(style.headings?.["1"], { font: "Arial", size: 24, color: "#1f3864", bold: true });
  assert.equal(style.headings?.["2"]?.color, "#2f5496");
  assert.equal(style.headings?.["3"]?.size, 11);
});

test("an ordered list keeps a start number other than one", () => {
  const { content } = convertPdfText([{ page: 1, width: 612, height: 792, items: [line("Intro text here.", 700), line("3. Third", 680), line("4. Fourth", 666.8)] }]);
  const list = content.content.find((node) => node.type === "orderedList");
  assert.deepEqual(list?.attrs, { start: 3 });
});

test("fill colours from the operator list follow save and restore and match text by font", () => {
  const OPS = { setFillRGBColor: 1, setFont: 2, showText: 3, showSpacedText: 4, nextLineShowText: 5, nextLineSetSpacingShowText: 6, save: 7, restore: 8 };
  const glyphs = (text: string) => [...text].map((unicode) => ({ unicode }));
  const drawn = textColors(
    [OPS.setFont, OPS.save, OPS.setFillRGBColor, OPS.showText, OPS.restore, OPS.showSpacedText, OPS.setFont, OPS.setFillRGBColor, OPS.showText],
    [["g_d0_f1", 1], [], ["#C00000"], [glyphs("Warning")], [], [[...glyphs("Plain"), -120, ...glyphs(" text")]], ["g_d0_f2", 1], [255, 0, 0], [glyphs("Bold red")]],
    OPS,
  );
  assert.deepEqual(drawn, [
    { font: "g_d0_f1", color: "#c00000", text: "Warning" },
    { font: "g_d0_f1", color: "#000000", text: "Plain text" },
    { font: "g_d0_f2", color: "#ff0000", text: "Bold red" },
  ]);
  const items: Array<{ str: string; font: string; color?: string }> = [
    { str: "Warning", font: "g_d0_f1" },
    { str: "Plain text", font: "g_d0_f1" },
    { str: "Unmatched", font: "g_d0_f2" },
  ];
  colorItems(items, drawn);
  assert.deepEqual(items.map((item) => item.color), ["#c00000", "#000000", "#ff0000"]);
});

test("font names lose subset prefixes and style suffixes", () => {
  assert.equal(cleanFontName("ABCDEF+TimesNewRomanPS-BoldMT"), "Times New Roman");
  assert.equal(cleanFontName("Arial-BoldMT"), "Arial");
  assert.equal(cleanFontName("BCDEEE+Calibri-Bold"), "Calibri");
  assert.equal(cleanFontName("HelveticaNeue-Light"), "Helvetica Neue");
  assert.equal(cleanFontName("CourierNewPSMT"), "Courier New");
  assert.equal(cleanFontName("Georgia,Italic"), "Georgia");
  assert.equal(cleanFontName("sans-serif"), "sans-serif");
});
