/** monday.com GraphQL (API-Version 2026-07): boards → projects, items → tasks via column types. */
import { cleanTitle, normalizeDate, splitList } from "../mapping.js";
import { ImportError, type ApiImportSource, type ImportContainer, type ImportItem, type SourceContext } from "../types.js";

const API = "https://api.monday.com/v2";
export const MONDAY_VERSION = "2026-07";

interface MondayColumn { id: string; type: string; text?: string | null; value?: string | null; column?: { title?: string } | null }
interface MondayItem {
  id: string;
  name: string;
  url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  group?: { title?: string } | null;
  column_values?: MondayColumn[];
}

const ITEM_FIELDS = "id name url created_at updated_at group { title } column_values { id type text value column { title } }";

async function gql<T>(ctx: SourceContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await ctx.http.json<{ data?: T; errors?: Array<{ message?: string }>; error_message?: string }>(API, {
    method: "POST",
    headers: { Authorization: ctx.auth.token, "API-Version": MONDAY_VERSION },
    body: { query, variables },
  });
  if (response.errors?.length || response.error_message || !response.data) {
    throw new ImportError(`monday.com could not answer: ${(response.errors?.[0]?.message ?? response.error_message ?? "no data").slice(0, 200)}.`, 502);
  }
  return response.data;
}

function parse(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function dateFrom(column: MondayColumn): string | null {
  const value = parse(column.value);
  const date = typeof value.date === "string" ? value.date : null;
  const time = typeof value.time === "string" && value.time ? value.time : null;
  // monday stores date+time in UTC.
  if (date && time) return normalizeDate(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  return normalizeDate(date ?? column.text);
}

const title = (column: MondayColumn) => column.column?.title ?? "";

export function mondayItem(item: MondayItem, container: ImportContainer): ImportItem {
  const columns = item.column_values ?? [];
  const ofType = (type: string) => columns.filter((column) => column.type === type);
  const byTitle = (type: string, pattern: RegExp) => ofType(type).find((column) => pattern.test(title(column)));
  const statusColumn = byTitle("status", /status|state|stage/i) ?? ofType("status").find((column) => !/priority/i.test(title(column)));
  const priorityColumn = byTitle("status", /priority|urgency/i);
  const dateColumn = byTitle("date", /due|deadline|date/i) ?? ofType("date")[0];
  const timeline = ofType("timeline")[0];
  const range = timeline ? parse(timeline.value) : {};
  const checkbox = byTitle("checkbox", /done|complete/i);
  const description = byTitle("long_text", /description|notes|details/i) ?? ofType("long_text")[0];
  const due = dateColumn ? dateFrom(dateColumn) : normalizeDate(range.to);
  return {
    kind: "task",
    externalId: item.id,
    title: cleanTitle(item.name),
    description: description?.text || null,
    dueDate: due,
    startDate: timeline ? normalizeDate(range.from) : null,
    status: statusColumn?.text || null,
    done: checkbox ? parse(checkbox.value).checked === true || parse(checkbox.value).checked === "true" : false,
    priority: priorityColumn?.text || null,
    labels: [...ofType("tags").flatMap((column) => splitList(column.text)), ...(item.group?.title ? [item.group.title] : [])],
    assignees: ofType("people").flatMap((column) => splitList(column.text)),
    url: item.url ?? null,
    containerId: container.id,
    projectRef: container.id,
    projectName: container.name,
    createdAt: item.created_at ?? null,
    updatedAt: item.updated_at ?? null,
  };
}

export const mondaySource: ApiImportSource = {
  id: "monday",
  async listContainers(ctx) {
    const containers: ImportContainer[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const data = await gql<{ boards: Array<{ id: string; name: string; type?: string; items_count?: number | null; workspace?: { name?: string } | null }> }>(
        ctx,
        `query($page: Int!) { boards(limit: 100, page: $page, state: active) { id name type items_count workspace { name } } }`,
        { page },
      );
      for (const board of data.boards ?? []) {
        if (board.type && board.type !== "board") continue;
        containers.push({ id: board.id, name: board.name, kind: "board", count: board.items_count ?? null, parent: board.workspace?.name ?? null, importAs: "tasks" });
      }
      if ((data.boards ?? []).length < 100) break;
    }
    return containers;
  },
  async *fetchItems(ctx, containers) {
    for (const container of containers) {
      const first = await gql<{ boards: Array<{ items_page: { cursor: string | null; items: MondayItem[] } }> }>(
        ctx,
        `query($ids: [ID!]) { boards(ids: $ids) { items_page(limit: 100) { cursor items { ${ITEM_FIELDS} } } } }`,
        { ids: [container.id] },
      );
      let page = first.boards?.[0]?.items_page;
      while (page) {
        yield page.items.map((item) => mondayItem(item, container));
        if (!page.cursor || ctx.signal.aborted) break;
        const next: { next_items_page: { cursor: string | null; items: MondayItem[] } } = await gql(
          ctx,
          `query($cursor: String!) { next_items_page(limit: 100, cursor: $cursor) { cursor items { ${ITEM_FIELDS} } } }`,
          { cursor: page.cursor },
        );
        page = next.next_items_page;
      }
    }
  },
};
