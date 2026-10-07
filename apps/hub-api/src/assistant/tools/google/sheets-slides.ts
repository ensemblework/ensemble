/** Google Sheets (create, read, update, append) and Google Slides (create, read). */
import { z } from "zod";
import { safeSheetName } from "../../../lib/office/xlsx.js";
import { defineTool, toolOk, type ToolContext } from "../../types.js";
import { UNTRUSTED_NOTE, appFetch, appToken, plural, quote, whose } from "../apps-common.js";
import {
  DRIVE_FILE_HINT,
  SHEETS_API,
  SHEETS_READ,
  SHEETS_WRITE,
  SLIDES_API,
  SLIDES_READ,
  SLIDES_WRITE,
  sheetLink,
  slidesLink,
} from "./meta.js";

export const Cell = z.union([z.string().max(5000), z.number(), z.boolean(), z.null()]);
export const Rows = z.array(z.array(Cell).max(60)).max(2000);
type CellValue = z.infer<typeof Cell>;

export const a1Sheet = (name: string): string => `'${name.replace(/'/g, "''")}'`;

/** Column letters for a 1-based index: 1 → A, 27 → AA. */
export function columnName(index: number): string {
  let name = "";
  let rest = index;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

export function columnIndex(name: string): number {
  return [...name.toUpperCase()].reduce((sum, char) => sum * 26 + (char.charCodeAt(0) - 64), 0);
}

/** "Budget!B2" + 3×2 values → "Budget!B2:C4". The written range always matches the values. */
export function rangeFor(anchor: string, rows: number, columns: number): { sheet: string | null; range: string } {
  const match = /^(?:(.+)!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/.exec(anchor.trim());
  if (!match) throw new Error(`"${anchor}" is not a cell like A1 or Sheet1!B2.`);
  const sheet = match[1] ? match[1].replace(/^'(.*)'$/, "$1").replace(/''/g, "'") : null;
  const first = columnIndex(match[2]!);
  const row = Number(match[3]);
  const cells = `${columnName(first)}${row}:${columnName(first + Math.max(columns, 1) - 1)}${row + Math.max(rows, 1) - 1}`;
  return { sheet, range: sheet ? `${a1Sheet(sheet)}!${cells}` : cells };
}

const width = (rows: ReadonlyArray<ReadonlyArray<unknown>>): number => rows.reduce((max, row) => Math.max(max, row.length), 0);

function tablePreview(rows: ReadonlyArray<ReadonlyArray<CellValue>>, limit = 4): string {
  const shown = rows.slice(0, limit);
  if (!shown.length) return "";
  const columns = Math.min(width(shown), 8);
  const cell = (value: CellValue | undefined) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 40);
  const line = (row: ReadonlyArray<CellValue>) => `| ${Array.from({ length: columns }, (_unused, index) => cell(row[index])).join(" | ")} |`;
  const more = rows.length > shown.length ? `\n…and ${plural(rows.length - shown.length, "more row")}` : "";
  return `\n${line(shown[0]!)}\n| ${Array.from({ length: columns }, () => "---").join(" | ")} |\n${shown.slice(1).map(line).join("\n")}${more}`.replace(/\n\n/g, "\n");
}

const sheetValue = (value: CellValue): string | number | boolean => (value === null ? "" : value);

interface SpreadsheetMeta {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  properties?: { title?: string };
  sheets?: Array<{ properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }>;
}

async function spreadsheet(ctx: ToolContext, token: string, spreadsheetId: string, meta = SHEETS_READ): Promise<SpreadsheetMeta> {
  return appFetch<SpreadsheetMeta>(
    ctx,
    meta,
    token,
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title,gridProperties)`,
    { notFound: DRIVE_FILE_HINT },
  );
}

const SheetSpec = z.object({
  name: z.string().max(100).optional(),
  headers: z.array(z.string().max(200)).max(60).optional(),
  rows: Rows.default([]),
});

const CreateSheet = z.object({
  title: z.string().trim().min(1).max(200),
  headers: z.array(z.string().max(200)).max(60).optional().describe("Header row for a one-tab sheet."),
  rows: Rows.optional().describe("Rows for a one-tab sheet. Strings starting with = are formulas."),
  sheets: z.array(SheetSpec).min(1).max(10).optional().describe("Several tabs; use instead of headers/rows."),
});

function tabsOf(input: z.infer<typeof CreateSheet>): Array<{ name: string; headers?: string[]; rows: CellValue[][] }> {
  const raw = input.sheets?.length ? input.sheets : [{ name: "Sheet1", headers: input.headers, rows: input.rows ?? [] }];
  const taken = new Set<string>();
  return raw.map((sheet, index) => ({ name: safeSheetName(sheet.name, index, taken), headers: sheet.headers, rows: sheet.rows }));
}

export const sheetsCreate = defineTool({
  name: "sheets_create",
  area: "apps",
  app: SHEETS_WRITE,
  description: "Create a Google Sheet with a header row and rows, optionally several tabs. Returns its link.",
  input: CreateSheet,
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const tabs = tabsOf(input);
    const rows = tabs.reduce((sum, tab) => sum + tab.rows.length, 0);
    const where = await whose(ctx, "google", "Google Drive");
    const first = tabs[0]!;
    const tabWords = tabs.length > 1 ? ` in ${plural(tabs.length, "tab")} (${tabs.map((tab) => tab.name).join(", ")})` : "";
    return `Create Google Sheet ${quote(input.title)} in ${where} with ${plural(rows, "row")}${tabWords}.${tablePreview(first.headers ? [first.headers, ...first.rows] : first.rows)}`;
  },
  async run(ctx, input) {
    const tabs = tabsOf(input);
    const token = await appToken(ctx, SHEETS_WRITE);
    const created = await appFetch<SpreadsheetMeta>(ctx, SHEETS_WRITE, token, SHEETS_API, {
      method: "POST",
      body: { properties: { title: input.title }, sheets: tabs.map((tab) => ({ properties: { title: tab.name } })) },
    });
    const id = created.spreadsheetId!;
    const data = tabs
      .map((tab) => ({ tab, values: [...(tab.headers?.length ? [tab.headers] : []), ...tab.rows.map((row) => row.map(sheetValue))] }))
      .filter((entry) => entry.values.length)
      .map((entry) => ({ range: `${a1Sheet(entry.tab.name)}!A1`, majorDimension: "ROWS", values: entry.values }));
    if (data.length) {
      await appFetch(ctx, SHEETS_WRITE, token, `${SHEETS_API}/${encodeURIComponent(id)}/values:batchUpdate`, {
        method: "POST",
        body: { valueInputOption: "USER_ENTERED", data },
      });
    }
    const sheetIds = new Map((created.sheets ?? []).map((sheet) => [sheet.properties?.title ?? "", sheet.properties?.sheetId ?? 0]));
    const formatting = tabs
      .filter((tab) => tab.headers?.length)
      .flatMap((tab) => {
        const sheetId = sheetIds.get(tab.name) ?? 0;
        return [
          { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
          { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
        ];
      });
    if (formatting.length) {
      await appFetch(ctx, SHEETS_WRITE, token, `${SHEETS_API}/${encodeURIComponent(id)}:batchUpdate`, { method: "POST", body: { requests: formatting } });
    }
    const link = created.spreadsheetUrl ?? sheetLink(id);
    const rows = tabs.reduce((sum, tab) => sum + tab.rows.length, 0);
    return toolOk(`Created the Google Sheet ${quote(input.title)} with ${plural(rows, "row")}.`, { id, link, tabs: tabs.map((tab) => tab.name) }, { href: link });
  },
});

export const sheetsRead = defineTool({
  name: "sheets_read",
  area: "apps",
  app: SHEETS_READ,
  description: "Read cells from a Google Sheet. Without a range, reads the first tab.",
  input: z.object({
    spreadsheetId: z.string().min(1).max(200),
    range: z.string().max(200).optional().describe("A1 range such as Budget!A1:D50, or a tab name."),
    maxRows: z.number().int().min(1).max(500).default(200),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, SHEETS_READ);
    const meta = await spreadsheet(ctx, token, input.spreadsheetId);
    const tabs = (meta.sheets ?? []).map((sheet) => sheet.properties?.title ?? "").filter(Boolean);
    const range = input.range?.trim() || a1Sheet(tabs[0] ?? "Sheet1");
    const values = await appFetch<{ range?: string; values?: unknown[][] }>(
      ctx,
      SHEETS_READ,
      token,
      `${SHEETS_API}/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`,
    );
    const rows = values.values ?? [];
    const link = meta.spreadsheetUrl ?? sheetLink(input.spreadsheetId);
    return toolOk(
      `Read ${plural(Math.min(rows.length, input.maxRows), "row")} from ${quote(meta.properties?.title ?? "the sheet")} (${values.range ?? range}).`,
      {
        title: meta.properties?.title,
        tabs,
        range: values.range ?? range,
        rows: rows.slice(0, input.maxRows),
        totalRows: rows.length,
        ...(rows.length > input.maxRows ? { truncated: true } : {}),
        link,
        note: UNTRUSTED_NOTE,
      },
      { href: link },
    );
  },
});

export const sheetsUpdateRange = defineTool({
  name: "sheets_update_range",
  area: "apps",
  app: SHEETS_WRITE,
  description: "Overwrite cells in a Google Sheet starting at a cell (e.g. Budget!B2). The range grows to fit the values.",
  input: z.object({
    spreadsheetId: z.string().min(1).max(200),
    range: z.string().min(2).max(200).describe("Top-left cell, e.g. Budget!B2. A full range is fine; it is resized to the values."),
    values: Rows.min(1),
  }),
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const token = await appToken(ctx, SHEETS_WRITE);
    const meta = await spreadsheet(ctx, token, input.spreadsheetId, SHEETS_WRITE);
    const target = rangeFor(input.range, input.values.length, width(input.values));
    return `In the Google Sheet ${quote(meta.properties?.title ?? input.spreadsheetId)}, overwrite ${target.range} (${plural(input.values.length, "row")} × ${plural(width(input.values), "column")}) with:${tablePreview(input.values, 5)}`;
  },
  async run(ctx, input) {
    const token = await appToken(ctx, SHEETS_WRITE);
    const target = rangeFor(input.range, input.values.length, width(input.values));
    const result = await appFetch<{ updatedRange?: string; updatedCells?: number }>(
      ctx,
      SHEETS_WRITE,
      token,
      `${SHEETS_API}/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(target.range)}?valueInputOption=USER_ENTERED`,
      { method: "PUT", body: { range: target.range, majorDimension: "ROWS", values: input.values.map((row) => row.map(sheetValue)) } },
    );
    const link = sheetLink(input.spreadsheetId);
    return toolOk(`Updated ${plural(result.updatedCells ?? 0, "cell")} in ${result.updatedRange ?? target.range}.`, { range: result.updatedRange ?? target.range, link }, { href: link });
  },
});

export const sheetsAppendRows = defineTool({
  name: "sheets_append_rows",
  area: "apps",
  app: SHEETS_WRITE,
  description: "Add rows after the last row of a tab in a Google Sheet.",
  input: z.object({
    spreadsheetId: z.string().min(1).max(200),
    sheet: z.string().max(100).optional().describe("Tab name; defaults to the first tab."),
    rows: Rows.min(1),
  }),
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const token = await appToken(ctx, SHEETS_WRITE);
    const meta = await spreadsheet(ctx, token, input.spreadsheetId, SHEETS_WRITE);
    const tab = input.sheet ?? meta.sheets?.[0]?.properties?.title ?? "the first tab";
    return `Add ${plural(input.rows.length, "row")} after the last row of ${quote(tab)} in the Google Sheet ${quote(meta.properties?.title ?? input.spreadsheetId)}:${tablePreview(input.rows, 5)}`;
  },
  async run(ctx, input) {
    const token = await appToken(ctx, SHEETS_WRITE);
    const range = input.sheet ? a1Sheet(input.sheet) : "A1";
    const result = await appFetch<{ updates?: { updatedRange?: string; updatedRows?: number } }>(
      ctx,
      SHEETS_WRITE,
      token,
      `${SHEETS_API}/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: { majorDimension: "ROWS", values: input.rows.map((row) => row.map(sheetValue)) } },
    );
    const link = sheetLink(input.spreadsheetId);
    return toolOk(
      `Added ${plural(result.updates?.updatedRows ?? input.rows.length, "row")}${result.updates?.updatedRange ? ` at ${result.updates.updatedRange}` : ""}.`,
      { range: result.updates?.updatedRange, link },
      { href: link },
    );
  },
});

const SlideInput = z.object({
  title: z.string().trim().min(1).max(200),
  bullets: z.array(z.string().max(500)).max(12).default([]).describe('Bullet lines; start a line with two spaces per nesting level.'),
  notes: z.string().max(3000).optional().describe("Speaker notes."),
});

export const DeckInput = z.object({
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().max(300).optional(),
  slides: z.array(SlideInput).min(1).max(40),
});

function deckPreview(kind: string, title: string, where: string, input: z.infer<typeof DeckInput>): string {
  const list = input.slides.slice(0, 12).map((slide, index) => `${index + 2}. ${slide.title}${slide.notes ? " (with notes)" : ""}`);
  const more = input.slides.length > 12 ? `\n…and ${plural(input.slides.length - 12, "more slide")}` : "";
  return `Create ${kind} ${quote(title)} in ${where} with ${plural(input.slides.length + 1, "slide")}:\n1. Title slide${input.subtitle ? ` — ${input.subtitle}` : ""}\n${list.join("\n")}${more}`;
}

interface Presentation {
  presentationId?: string;
  title?: string;
  slides?: Array<{
    objectId?: string;
    pageElements?: Array<{ objectId?: string; shape?: { placeholder?: { type?: string }; text?: { textElements?: Array<{ textRun?: { content?: string } }> } } }>;
    slideProperties?: {
      notesPage?: {
        notesProperties?: { speakerNotesObjectId?: string };
        pageElements?: Array<{ objectId?: string; shape?: { text?: { textElements?: Array<{ textRun?: { content?: string } }> } } }>;
      };
    };
  }>;
}

const shapeText = (shape: { text?: { textElements?: Array<{ textRun?: { content?: string } }> } } | undefined): string =>
  (shape?.text?.textElements ?? []).map((element) => element.textRun?.content ?? "").join("").trim();

const bulletText = (bullets: readonly string[]): string =>
  bullets
    .filter((line) => line.trim())
    .map((line) => {
      const depth = Math.min(Math.floor((/^\s*/.exec(line)?.[0].length ?? 0) / 2), 4);
      return "\t".repeat(depth) + line.trim().replace(/^[-*+]\s+/, "");
    })
    .join("\n");

/** Slides batchUpdate requests: fill the cover slide, then one TITLE_AND_BODY slide per spec. */
export function slidesCreateRequests(input: z.infer<typeof DeckInput>, cover: Presentation["slides"]): Array<Record<string, unknown>> {
  const requests: Array<Record<string, unknown>> = [];
  const first = cover?.[0];
  const placeholder = (types: string[]) => first?.pageElements?.find((element) => types.includes(element.shape?.placeholder?.type ?? ""))?.objectId;
  const titleId = placeholder(["CENTERED_TITLE", "TITLE"]);
  const subtitleId = placeholder(["SUBTITLE"]);
  if (titleId) requests.push({ insertText: { objectId: titleId, text: input.title } });
  if (subtitleId && input.subtitle) requests.push({ insertText: { objectId: subtitleId, text: input.subtitle } });
  input.slides.forEach((slide, index) => {
    const ids = { slide: `ens_slide_${index}`, title: `ens_title_${index}`, body: `ens_body_${index}` };
    requests.push({
      createSlide: {
        objectId: ids.slide,
        insertionIndex: index + 1,
        slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: ids.title },
          { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: ids.body },
        ],
      },
    });
    requests.push({ insertText: { objectId: ids.title, text: slide.title } });
    const body = bulletText(slide.bullets);
    if (body) {
      requests.push({ insertText: { objectId: ids.body, text: body } });
      requests.push({ createParagraphBullets: { objectId: ids.body, textRange: { type: "ALL" }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
    }
  });
  return requests;
}

export const slidesCreate = defineTool({
  name: "slides_create",
  area: "apps",
  app: SLIDES_WRITE,
  description: "Create a Google Slides deck: a title slide, then slides with a title, bullets and speaker notes.",
  input: DeckInput,
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    return deckPreview("Google Slides deck", input.title, await whose(ctx, "google", "Google Drive"), input);
  },
  async run(ctx, input) {
    const token = await appToken(ctx, SLIDES_WRITE);
    const created = await appFetch<Presentation>(ctx, SLIDES_WRITE, token, SLIDES_API, { method: "POST", body: { title: input.title } });
    const id = created.presentationId!;
    const batch = (requests: Array<Record<string, unknown>>) =>
      appFetch(ctx, SLIDES_WRITE, token, `${SLIDES_API}/${encodeURIComponent(id)}:batchUpdate`, { method: "POST", body: { requests } });
    await batch(slidesCreateRequests(input, created.slides));
    if (input.slides.some((slide) => slide.notes?.trim())) {
      const deck = await appFetch<Presentation>(
        ctx,
        SLIDES_WRITE,
        token,
        `${SLIDES_API}/${encodeURIComponent(id)}?fields=slides(objectId,slideProperties(notesPage(notesProperties)))`,
      );
      const notesIds = new Map((deck.slides ?? []).map((slide) => [slide.objectId ?? "", slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId]));
      const notes = input.slides.flatMap((slide, index) => {
        const target = notesIds.get(`ens_slide_${index}`);
        return target && slide.notes?.trim() ? [{ insertText: { objectId: target, text: slide.notes.trim() } }] : [];
      });
      if (notes.length) await batch(notes);
    }
    const link = slidesLink(id);
    return toolOk(`Created the Google Slides deck ${quote(input.title)} with ${plural(input.slides.length + 1, "slide")}.`, { id, link }, { href: link });
  },
});

export const slidesRead = defineTool({
  name: "slides_read",
  area: "apps",
  app: SLIDES_READ,
  description: "Read the text and speaker notes of each slide in a Google Slides deck.",
  input: z.object({ presentationId: z.string().min(1).max(200) }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, SLIDES_READ);
    const deck = await appFetch<Presentation>(ctx, SLIDES_READ, token, `${SLIDES_API}/${encodeURIComponent(input.presentationId)}`, { notFound: DRIVE_FILE_HINT });
    const slides = (deck.slides ?? []).map((slide, index) => {
      const elements = slide.pageElements ?? [];
      const title = elements.find((element) => ["TITLE", "CENTERED_TITLE"].includes(element.shape?.placeholder?.type ?? ""));
      const notesId = slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
      const notes = slide.slideProperties?.notesPage?.pageElements?.find((element) => element.objectId === notesId);
      return {
        index: index + 1,
        title: shapeText(title?.shape),
        text: elements.filter((element) => element !== title).map((element) => shapeText(element.shape)).filter(Boolean).join("\n"),
        notes: shapeText(notes?.shape),
      };
    });
    const link = slidesLink(input.presentationId);
    return toolOk(`Read ${plural(slides.length, "slide")} from ${quote(deck.title ?? "the deck")}.`, { title: deck.title, slides, link, note: UNTRUSTED_NOTE }, { href: link });
  },
});

export const googleSheetsSlidesTools = [sheetsCreate, sheetsRead, sheetsUpdateRange, sheetsAppendRows, slidesCreate, slidesRead];
