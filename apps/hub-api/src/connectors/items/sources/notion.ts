/**
 * Notion: pages and databases shared with the connection (search), a page's
 * properties and body as Markdown, workspace members, and page comments.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { createImportHttp } from "../../../imports/http.js";
import { notionBlocks, notionHeaders } from "../../../imports/api/notion.js";
import { notionBlocksToMarkdown, notionPlain } from "../../../imports/markdown.js";
import type { SourceContext } from "../../../imports/types.js";
import { facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.notion.com/v1";
const LABEL = "Notion";

type Json = Record<string, unknown>;
interface NotionObject extends Json {
  id: string;
  object: string;
  url?: string;
  in_trash?: boolean;
  archived?: boolean;
  properties?: Record<string, Json>;
  title?: unknown;
  last_edited_time?: string;
  parent?: Json;
}

const ID = /^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i;

/** A Notion URL or id → the bare page id. */
export function notionId(text: string): string | null {
  const value = text.trim();
  const match = /([0-9a-f]{32})(?:[?#].*)?$/i.exec(value.replace(/-/g, "")) ?? null;
  if (/notion\.(so|site)\//i.test(value) && match) return match[1]!.toLowerCase();
  return ID.test(value) ? value.replace(/-/g, "").toLowerCase() : null;
}

function titleOf(row: NotionObject): string {
  for (const property of Object.values(row.properties ?? {})) {
    if (property.type === "title") return notionPlain(property.title).trim();
  }
  return Array.isArray(row.title) ? notionPlain(row.title).trim() : "";
}

function propertyValue(property: Json): string {
  const value = property[String(property.type)] as unknown;
  switch (property.type) {
    case "rich_text":
    case "title":
      return notionPlain(value).trim();
    case "select":
    case "status":
      return String((value as Json | null)?.name ?? "");
    case "multi_select":
      return Array.isArray(value) ? value.map((row) => String((row as Json).name ?? "")).join(", ") : "";
    case "date": {
      const date = value as { start?: string; end?: string } | null;
      return date?.start ? `${date.start}${date.end ? ` → ${date.end}` : ""}` : "";
    }
    case "people":
      return Array.isArray(value) ? value.map((row) => String((row as Json).name ?? "")).filter(Boolean).join(", ") : "";
    case "checkbox":
      return value ? "yes" : "no";
    case "number":
      return value === null || value === undefined ? "" : String(value);
    case "url":
    case "email":
    case "phone_number":
      return value ? String(value) : "";
    default:
      return "";
  }
}

function asItem(row: NotionObject): AppItem {
  const database = row.object === "data_source" || row.object === "database";
  const parent = row.parent?.type === "data_source_id" || row.parent?.type === "database_id" ? "row in a database" : null;
  return {
    source: "notion",
    kind: database ? "database" : "page",
    id: row.id.replace(/-/g, ""),
    title: titleOf(row) || "Untitled",
    subtitle: database ? "Database" : (parent ?? "Page"),
    url: row.url,
    updatedAt: row.last_edited_time,
  };
}

function sourceContext(ctx: ItemContext): SourceContext {
  return {
    auth: { token: ctx.token.token, via: "account" },
    http: createImportHttp({ signal: ctx.signal, gapMs: 340, label: LABEL, fetchImpl: ctx.fetch, timeoutMs: 20_000, maxRetries: 2 }),
    signal: ctx.signal,
    options: {},
  };
}

const call = <T>(ctx: ItemContext, path: string, body?: unknown) =>
  itemFetch<T>(ctx, "notion", LABEL, `${API}${path}`, { headers: notionHeaders(ctx.token.token), ...(body === undefined ? {} : { method: "POST" as const, body }) });

export const notionItems: ItemSource = {
  id: "notion",
  provider: "notion",
  label: LABEL,
  kinds: ["page", "database"],
  async search(ctx, query) {
    const direct = notionId(query.q);
    if (direct) {
      const page = await this.read(ctx, { kind: "page", id: direct }).catch(() => null);
      if (page) return [{ source: page.source, kind: page.kind, id: page.id, title: page.title, subtitle: page.subtitle, url: page.url, updatedAt: page.updatedAt }];
    }
    const filter = query.kind === "database" ? { filter: { property: "object", value: "data_source" } } : query.kind === "page" ? { filter: { property: "object", value: "page" } } : {};
    const found = await call<{ results: NotionObject[] }>(ctx, "/search", {
      query: query.q.trim().slice(0, 200),
      page_size: query.limit,
      sort: { direction: "descending", timestamp: "last_edited_time" },
      ...filter,
    });
    return found.results.filter((row) => !row.in_trash && !row.archived).map(asItem);
  },
  async read(ctx, ref): Promise<AppItemContent> {
    if (!ID.test(ref.id)) throw new ItemError("That is not a Notion page id.", 400);
    if (ref.kind === "database") {
      const source = await call<NotionObject & { properties?: Record<string, Json> }>(ctx, `/data_sources/${ref.id}`);
      const rows = await call<{ results: NotionObject[] }>(ctx, `/data_sources/${ref.id}/query`, { page_size: 50 });
      const columns = Object.keys(source.properties ?? {}).join(", ");
      const lines = rows.results.map((row) => {
        const values = Object.entries(row.properties ?? {})
          .filter(([, property]) => property.type !== "title")
          .map(([name, property]) => [name, propertyValue(property)] as const)
          .filter(([, value]) => value)
          .slice(0, 6)
          .map(([name, value]) => `${name}: ${value}`)
          .join("; ");
        return `- ${titleOf(row) || "Untitled"}${values ? ` (${values})` : ""}`;
      });
      const item = asItem({ ...source, object: "data_source" });
      const list = facts({ Columns: columns, Rows: `${rows.results.length}${rows.results.length === 50 ? "+" : ""}` });
      return { ...item, facts: list, text: itemMarkdown(item.title, list, lines.join("\n")) };
    }
    const page = await call<NotionObject>(ctx, `/pages/${ref.id}`);
    const props = Object.entries(page.properties ?? {})
      .filter(([, property]) => property.type !== "title")
      .map(([name, property]) => [name, propertyValue(property)] as const)
      .filter(([, value]) => value);
    const list = Object.fromEntries(props.slice(0, 12));
    const blocks = await notionBlocks(sourceContext(ctx), ref.id);
    const item = asItem(page);
    const people: AppItemPerson[] = Object.values(page.properties ?? {})
      .filter((property) => property.type === "people" && Array.isArray(property.people))
      .flatMap((property) => (property.people as Json[]).map((person) => ({ name: String(person.name ?? ""), email: String((person.person as Json | undefined)?.email ?? "") || undefined })))
      .filter((person) => person.name);
    return { ...item, facts: list, people, text: itemMarkdown(item.title, list, notionBlocksToMarkdown(blocks)) };
  },
  async people(ctx) {
    const out: AppItemPerson[] = [];
    let cursor: string | undefined;
    do {
      const page = await itemFetch<{ results: Array<Json & { type?: string; name?: string; person?: { email?: string } }>; has_more?: boolean; next_cursor?: string | null }>(
        ctx,
        "notion",
        LABEL,
        `${API}/users?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers: notionHeaders(ctx.token.token) },
      );
      for (const user of page.results) {
        if (user.type !== "person" || !user.name) continue;
        out.push({ name: user.name, ...(user.person?.email ? { email: user.person.email } : {}) });
      }
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor && out.length < 500);
    return out;
  },
  fromUrl(url) {
    const id = /notion\.(so|site)\//i.test(url) ? notionId(url) : null;
    return id ? { kind: "page", id } : null;
  },
  async comment(ctx, ref, body) {
    if (!ID.test(ref.id)) throw new ItemError("That is not a Notion page id.", 400);
    await call(ctx, "/comments", { parent: { page_id: ref.id }, rich_text: [{ type: "text", text: { content: body.slice(0, 2000) } }] });
    return {};
  },
};
