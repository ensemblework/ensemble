/**
 * The first rows of every sheet in an .xlsx, for agents, without loading the workbook.
 * Sheets are inflated as a stream and read row by row, so a large workbook costs about
 * as much as the rows kept. Cached formula results are read, not formulas.
 */
import { strFromU8, Unzip, UnzipInflate, unzipSync } from "fflate";
import { decodeXml } from "../lib/office/extract.js";

const SMALL_PART_BYTES = 8 * 1024 * 1024;
const MAX_SHARED_STRINGS = 500_000;
const PUSH_BYTES = 64 * 1024;

export type SheetPreview = { name: string; rows: string[][]; more: boolean };

const attr = (attrs: string, name: string): string | undefined => {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return match ? decodeXml(match[1]!) : undefined;
};

/** Text of every <t> in a shared string or inline string, skipping phonetic runs. */
const runText = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1]!)).join("");

/** Feeds the named parts to `read` as text, in order, until it returns false. */
function streamParts(bytes: Uint8Array, names: ReadonlySet<string>, read: (name: string, text: string) => boolean): void {
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    if (!names.has(file.name)) return;
    const decoder = new TextDecoder();
    let open = true;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      if (!open) return;
      open = read(file.name, decoder.decode(chunk, { stream: !final }));
    };
    file.start();
  };
  for (let index = 0; index < bytes.length; index += PUSH_BYTES) unzip.push(bytes.subarray(index, index + PUSH_BYTES), index + PUSH_BYTES >= bytes.length);
}

const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Style indexes (cellXfs) whose number format shows a date. */
function dateStyles(xml: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!xml) return out;
  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) custom.set(Number(attr(match[1]!, "numFmtId")), attr(match[1]!, "formatCode") ?? "");
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  [...xfs.matchAll(/<xf\b([^>]*)\/?>/g)].forEach((match, index) => {
    const id = Number(attr(match[1]!, "numFmtId") ?? 0);
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    if (BUILTIN_DATES.has(id) || /[dy]/i.test(code)) out.add(index);
  });
  return out;
}

function serialDate(serial: number, from1904: boolean): string {
  const ms = Math.round((serial + (from1904 ? 24107 : 0) - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return serial % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

const columnIndex = (ref: string) => {
  let index = 0;
  for (const char of /^[A-Z]+/.exec(ref)?.[0] ?? "") index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
};

export function xlsxPreview(bytes: Uint8Array, maxRows: number): SheetPreview[] {
  const small = unzipSync(bytes, {
    filter: (file) => ["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml"].includes(file.name) && file.originalSize <= SMALL_PART_BYTES,
  });
  const workbook = small["xl/workbook.xml"] ? strFromU8(small["xl/workbook.xml"]) : "";
  if (!workbook) throw new Error("That does not look like an Excel workbook.");
  const from1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook);
  const targets = new Map<string, string>();
  for (const match of strFromU8(small["xl/_rels/workbook.xml.rels"] ?? new Uint8Array()).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const type = attr(match[1]!, "Type") ?? "";
    const target = attr(match[1]!, "Target") ?? "";
    if (!type.endsWith("/worksheet") || !target) continue;
    targets.set(attr(match[1]!, "Id") ?? "", target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)]
    .map((match) => ({ name: attr(match[1]!, "name") ?? "Sheet", part: targets.get(attr(match[1]!, "r:id") ?? "") }))
    .filter((sheet): sheet is { name: string; part: string } => Boolean(sheet.part));
  const dates = dateStyles(small["xl/styles.xml"] ? strFromU8(small["xl/styles.xml"]) : undefined);

  const shared: string[] = [];
  let pending = "";
  streamParts(bytes, new Set(["xl/sharedStrings.xml"]), (_name, text) => {
    pending += text;
    const end = pending.lastIndexOf("</si>");
    if (end < 0) return true;
    for (const match of pending.slice(0, end + 5).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(match[1] ? runText(match[1]) : "");
    pending = pending.slice(end + 5);
    return shared.length < MAX_SHARED_STRINGS;
  });

  const previews = new Map<string, SheetPreview>(sheets.map((sheet) => [sheet.part, { name: sheet.name, rows: [], more: false }]));
  const buffers = new Map<string, string>();
  streamParts(bytes, new Set(previews.keys()), (part, text) => {
    const preview = previews.get(part)!;
    let buffer = (buffers.get(part) ?? "") + text;
    const end = buffer.lastIndexOf("</row>");
    if (end < 0) {
      buffers.set(part, buffer);
      return true;
    }
    for (const row of buffer.slice(0, end + 6).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const number = Number(attr(row[1]!, "r") ?? preview.rows.length + 1);
      if (number > maxRows) {
        preview.more = true;
        return false;
      }
      const cells: string[] = [];
      let next = 0;
      for (const cell of (row[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1]!;
        const ref = attr(attrs, "r");
        const index = ref ? columnIndex(ref) : next;
        next = index + 1;
        const body = cell[2] ?? "";
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        const type = attr(attrs, "t") ?? "n";
        let value = "";
        if (type === "inlineStr") value = runText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
        else if (raw === undefined) value = "";
        else if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
        else if (type === "n" && dates.has(Number(attr(attrs, "s") ?? -1)) && Number.isFinite(Number(raw))) value = serialDate(Number(raw), from1904);
        else value = decodeXml(raw);
        cells[index] = value;
      }
      while (preview.rows.length < number - 1) preview.rows.push([]);
      preview.rows.push(Array.from(cells, (value) => value ?? ""));
    }
    buffer = buffer.slice(end + 6);
    buffers.set(part, buffer);
    return true;
  });
  return [...previews.values()];
}
