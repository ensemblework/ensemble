/**
 * Zendesk: tickets (search, or yours that are not solved), a ticket with its latest
 * comments, the account's agents and admins, and internal notes on tickets.
 * Ids: the ticket number. A ticket link gives "fieldnote.zendesk.com/123" so a note
 * never lands on another Zendesk's ticket with the same number.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { facts, itemFetch, itemMarkdown, type ItemRequest } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const LABEL = "Zendesk";
const HOST = /^[a-z0-9][a-z0-9-]{0,62}\.zendesk\.com$/;
const TICKET = /^\d{1,15}$/;
const MAX_PEOPLE_PAGES = 5;

interface Ticket {
  id: number;
  subject?: string | null;
  description?: string | null;
  status?: string;
  priority?: string | null;
  type?: string | null;
  tags?: string[];
  due_at?: string | null;
  requester_id?: number | null;
  assignee_id?: number | null;
  created_at?: string;
  updated_at?: string;
}

interface User {
  id: number;
  name?: string;
  email?: string | null;
  role?: string;
  active?: boolean;
}

interface Comment {
  id: number;
  author_id?: number;
  body?: string;
  plain_body?: string;
  public?: boolean;
  created_at?: string;
}

function host(ctx: ItemContext): string {
  const site = ctx.token.meta?.site;
  if (typeof site !== "string" || !HOST.test(site)) throw new ItemError("Zendesk is connected without a subdomain. Connect it again in Settings → Connections.", 409);
  return site;
}

function call<T>(ctx: ItemContext, path: string, init: ItemRequest = {}): Promise<T> {
  // The stored secret is "email/token:api-token", Zendesk's Basic credentials. itemFetch scrubs
  // ctx's token from errors; scrubbing the API token part covers the whole secret too.
  const secret = ctx.token.token;
  const at = secret.indexOf("/token:");
  const scrubbed: ItemContext = { ...ctx, token: { ...ctx.token, token: at >= 0 ? secret.slice(at + "/token:".length) : secret } };
  return itemFetch<T>(scrubbed, "zendesk", LABEL, `https://${host(ctx)}${path}`, { ...init, headers: { Authorization: `Basic ${Buffer.from(secret).toString("base64")}`, ...init.headers } });
}

const ticketUrl = (ctx: ItemContext, id: number | string) => `https://${host(ctx)}/agent/tickets/${id}`;

function ticketItem(ctx: ItemContext, ticket: Ticket): AppItem {
  return {
    source: "zendesk",
    kind: "ticket",
    id: String(ticket.id),
    title: ticket.subject?.trim() || `Ticket #${ticket.id}`,
    subtitle: [`#${ticket.id}`, ticket.status, ticket.priority].filter(Boolean).join(" · "),
    url: ticketUrl(ctx, ticket.id),
    updatedAt: ticket.updated_at,
  };
}

/** "https://fieldnote.zendesk.com/agent/tickets/123" → "fieldnote.zendesk.com/123". */
export function zendeskTicketRef(text: string): string | null {
  const match = /^https?:\/\/([a-z0-9][a-z0-9-]*\.zendesk\.com)\/agent\/tickets\/(\d{1,15})/i.exec(text.trim());
  return match ? `${match[1]!.toLowerCase()}/${match[2]}` : null;
}

/** "123", "#123", or "host/123" when host is the connected Zendesk. */
function ticketNumber(ctx: ItemContext, id: string): string {
  const value = id.trim().replace(/^#/, "");
  const slash = value.lastIndexOf("/");
  if (slash >= 0) {
    const owner = value.slice(0, slash).toLowerCase();
    if (owner !== host(ctx)) throw new ItemError(`That ticket is in ${owner}, but Zendesk is connected to ${host(ctx)}.`, 409);
  }
  const number = value.slice(slash + 1);
  if (!TICKET.test(number)) throw new ItemError("That is not a Zendesk ticket number.", 400);
  return number;
}

const personOf = (user: User | undefined): AppItemPerson | null => (user?.name ? { name: user.name, ...(user.email ? { email: user.email } : {}) } : null);

export const zendeskItems: ItemSource = {
  id: "zendesk",
  provider: "zendesk",
  label: LABEL,
  kinds: ["ticket"],
  async search(ctx, query) {
    const q = query.q.trim();
    const direct = zendeskTicketRef(q) ?? (/^#?\d{1,15}$/.test(q) ? q : null);
    if (direct) {
      const read = await this.read(ctx, { kind: "ticket", id: direct });
      return [{ source: read.source, kind: read.kind, id: read.id, title: read.title, subtitle: read.subtitle, url: read.url, updatedAt: read.updatedAt }];
    }
    const search = q ? `type:ticket ${q.slice(0, 200)}` : "type:ticket assignee:me status<solved";
    const found = await call<{ results: Ticket[] }>(ctx, `/api/v2/search.json?query=${encodeURIComponent(search)}&sort_by=updated_at&sort_order=desc&per_page=${query.limit}`);
    return found.results.filter((ticket) => typeof ticket.id === "number").slice(0, query.limit).map((ticket) => ticketItem(ctx, ticket));
  },
  async read(ctx, ref): Promise<AppItemContent> {
    const id = ticketNumber(ctx, ref.id);
    const { ticket, users = [] } = await call<{ ticket: Ticket; users?: User[] }>(ctx, `/api/v2/tickets/${id}.json?include=users`);
    const thread = await call<{ comments: Comment[]; users?: User[] }>(ctx, `/api/v2/tickets/${id}/comments.json?sort_order=desc&per_page=20&include=users`);
    const people = new Map([...users, ...(thread.users ?? [])].map((user) => [user.id, user]));
    const name = (userId: number | null | undefined) => (userId ? people.get(userId)?.name : undefined);
    const description = (ticket.description ?? "").trim();
    const comments = [...thread.comments]
      .reverse()
      .filter((comment) => (comment.plain_body ?? comment.body ?? "").trim() !== description)
      .map((comment) => `**${name(comment.author_id) ?? "Someone"}** (${(comment.created_at ?? "").slice(0, 10)}${comment.public === false ? ", internal note" : ""}):\n${comment.plain_body ?? comment.body ?? ""}`)
      .join("\n\n");
    const list = facts({
      Status: ticket.status,
      Priority: ticket.priority,
      Type: ticket.type,
      Requester: name(ticket.requester_id),
      Assignee: name(ticket.assignee_id),
      Tags: (ticket.tags ?? []).join(", "),
      Due: ticket.due_at?.slice(0, 10),
    });
    const named = [ticket.requester_id, ticket.assignee_id].map((userId) => personOf(userId ? people.get(userId) : undefined)).filter((person): person is AppItemPerson => Boolean(person));
    const item = ticketItem(ctx, ticket);
    return { ...item, facts: list, people: named, text: itemMarkdown(item.title, list, [description, comments ? `## Latest comments\n\n${comments}` : ""].filter(Boolean).join("\n\n")) };
  },
  async people(ctx) {
    const out: AppItemPerson[] = [];
    let next: string | null = `/api/v2/users.json?${new URLSearchParams([["role[]", "agent"], ["role[]", "admin"], ["per_page", "100"]])}`;
    for (let page = 0; next && page < MAX_PEOPLE_PAGES; page += 1) {
      const found: { users: User[]; next_page?: string | null } = await call(ctx, next);
      for (const user of found.users) {
        const person = user.active === false ? null : personOf(user);
        if (person) out.push(person);
      }
      const following: URL | null = found.next_page ? new URL(found.next_page) : null;
      next = following && following.host === host(ctx) ? `${following.pathname}${following.search}` : null;
    }
    return out;
  },
  fromUrl(url) {
    const id = zendeskTicketRef(url);
    return id ? { kind: "ticket", id } : null;
  },
  async comment(ctx, ref, body) {
    const id = ticketNumber(ctx, ref.id);
    await call(ctx, `/api/v2/tickets/${id}.json`, { method: "PUT", body: { ticket: { comment: { body, public: false } } } });
    return { url: ticketUrl(ctx, id) };
  },
};
