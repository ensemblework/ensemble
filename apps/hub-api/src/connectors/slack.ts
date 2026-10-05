/**
 * Slack, read-only: direct messages and group DMs always, plus any channel
 * named in the connector scope (Settings → Connections). Mentions of you in
 * those channels go to triage; everything else is context.
 */
import { getAccount } from "./accounts.js";
import { upsertArtifact, upsertPerson } from "./ingest.js";
import { ConnectorError, type SyncContext, type SyncResult } from "./types.js";

async function slack<T extends { ok: boolean; error?: string }>(token: string, method: string, params: Record<string, string>): Promise<T> {
  const response = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 429) throw new ConnectorError(`Slack is rate limiting. Retry after ${response.headers.get("retry-after") ?? "a minute"}s.`);
  const body = (await response.json()) as T;
  if (!body.ok) {
    const reconnect = ["invalid_auth", "not_authed", "token_revoked", "account_inactive"].includes(body.error ?? "");
    throw new ConnectorError(`Slack ${method} failed: ${body.error}.`, reconnect);
  }
  return body;
}

interface Conversation {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  user?: string;
}

interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
  thread_ts?: string;
}

export async function syncSlack(ctx: SyncContext): Promise<SyncResult> {
  const account = await getAccount(ctx.userId, "slack");
  if (!account) throw new ConnectorError("Slack is not connected. Paste a Slack token in Settings → Connections.", true);
  const token = account.accessToken;
  const auth = await slack<{ ok: boolean; user_id: string; user: string; team: string; url: string }>(token, "auth.test", {});
  const wanted = new Set(
    (ctx.settings.connections.slack?.scope ?? "")
      .split(",")
      .map((name) => name.trim().replace(/^#/, "").toLowerCase())
      .filter(Boolean),
  );
  const conversations: Conversation[] = [];
  let cursor = "";
  do {
    const page = await slack<{ ok: boolean; channels: Conversation[]; response_metadata?: { next_cursor?: string } }>(token, "users.conversations", {
      types: "im,mpim,public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });
    conversations.push(...page.channels);
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor && conversations.length < 1000);

  const chosen = conversations.filter((row) => row.is_im || row.is_mpim || (row.name && wanted.has(row.name.toLowerCase()))).slice(0, 40);
  const names = new Map<string, { name: string; email: string | null }>();
  const who = async (id: string): Promise<{ name: string; email: string | null }> => {
    const cached = names.get(id);
    if (cached) return cached;
    try {
      const info = await slack<{ ok: boolean; user: { real_name?: string; name: string; profile?: { email?: string; real_name?: string } } }>(token, "users.info", { user: id });
      const value = { name: info.user.profile?.real_name || info.user.real_name || info.user.name, email: info.user.profile?.email ?? null };
      names.set(id, value);
      return value;
    } catch {
      const value = { name: id, email: null };
      names.set(id, value);
      return value;
    }
  };

  const result: SyncResult = { items: 0, stored: [], proposals: [], triage: [], account: `${auth.user} @ ${auth.team}` };
  const oldest = (ctx.since.getTime() / 1000).toFixed(6);
  for (const conversation of chosen) {
    const history = await slack<{ ok: boolean; messages: SlackMessage[] }>(token, "conversations.history", {
      channel: conversation.id,
      oldest,
      limit: "50",
    });
    const label = conversation.is_im ? `DM with ${(await who(conversation.user ?? "")).name}` : conversation.is_mpim ? "Group DM" : `#${conversation.name}`;
    for (const message of history.messages) {
      if (!message.text || message.bot_id || (message.subtype && message.subtype !== "thread_broadcast")) continue;
      const author = message.user ? await who(message.user) : { name: "unknown", email: null };
      const mine = message.user === auth.user_id;
      const at = new Date(Number(message.ts) * 1000);
      const personId = mine
        ? null
        : await upsertPerson(ctx.userId, { email: author.email, name: author.name, handle: message.user ? `slack:${message.user}` : null, at, evidence: `slack:${conversation.id}` }, [ctx.settings.email]);
      const mentionsMe = message.text.includes(`<@${auth.user_id}>`);
      const text = await replaceMentions(message.text, who);
      const stored = await upsertArtifact(ctx.userId, {
        kind: conversation.is_im || conversation.is_mpim ? "chat_msg" : "channel_msg",
        externalId: `${conversation.id}:${message.ts}`,
        threadId: `${conversation.id}:${message.thread_ts ?? message.ts}`,
        url: `${auth.url}archives/${conversation.id}/p${message.ts.replace(".", "")}`,
        ts: at,
        title: `${label} · ${author.name}`,
        text,
        authoredByMe: mine,
        actorId: personId,
        participants: [{ name: author.name, email: author.email, handle: message.user ?? null }],
        metadata: { channel: conversation.id, channelName: label, mentionsMe, direct: Boolean(conversation.is_im) },
      });
      result.items += 1;
      result.stored.push(stored);
      if (stored.created && !mine && (conversation.is_im || conversation.is_mpim || mentionsMe)) result.triage.push({ ...stored, personId });
    }
  }
  return result;
}

async function replaceMentions(text: string, who: (id: string) => Promise<{ name: string }>): Promise<string> {
  const ids = [...new Set([...text.matchAll(/<@([A-Z0-9]+)>/g)].map((match) => match[1]!))];
  let out = text;
  for (const id of ids) out = out.replaceAll(`<@${id}>`, `@${(await who(id)).name}`);
  return out;
}
