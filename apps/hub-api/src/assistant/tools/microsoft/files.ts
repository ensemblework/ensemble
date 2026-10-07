/** OneDrive (search, read) and Word, Excel, PowerPoint files made or edited through Microsoft Graph. */
import { z } from "zod";
import { markdownToDocx } from "../../../lib/office/docx.js";
import { officeKind, officeText } from "../../../lib/office/extract.js";
import { outline, wordCount } from "../../../lib/office/markdown.js";
import { slidesToPptx } from "../../../lib/office/pptx.js";
import { clip } from "../../../lib/office/text.js";
import { rowsToXlsx } from "../../../lib/office/xlsx.js";
import { defineTool, toolOk, type AppToolMeta, type ToolContext } from "../../types.js";
import { MAX_DOWNLOAD_BYTES, UNTRUSTED_NOTE, appFetch, appToken, fileName, localStamp, plural, quote, whose } from "../apps-common.js";
import { DeckInput, Rows, rangeFor } from "../google/sheets-slides.js";
import { odata } from "./mail-calendar-teams.js";
import { ENSEMBLE_FOLDER, EXCEL_READ, EXCEL_WRITE, GRAPH, OFFICE_TYPES, ONEDRIVE_READ, POWERPOINT_WRITE, WORD_WRITE } from "./meta.js";

interface DriveItem {
  id: string;
  name?: string;
  size?: number;
  eTag?: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { path?: string };
}

const itemRow = (item: DriveItem, zone: string) => ({
  id: item.id,
  name: item.name,
  kind: item.folder ? "folder" : item.file?.mimeType ?? "file",
  size: item.size,
  modified: localStamp(item.lastModifiedDateTime, zone),
  path: item.parentReference?.path?.replace(/^\/drive\/root:?/, "") || "/",
  link: item.webUrl,
});

export const onedriveSearch = defineTool({
  name: "onedrive_search",
  area: "apps",
  app: ONEDRIVE_READ,
  description: "Search the person's OneDrive by file name or content; without a query, recent files.",
  input: z.object({ query: z.string().max(200).default(""), max: z.number().int().min(1).max(50).default(20) }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, ONEDRIVE_READ);
    const query = input.query.trim();
    const url = query
      ? `${GRAPH}/me/drive/root/search(q='${encodeURIComponent(query.replace(/'/g, "''"))}')${odata({ $top: input.max })}`
      : `${GRAPH}/me/drive/recent${odata({ $top: input.max })}`;
    const body = await appFetch<{ value?: DriveItem[] }>(ctx, ONEDRIVE_READ, token, url);
    const files = (body.value ?? []).slice(0, input.max).map((item) => itemRow(item, ctx.settings.timezone));
    return toolOk(`Found ${plural(files.length, "file")} in OneDrive${query ? ` for ${quote(query)}` : ""}.`, { files });
  },
});

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log|html?)$/i;

const itemUrl = (itemId: string) => `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}`;

async function loadItem(ctx: ToolContext, meta: AppToolMeta, token: string, itemId: string): Promise<DriveItem> {
  return appFetch<DriveItem>(ctx, meta, token, `${itemUrl(itemId)}${odata({ $select: "id,name,size,eTag,file,folder,webUrl,lastModifiedDateTime,parentReference" })}`);
}

export const onedriveReadFile = defineTool({
  name: "onedrive_read_file",
  area: "apps",
  app: ONEDRIVE_READ,
  description: "Read a OneDrive file as text: Word, Excel, PowerPoint, text, Markdown and CSV. PDFs return details only; folders list their files.",
  input: z.object({
    itemId: z.string().min(1).max(400),
    offset: z.number().int().min(0).default(0).describe("Character offset for long files; use nextOffset from the last read."),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, ONEDRIVE_READ);
    const item = await loadItem(ctx, ONEDRIVE_READ, token, input.itemId);
    const details = itemRow(item, ctx.settings.timezone);
    const href = item.webUrl ? { href: item.webUrl } : {};
    if (item.folder) {
      const children = await appFetch<{ value?: DriveItem[] }>(ctx, ONEDRIVE_READ, token, `${itemUrl(item.id)}/children${odata({ $top: 50 })}`);
      return toolOk(`${quote(item.name ?? "The folder")} is a folder with ${plural(children.value?.length ?? 0, "item")}.`, {
        ...details,
        children: (children.value ?? []).map((child) => itemRow(child, ctx.settings.timezone)),
      }, href);
    }
    const name = item.name ?? "";
    const kind = officeKind(name, item.file?.mimeType);
    const textual = TEXT_EXTENSIONS.test(name) || (item.file?.mimeType ?? "").startsWith("text/");
    if ((!kind && !textual) || (item.size ?? 0) > MAX_DOWNLOAD_BYTES) {
      return toolOk(`${quote(name || item.id)} cannot be read as text here. Open the link to see it.`, details, href);
    }
    const bytes = await appFetch<Uint8Array>(ctx, ONEDRIVE_READ, token, `${itemUrl(item.id)}/content`, { expect: "bytes" });
    const text = kind ? await officeText(kind, bytes) : new TextDecoder().decode(bytes);
    const window = clip(text, input.offset, 5000);
    return toolOk(
      `Read ${quote(name)} from OneDrive.`,
      {
        ...details,
        text: window.text,
        offset: window.offset,
        total: window.total,
        ...(window.nextOffset !== undefined ? { nextOffset: window.nextOffset } : {}),
        note: UNTRUSTED_NOTE,
      },
      href,
    );
  },
});

async function uploadNew(ctx: ToolContext, meta: AppToolMeta, token: string, name: string, type: string, bytes: Uint8Array): Promise<DriveItem> {
  const path = `${encodeURIComponent(ENSEMBLE_FOLDER)}/${encodeURIComponent(name)}`;
  return appFetch<DriveItem>(ctx, meta, token, `${GRAPH}/me/drive/root:/${path}:/content?@microsoft.graph.conflictBehavior=rename`, {
    method: "PUT",
    headers: { "Content-Type": type },
    body: bytes,
  });
}

const created = (kind: string, item: DriveItem) =>
  toolOk(`Created the ${kind} ${quote(item.name ?? "file")} in OneDrive/${ENSEMBLE_FOLDER}.`, { id: item.id, name: item.name, link: item.webUrl }, item.webUrl ? { href: item.webUrl } : {});

const previewOutline = (markdown: string): string => {
  const lines = outline(markdown);
  return lines.length ? `\nOutline:\n${lines.map((line) => `- ${line.trim()}`).join("\n")}` : "";
};

const Markdown = z.string().min(1).max(100_000).describe("Content in Markdown: headings, lists, tables, bold, links.");

export const wordCreate = defineTool({
  name: "word_create",
  area: "apps",
  app: WORD_WRITE,
  description: "Create a Word document (.docx) from Markdown in the person's OneDrive, in the Ensemble folder. Returns its link.",
  input: z.object({ title: z.string().trim().min(1).max(200), markdown: Markdown }),
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const where = await whose(ctx, "microsoft", "OneDrive");
    return `Create Word document ${quote(fileName(input.title, "docx"))} in ${where}, folder ${ENSEMBLE_FOLDER}, with ${plural(wordCount(input.markdown), "word")}.${previewOutline(input.markdown)}`;
  },
  async run(ctx, input) {
    const token = await appToken(ctx, WORD_WRITE);
    const bytes = await markdownToDocx(input.markdown, input.title);
    return created("Word document", await uploadNew(ctx, WORD_WRITE, token, fileName(input.title, "docx"), OFFICE_TYPES.docx, bytes));
  },
});

async function wordItem(ctx: ToolContext, token: string, itemId: string): Promise<DriveItem> {
  const item = await loadItem(ctx, WORD_WRITE, token, itemId);
  if (officeKind(item.name ?? "", item.file?.mimeType) !== "docx") throw new Error(`${quote(item.name ?? itemId)} is not a Word (.docx) document.`);
  return item;
}

export const wordUpdate = defineTool({
  name: "word_update",
  area: "apps",
  app: WORD_WRITE,
  description: "Replace the whole text of a Word document in OneDrive with new Markdown. Read it with onedrive_read_file first and send the complete new text.",
  input: z.object({ itemId: z.string().min(1).max(400), markdown: Markdown }),
  isWrite: true,
  risk: "high",
  async preview(ctx, input) {
    const item = await wordItem(ctx, await appToken(ctx, WORD_WRITE), input.itemId);
    return `Overwrite the Word document ${quote(item.name ?? input.itemId)} in OneDrive with new content (${plural(wordCount(input.markdown), "word")}). Everything in it now is replaced; OneDrive keeps the old version in its version history.${previewOutline(input.markdown)}`;
  },
  async run(ctx, input) {
    const token = await appToken(ctx, WORD_WRITE);
    const item = await wordItem(ctx, token, input.itemId);
    const bytes = await markdownToDocx(input.markdown, (item.name ?? "").replace(/\.docx$/i, ""));
    const saved = await appFetch<DriveItem>(ctx, WORD_WRITE, token, `${itemUrl(item.id)}/content`, {
      method: "PUT",
      headers: { "Content-Type": OFFICE_TYPES.docx, ...(item.eTag ? { "If-Match": item.eTag } : {}) },
      body: bytes,
    });
    return toolOk(`Replaced the text of ${quote(saved.name ?? item.name ?? "the document")}.`, { id: saved.id, link: saved.webUrl ?? item.webUrl }, saved.webUrl ?? item.webUrl ? { href: (saved.webUrl ?? item.webUrl)! } : {});
  },
});

const ExcelSheet = z.object({
  name: z.string().max(100).optional(),
  headers: z.array(z.string().max(200)).max(60).optional(),
  rows: Rows.default([]),
});

const ExcelCreate = z.object({
  title: z.string().trim().min(1).max(200),
  headers: z.array(z.string().max(200)).max(60).optional().describe("Header row for a one-sheet workbook."),
  rows: Rows.optional().describe("Rows for a one-sheet workbook. Strings starting with = are formulas."),
  sheets: z.array(ExcelSheet).min(1).max(10).optional().describe("Several sheets; use instead of headers/rows."),
});

const excelSheets = (input: z.infer<typeof ExcelCreate>) =>
  input.sheets?.length ? input.sheets : [{ name: "Sheet1", headers: input.headers, rows: input.rows ?? [] }];

export const excelCreate = defineTool({
  name: "excel_create",
  area: "apps",
  app: EXCEL_WRITE,
  description: "Create an Excel workbook (.xlsx) with a header row and rows in the person's OneDrive, in the Ensemble folder.",
  input: ExcelCreate,
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const sheets = excelSheets(input);
    const rows = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
    const where = await whose(ctx, "microsoft", "OneDrive");
    const tabs = sheets.length > 1 ? ` across ${plural(sheets.length, "sheet")}` : "";
    const head = sheets[0]?.headers?.length ? `\nColumns: ${sheets[0].headers.join(", ")}` : "";
    return `Create Excel workbook ${quote(fileName(input.title, "xlsx"))} in ${where}, folder ${ENSEMBLE_FOLDER}, with ${plural(rows, "row")}${tabs}.${head}`;
  },
  async run(ctx, input) {
    const token = await appToken(ctx, EXCEL_WRITE);
    const bytes = await rowsToXlsx(excelSheets(input), input.title);
    return created("Excel workbook", await uploadNew(ctx, EXCEL_WRITE, token, fileName(input.title, "xlsx"), OFFICE_TYPES.xlsx, bytes));
  },
});

const sheetPath = (itemId: string, sheet: string) => `${itemUrl(itemId)}/workbook/worksheets/${encodeURIComponent(sheet)}`;
const address = (cells: string) => `'${cells.replace(/'/g, "''")}'`;

async function firstSheet(ctx: ToolContext, meta: AppToolMeta, token: string, itemId: string): Promise<string> {
  const body = await appFetch<{ value?: Array<{ name?: string; position?: number }> }>(
    ctx,
    meta,
    token,
    `${itemUrl(itemId)}/workbook/worksheets${odata({ $select: "name,position" })}`,
  );
  const sheet = [...(body.value ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]?.name;
  if (!sheet) throw new Error("That workbook has no sheets.");
  return sheet;
}

/** "Budget!A1:C3" or "A1" plus an optional sheet → sheet name and cells. */
function splitAddress(raw: string | undefined, sheet: string | undefined): { sheet?: string; cells?: string } {
  const value = raw?.trim();
  if (!value) return { sheet };
  const bang = value.lastIndexOf("!");
  if (bang < 0) return { sheet, cells: value };
  return { sheet: value.slice(0, bang).replace(/^'(.*)'$/, "$1").replace(/''/g, "'"), cells: value.slice(bang + 1) };
}

export const excelReadRange = defineTool({
  name: "excel_read_range",
  area: "apps",
  app: EXCEL_READ,
  description: "Read cells from an Excel workbook in OneDrive. Without an address, reads the sheet's used range.",
  input: z.object({
    itemId: z.string().min(1).max(400),
    sheet: z.string().max(100).optional().describe("Sheet name; defaults to the first sheet."),
    address: z.string().max(100).optional().describe("Range such as A1:D50."),
    maxRows: z.number().int().min(1).max(500).default(200),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, EXCEL_READ);
    const target = splitAddress(input.address, input.sheet);
    const sheet = target.sheet ?? (await firstSheet(ctx, EXCEL_READ, token, input.itemId));
    const url = target.cells
      ? `${sheetPath(input.itemId, sheet)}/range(address=${address(target.cells)})${odata({ $select: "address,values" })}`
      : `${sheetPath(input.itemId, sheet)}/usedRange(valuesOnly=true)${odata({ $select: "address,values" })}`;
    const range = await appFetch<{ address?: string; values?: unknown[][] }>(ctx, EXCEL_READ, token, url);
    const rows = range.values ?? [];
    return toolOk(`Read ${plural(Math.min(rows.length, input.maxRows), "row")} from ${range.address ?? sheet}.`, {
      sheet,
      address: range.address,
      rows: rows.slice(0, input.maxRows),
      totalRows: rows.length,
      ...(rows.length > input.maxRows ? { truncated: true } : {}),
      note: UNTRUSTED_NOTE,
    });
  },
});

const cellsFor = (cells: string, values: ReadonlyArray<ReadonlyArray<unknown>>) =>
  rangeFor(cells, values.length, values.reduce((max, row) => Math.max(max, row.length), 0)).range;

export const excelUpdateRange = defineTool({
  name: "excel_update_range",
  area: "apps",
  app: EXCEL_WRITE,
  description: "Overwrite cells in an Excel workbook in OneDrive starting at a cell (e.g. B2). The range grows to fit the values.",
  input: z.object({
    itemId: z.string().min(1).max(400),
    sheet: z.string().max(100).optional().describe("Sheet name; defaults to the first sheet."),
    address: z.string().min(2).max(100).describe("Top-left cell such as B2 (or Sheet1!B2)."),
    values: Rows.min(1),
  }),
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const token = await appToken(ctx, EXCEL_WRITE);
    const item = await loadItem(ctx, EXCEL_WRITE, token, input.itemId);
    const target = splitAddress(input.address, input.sheet);
    const sheet = target.sheet ?? (await firstSheet(ctx, EXCEL_WRITE, token, input.itemId));
    const cells = cellsFor(target.cells ?? "A1", input.values);
    const columns = input.values.reduce((max, row) => Math.max(max, row.length), 0);
    const sample = input.values
      .slice(0, 5)
      .map((row) => `| ${row.map((value) => String(value ?? "").slice(0, 40)).join(" | ")} |`)
      .join("\n");
    return `In the Excel workbook ${quote(item.name ?? input.itemId)}, overwrite ${sheet}!${cells} (${plural(input.values.length, "row")} × ${plural(columns, "column")}) with:\n${sample}${input.values.length > 5 ? `\n…and ${plural(input.values.length - 5, "more row")}` : ""}`;
  },
  async run(ctx, input) {
    const token = await appToken(ctx, EXCEL_WRITE);
    const target = splitAddress(input.address, input.sheet);
    const sheet = target.sheet ?? (await firstSheet(ctx, EXCEL_WRITE, token, input.itemId));
    const cells = cellsFor(target.cells ?? "A1", input.values);
    const columns = input.values.reduce((max, row) => Math.max(max, row.length), 0);
    const values = input.values.map((row) => Array.from({ length: columns }, (_unused, index) => row[index] ?? ""));
    const range = await appFetch<{ address?: string }>(ctx, EXCEL_WRITE, token, `${sheetPath(input.itemId, sheet)}/range(address=${address(cells)})`, {
      method: "PATCH",
      body: { values },
    });
    const item = await loadItem(ctx, EXCEL_WRITE, token, input.itemId).catch(() => null);
    return toolOk(
      `Updated ${range.address ?? `${sheet}!${cells}`} in ${quote(item?.name ?? "the workbook")}.`,
      { address: range.address ?? `${sheet}!${cells}`, link: item?.webUrl },
      item?.webUrl ? { href: item.webUrl } : {},
    );
  },
});

export const powerpointCreate = defineTool({
  name: "powerpoint_create",
  area: "apps",
  app: POWERPOINT_WRITE,
  description: "Create a PowerPoint deck (.pptx) in the person's OneDrive: a title slide, then slides with bullets and speaker notes.",
  input: DeckInput,
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const where = await whose(ctx, "microsoft", "OneDrive");
    const list = input.slides.slice(0, 12).map((slide, index) => `${index + 2}. ${slide.title}${slide.notes ? " (with notes)" : ""}`);
    const more = input.slides.length > 12 ? `\n…and ${plural(input.slides.length - 12, "more slide")}` : "";
    return `Create PowerPoint deck ${quote(fileName(input.title, "pptx"))} in ${where}, folder ${ENSEMBLE_FOLDER}, with ${plural(input.slides.length + 1, "slide")}:\n1. Title slide${input.subtitle ? ` — ${input.subtitle}` : ""}\n${list.join("\n")}${more}`;
  },
  async run(ctx, input) {
    const token = await appToken(ctx, POWERPOINT_WRITE);
    const bytes = await slidesToPptx(input);
    return created("PowerPoint deck", await uploadNew(ctx, POWERPOINT_WRITE, token, fileName(input.title, "pptx"), OFFICE_TYPES.pptx, bytes));
  },
});

export const microsoftFileTools = [onedriveSearch, onedriveReadFile, wordCreate, wordUpdate, excelCreate, excelReadRange, excelUpdateRange, powerpointCreate];
