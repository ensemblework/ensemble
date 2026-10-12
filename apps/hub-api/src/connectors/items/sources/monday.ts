/**
 * monday.com (GraphQL): items as tasks and boards (search, read with updates),
 * account users, and updates on items. Ids: monday ids.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { MONDAY_VERSION } from "../../../imports/api/monday.js";
import { escapeHtml } from "../../../lib/office/html.js";
import { ConnectorNotConnectedError } from "../../tokens.js";
import { facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, MAX_PEOPLE, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.monday.com/v2";
const LABEL = "monday.com";
/** Boards, most recently used first, whose items a search looks through. */
const SEARCH_BOARDS = 10;

interface Board {
  id: string;
  name: string;
  url?: string;
  type?: string;
  state?: string;
  updated_at?: string;
  description?: string | null;
  items_count?: number;
  workspace?: { name?: string } | null;
}

interface Item {
  id: string;
  name: string;
  url?: string;
  state?: string;
  updated_at?: string;
  group?: { title?: string } | null;
  board?: { id?: string; name?: string } | null;
}

interface Person {
  name?: string;
  email?: string;
}

const ITEM_FIELDS = "id name url state updated_at group { title } board { id name }";
const ID = /^\d{1,20}$/;

/** "https://fieldnote.monday.com/boards/123/pulses/456" → item 456; a board link → the board. */
export function mondayRef(text: string): { kind: "task" | "board"; id: string } | null {
  const value = text.trim();
  if (!/^https?:\/\/[a-z0-9-]+\.monday\.com\/boards\/\d+/i.test(value)) return null;
  const item = /\/pulses\/(\d+)/.exec(value);
  if (item) return { kind: "task", id: item[1]! };
  return { kind: "board", id: /\/boards\/(\d+)/.exec(value)![1]! };
}

async function gql<T>(ctx: ItemContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const body = await itemFetch<{ data?: T; errors?: Array<{ message?: string }>; error_message?: string }>(ctx, "monday", LABEL, API, {
    method: "POST",
    headers: { Authorization: ctx.token.token, "API-Version": MONDAY_VERSION },
    body: { query, variables },
  });
  if (body.errors?.length || body.error_message || !body.data) {
    const message = (body.errors?.[0]?.message ?? body.error_message ?? "no data").split(ctx.token.token).join("[token]").slice(0, 200);
    if (/not authenticated|invalid token/i.test(message)) throw new ConnectorNotConnectedError("monday", `${LABEL} no longer accepts the saved sign-in. Connect it again in Settings → Connections.`);
    if (/permission|scope|not allowed/i.test(message)) throw new ItemError(`${LABEL} refused: ${message}.`, 403);
    throw new ItemError(`${LABEL} could not answer: ${message}.`);
  }
  return body.data;
}

const hit = ({ source, kind, id, title, subtitle, url, updatedAt }: AppItem): AppItem => ({ source, kind, id, title, subtitle, url, updatedAt });
const person = (row: Person | null | undefined): AppItemPerson | null => (row?.name ? { name: row.name, ...(row.email ? { email: row.email } : {}) } : null);

function itemItem(item: Item, boardName?: string): AppItem {
  return {
    source: "monday",
    kind: "task",
    id: item.id,
    title: item.name || "Untitled item",
    subtitle: [boardName ?? item.board?.name, item.group?.title, item.state && item.state !== "active" ? item.state : null].filter(Boolean).join(" · "),
    url: item.url,
    updatedAt: item.updated_at,
  };
}

function boardItem(board: Board): AppItem {
  return {
    source: "monday",
    kind: "board",
    id: board.id,
    title: board.name || "Untitled board",
    subtitle: ["Board", board.workspace?.name].filter(Boolean).join(" · "),
    url: board.url,
    updatedAt: board.updated_at,
  };
}

async function readItem(ctx: ItemContext, id: string): Promise<AppItemContent> {
  const { items } = await gql<{
    items: Array<
      Item & {
        creator?: Person | null;
        subscribers?: Person[];
        column_values?: Array<{ id: string; type: string; text?: string | null; column?: { title?: string } | null }>;
        updates?: Array<{ text_body?: string | null; created_at?: string; creator?: Person | null }>;
      }
    >;
  }>(
    ctx,
    `query($ids: [ID!]) { items(ids: $ids) { ${ITEM_FIELDS} creator { name email } subscribers { name email } column_values { id type text column { title } } updates(limit: 10) { text_body created_at creator { name email } } } }`,
    { ids: [id] },
  );
  const item = items[0];
  if (!item) throw new ItemError(`${LABEL} could not find that item.`, 404);
  const columns = (item.column_values ?? []).filter((column) => column.text?.trim() && column.type !== "name" && column.type !== "subtasks");
  const due = columns.find((column) => column.type === "date" && /^\d{4}-\d{2}-\d{2}/.test(column.text ?? ""));
  const list = facts({
    Board: item.board?.name,
    Group: item.group?.title,
    Due: due?.text?.slice(0, 10),
    ...Object.fromEntries(
      columns
        .filter((column) => column !== due)
        .slice(0, 10)
        .map((column) => [column.column?.title || column.id, column.text!.trim().slice(0, 200)]),
    ),
  });
  const thread = [...(item.updates ?? [])]
    .reverse()
    .map((update) => `**${update.creator?.name ?? "Someone"}** (${(update.created_at ?? "").slice(0, 10)}):\n${update.text_body ?? ""}`)
    .join("\n\n");
  const people = new Map<string, AppItemPerson>();
  for (const row of [item.creator, ...(item.subscribers ?? [])].map(person)) if (row) people.set(row.email ?? row.name, row);
  const summary = itemItem(item);
  return { ...summary, facts: list, people: [...people.values()], text: itemMarkdown(summary.title, list, thread ? `## Latest updates\n\n${thread}` : "") };
}

async function readBoard(ctx: ItemContext, id: string): Promise<AppItemContent> {
  const { boards } = await gql<{ boards: Array<Board & { groups?: Array<{ id: string; title?: string }>; items_page?: { items: Array<{ name: string; group?: { id?: string } | null }> } }> }>(
    ctx,
    `query($ids: [ID!]) { boards(ids: $ids) { id name url description updated_at items_count workspace { name } groups { id title } items_page(limit: 100) { items { name group { id } } } } }`,
    { ids: [id] },
  );
  const board = boards[0];
  if (!board) throw new ItemError(`${LABEL} could not find that board.`, 404);
  const items = board.items_page?.items ?? [];
  const sections = (board.groups ?? []).map((group) => {
    const lines = items.filter((row) => row.group?.id === group.id).map((row) => `- ${row.name}`);
    return `## ${group.title ?? "Group"}\n\n${lines.join("\n") || "(no items shown)"}`;
  });
  const list = facts({ Workspace: board.workspace?.name, Items: board.items_count ?? items.length, Groups: board.groups?.length });
  const summary = boardItem(board);
  return { ...summary, facts: list, text: itemMarkdown(summary.title, list, [board.description ?? "", ...sections].filter(Boolean).join("\n\n")) };
}

async function read(ctx: ItemContext, ref: { kind: string; id: string }): Promise<AppItemContent> {
  if (!ID.test(ref.id)) throw new ItemError("That is not a monday.com item or board id.", 400);
  return ref.kind === "board" ? readBoard(ctx, ref.id) : readItem(ctx, ref.id);
}

export const mondayItems: ItemSource = {
  id: "monday",
  provider: "monday",
  label: LABEL,
  kinds: ["task", "board"],
  async search(ctx, query) {
    const direct = mondayRef(query.q);
    if (direct && (!query.kind || query.kind === direct.kind)) return [hit(await read(ctx, direct))];
    const text = query.q.trim().slice(0, 200);
    const needle = text.toLowerCase();
    const { boards } = await gql<{ boards: Board[] }>(ctx, `query { boards(limit: 100, state: active, order_by: used_at) { id name url type updated_at workspace { name } } }`);
    const real = boards.filter((board) => !board.type || board.type === "board");
    const out: AppItem[] = [];
    if (!query.kind || query.kind === "task") {
      const ids = real.slice(0, SEARCH_BOARDS).map((board) => board.id);
      // JSON string literals are valid GraphQL string literals.
      const rules = text ? `, query_params: { rules: [{ column_id: "name", compare_value: [${JSON.stringify(text)}], operator: contains_text }] }` : "";
      const found = ids.length
        ? await gql<{ boards: Array<{ name: string; items_page?: { items: Item[] } }> }>(
            ctx,
            `query($ids: [ID!]) { boards(ids: $ids) { name items_page(limit: ${query.limit}${rules}) { items { id name url state updated_at group { title } } } } }`,
            { ids },
          )
        : { boards: [] };
      const items = found.boards.flatMap((board) => (board.items_page?.items ?? []).map((item) => itemItem(item, board.name)));
      out.push(...items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, query.limit));
    }
    if (!query.kind || query.kind === "board") {
      const matching = real.filter((board) => !needle || board.name.toLowerCase().includes(needle));
      out.push(...matching.slice(0, query.kind ? query.limit : Math.min(5, query.limit)).map(boardItem));
    }
    return out;
  },
  read,
  async people(ctx) {
    const { users } = await gql<{ users: Array<Person & { enabled?: boolean }> }>(ctx, `query { users(limit: ${MAX_PEOPLE}, kind: non_guests) { name email enabled } }`);
    return users.filter((user) => user.enabled !== false).map(person).filter((row): row is AppItemPerson => Boolean(row));
  },
  fromUrl(url) {
    const ref = mondayRef(url);
    return ref?.kind === "task" ? ref : null;
  },
  async comment(ctx, ref, body) {
    if (ref.kind !== "task" || !ID.test(ref.id)) throw new ItemError("Only monday.com items take updates.", 400);
    const html = body.split(/\r?\n/).map((line) => `<p>${escapeHtml(line)}</p>`).join("");
    await gql<{ create_update: { id: string } }>(ctx, `mutation($id: ID!, $body: String!) { create_update(item_id: $id, body: $body) { id } }`, { id: ref.id, body: html });
    return {};
  },
};
