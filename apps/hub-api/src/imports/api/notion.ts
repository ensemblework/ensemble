/**
 * Notion over its API (version 2026-03-11). Databases are read through their
 * data sources (POST /v1/data_sources/{id}/query); standalone pages through
 * search. Page bodies become native page blocks; data sources become ordinary tables.
 */
import { type PageNode } from "@ensemble/shared-types";
import { notionInline, notionNodes, notionTable } from "../notion-content.js";
import { ImportError } from "../types.js";
import { normalizeNotionId } from "../mapping.js";
import { notionPlain, notionRichText, type NotionBlock } from "../markdown.js";
import type { ApiImportSource, ImportContainer, ImportItem, SourceContext } from "../types.js";

export const NOTION_VERSION = "2026-03-11";
const API = "https://api.notion.com/v1";
const MAX_PAGES = 5000;
const BLOCK_DEPTH = 32;

type Json = Record<string, unknown>;
interface NotionList<T> { results: T[]; has_more?: boolean; next_cursor?: string | null }
interface NotionPage extends Json {
  id: string;
  object: string;
  url?: string;
  in_trash?: boolean;
  archived?: boolean;
  parent?: Json;
  properties?: Record<string, Json>;
  created_time?: string;
  last_edited_time?: string;
}

export function notionHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION };
}

function titleOf(page: NotionPage): string {
  for (const property of Object.values(page.properties ?? {})) {
    if (property.type === "title" && Array.isArray(property.title)) {
      const title = notionPlain(property.title).trim();
      if (title) return title;
    }
  }
  const title = (page as Json).title;
  return Array.isArray(title) ? notionPlain(title).trim() : "";
}

async function* searchAll(ctx: SourceContext, value: "page" | "data_source"): AsyncGenerator<NotionPage[]> {
  let cursor: string | undefined;
  let seen = 0;
  do {
    const page = await ctx.http.json<NotionList<NotionPage>>(`${API}/search`, {
      method: "POST",
      headers: notionHeaders(ctx.auth.token),
      body: { filter: { property: "object", value }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    seen += page.results.length;
    yield page.results.filter((row) => !row.in_trash && !row.archived);
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor && seen < MAX_PAGES && !ctx.signal.aborted);
}

const standalone = (page: NotionPage) => {
  const type = page.parent?.type;
  return type !== "data_source_id" && type !== "database_id";
};

export async function notionBlocks(ctx: SourceContext, id: string, depth = 0): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
    const page = await ctx.http.json<NotionList<NotionBlock & { id: string }>>(`${API}/blocks/${id}/children?${query}`, { headers: notionHeaders(ctx.auth.token) });
    blocks.push(...page.results);
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor && !ctx.signal.aborted);
  for (const block of blocks) {
    if (!block.has_children || block.type === "child_page" || block.type === "child_database") continue;
    if (depth >= BLOCK_DEPTH) throw new ImportError("This Notion page nests blocks more than 32 levels deep. Import a smaller section.");
    block.children = await notionBlocks(ctx, String(block.id), depth + 1);
  }
  return blocks;
}

export function propertyText(property: Json): string {
  const value = property[String(property.type)] as unknown;
  switch (property.type) {
    case "rich_text":
    case "title":
      return notionRichText(value);
    case "number":
      return value === null || value === undefined ? "" : String(value);
    case "select":
    case "status":
      return String((value as Json | null)?.name ?? "");
    case "multi_select":
      return ((value as Json[]) ?? []).map((option) => String(option.name ?? "")).join(", ");
    case "date": {
      const date = value as Json | null;
      return date ? [date.start, date.end].filter(Boolean).join(" → ") : "";
    }
    case "checkbox":
      return value ? "Yes" : "No";
    case "url":
    case "email":
    case "phone_number":
      return String(value ?? "");
    case "people":
      return ((value as Json[]) ?? []).map(personName).filter(Boolean).join(", ");
    case "formula": return propertyText((value ?? {}) as Json);
    case "string": return String(value ?? "");
    case "boolean": return value ? "Yes" : "No";
    case "files":
      return ((value as Json[]) ?? []).map((file) => String(file.name ?? ((file[String(file.type)] ?? {}) as Json).url ?? "")).join(", ");
    case "relation":
      return ((value as Json[]) ?? []).map((page) => `https://www.notion.so/${String(page.id).replace(/-/g, "")}`).join(", ");
    case "rollup": {
      const rollup = (value ?? {}) as Json;
      return rollup.type === "array" ? ((rollup.array as Json[]) ?? []).map(propertyText).filter(Boolean).join(", ") : propertyText(rollup);
    }
    case "created_time": case "last_edited_time":
      return String(value ?? "");
    case "created_by": case "last_edited_by":
      return personName((value ?? {}) as Json);
    case "unique_id": {
      const id = (value ?? {}) as Json;
      return id.number === undefined ? "" : `${id.prefix ? `${id.prefix}-` : ""}${id.number}`;
    }
    default:
      return "";
  }
}

function personName(person: Json): string {
  return String(person.name ?? ((person.person ?? {}) as Json).email ?? "").trim();
}

/** Fetch a page and its descendants, or a data source as a plain table with row pages. */
export async function notionTree(ctx: SourceContext, root: { id: string; kind: "page" | "database"; title?: string }, seen = new Set<string>(), containerId = "pages"): Promise<ImportItem[]> {
  const items: ImportItem[] = [];
  const headers = notionHeaders(ctx.auth.token);
  const get = <T>(path: string) => ctx.http.json<T>(`${API}${path}`, { headers });
  const hydrated = new Set<string>();
  const hydrate = async (row: NotionPage) => {
    if (hydrated.has(row.id)) return;
    hydrated.add(row.id);
    for (const property of Object.values(row.properties ?? {})) {
      const type = String(property.type);
      const value = property[type];
      if (!property.id || !["title", "rich_text", "people", "relation"].includes(type) || (!property.has_more && (!Array.isArray(value) || value.length < 25))) continue;
      const values: unknown[] = [];
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
        const result = await get<NotionList<Json>>(`/pages/${row.id}/properties/${encodeURIComponent(decodeURIComponent(String(property.id)))}?${query}`);
        values.push(...result.results.map((item) => item[type]));
        cursor = result.has_more && result.next_cursor ? result.next_cursor : undefined;
      } while (cursor && !ctx.signal.aborted);
      property[type] = values;
    }
  };
  const claim = (id: string) => {
    const key = normalizeNotionId(id);
    if (seen.has(key)) return false;
    if (seen.size >= MAX_PAGES) throw new ImportError("This Notion import has more than 5,000 pages. Import a smaller section.");
    if (ctx.signal.aborted) throw new ImportError("Notion import cancelled.");
    seen.add(key);
    return true;
  };
  const page = async (id: string, parentRef?: string | null, depth = 0) => {
    if (depth > BLOCK_DEPTH) throw new ImportError("This Notion page nests pages more than 32 levels deep. Import a smaller section.");
    if (!claim(id)) return;
    const row = await get<NotionPage>(`/pages/${id}`);
    if (row.in_trash || row.archived) return;
    if (!ctx.options.preview) await hydrate(row);
    const parent = parentRef ?? (row.parent?.type === "page_id" ? normalizeNotionId(String(row.parent.page_id)) : null);
    const item: ImportItem = { kind: "page", externalId: normalizeNotionId(id), title: titleOf(row) || "Untitled", parentRef: parent, containerId, url: row.url };
    items.push(item);
    if (ctx.options.preview) return;
    const blocks = await notionBlocks(ctx, id);
    const descend = async (children: NotionBlock[]) => {
      for (const block of children) {
        if (block.type === "child_page") await page(String(block.id), item.externalId, depth + 1);
        else if (block.type === "child_database") {
          const database = await get<NotionPage & { data_sources?: Array<{ id: string; name?: string }> }>(`/databases/${String(block.id)}`);
          const tables: PageNode[] = [];
          for (const source of database.data_sources ?? []) tables.push(...await table(source.id, item.externalId, source.name || String((block.child_database as Json)?.title ?? "Table"), depth + 1, false));
          block.tableContent = tables;
        }
        if (block.children) await descend(block.children);
      }
    };
    await descend(blocks);
    const props = Object.entries(row.properties ?? {}).filter(([, property]) => property.type !== "title");
    const lead: PageNode[] = props.length ? [notionTable([{ name: "Property" }, { name: "Value" }], props.map(([name, property]) => ({ id: name, values: [[{ type: "text", text: name }], propertyNodes(property)] })))] : [];
    item.pageContent = { type: "doc", content: [...lead, ...notionNodes(blocks)] };
  };
  const table = async (id: string, parentRef: string | null, title?: string, depth = 0, ownPage = true): Promise<PageNode[]> => {
    const key = normalizeNotionId(id);
    if (!ownPage && !seen.has(key)) claim(id);
    const source = await get<NotionPage>(`/data_sources/${id}`);
    const columns = Object.entries(source.properties ?? {}).sort((a, b) => Number(b[1].type === "title") - Number(a[1].type === "title"));
    const rows: NotionPage[] = [];
    let cursor: string | undefined;
    do {
      const result = await ctx.http.json<NotionList<NotionPage>>(`${API}/data_sources/${id}/query`, { method: "POST", headers, body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } });
      rows.push(...result.results.filter((row) => !row.in_trash && !row.archived));
      if (rows.length > MAX_PAGES) throw new ImportError("This Notion table has more than 5,000 rows. Import a smaller section.");
      cursor = result.has_more && result.next_cursor ? result.next_cursor : undefined;
    } while (cursor && !ctx.signal.aborted);
    if (!ctx.options.preview) for (const row of rows) await hydrate(row);
    const name = title || titleOf(source) || "Table";
    const content = [notionTable(columns.map(([name, property]) => ({ name, type: String(property.type) })), rows.map((row) => ({ id: row.id, values: columns.map(([name, property]) => property.type === "title" ? [{ type: "text", text: titleOf(row) || "Untitled", marks: [{ type: "link", attrs: { href: `notion-page://${normalizeNotionId(row.id)}` } }] }] : propertyNodes(row.properties?.[name] ?? property)) })))];
    if (ownPage && claim(id)) items.push({ kind: "page", externalId: key, title: name, parentRef, containerId, pageContent: { type: "doc", content } });
    if (!ctx.options.preview) for (const row of rows) await page(row.id, ownPage ? key : parentRef, depth + 1);
    return [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: name }] }, ...content];
  };
  if (root.kind === "database") await table(root.id, null, root.title);
  else await page(root.id);
  if (root.title && root.kind === "page" && items[0]) items[0].title = root.title;
  return items;
}

function propertyNodes(property: Json): PageNode[] {
  if (property.type === "title" || property.type === "rich_text") return notionInline(property[String(property.type)]);
  if (property.type === "relation" && Array.isArray(property.relation)) return property.relation.flatMap((value, index) => {
    const id = normalizeNotionId(String((value as Json).id ?? ""));
    return [...(index ? [{ type: "text", text: ", " }] : []), { type: "text", text: `Page ${id.slice(-6)}`, marks: [{ type: "link", attrs: { href: `notion-page://${id}` } }] }];
  });
  if (property.type === "files" && Array.isArray(property.files)) return property.files.flatMap((value, index) => {
    const file = value as Json;
    const href = String(((file[String(file.type)] ?? {}) as Json).url ?? "");
    return [...(index ? [{ type: "text", text: ", " }] : []), { type: "text", text: String(file.name ?? "File"), ...(/^https?:\/\//.test(href) ? { marks: [{ type: "link", attrs: { href } }] } : {}) }];
  });
  const text = property.type === "checkbox" ? (property.checkbox ? "☑" : "☐") : propertyText(property);
  if (!text) return [];
  const href = property.type === "url" ? text : property.type === "email" ? `mailto:${text}` : null;
  return [{ type: "text", text, ...(href ? { marks: [{ type: "link", attrs: { href } }] } : {}) }];
}

export const notionSource: ApiImportSource = {
  id: "notion",
  async listContainers(ctx) {
    const containers: ImportContainer[] = [];
    for await (const batch of searchAll(ctx, "data_source")) {
      for (const source of batch) {
        containers.push({ id: source.id, name: titleOf(source) || "Untitled database", kind: "database", count: null, importAs: "pages" });
      }
    }
    let pages = 0;
    for await (const batch of searchAll(ctx, "page")) pages += batch.filter(standalone).length;
    if (pages) containers.push({ id: "pages", name: "Pages", kind: "page", count: pages, importAs: "pages" });
    return containers;
  },
  async *fetchItems(ctx, containers) {
    const seen = new Set<string>();
    // Pages first: a table already embedded in an imported page needs no duplicate standalone page.
    if (containers.some((container) => container.id === "pages")) {
      for await (const batch of searchAll(ctx, "page")) {
        for (const page of batch.filter(standalone)) yield await notionTree(ctx, { id: page.id, kind: "page" }, seen, "pages");
      }
    }
    for (const container of containers) {
      if (container.id === "pages" || seen.has(normalizeNotionId(container.id))) continue;
      yield await notionTree(ctx, { id: container.id, kind: "database", title: container.name }, seen, container.id);
    }
  },
};
