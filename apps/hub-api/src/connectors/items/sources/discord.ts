/**
 * Discord: text and announcement channels in the servers this person added Ensemble's
 * bot to, and a channel's latest messages. Discord lets only bots read server channels,
 * so reads use the operator's bot token (DISCORD_BOT_TOKEN), limited to the servers saved
 * on this person's connection; their own token only says who connected.
 * Ids: the channel id.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { ConnectorNotConnectedError } from "../../tokens.js";
import { facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const API = "https://discord.com/api/v10";
const LABEL = "Discord";
const SNOWFLAKE = /^\d{5,25}$/;
/** Text (0) and announcement (5) channels. */
const READABLE = new Set([0, 5]);
const MAX_GUILDS = 10;

interface Guild {
  id: string;
  name: string;
}

interface Channel {
  id: string;
  type: number;
  name?: string;
  topic?: string | null;
  guild_id?: string;
  position?: number;
}

interface Message {
  id: string;
  content?: string;
  timestamp?: string;
  author?: { username?: string; global_name?: string | null; bot?: boolean };
  attachments?: Array<{ filename?: string }>;
  embeds?: Array<{ title?: string; description?: string }>;
}

function botToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) throw new ItemError("Discord is not set up on this server yet. The person who hosts Ensemble adds the Discord bot token once.", 409);
  return token;
}

function guilds(ctx: ItemContext): Guild[] {
  const saved = ctx.token.meta?.guilds;
  const list = Array.isArray(saved) ? (saved as Array<Partial<Guild>>).filter((guild): guild is Guild => typeof guild?.id === "string" && SNOWFLAKE.test(guild.id)) : [];
  if (!list.length) throw new ItemError("Ensemble's bot is not in any of your Discord servers. Connect Discord again and pick a server.", 409);
  return list;
}

async function bot<T>(ctx: ItemContext, path: string): Promise<T> {
  const token = botToken();
  // itemFetch keeps the token in ctx out of error messages; here that is the bot's.
  const asBot: ItemContext = { ...ctx, token: { ...ctx.token, token } };
  try {
    return await itemFetch<T>(asBot, "discord", LABEL, `${API}${path}`, { headers: { Authorization: `Bot ${token}` } });
  } catch (error) {
    if (error instanceof ConnectorNotConnectedError) throw new ItemError("Discord refused this server's bot token. The person who hosts Ensemble needs to check it.", 502);
    throw error;
  }
}

const channelUrl = (guildId: string, channelId: string) => `https://discord.com/channels/${guildId}/${channelId}`;

function channelItem(channel: Channel, guild: Guild): AppItem {
  return {
    source: "discord",
    kind: "channel",
    id: channel.id,
    title: `#${channel.name ?? channel.id}`,
    subtitle: [guild.name, channel.type === 5 ? "announcements" : null, channel.topic].filter(Boolean).join(" · ").slice(0, 160),
    url: channelUrl(guild.id, channel.id),
  };
}

/** "https://discord.com/channels/<server>/<channel>" → the channel id. */
export function discordChannelId(text: string): string | null {
  return /discord(?:app)?\.com\/channels\/\d{5,25}\/(\d{5,25})/i.exec(text.trim())?.[1] ?? null;
}

const authorName = (message: Message) => message.author?.global_name || message.author?.username || "Someone";

function messageText(message: Message): string {
  const parts = [message.content?.trim() ?? ""];
  for (const embed of message.embeds ?? []) parts.push([embed.title, embed.description].filter(Boolean).join(": "));
  for (const file of message.attachments ?? []) if (file.filename) parts.push(`[attachment: ${file.filename}]`);
  return parts.filter(Boolean).join("\n");
}

export const discordItems: ItemSource = {
  id: "discord",
  provider: "discord",
  label: LABEL,
  kinds: ["channel"],
  async search(ctx, query) {
    const direct = discordChannelId(query.q);
    if (direct) {
      const read = await this.read(ctx, { kind: "channel", id: direct });
      return [{ source: read.source, kind: read.kind, id: read.id, title: read.title, subtitle: read.subtitle, url: read.url }];
    }
    const needle = query.q.trim().replace(/^#/, "").toLowerCase();
    const out: AppItem[] = [];
    for (const guild of guilds(ctx).slice(0, MAX_GUILDS)) {
      const channels = await bot<Channel[]>(ctx, `/guilds/${guild.id}/channels`);
      const readable = channels.filter((channel) => READABLE.has(channel.type) && (!needle || (channel.name ?? "").toLowerCase().includes(needle)));
      out.push(...readable.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((channel) => channelItem(channel, guild)));
      if (out.length >= query.limit) break;
    }
    return out.slice(0, query.limit);
  },
  async read(ctx, ref): Promise<AppItemContent> {
    if (!SNOWFLAKE.test(ref.id)) throw new ItemError("That is not a Discord channel id.", 400);
    const allowed = guilds(ctx);
    const channel = await bot<Channel>(ctx, `/channels/${ref.id}`);
    const guild = allowed.find((row) => row.id === channel.guild_id);
    if (!guild) throw new ItemError("That channel is not in a Discord server you added Ensemble's bot to.", 403);
    if (!READABLE.has(channel.type)) throw new ItemError("Only text and announcement channels can be read.", 400);
    const messages = await bot<Message[]>(ctx, `/channels/${ref.id}/messages?limit=50`);
    const ordered = [...messages].sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
    const lines = ordered
      .map((message) => ({ message, text: messageText(message) }))
      .filter((row) => row.text)
      .map(({ message, text }) => `**${authorName(message)}** (${(message.timestamp ?? "").slice(0, 16).replace("T", " ")}): ${text}`);
    const people = new Map<string, AppItemPerson>();
    for (const message of ordered) {
      const handle = message.author?.username;
      if (handle && !message.author?.bot) people.set(handle, { name: authorName(message), handle });
    }
    const list = facts({ Server: guild.name, Topic: channel.topic, Messages: ordered.length });
    const item = channelItem(channel, guild);
    return {
      ...item,
      updatedAt: ordered[ordered.length - 1]?.timestamp,
      facts: list,
      people: [...people.values()],
      text: itemMarkdown(item.title, list, lines.length ? `## Latest messages\n\n${lines.join("\n")}` : "No messages Ensemble's bot can read."),
    };
  },
};
