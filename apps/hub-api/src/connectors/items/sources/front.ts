/**
 * Front: shared-inbox conversations (search, or open ones), a conversation with its
 * latest messages, teammates, and internal comments on conversations.
 * Ids: Front's conversation id ("cnv_…").
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { htmlToText } from "../../../lib/office/text.js";
import { capText, facts, itemFetch, itemMarkdown, type ItemRequest } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api2.frontapp.com";
const LABEL = "Front";
const ID = /^cnv_[A-Za-z0-9]{1,40}$/;
const MESSAGE_CHARS = 4_000;

interface Teammate {
  email?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_blocked?: boolean;
}

interface Recipient {
  handle?: string;
  name?: string | null;
  role?: string;
}

interface Conversation {
  id: string;
  subject?: string | null;
  status?: string;
  assignee?: Teammate | null;
  recipient?: Recipient | null;
  tags?: Array<{ name?: string }>;
  created_at?: number;
  updated_at?: number;
}

interface Message {
  id: string;
  is_inbound?: boolean;
  created_at?: number;
  text?: string | null;
  body?: string | null;
  blurb?: string;
  author?: Teammate | null;
  recipients?: Recipient[];
}

function call<T>(ctx: ItemContext, path: string, init: ItemRequest = {}): Promise<T> {
  return itemFetch<T>(ctx, "front", LABEL, `${API}${path}`, { ...init, headers: { Authorization: `Bearer ${ctx.token.token}`, ...init.headers } });
}

const iso = (seconds: number | undefined) => (typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined);

const teammateName = (person: Teammate | null | undefined) => [person?.first_name, person?.last_name].filter(Boolean).join(" ") || person?.username || person?.email || "";

const conversationUrl = (id: string) => `https://app.frontapp.com/open/${id}`;

function conversationItem(conversation: Conversation): AppItem {
  return {
    source: "front",
    kind: "conversation",
    id: conversation.id,
    title: conversation.subject?.trim() || "(no subject)",
    subtitle: [conversation.recipient?.name || conversation.recipient?.handle, conversation.status, teammateName(conversation.assignee)].filter(Boolean).join(" · "),
    url: conversationUrl(conversation.id),
    updatedAt: iso(conversation.updated_at ?? conversation.created_at),
  };
}

/** "https://app.frontapp.com/open/cnv_abc" → "cnv_abc". */
export function frontConversationId(text: string): string | null {
  const value = text.trim();
  const match = /frontapp\.com\/open\/(cnv_[A-Za-z0-9]{1,40})/i.exec(value);
  if (match) return match[1]!;
  return ID.test(value) ? value : null;
}

function requireId(id: string): string {
  if (!ID.test(id)) throw new ItemError("That is not a Front conversation id.", 400);
  return id;
}

export const frontItems: ItemSource = {
  id: "front",
  provider: "front",
  label: LABEL,
  kinds: ["conversation"],
  async search(ctx, query) {
    const direct = frontConversationId(query.q);
    if (direct) return [conversationItem(await call<Conversation>(ctx, `/conversations/${direct}`))];
    const q = query.q.trim().slice(0, 200) || "is:open";
    const found = await call<{ _results: Conversation[] }>(ctx, `/conversations/search/${encodeURIComponent(q)}?limit=${query.limit}`);
    return found._results.slice(0, query.limit).map(conversationItem);
  },
  async read(ctx, ref): Promise<AppItemContent> {
    const id = requireId(ref.id);
    const conversation = await call<Conversation>(ctx, `/conversations/${id}`);
    const { _results: messages } = await call<{ _results: Message[] }>(ctx, `/conversations/${id}/messages?limit=20`);
    const thread = [...messages]
      .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))
      .map((message) => {
        const from = message.recipients?.find((recipient) => recipient.role === "from");
        const who = teammateName(message.author) || from?.name || from?.handle || "Someone";
        const text = message.text?.trim() || (message.body ? htmlToText(message.body) : message.blurb ?? "");
        return `**${who}** (${(iso(message.created_at) ?? "").slice(0, 16).replace("T", " ")}${message.is_inbound === false ? ", sent" : ""}):\n${capText(text, MESSAGE_CHARS)}`;
      })
      .join("\n\n");
    const list = facts({
      Status: conversation.status,
      Assignee: teammateName(conversation.assignee),
      Contact: conversation.recipient?.name || conversation.recipient?.handle,
      Tags: (conversation.tags ?? []).map((tag) => tag.name).filter(Boolean).join(", "),
    });
    const people: AppItemPerson[] = [];
    if (conversation.assignee?.email) people.push({ name: teammateName(conversation.assignee), email: conversation.assignee.email });
    const handle = conversation.recipient?.handle;
    if (handle?.includes("@")) people.push({ name: conversation.recipient?.name || handle, email: handle });
    const item = conversationItem(conversation);
    return { ...item, facts: list, people, text: itemMarkdown(item.title, list, thread ? `## Latest messages\n\n${thread}` : "") };
  },
  async people(ctx) {
    const { _results: teammates } = await call<{ _results: Teammate[] }>(ctx, "/teammates");
    return teammates
      .filter((teammate) => !teammate.is_blocked && (teammate.email || teammateName(teammate)))
      .map((teammate) => ({ name: teammateName(teammate), ...(teammate.email ? { email: teammate.email } : {}), ...(teammate.username ? { handle: teammate.username } : {}) }));
  },
  fromUrl(url) {
    const id = /frontapp\.com\//i.test(url) ? frontConversationId(url) : null;
    return id ? { kind: "conversation", id } : null;
  },
  async comment(ctx, ref, body) {
    const id = requireId(ref.id);
    await call(ctx, `/conversations/${id}/comments`, { method: "POST", body: { body } });
    return { url: conversationUrl(id) };
  },
};
