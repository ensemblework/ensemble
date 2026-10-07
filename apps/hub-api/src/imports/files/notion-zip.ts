/**
 * Notion "Markdown & CSV" exports (Settings → Export all workspace content, or
 * ••• → Export on a page). Each database is a CSV next to a folder of one .md
 * per row; every other .md is a page. Notion adds a 32-hex id to every name,
 * which is the page id, so re-importing (or later importing over the API)
 * updates the same rows.
 */
import { createHash } from "node:crypto";
import { normalizeNotionId, notionIdFrom, stripNotionId } from "../mapping.js";
import { ImportError, type ImportContainer, type ImportItem } from "../types.js";
import { parseCsv, proposeMapping, type CsvItemOptions, type CsvMapping, type CsvTable } from "./csv.js";
import { safeUnzip, unzipBudget } from "./zip.js";

/** Everything one upload may inflate to, nested zips included. */
export const MAX_UNZIPPED = 100 * 1024 * 1024;
/** Page bodies and row bodies together, in characters. */
export const MAX_MARKDOWN_CHARS = 40_000_000;
const MAX_ENTRIES = 50_000;
const MAX_ENTRY = 20 * 1024 * 1024;

export interface NotionDatabase {
  container: ImportContainer;
  table: CsvTable;
  mapping: CsvMapping;
  options: Omit<CsvItemOptions, "containerId">;
}

export interface NotionExport {
  databases: NotionDatabase[];
  pages: ImportItem[];
  pagesContainer: ImportContainer | null;
}

const decoder = new TextDecoder("utf-8");

const base = (path: string) => path.split("/").pop() ?? path;
const dir = (path: string) => path.split("/").slice(0, -1).join("/");
const withoutExt = (path: string) => path.replace(/\.[a-z0-9]+$/i, "");
const key = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function readNotionZip(data: Uint8Array, maxBytes = MAX_UNZIPPED): Map<string, string> {
  const wanted = (name: string) => /\.(md|csv)$/i.test(name) && !name.startsWith("__MACOSX/");
  const budget = unzipBudget(maxBytes);
  const top = safeUnzip(data, { want: (name) => wanted(name) || /\.zip$/i.test(name), budget, maxEntries: MAX_ENTRIES, maxEntryBytes: maxBytes });
  const texts = new Map<string, string>();
  for (const [name, bytes] of top) {
    top.delete(name);
    if (/\.zip$/i.test(name)) {
      // Notion wraps big exports as Export-…-Part-1.zip inside the download. One level only, same budget.
      const inner = safeUnzip(bytes, { want: wanted, budget, maxEntries: MAX_ENTRIES, maxEntryBytes: MAX_ENTRY });
      for (const [innerName, innerBytes] of inner) texts.set(innerName, decoder.decode(innerBytes));
      continue;
    }
    texts.set(name, decoder.decode(bytes));
  }
  if (![...texts.keys()].some((name) => /\.(md|csv)$/i.test(name))) {
    throw new ImportError("That zip has no Notion pages. In Notion, choose Export → Markdown & CSV and upload the downloaded zip.");
  }
  return texts;
}

/** The title line and the "Key: Value" property block Notion writes under it. */
export function splitNotionMarkdown(text: string): { title: string | null; properties: Record<string, string>; body: string } {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length && !lines[index]!.trim()) index += 1;
  let title: string | null = null;
  const heading = /^#\s+(.*)$/.exec(lines[index] ?? "");
  if (heading) {
    title = heading[1]!.trim();
    index += 1;
  }
  while (index < lines.length && !lines[index]!.trim()) index += 1;
  const properties: Record<string, string> = {};
  const start = index;
  while (index < lines.length && /^[^\s:#>|`*-][^:]{0,60}:\s+\S/.test(lines[index]!)) {
    const [name, ...rest] = lines[index]!.split(":");
    properties[name!.trim()] = rest.join(":").trim();
    index += 1;
  }
  // A single "Key: value" line is just as likely to be prose; only treat a block followed by a blank line as properties.
  if (index > start && lines[index] !== undefined && lines[index]!.trim()) {
    index = start;
    for (const name of Object.keys(properties)) delete properties[name];
  }
  return { title, properties, body: cleanNotionMarkdown(lines.slice(index).join("\n")) };
}

/** Relative links and images point into the zip; keep their text. Asides become quotes. */
export function cleanNotionMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\((?!https?:)[^)]*\)/g, (_m, alt: string) => (alt ? `(image: ${alt})` : "(image)"))
    .replace(/\[([^\]]+)\]\((?!https?:)[^)]*\)/g, "$1")
    .replace(/<aside>\s*([\s\S]*?)\s*<\/aside>/g, (_m, inner: string) => inner.split("\n").map((line) => `> ${line.trim()}`).join("\n"))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(details|summary|span|div)[^>]*>/gi, "")
    .trim();
}

export function parseNotionExport(texts: Map<string, string>, maxMarkdownChars = MAX_MARKDOWN_CHARS): NotionExport {
  let markdownChars = 0;
  const spend = (text: string) => {
    markdownChars += text.length;
    if (markdownChars > maxMarkdownChars) {
      throw new ImportError("That export has more page text than Ensemble imports at once. Export a smaller part of the workspace and import each.", 413);
    }
    return text;
  };
  const paths = [...texts.keys()].sort();
  const csvs = paths.filter((path) => /\.csv$/i.test(path));
  const full = new Set(csvs.filter((path) => /_all\.csv$/i.test(path)).map((path) => path.replace(/_all\.csv$/i, ".csv")));
  const databases: NotionDatabase[] = [];
  const rowFiles = new Set<string>();
  const titleOf = new Map<string, string>();

  for (const path of paths.filter((item) => /\.md$/i.test(item))) {
    const { title } = splitNotionMarkdown(texts.get(path)!);
    titleOf.set(withoutExt(path), title || stripNotionId(withoutExt(base(path))));
  }

  for (const path of csvs) {
    if (full.has(path)) continue;
    const folder = path.replace(/(_all)?\.csv$/i, "");
    const name = stripNotionId(base(folder)) || "Notion database";
    const id = notionIdFrom(base(folder)) ?? hashId(path);
    let table: CsvTable;
    try {
      table = parseCsv(texts.get(path)!);
    } catch {
      continue;
    }
    const rows = paths.filter((item) => /\.md$/i.test(item) && dir(item) === folder);
    const byTitle = new Map<string, string[]>();
    for (const row of rows) {
      rowFiles.add(row);
      const rowId = notionIdFrom(withoutExt(base(row)));
      if (!rowId) continue;
      const titles = [titleOf.get(withoutExt(row)) ?? "", stripNotionId(withoutExt(base(row)))];
      for (const title of titles) {
        const k = key(title);
        if (!k) continue;
        byTitle.set(k, [...(byTitle.get(k) ?? []), rowId]);
      }
    }
    const used = new Set<string>();
    // Notion's title property is the first column.
    const rowIds = table.rows.map((row) => {
      const k = key(row[0] ?? "");
      let candidates = byTitle.get(k) ?? [];
      // Notion shortens long file names; fall back to a prefix match.
      if (!candidates.length && k.length > 30) {
        for (const [titleKey, ids] of byTitle) if (k.startsWith(titleKey) && titleKey.length >= 30) candidates = ids;
      }
      const next = candidates.find((candidate) => !used.has(candidate)) ?? null;
      if (next) used.add(next);
      return next;
    });
    const bodies = new Map<string, string>();
    for (const row of rows) {
      const rowId = notionIdFrom(withoutExt(base(row)));
      if (rowId) bodies.set(rowId, spend(splitNotionMarkdown(texts.get(row)!).body));
    }
    const mapping = proposeMapping(table, "notion");
    databases.push({
      container: { id, name, kind: "database", count: table.rows.length, parent: parentTitle(dir(folder), titleOf), importAs: "tasks" },
      table,
      mapping,
      options: {
        projectName: name,
        projectRef: id,
        idNamespace: id,
        rowIdFor: (index) => rowIds[index] ?? null,
        rowPage: (rowId) => bodies.get(rowId) ?? null,
        sourceUrlFor: (rowId) => (/^[0-9a-f]{32}$/.test(rowId) ? `https://www.notion.so/${rowId}` : null),
      },
    });
  }

  const pages: ImportItem[] = [];
  for (const path of paths) {
    if (!/\.md$/i.test(path) || rowFiles.has(path)) continue;
    const text = texts.get(path)!;
    const split = splitNotionMarkdown(text);
    const id = notionIdFrom(withoutExt(base(path))) ?? hashId(path);
    const properties = Object.entries(split.properties).map(([name, value]) => `- **${name}:** ${value}`).join("\n");
    pages.push({
      kind: "page",
      externalId: normalizeNotionId(id),
      title: split.title || stripNotionId(withoutExt(base(path))) || "Untitled",
      pageMarkdown: spend([properties, split.body].filter(Boolean).join("\n\n")),
      parentTitle: parentTitle(dir(path), titleOf),
      parentRef: notionIdFrom(base(dir(path))),
      containerId: "pages",
      url: /^[0-9a-f]{32}$/.test(id) ? `https://www.notion.so/${id}` : null,
    });
  }
  return {
    databases,
    pages,
    pagesContainer: pages.length ? { id: "pages", name: "Pages", kind: "page", count: pages.length, importAs: "pages" } : null,
  };
}

function parentTitle(folder: string, titles: Map<string, string>): string | null {
  if (!folder) return null;
  const known = titles.get(folder);
  if (known) return known;
  const name = stripNotionId(base(folder));
  if (!name || /^Export-[0-9a-f-]+/i.test(name)) return null;
  return name;
}
