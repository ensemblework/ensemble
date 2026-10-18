import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { blocksFromMarkdown, type Run } from "./document";
import { columnWidths, fileSlug, layoutRuns, pdfCanDraw, toDocx, toPdf, type PdfLine } from "./formats";

test("download names keep letters in any script and emoji, and drop only what file systems refuse", () => {
  assert.equal(fileSlug("नोट्स 2026"), "नोट्स-2026");
  assert.equal(fileSlug("🚀"), "🚀");
  assert.equal(fileSlug("👍🏽 Done!"), "👍🏽-done");
  assert.equal(fileSlug("日本語のメモ"), "日本語のメモ");
  assert.equal(fileSlug("Q3: plan/review? <draft> \"v2\" | final*"), "q3-plan-review-draft-v2-final");
  assert.equal(fileSlug("  "), "untitled");
  assert.equal(fileSlug("My Plan"), "my-plan");
  assert.equal(Array.from(fileSlug("😀".repeat(100))).length, 80);
});

test("a PDF is drawn here only when the built-in fonts have every character", () => {
  assert.equal(pdfCanDraw({ title: "Plan “Q3” – café", blocks: blocksFromMarkdown("- ship • now") }), true);
  assert.equal(pdfCanDraw({ title: "नोट्स", blocks: [] }), false);
  assert.equal(pdfCanDraw({ title: "Plan", blocks: blocksFromMarkdown("Launch 🚀") }), false);
  assert.equal(pdfCanDraw({ title: "Plan", meta: [["Owner", "Łukasz"]], blocks: [] }), false);
});

const near = (actual: number[], expected: number[]) => assert.ok(actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) < 1e-6), `${actual} != ${expected}`);

test("table columns fill the width, keep a floor each when crowded, and shrink together when even the floors don't fit", () => {
  near(columnWidths([100, 50, 50], [36, 36, 36], 400), [200, 100, 100]);
  near(columnWidths([400, 40, 300], [110, 40, 110], 400), [110 + (290 * 140) / 480, 40, 110 + (190 * 140) / 480]);
  near(columnWidths([200, 200, 200], [150, 150, 100], 200), [75, 75, 50]);
  near(columnWidths([0, 0], [0, 0], 100), [50, 50]);
});

// One point per character, so widths are easy to reason about.
const measure = (text: string) => text.length;
const base = { font: "helvetica" as const, size: 10, color: [0, 0, 0] as [number, number, number] };
const texts = (lines: PdfLine[]) => lines.map((line) => line.pieces.map((piece) => piece.text).join(""));

test("text wraps at spaces, cuts a word wider than the line (after a slash when it can), and breaks at newlines", () => {
  assert.deepEqual(texts(layoutRuns([{ text: "aaa bbb ccc   " }], base, 7, measure)), ["aaa bbb", "ccc"]);
  assert.deepEqual(texts(layoutRuns([{ text: "abcdefghijkl" }], base, 5, measure)), ["abcde", "fghij", "kl"]);
  assert.deepEqual(texts(layoutRuns([{ text: "ab/cdefgh" }], base, 5, measure)), ["ab/", "cdefg", "h"]);
  assert.deepEqual(texts(layoutRuns([{ text: "a" }, { text: "\n" }, { text: "b" }], base, 50, measure)), ["a", "b"]);
  assert.deepEqual(texts(layoutRuns([], base, 50, measure)), [""]);
  assert.deepEqual(texts(layoutRuns([{ text: "  x = 1" }], { ...base, font: "courier" }, 50, measure, { keepIndent: true })), ["  x = 1"]);
  assert.deepEqual(texts(layoutRuns([{ text: "  x = 1" }], base, 50, measure)), ["x = 1"]);
});

test("laid-out pieces carry bold, italic, code, strikethrough and links, merged where they look the same", () => {
  const runs: Run[] = [{ text: "plain " }, { text: "and " }, { text: "bold", bold: true }, { text: " " }, { text: "both", bold: true, italic: true }, { text: " f()", code: true }, { text: " old", strike: true }, { text: " see https://x.co/a." }, { text: " no", href: "javascript:alert(1)" }];
  const [line] = layoutRuns(runs, base, 200, measure);
  assert.deepEqual(
    line!.pieces.map(({ text, font, style, href, strike }) => ({ text, font, style, href, strike })),
    [
      { text: "plain and ", font: "helvetica", style: "normal", href: undefined, strike: undefined },
      { text: "bold", font: "helvetica", style: "bold", href: undefined, strike: undefined },
      { text: " ", font: "helvetica", style: "normal", href: undefined, strike: undefined },
      { text: "both", font: "helvetica", style: "bolditalic", href: undefined, strike: undefined },
      { text: " f()", font: "courier", style: "normal", href: undefined, strike: undefined },
      { text: " old", font: "helvetica", style: "normal", href: undefined, strike: true },
      { text: " see ", font: "helvetica", style: "normal", href: undefined, strike: undefined },
      { text: "https://x.co/a", font: "helvetica", style: "normal", href: "https://x.co/a", strike: undefined },
      { text: ". no", font: "helvetica", style: "normal", href: undefined, strike: undefined },
    ],
  );
  assert.notDeepEqual(line!.pieces[7]!.color, base.color, "links are coloured");
  assert.equal(line!.width, line!.pieces.reduce((sum, piece) => sum + piece.width, 0));
});

const papers = [
  "Name | Assign | Status | Title / DOI",
  "--- | --- | --- | ---",
  ...Array.from({ length: 40 }, (_, index) => `https://www.sciencedirect.com/science/article/pii/S2095756421000192?via%3Dihub#bib${index} | | ${["Promising", "Decent", "Relevant"][index % 3]} | IEEE document **${9681234 + index}**`),
].join("\n");

test("a PDF draws tables as a grid of cells, repeats the header on every page and keeps links clickable", async () => {
  const blob = await toPdf({ title: "Reading list", blocks: blocksFromMarkdown(`Some **bold** text.\n\n${papers}`) });
  assert.equal(blob.type, "application/pdf");
  const raw = new TextDecoder("latin1").decode(await blob.arrayBuffer());
  const pages = raw.match(/\/Type \/Page\n/g)?.length ?? 0;
  assert.ok(pages >= 2, "forty rows run onto a second page");
  assert.equal(raw.match(/\(Title \/ DOI\) Tj/g)?.length, pages, "the header row starts every page of the table");
  assert.ok(!raw.includes("|"), "no row is written as text joined by pipes");
  assert.ok(raw.includes("(9681234) Tj"), "bold text in a cell is drawn on its own in the bold font");
  assert.ok(raw.includes("/URI (https://www.sciencedirect.com/science/article/pii/S2095756421000192?via%3Dihub#bib0)"));
  assert.ok(raw.includes("/Title (Reading list)"));
});

test("a Word table has a repeating, shaded, bold header row and keeps formatting on links", async () => {
  const blob = await toDocx({ title: "Reading list", blocks: blocksFromMarkdown("| Name | Status |\n| --- | --- |\n| **[docs](https://example.com)** | *Decent* |") });
  const xml = strFromU8(unzipSync(new Uint8Array(await blob.arrayBuffer()))["word/document.xml"]!);
  assert.match(xml, /<w:trPr><w:cantSplit\/><w:tblHeader\/><\/w:trPr><w:tc><w:tcPr><w:tcW w:type="dxa" w:w="\d+"\/><w:shd w:fill="F1EDE5"[^>]*\/><\/w:tcPr><w:p><w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">Name<\/w:t>/);
  assert.match(xml, /<w:hyperlink [^>]*><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">docs<\/w:t>/);
  assert.match(xml, /<w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">Decent<\/w:t>/);
});
