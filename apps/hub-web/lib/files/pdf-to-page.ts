/**
 * A PDF becomes a page: pdf.js reads each page's text, the pure functions here turn
 * positioned text into lines, paragraphs, headings and lists, and read the formatting
 * (page size, margins, fonts, sizes, colours) a page needs to be exported back.
 */
import type { FileStyleProfile, PageDocument, PageNode } from "@ensemble/shared-types";

export type PdfTextItem = {
  str: string;
  /** Baseline position in PDF points, y up from the bottom of the page. */
  x: number;
  y: number;
  width: number;
  size: number;
  font: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
};

export type PdfRun = { text: string; bold?: boolean; italic?: boolean };

export type PdfLine = {
  page: number;
  x: number;
  y: number;
  right: number;
  size: number;
  text: string;
  runs: PdfRun[];
  /** Every visible character is bold. */
  bold: boolean;
  font: string;
  color?: string;
};

export type PdfPageText = { page: number; width: number; height: number; items: PdfTextItem[] };

const round = (value: number, step = 0.5) => Math.round(value / step) * step;

function mode<T>(entries: Array<[T, number]>): T | undefined {
  const totals = new Map<T, number>();
  for (const [key, weight] of entries) totals.set(key, (totals.get(key) ?? 0) + weight);
  let best: T | undefined;
  let bestWeight = -1;
  for (const [key, weight] of totals) {
    if (weight > bestWeight) {
      best = key;
      bestWeight = weight;
    }
  }
  return best;
}

/** Text items in reading order become lines: same baseline, moving right. */
export function itemsToLines(items: PdfTextItem[], page: number): PdfLine[] {
  const lines: PdfLine[] = [];
  let current: (PdfLine & { weights: Array<[string, number]>; colors: Array<[string, number]> }) | null = null;
  const finish = () => {
    if (!current) return;
    const text = current.runs.map((run) => run.text).join("").replace(/\s+/g, " ").trim();
    if (text) {
      const visible = current.runs.filter((run) => run.text.trim());
      lines.push({
        page,
        x: current.x,
        y: current.y,
        right: current.right,
        size: current.size,
        text,
        runs: current.runs,
        bold: visible.length > 0 && visible.every((run) => run.bold),
        font: mode(current.weights) ?? current.font,
        ...(current.colors.length ? { color: mode(current.colors) } : {}),
      });
    }
    current = null;
  };
  for (const item of items) {
    if (!item.str) continue;
    const size = item.size > 0 ? item.size : 10;
    const sameLine = current && Math.abs(current.y - item.y) <= Math.max(current.size, size) * 0.45 && item.x >= current.right - Math.max(current.size, size) * 0.6;
    if (!sameLine) {
      finish();
      current = { page, x: item.x, y: item.y, right: item.x + item.width, size, text: "", runs: [], bold: false, font: item.font, weights: [], colors: [] };
    }
    const line = current!;
    const gap = item.x - line.right;
    const previous = line.runs.at(-1);
    const text = item.str;
    if (previous && gap > size * 0.12 && !/\s$/.test(previous.text) && !/^\s/.test(text)) previous.text += " ";
    if (previous && Boolean(previous.bold) === Boolean(item.bold) && Boolean(previous.italic) === Boolean(item.italic)) previous.text += text;
    else line.runs.push({ text, ...(item.bold ? { bold: true } : {}), ...(item.italic ? { italic: true } : {}) });
    line.right = Math.max(line.right, item.x + item.width);
    if (item.str.trim()) {
      line.size = Math.max(line.size, size);
      line.weights.push([item.font, item.str.length]);
      if (item.color) line.colors.push([item.color, item.str.length]);
    }
  }
  finish();
  return lines;
}

const PAGE_NUMBER = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i;

/** Drops running headers, footers and page numbers: the same text near the top or bottom of most pages. */
export function dropRepeats(pages: Array<{ height: number; lines: PdfLine[] }>): PdfLine[][] {
  const edge = (line: PdfLine, height: number) => line.y > height * 0.88 || line.y < height * 0.12;
  const key = (line: PdfLine) => line.text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const seen = new Map<string, Set<number>>();
  pages.forEach(({ height, lines }, index) => {
    for (const line of lines) {
      if (!edge(line, height)) continue;
      const k = key(line);
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k)!.add(index);
    }
  });
  const enough = Math.max(3, Math.ceil(pages.length * 0.5));
  return pages.map(({ height, lines }) =>
    lines.filter((line) => {
      if (!edge(line, height)) return true;
      if (PAGE_NUMBER.test(line.text.trim())) return false;
      return pages.length < 3 || (seen.get(key(line))?.size ?? 0) < enough;
    }),
  );
}

const BULLET = /^\s*([•●○◦▪■□▫‣⁃∙·➢►▶✓✔❖\u{F000}-\u{F0FF}]|[-–—*](?=\s))\s*/u;
const NUMBERED = /^\s*(\(?(\d{1,3}|[a-zA-Z]|[ivxIVX]{1,4})[.)])\s+/;

function listMarker(text: string): { ordered: boolean; length: number; start?: number } | null {
  const bullet = BULLET.exec(text);
  if (bullet && text.length > bullet[0].length) return { ordered: false, length: bullet[0].length };
  const numbered = NUMBERED.exec(text);
  if (numbered && text.length > numbered[0].length) {
    const value = Number(numbered[2]);
    return { ordered: true, length: numbered[0].length, ...(Number.isFinite(value) ? { start: value } : {}) };
  }
  return null;
}

function dropChars(runs: PdfRun[], count: number): PdfRun[] {
  let left = count;
  const out: PdfRun[] = [];
  for (const run of runs) {
    if (left >= run.text.length) {
      left -= run.text.length;
      continue;
    }
    out.push({ ...run, text: run.text.slice(left) });
    left = 0;
  }
  return out;
}

function stripLeading(runs: PdfRun[], text: string, markerLength: number): PdfRun[] {
  // Run text can carry spaces the line text collapsed, so count from the raw runs.
  const raw = runs.map((run) => run.text).join("");
  const leading = raw.length - raw.trimStart().length;
  const marker = text.slice(0, markerLength).trimEnd();
  const at = raw.indexOf(marker, leading);
  const end = at >= 0 ? at + marker.length : leading + markerLength;
  const rest = dropChars(runs, end);
  const restText = rest.map((run) => run.text).join("");
  return dropChars(rest, restText.length - restText.trimStart().length);
}

function joinRuns(into: PdfRun[], next: PdfRun[]): void {
  const last = into.at(-1);
  const head = next[0];
  if (!last || !head) {
    into.push(...next);
    return;
  }
  const hyphen = /[A-Za-z]-$/.test(last.text.trimEnd()) && /^[a-z]/.test(head.text.trimStart());
  if (hyphen) last.text = last.text.trimEnd().slice(0, -1);
  else if (!/\s$/.test(last.text)) last.text += " ";
  if (hyphen) next = [{ ...head, text: head.text.trimStart() }, ...next.slice(1)];
  into.push(...next);
}

/** Spaces at the edge of a bold or italic run move outside it, so marks cover words only. */
function trimMarks(runs: PdfRun[]): PdfRun[] {
  const out = runs.map((run) => ({ ...run }));
  for (let index = 0; index < out.length; index += 1) {
    const run = out[index]!;
    if (!run.bold && !run.italic) continue;
    const lead = /^\s+/.exec(run.text)?.[0] ?? "";
    const trail = /\s+$/.exec(run.text)?.[0] ?? "";
    if (!lead && !trail) continue;
    run.text = run.text.trim();
    if (lead) out.splice(index, 0, { text: lead });
    if (trail) out.splice(index + (lead ? 2 : 1), 0, { text: trail });
    index += (lead ? 1 : 0) + (trail ? 1 : 0);
  }
  return out;
}

function textNodes(runs: PdfRun[], plain = false): PageNode[] {
  const merged: PdfRun[] = [];
  for (const run of trimMarks(runs)) {
    const text = run.text.replace(/\u00AD/g, "").replace(/\s+/g, " ");
    const bold = !plain && Boolean(run.bold);
    const italic = Boolean(run.italic);
    const last = merged.at(-1);
    if (last && Boolean(last.bold) === bold && Boolean(last.italic) === italic) last.text += text;
    else merged.push({ text, bold, italic });
  }
  if (merged.length) {
    merged[0]!.text = merged[0]!.text.trimStart();
    merged[merged.length - 1]!.text = merged[merged.length - 1]!.text.trimEnd();
  }
  for (let index = 1; index < merged.length; index += 1) {
    if (merged[index - 1]!.text.endsWith(" ") && merged[index]!.text.startsWith(" ")) merged[index]!.text = merged[index]!.text.trimStart();
  }
  return merged
    .filter((run) => run.text)
    .map((run) => {
      const marks = [...(run.bold ? [{ type: "bold" }] : []), ...(run.italic ? [{ type: "italic" }] : [])];
      return { type: "text", text: run.text, ...(marks.length ? { marks } : {}) };
    });
}

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; runs: PdfRun[]; lines: PdfLine[] }
  | { kind: "paragraph"; runs: PdfRun[]; lines: PdfLine[]; left: number; right: number }
  | { kind: "list"; ordered: boolean; start?: number; items: Array<{ runs: PdfRun[]; textX: number }>; lines: PdfLine[] };

export type PdfConversion = { content: PageDocument; style: FileStyleProfile; characters: number };

/** Lines from every page become a page document, with the formatting read from the original. */
export function convertPdfText(pages: PdfPageText[]): PdfConversion {
  const raw = pages.map((page) => ({ height: page.height, lines: itemsToLines(page.items, page.page) }));
  const kept = dropRepeats(raw);
  const all = kept.flat();
  const characters = all.reduce((sum, line) => sum + line.text.length, 0);
  const body = mode(all.map((line) => [round(line.size), line.text.length] as [number, number])) ?? 11;

  // Line spacing is the most common gap between plain body lines; paragraph and heading gaps are rarer.
  const gaps: Array<[number, number]> = [];
  const plain = (line: PdfLine) => Math.abs(round(line.size) - body) <= 0.6 && !line.bold && !listMarker(line.text);
  for (const lines of kept) {
    for (let index = 1; index < lines.length; index += 1) {
      const a = lines[index - 1]!;
      const b = lines[index]!;
      if (!plain(a) || !plain(b)) continue;
      const gap = a.y - b.y;
      if (gap > body * 0.8 && gap < body * 3) gaps.push([round(gap, 0.1), 1 + 1e-6 / gap]);
    }
  }
  const leading = mode(gaps) ?? body * 1.2;
  const leadingFor = (size: number) => (leading / body) * size;

  const larger = [...new Set(all.filter((line) => round(line.size) > body * 1.12 && line.text.length < 160).map((line) => round(line.size)))].sort((a, b) => b - a);
  const shift = larger.length && larger[0]! / body < 1.4 ? 1 : 0;
  const levelOf = (line: PdfLine): 0 | 1 | 2 | 3 => {
    const size = round(line.size);
    const rank = larger.indexOf(size);
    if (rank >= 0) return Math.min(3, rank + 1 + shift) as 1 | 2 | 3;
    if (line.bold && Math.abs(size - body) <= 0.6 && line.text.length <= 90 && !/[.,;]$/.test(line.text) && !listMarker(line.text)) return 3;
    return 0;
  };

  const blocks: Block[] = [];
  const levels = new Map<PdfLine, number>();
  for (const line of all) {
    const last = blocks.at(-1);
    const prev = last?.lines.at(-1);
    const samePage = prev ? prev.page === line.page : false;
    const gap = prev && samePage ? prev.y - line.y : Number.POSITIVE_INFINITY;
    const level = levelOf(line);
    levels.set(line, level);
    if (level) {
      if (last?.kind === "heading" && last.level === level && samePage && gap > 0 && gap <= line.size * 1.7 && last.lines.length < 3) {
        joinRuns(last.runs, line.runs);
        last.lines.push(line);
      } else blocks.push({ kind: "heading", level, runs: [...line.runs.map((run) => ({ ...run }))], lines: [line] });
      continue;
    }
    const marker = listMarker(line.text);
    if (marker) {
      const runs = stripLeading(line.runs.map((run) => ({ ...run })), line.text, marker.length);
      const textX = line.x + (line.right - line.x) * (marker.length / Math.max(1, line.text.length));
      const close = !samePage || (gap > 0 && gap <= leadingFor(line.size) * 2.2);
      if (last?.kind === "list" && last.ordered === marker.ordered && close) {
        last.items.push({ runs, textX });
        last.lines.push(line);
      } else blocks.push({ kind: "list", ordered: marker.ordered, ...(marker.ordered && marker.start !== undefined ? { start: marker.start } : {}), items: [{ runs, textX }], lines: [line] });
      continue;
    }
    if (last?.kind === "list" && prev) {
      const item = last.items.at(-1)!;
      if (samePage && gap > 0 && gap <= leadingFor(line.size) * 1.5 && line.x >= item.textX - line.size * 0.8) {
        joinRuns(item.runs, line.runs.map((run) => ({ ...run })));
        last.lines.push(line);
        continue;
      }
    }
    if (last?.kind === "paragraph" && prev) {
      const sizeMatch = Math.abs(round(line.size) - round(prev.size)) <= 0.6;
      let continues: boolean;
      if (!samePage) {
        continues = sizeMatch && !/[.!?:;"”)]$/.test(prev.text) && (/^[a-z(]/.test(line.text) || /[,-]$/.test(prev.text));
      } else {
        const endedShort = prev.right < last.right - line.size * 5 && /[.!?:]["”’)]?$/.test(prev.text);
        continues = sizeMatch && gap > 0 && gap <= leadingFor(line.size) * 1.45 && line.x - last.left <= line.size * 1.2 && !endedShort;
      }
      if (continues) {
        joinRuns(last.runs, line.runs.map((run) => ({ ...run })));
        last.lines.push(line);
        last.left = Math.min(last.left, line.x);
        last.right = Math.max(last.right, line.right);
        continue;
      }
    }
    blocks.push({ kind: "paragraph", runs: line.runs.map((run) => ({ ...run })), lines: [line], left: line.x, right: line.right });
  }

  const content: PageNode[] = [];
  for (const block of blocks) {
    if (block.kind === "heading") {
      const nodes = textNodes(block.runs, true);
      if (nodes.length) content.push({ type: "heading", attrs: { level: block.level }, content: nodes });
    } else if (block.kind === "paragraph") {
      const nodes = textNodes(block.runs);
      if (nodes.length) content.push({ type: "paragraph", content: nodes });
    } else {
      const items = block.items
        .map((item) => textNodes(item.runs))
        .filter((nodes) => nodes.length)
        .map((nodes) => ({ type: "listItem", content: [{ type: "paragraph", content: nodes }] }));
      if (!items.length) continue;
      content.push({
        type: block.ordered ? "orderedList" : "bulletList",
        ...(block.ordered && block.start !== undefined && block.start !== 1 ? { attrs: { start: block.start } } : {}),
        content: items,
      });
    }
  }

  return {
    content: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] },
    style: styleProfile(pages, kept, levels, body, leading),
    characters,
  };
}

/** "ABCDEF+TimesNewRomanPS-BoldMT" → "Times New Roman". */
export function cleanFontName(raw: string): string {
  if (/^(serif|sans-serif|monospace)$/i.test(raw)) return raw;
  let name = raw.replace(/^[A-Z]{6}\+/, "").split(/[-,]/)[0] || raw;
  name = name.replace(/(PSMT|PS|MT)$/, "").replace(/(?<=[a-z])(BoldItalic|BoldOblique|Bold|Italic|Oblique|Regular|Medium|Light|Semibold)$/, "");
  name = name.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return name || raw;
}

function styleProfile(pages: PdfPageText[], kept: PdfLine[][], levels: Map<PdfLine, number>, body: number, leading: number): FileStyleProfile {
  const first = pages[0];
  const profile: FileStyleProfile = { source: "pdf" };
  if (first) {
    const sample = kept.slice(0, 3).flat();
    const clamp = (value: number) => Math.round(Math.min(144, Math.max(18, value)));
    const margins = { top: 72, right: 72, bottom: 72, left: 72 };
    if (sample.length) {
      const sized = (index: number) => pages[index] ?? first;
      margins.left = clamp(Math.min(...sample.map((line) => line.x)));
      margins.right = clamp(Math.min(...sample.map((line) => sized(line.page - 1).width - line.right)));
      margins.top = clamp(Math.min(...sample.map((line) => sized(line.page - 1).height - (line.y + line.size * 0.8))));
      margins.bottom = clamp(Math.min(...sample.map((line) => line.y - line.size * 0.25)));
      // Short lines and short pages leave the right and bottom looking wider than they are; most documents are symmetric.
      if (margins.right > margins.left * 1.5) margins.right = margins.left;
      if (margins.bottom > margins.top * 1.5) margins.bottom = margins.top;
    }
    profile.page = { width: Math.round(first.width), height: Math.round(first.height), margins };
  }
  const lines = kept.flat();
  const bodyLines = lines.filter((line) => !levels.get(line) && Math.abs(round(line.size) - body) <= 0.6);
  const fontOf = (group: PdfLine[]) => mode(group.map((line) => [cleanFontName(line.font), line.text.length] as [string, number]));
  const colorOf = (group: PdfLine[]) => mode(group.filter((line) => line.color).map((line) => [line.color!, line.text.length] as [string, number])) ?? "#000000";
  if (bodyLines.length) {
    profile.body = {
      font: fontOf(bodyLines) ?? "Helvetica",
      size: body,
      color: colorOf(bodyLines),
      lineHeight: Math.round(Math.min(2.5, Math.max(1, leading / body)) * 100) / 100,
    };
  }
  const headings: NonNullable<FileStyleProfile["headings"]> = {};
  for (const level of [1, 2, 3] as const) {
    const group = lines.filter((line) => levels.get(line) === level);
    if (!group.length) continue;
    const weight = group.reduce((sum, line) => sum + line.text.length, 0) || 1;
    headings[String(level) as "1" | "2" | "3"] = {
      font: fontOf(group),
      size: round(group.reduce((sum, line) => sum + line.size * line.text.length, 0) / weight),
      color: colorOf(group),
      bold: group.filter((line) => line.bold).length * 2 >= group.length,
    };
  }
  if (Object.keys(headings).length) profile.headings = headings;
  return profile;
}

/** Fill colour and font in effect for each text-showing operator, from pdf.js's operator list. */
export function textColors(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  ops: { setFillRGBColor: number; setFont: number; showText: number; showSpacedText: number; nextLineShowText: number; nextLineSetSpacingShowText: number; save: number; restore: number },
): Array<{ font: string; color: string; text: string }> {
  const out: Array<{ font: string; color: string; text: string }> = [];
  const stack: Array<{ color: string; font: string }> = [];
  let color = "#000000";
  let font = "";
  const glyphText = (glyphs: unknown) =>
    Array.isArray(glyphs) ? glyphs.map((glyph) => (glyph && typeof glyph === "object" && "unicode" in glyph ? String((glyph as { unicode: unknown }).unicode ?? "") : "")).join("") : "";
  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    const args = argsArray[index] as unknown[] | null;
    if (fn === ops.save) stack.push({ color, font });
    else if (fn === ops.restore) ({ color, font } = stack.pop() ?? { color, font });
    else if (fn === ops.setFillRGBColor) {
      const value = args?.[0];
      if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) color = value.toLowerCase();
      else if (args && args.length >= 3 && args.slice(0, 3).every((part) => typeof part === "number")) {
        color = `#${(args.slice(0, 3) as number[]).map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")}`;
      }
    } else if (fn === ops.setFont) font = String(args?.[0] ?? "");
    else if (fn === ops.showText || fn === ops.showSpacedText || fn === ops.nextLineShowText || fn === ops.nextLineSetSpacingShowText) {
      const glyphs = fn === ops.nextLineSetSpacingShowText ? args?.[2] : args?.[0];
      out.push({ font, color, text: glyphText(glyphs) });
    }
  }
  return out;
}

/** Gives each text item the colour it was drawn in: matched by font and text in drawing order, else the font's usual colour. */
export function colorItems(items: Array<{ str: string; font: string; color?: string }>, drawn: Array<{ font: string; color: string; text: string }>): void {
  const usual = new Map<string, string>();
  const byFont = new Map<string, Array<[string, number]>>();
  for (const entry of drawn) {
    if (!byFont.has(entry.font)) byFont.set(entry.font, []);
    byFont.get(entry.font)!.push([entry.color, Math.max(1, entry.text.length)]);
  }
  for (const [font, entries] of byFont) usual.set(font, mode(entries) ?? "#000000");
  let pointer = 0;
  for (const item of items) {
    const key = item.str.replace(/\s+/g, "").slice(0, 12);
    if (!key) continue;
    let found = -1;
    for (let index = pointer; index < Math.min(drawn.length, pointer + 60); index += 1) {
      const entry = drawn[index]!;
      if (entry.font === item.font && entry.text.replace(/\s+/g, "").includes(key)) {
        found = index;
        break;
      }
    }
    if (found >= 0) {
      item.color = drawn[found]!.color;
      pointer = found;
    } else if (usual.has(item.font)) item.color = usual.get(item.font);
  }
}

const BOLD = /bold|black|heavy|semibold|demibold|demi\b/i;
const ITALIC = /italic|oblique/i;
/** Operator lists are only read this far in: enough to learn the fonts and colours, without decoding every image in a long scan. */
const OPERATOR_PAGES = 40;

export const SCANNED_PDF = "This PDF looks like scanned pages, so there is no text to make a page from. Run it through a text-recognition (OCR) app, then upload it again.";

/** Reads a PDF in the browser and returns page content and the original's formatting. */
export async function pdfToPage(bytes: ArrayBuffer, onProgress?: (done: number, total: number) => void): Promise<PdfConversion> {
  const { loadPdfjs } = await import("./pdfjs");
  const { pdfjs, worker } = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), fontExtraProperties: true, worker });
  const doc = await task.promise;
  try {
    const pages: PdfPageText[] = [];
    const fonts = new Map<string, { name?: string; bold?: boolean; italic?: boolean }>();
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      let drawn: Array<{ font: string; color: string; text: string }> = [];
      if (number <= OPERATOR_PAGES) {
        const list = await page.getOperatorList();
        drawn = textColors(list.fnArray, list.argsArray, pdfjs.OPS);
      }
      const text = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const entry of text.items) {
        if (!("str" in entry) || !entry.str) continue;
        let font = fonts.get(entry.fontName);
        if (!font) {
          try {
            const loaded = page.commonObjs.has(entry.fontName) ? (page.commonObjs.get(entry.fontName) as { name?: string; bold?: boolean; italic?: boolean } | null) : null;
            if (loaded) {
              font = { name: loaded.name, bold: loaded.bold, italic: loaded.italic };
              fonts.set(entry.fontName, font);
            }
          } catch {
            // Not loaded on this page; the text style's family is the fallback.
          }
        }
        const name = font?.name ?? text.styles[entry.fontName]?.fontFamily ?? entry.fontName;
        const [a = 1, b = 0, c = 0, d = 1, x = 0, y = 0] = entry.transform as number[];
        items.push({
          str: entry.str,
          x,
          y,
          width: entry.width,
          size: Math.hypot(c, d) || Math.hypot(a, b) || entry.height,
          font: name,
          bold: Boolean(font?.bold) || BOLD.test(name),
          italic: Boolean(font?.italic) || ITALIC.test(name),
        });
      }
      if (drawn.length) {
        const keyed = text.items.filter((entry): entry is (typeof text.items)[number] & { str: string; fontName: string } => "str" in entry && Boolean(entry.str));
        const probe = keyed.map((entry) => ({ str: entry.str, font: entry.fontName, color: undefined as string | undefined }));
        colorItems(probe, drawn);
        probe.forEach((entry, index) => {
          if (entry.color && items[index]) items[index]!.color = entry.color;
        });
      }
      pages.push({ page: number, width: viewport.width, height: viewport.height, items });
      page.cleanup();
      onProgress?.(number, doc.numPages);
    }
    const result = convertPdfText(pages);
    if (result.characters < Math.max(40, doc.numPages * 20)) throw new Error(SCANNED_PDF);
    return result;
  } finally {
    void task.destroy();
  }
}
