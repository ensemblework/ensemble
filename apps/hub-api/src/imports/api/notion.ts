/**
 * Notion over its API (version 2026-03-11). Databases are read through their
 * data sources (POST /v1/data_sources/{id}/query); standalone pages through
 * search. Page bodies come from block children, converted to Markdown.
 */
import { normalizeDate, normalizeNotionId } from "../mapping.js";
import { notionBlocksToMarkdown, notionPlain, notionRichText, type NotionBlock } from "../markdown.js";
import type { ApiImportSource, ImportContainer, ImportItem, SourceContext } from "../types.js";

export const NOTION_VERSION = "2026-03-11";
const API = "https://api.notion.com/v1";
const MAX_PAGES = 5000;
const BLOCK_DEPTH = 3;

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
    if (property.type === "title") return notionPlain(property.title).trim();
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
    if (depth >= BLOCK_DEPTH && block.type !== "table") continue;
    block.children = await notionBlocks(ctx, String(block.id), depth + 1);
  }
  return blocks;
}

function propertyText(property: Json): string {
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
    case "formula": {
      const formula = (value ?? {}) as Json;
      return String(formula[String(formula.type)] ?? "");
    }
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

function pick(properties: Array<[string, Json]>, type: string, name?: RegExp, fallback = true): [string, Json] | undefined {
  const matches = properties.filter(([, property]) => property.type === type);
  return (name ? matches.find(([key]) => name.test(key)) : undefined) ?? (fallback ? matches[0] : undefined);
}

/** One database row → task fields. Unmatched properties are listed at the top of the page. */
export function notionRowItem(page: NotionPage, container: ImportContainer): ImportItem {
  const properties = Object.entries(page.properties ?? {});
  const used = new Set<string>();
  const take = (entry: [string, Json] | undefined) => {
    if (entry) used.add(entry[0]);
    return entry?.[1];
  };
  const titleEntry = properties.find(([, property]) => property.type === "title");
  if (titleEntry) used.add(titleEntry[0]);
  const date = take(pick(properties, "date", /due|deadline|date|when/i))?.date as Json | null | undefined;
  const statusProperty = take(pick(properties, "status") ?? pick(properties, "select", /status|state|stage/i, false));
  const priorityProperty = take(pick(properties, "select", /priority|importance|urgency/i, false));
  const people = take(pick(properties, "people", /assign|owner|people|person|responsible/i));
  const done = take(pick(properties, "checkbox", /done|complete|finished|closed/i));
  const description = take(pick(properties, "rich_text", /description|summary|notes|details/i, false));
  const labels: string[] = [];
  for (const [key, property] of properties) {
    if (property.type !== "multi_select") continue;
    used.add(key);
    for (const option of (property.multi_select as Json[]) ?? []) labels.push(String(option.name ?? ""));
  }
  const extras = properties
    .filter(([key]) => !used.has(key))
    .map(([key, property]) => [key, propertyText(property).replace(/\s+/g, " ").trim()] as const)
    .filter(([, value]) => value)
    .slice(0, 20)
    .map(([key, value]) => `- **${key}:** ${value.slice(0, 300)}`);
  const end = normalizeDate(date?.end);
  const start = normalizeDate(date?.start);
  return {
    kind: "task",
    externalId: normalizeNotionId(page.id),
    title: titleOf(page),
    description: description ? notionRichText(description.rich_text) : null,
    dueDate: end ?? start,
    startDate: end ? start : null,
    status: statusProperty ? String(((statusProperty[String(statusProperty.type)] ?? {}) as Json).name ?? "") || null : null,
    done: Boolean(done?.checkbox),
    priority: priorityProperty ? String(((priorityProperty.select ?? {}) as Json).name ?? "") || null : null,
    labels,
    assignees: ((people?.people as Json[]) ?? []).map(personName).filter(Boolean),
    url: page.url ?? null,
    containerId: container.id,
    projectRef: normalizeNotionId(container.id),
    projectName: container.name,
    pageMarkdown: extras.length ? `**Properties**\n\n${extras.join("\n")}` : null,
    createdAt: page.created_time ?? null,
    updatedAt: page.last_edited_time ?? null,
  };
}

export const notionSource: ApiImportSource = {
  id: "notion",
  async listContainers(ctx) {
    const containers: ImportContainer[] = [];
    for await (const batch of searchAll(ctx, "data_source")) {
      for (const source of batch) {
        containers.push({ id: source.id, name: titleOf(source) || "Untitled database", kind: "database", count: null, importAs: "tasks" });
      }
    }
    let pages = 0;
    for await (const batch of searchAll(ctx, "page")) pages += batch.filter(standalone).length;
    if (pages) containers.push({ id: "pages", name: "Pages", kind: "page", count: pages, importAs: "pages" });
    return containers;
  },
  async *fetchItems(ctx, containers) {
    for (const container of containers) {
      if (container.id === "pages") continue;
      let cursor: string | undefined;
      do {
        const page = await ctx.http.json<NotionList<NotionPage>>(`${API}/data_sources/${container.id}/query`, {
          method: "POST",
          headers: notionHeaders(ctx.auth.token),
          body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
        });
        const items: ImportItem[] = [];
        for (const row of page.results) {
          if (row.in_trash || row.archived || row.object !== "page") continue;
          const item = notionRowItem(row, container);
          const body = ctx.options.preview ? "" : notionBlocksToMarkdown(await notionBlocks(ctx, row.id));
          item.pageMarkdown = [item.pageMarkdown, body].filter(Boolean).join("\n\n") || null;
          items.push(item);
        }
        yield items;
        cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
      } while (cursor && !ctx.signal.aborted);
    }
    if (!containers.some((container) => container.id === "pages")) return;
    const pages: NotionPage[] = [];
    for await (const batch of searchAll(ctx, "page")) pages.push(...batch.filter(standalone));
    const titles = new Map(pages.map((page) => [normalizeNotionId(page.id), titleOf(page)]));
    for (let index = 0; index < pages.length && !ctx.signal.aborted; index += 20) {
      const items: ImportItem[] = [];
      for (const page of pages.slice(index, index + 20)) {
        const parentId = page.parent?.type === "page_id" ? normalizeNotionId(String(page.parent.page_id)) : null;
        items.push({
          kind: "page",
          externalId: normalizeNotionId(page.id),
          title: titleOf(page) || "Untitled",
          pageMarkdown: ctx.options.preview ? null : notionBlocksToMarkdown(await notionBlocks(ctx, page.id)),
          parentRef: parentId,
          parentTitle: parentId ? titles.get(parentId) ?? null : null,
          url: page.url ?? null,
          containerId: "pages",
          createdAt: page.created_time ?? null,
          updatedAt: page.last_edited_time ?? null,
        });
      }
      yield items;
    }
  },
};
