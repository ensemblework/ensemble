/**
 * Slack: channels (latest messages) and people (profiles), and the workspace's
 * people. Read only: Slack has no comment target here, and the connection has no
 * search scope, so channel and person searches match names from the lists.
 * Ids: Slack channel ids (C…, G…) and user ids (U…, W…).
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { ConnectorNotConnectedError } from "../../tokens.js";
import { facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, MAX_PEOPLE, type ItemContext, type ItemSource } from "../types.js";

const API = "https://slack.com/api";
const LABEL = "Slack";
const LIST_PAGES = 5;
const HISTORY = 50;
/** Distinct authors looked up per channel read; the rest show as their ids. */
const NAME_LOOKUPS = 25;

const RECONNECT = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);

interface Channel {
  id: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

interface User {
  id: string;
  name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  real_name?: string;
  tz?: string;
  tz_label?: string;
  profile?: { real_name?: string; display_name?: string; title?: string; email?: string; status_text?: string };
}

interface Message {
  ts: string;
  user?: string;
  username?: string;
  text?: string;
  subtype?: string;
  reply_count?: number;
}

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
const USER_ID = /^[UW][A-Z0-9]{6,}$/;

/** A Slack channel link (/archives/C…, /client/T…/C…) or profile link (/team/U…). */
export function slackRef(text: string): { kind: "channel" | "person"; id: string } | null {
  const value = text.trim();
  if (!/^https?:\/\/[a-z0-9.-]*slack\.com\//i.test(value)) return null;
  const channel = /\/(?:archives|client\/[A-Z0-9]+)\/([CG][A-Z0-9]{6,})/i.exec(value);
  if (channel) return { kind: "channel", id: channel[1]!.toUpperCase() };
  const user = /\/team\/([UW][A-Z0-9]{6,})/i.exec(value);
  return user ? { kind: "person", id: user[1]!.toUpperCase() } : null;
}

/** Slack answers 200 with ok:false; this turns its error code into something a person can act on. */
function slackError(code: string | undefined, needed: string | undefined): Error {
  const error = /^[a-z_]+$/.test(code ?? "") ? code! : "unknown_error";
  if (RECONNECT.has(error)) return new ConnectorNotConnectedError("slack", `${LABEL} no longer accepts the saved sign-in. Connect it again in Settings → Connections.`);
  if (error === "missing_scope") {
    const scope = needed && /^[a-z:._,]+$/.test(needed) ? ` (${needed})` : "";
    return new ItemError(`The Slack connection lacks the permission this needs${scope}. Connect Slack again in Settings → Connections and approve it.`, 403);
  }
  if (error === "not_in_channel") return new ItemError("You are not in that Slack channel, so Ensemble cannot read it. Join it in Slack first.", 403);
  if (error === "channel_not_found" || error === "user_not_found") return new ItemError("Slack could not find that. It may be private, deleted or in another workspace.", 404);
  if (error === "ratelimited") return new ItemError("Slack is rate limiting requests. Try again in a minute.", 429);
  return new ItemError(`Slack answered with an error: ${error}.`);
}

async function slack<T>(ctx: ItemContext, method: string, params: Record<string, string>): Promise<T> {
  const body = await itemFetch<T & { ok?: boolean; error?: string; needed?: string }>(ctx, "slack", LABEL, `${API}/${method}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${ctx.token.token}` },
  });
  if (!body.ok) throw slackError(body.error, body.needed);
  return body;
}

async function listAll<T>(ctx: ItemContext, method: string, key: "channels" | "members", params: Record<string, string>, enough: (rows: T[]) => boolean, pages = LIST_PAGES): Promise<T[]> {
  const out: T[] = [];
  let cursor = "";
  for (let page = 0; page < pages; page += 1) {
    const body = await slack<{ channels?: T[]; members?: T[]; response_metadata?: { next_cursor?: string } }>(ctx, method, { ...params, limit: "200", ...(cursor ? { cursor } : {}) });
    out.push(...(body[key] ?? []));
    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor || enough(out)) break;
  }
  return out;
}

function workspaceUrl(ctx: ItemContext): string | null {
  const url = ctx.token.extra?.url ?? "";
  return /^https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\/$/.test(url) ? url : null;
}

function channelLink(ctx: ItemContext, id: string): string | undefined {
  const base = workspaceUrl(ctx);
  if (base) return `${base}archives/${id}`;
  const team = ctx.token.extra?.teamId;
  return team && /^[TE][A-Z0-9]+$/.test(team) ? `https://app.slack.com/client/${team}/${id}` : undefined;
}

function personLink(ctx: ItemContext, id: string): string | undefined {
  const base = workspaceUrl(ctx);
  return base ? `${base}team/${id}` : undefined;
}

const hit = ({ source, kind, id, title, subtitle, url, updatedAt }: AppItem): AppItem => ({ source, kind, id, title, subtitle, url, updatedAt });
const displayName = (user: User) => user.profile?.real_name || user.real_name || user.profile?.display_name || user.name || user.id;
const isPerson = (user: User) => !user.deleted && !user.is_bot && !user.is_app_user && user.id !== "USLACKBOT";
const stamp = (ts: string) => new Date(Number(ts) * 1000).toISOString();

function channelItem(ctx: ItemContext, channel: Channel): AppItem {
  return {
    source: "slack",
    kind: "channel",
    id: channel.id,
    title: channel.name ? `#${channel.name}` : channel.id,
    subtitle: [
      channel.is_private ? "Private channel" : "Channel",
      channel.num_members !== undefined ? `${channel.num_members} members` : null,
      channel.purpose?.value || channel.topic?.value || null,
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 160),
    url: channelLink(ctx, channel.id),
  };
}

function personItem(ctx: ItemContext, user: User): AppItem {
  return {
    source: "slack",
    kind: "person",
    id: user.id,
    title: displayName(user),
    subtitle: [user.profile?.title, user.profile?.email].filter(Boolean).join(" · "),
    url: personLink(ctx, user.id),
  };
}

/** Slack's markup (<@U1>, <#C1|name>, <url|label>) as plain text. */
export function slackText(text: string, names: ReadonlyMap<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_all, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function userNames(ctx: ItemContext, ids: Iterable<string>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)].filter((id) => USER_ID.test(id)).slice(0, NAME_LOOKUPS);
  const found = await Promise.all(
    wanted.map((id) =>
      slack<{ user: User }>(ctx, "users.info", { user: id }).then(
        (body) => [id, displayName(body.user)] as const,
        (error: unknown) => {
          if (error instanceof ConnectorNotConnectedError) throw error;
          return [id, id] as const;
        },
      ),
    ),
  );
  return new Map(found);
}

async function readChannel(ctx: ItemContext, id: string): Promise<AppItemContent> {
  if (!CHANNEL_ID.test(id)) throw new ItemError("That is not a Slack channel id.", 400);
  const [info, history] = await Promise.all([
    // channels:read is optional: without it the channel still reads, just without its name.
    slack<{ channel: Channel }>(ctx, "conversations.info", { channel: id }).catch((error: unknown) => {
      if (error instanceof ItemError && error.statusCode === 403) return null;
      throw error;
    }),
    slack<{ messages?: Message[] }>(ctx, "conversations.history", { channel: id, limit: String(HISTORY) }),
  ]);
  const channel = info?.channel ?? { id };
  const messages = (history.messages ?? []).filter((message) => message.text && (!message.subtype || message.subtype === "thread_broadcast" || message.subtype === "bot_message")).reverse();
  const mentioned = messages.flatMap((message) => [message.user ?? "", ...[...(message.text ?? "").matchAll(/<@([UW][A-Z0-9]+)/g)].map((match) => match[1]!)]);
  const names = await userNames(ctx, mentioned);
  const lines = messages.map((message) => {
    const who = message.user ? (names.get(message.user) ?? message.user) : (message.username ?? "app");
    const replies = message.reply_count ? ` (${message.reply_count} ${message.reply_count === 1 ? "reply" : "replies"})` : "";
    return `**${who}** (${stamp(message.ts).slice(0, 16).replace("T", " ")} UTC): ${slackText(message.text ?? "", names)}${replies}`;
  });
  const item = channelItem(ctx, channel);
  const list = facts({
    Type: channel.is_private ? "Private channel" : info ? "Public channel" : null,
    Members: channel.num_members,
    Topic: channel.topic?.value,
    Purpose: channel.purpose?.value,
    Archived: channel.is_archived ? "yes" : null,
    "Messages shown": `latest ${messages.length}`,
  });
  const authors = new Set(messages.map((message) => message.user).filter((user): user is string => Boolean(user)));
  return {
    ...item,
    updatedAt: messages.length ? stamp(messages.at(-1)!.ts) : undefined,
    facts: list,
    people: [...authors].map((handle) => ({ name: names.get(handle) ?? handle, handle })),
    text: itemMarkdown(item.title, list, lines.join("\n\n")),
  };
}

async function readPerson(ctx: ItemContext, id: string): Promise<AppItemContent> {
  if (!USER_ID.test(id)) throw new ItemError("That is not a Slack user id.", 400);
  const { user } = await slack<{ user: User }>(ctx, "users.info", { user: id });
  const list = facts({
    Title: user.profile?.title,
    Email: user.profile?.email,
    "Display name": user.profile?.display_name,
    "Time zone": user.tz_label ?? user.tz,
    Status: user.profile?.status_text,
    Deactivated: user.deleted ? "yes" : null,
  });
  const item = personItem(ctx, user);
  return { ...item, facts: list, people: [{ name: item.title, handle: user.id, ...(user.profile?.email ? { email: user.profile.email } : {}), ...(user.profile?.title ? { title: user.profile.title } : {}) }], text: itemMarkdown(item.title, list, "") };
}

export const slackItems: ItemSource = {
  id: "slack",
  provider: "slack",
  label: LABEL,
  kinds: ["channel", "person"],
  async search(ctx, query) {
    const direct = slackRef(query.q);
    if (direct && (!query.kind || query.kind === direct.kind)) return [hit(direct.kind === "channel" ? await readChannel(ctx, direct.id) : await readPerson(ctx, direct.id))];
    const needle = query.q.trim().replace(/^[#@]/, "").toLowerCase().slice(0, 200);
    const peopleCount = query.kind ? query.limit : Math.min(5, query.limit);
    const out: AppItem[] = [];
    let channelError: unknown = null;
    if (!query.kind || query.kind === "channel") {
      try {
        const params = { types: "public_channel,private_channel", exclude_archived: "true" };
        const named = (row: Channel) => (row.name ?? "").toLowerCase().includes(needle);
        const matching = needle
          ? (await listAll<Channel>(ctx, "conversations.list", "channels", params, (rows) => rows.filter(named).length >= query.limit)).filter(named)
          : await listAll<Channel>(ctx, "users.conversations", "channels", params, (rows) => rows.length >= query.limit, 1);
        matching.sort((a, b) => Number(Boolean(b.is_member)) - Number(Boolean(a.is_member)) || (b.num_members ?? 0) - (a.num_members ?? 0));
        out.push(...matching.slice(0, query.limit).map((row) => channelItem(ctx, row)));
      } catch (error) {
        if (query.kind || !(error instanceof ItemError)) throw error;
        channelError = error;
      }
    }
    if (!query.kind || query.kind === "person") {
      const matches = (user: User) =>
        [user.real_name, user.name, user.profile?.display_name, user.profile?.email, user.profile?.title].some((value) => (value ?? "").toLowerCase().includes(needle));
      const users = await listAll<User>(ctx, "users.list", "members", {}, (rows) => !needle || rows.filter((row) => isPerson(row) && matches(row)).length >= peopleCount);
      out.push(...users.filter((user) => isPerson(user) && (!needle || matches(user))).slice(0, peopleCount).map((user) => personItem(ctx, user)));
    }
    if (!out.length && channelError) throw channelError;
    return out;
  },
  async read(ctx, ref) {
    return ref.kind === "person" ? readPerson(ctx, ref.id) : readChannel(ctx, ref.id);
  },
  async people(ctx) {
    const users = await listAll<User>(ctx, "users.list", "members", {}, (rows) => rows.filter(isPerson).length >= MAX_PEOPLE, 10);
    return users
      .filter(isPerson)
      .slice(0, MAX_PEOPLE)
      .map((user) => ({ name: displayName(user), handle: user.id, ...(user.profile?.email ? { email: user.profile.email } : {}), ...(user.profile?.title ? { title: user.profile.title } : {}) }));
  },
};
