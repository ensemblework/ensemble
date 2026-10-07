/**
 * Outlook mail, Outlook calendar and Teams chats through Microsoft Graph
 * (docs/03 §2). Uses the person's own Microsoft 365 sign-in from
 * oauth_tokens. Sync only reads; calendar writes go through the assistant
 * and wait for Apply.
 */
import { prisma } from "../lib/prisma.js";
import { stripQuoted } from "./google.js";
import { htmlToText, upsertArtifact, upsertPerson } from "./ingest.js";
import { hasScopes, syncAccount } from "./tokens.js";
import { ConnectorError, readJson, type SyncContext, type SyncResult } from "./types.js";

export const GRAPH = "https://graph.microsoft.com/v1.0";

const MAIL_PER_FOLDER = 100;
const CALENDAR_MAX = 1000;
const CHATS_MAX = 40;
const MESSAGES_PER_CHAT = 50;

/** OData query string. Graph wants the `$` of system query options left as is. */
export function odata(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");
}

interface GraphAccount {
  token: string;
  account: string | null;
  graphUserId: string | null;
}

async function graphAccount(userId: string, scopes: readonly string[], label: string): Promise<GraphAccount> {
  const account = await syncAccount(userId, "microsoft");
  if (!account) throw new ConnectorError("Microsoft 365 is not connected. Connect it in Settings → Connections.", true);
  if (!hasScopes(account, scopes)) {
    throw new ConnectorError(`${label} is switched off for Microsoft 365. Turn it on in Settings → Connections and approve the access.`, true);
  }
  const graphUserId = typeof account.meta.graphUserId === "string" ? account.meta.graphUserId : null;
  return { token: account.accessToken, account: account.account, graphUserId };
}

/** Follows @odata.nextLink until `max` rows, and never off Graph. */
export async function graphPages<T>(token: string, url: string, label: string, max: number, headers: Record<string, string> = {}): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next && out.length < max) {
    const page: { value?: T[]; "@odata.nextLink"?: string } = await readJson(
      await fetch(next, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...headers } }),
      label,
    );
    out.push(...(page.value ?? []));
    const link: string | undefined = page["@odata.nextLink"];
    next = link && link.startsWith(`${GRAPH}/`) ? link : undefined;
  }
  return out.slice(0, max);
}

// ── Outlook mail ────────────────────────────────────────────────────────────

interface GraphRecipient {
  emailAddress?: { name?: string | null; address?: string | null };
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string | null;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  webLink?: string;
  isDraft?: boolean;
  inferenceClassification?: string;
}

type Address = { name: string | null; email: string | null };

const address = (recipient: GraphRecipient | undefined): Address => ({
  name: recipient?.emailAddress?.name?.trim() || null,
  email: recipient?.emailAddress?.address?.trim().toLowerCase() || null,
});

const formatted = (row: Address): string => (row.name && row.email ? `${row.name} <${row.email}>` : row.email ?? row.name ?? "");

/** One Graph message as an email artifact input. Exported for tests. */
export function outlookMessageInput(message: GraphMessage, folder: "inbox" | "sent", self: Array<string | null | undefined>) {
  const from = address(message.from);
  const to = (message.toRecipients ?? []).map(address).filter((row) => row.email);
  const cc = (message.ccRecipients ?? []).map(address).filter((row) => row.email);
  const raw = message.body?.content ?? "";
  const text = (message.body?.contentType?.toLowerCase() === "html" ? htmlToText(raw) : raw)
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  const mine = self.filter(Boolean).map((value) => value!.toLowerCase());
  return {
    from,
    to,
    sent: folder === "sent",
    at: new Date(message.receivedDateTime ?? message.sentDateTime ?? Date.now()),
    input: {
      kind: "email" as const,
      externalId: `outlook:${message.id}`,
      threadId: message.conversationId ? `outlook:${message.conversationId}` : null,
      url: message.webLink ?? null,
      ts: new Date(message.receivedDateTime ?? message.sentDateTime ?? Date.now()),
      title: message.subject?.trim() || "(no subject)",
      text: stripQuoted(text) || message.bodyPreview || "",
      authoredByMe: folder === "sent",
      participants: [from, ...to, ...cc],
      metadata: {
        source: "outlook",
        from: formatted(from),
        to: to.map(formatted).join(", "),
        cc: cc.map(formatted).join(", "),
        snippet: message.bodyPreview ?? "",
        directlyToMe: to.some((row) => row.email && mine.includes(row.email)),
      },
    },
  };
}

const MAIL_SELECT = "id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,webLink,isDraft,inferenceClassification";
const TEXT_BODY = { Prefer: 'outlook.body-content-type="text"' };

export async function syncOutlook(ctx: SyncContext): Promise<SyncResult> {
  const { token, account } = await graphAccount(ctx.userId, ["Mail.Read"], "Outlook mail");
  const since = ctx.since.toISOString();
  const folders: Array<{ folder: "inbox" | "sent"; path: string; field: string }> = [
    { folder: "inbox", path: "inbox", field: "receivedDateTime" },
    { folder: "sent", path: "sentitems", field: "sentDateTime" },
  ];
  const result: SyncResult = { items: 0, stored: [], proposals: [], triage: [], account };
  const self = [account, ctx.settings.email];
  for (const { folder, path, field } of folders) {
    const url = `${GRAPH}/me/mailFolders/${path}/messages?${odata({ $filter: `${field} ge ${since}`, $orderby: `${field} desc`, $top: 50, $select: MAIL_SELECT })}`;
    const messages = await graphPages<GraphMessage>(token, url, "Outlook", MAIL_PER_FOLDER, TEXT_BODY);
    for (const message of messages) {
      // "Other" is Outlook's sorted-away pile: newsletters and notifications, like Gmail's promotions tab.
      if (message.isDraft || (folder === "inbox" && message.inferenceClassification === "other")) continue;
      const parsed = outlookMessageInput(message, folder, self);
      const evidence = `outlook:${message.conversationId ?? message.id}`;
      const personId = parsed.sent ? null : await upsertPerson(ctx.userId, { email: parsed.from.email, name: parsed.from.name, at: parsed.at, evidence }, self);
      for (const recipient of parsed.sent ? parsed.to : []) {
        await upsertPerson(ctx.userId, { email: recipient.email, name: recipient.name, at: parsed.at, evidence }, self);
      }
      const stored = await upsertArtifact(ctx.userId, { ...parsed.input, actorId: personId });
      result.items += 1;
      result.stored.push(stored);
      if (stored.created && !parsed.sent) result.triage.push({ ...stored, personId });
    }
  }
  return result;
}

// ── Outlook calendar ────────────────────────────────────────────────────────

export interface GraphEvent {
  id: string;
  subject?: string | null;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  showAs?: string;
  location?: { displayName?: string | null };
  webLink?: string;
  onlineMeeting?: { joinUrl?: string | null } | null;
  onlineMeetingUrl?: string | null;
  attendees?: Array<GraphRecipient & { type?: string; status?: { response?: string } }>;
  organizer?: GraphRecipient;
  responseStatus?: { response?: string };
}

/** Graph returns times in UTC when asked (Prefer: outlook.timezone="UTC"), without a zone suffix. */
const utc = (value: string | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** One Graph event as an event artifact input, or null when it should not be on the calendar. Exported for tests. */
export function outlookEventInput(event: GraphEvent) {
  if (event.isCancelled || event.responseStatus?.response === "declined") return null;
  const start = utc(event.start?.dateTime);
  if (!start) return null;
  const end = utc(event.end?.dateTime);
  const joinUrl = event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? null;
  return {
    kind: "event" as const,
    externalId: `outlook:${event.id}`,
    url: event.webLink ?? null,
    ts: start,
    title: event.subject?.trim() || "(busy)",
    text: event.body?.contentType?.toLowerCase() === "html" ? htmlToText(event.body.content ?? "") : (event.body?.content ?? event.bodyPreview ?? ""),
    participants: (event.attendees ?? []).map((row) => ({ name: row.emailAddress?.name ?? null, email: row.emailAddress?.address?.toLowerCase() ?? null })),
    authoredByMe: Boolean(event.isOrganizer),
    metadata: {
      source: "outlook",
      end: end ? end.toISOString() : null,
      allDay: Boolean(event.isAllDay),
      joinUrl,
      location: event.location?.displayName || null,
      organizer: event.organizer?.emailAddress?.address?.toLowerCase() ?? null,
      eventId: event.id,
    },
  };
}

const EVENT_SELECT = "id,subject,bodyPreview,body,start,end,isAllDay,isCancelled,isOrganizer,showAs,location,webLink,onlineMeeting,onlineMeetingUrl,attendees,organizer,responseStatus";

export async function syncOutlookCalendar(ctx: SyncContext): Promise<SyncResult> {
  const { token, account } = await graphAccount(ctx.userId, ["Calendars.ReadWrite"], "Outlook calendar");
  const from = new Date(Date.now() - 7 * 86_400_000);
  const to = new Date(Date.now() + 21 * 86_400_000);
  const url = `${GRAPH}/me/calendarView?${odata({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: 100, $select: EVENT_SELECT, $orderby: "start/dateTime" })}`;
  const events = await graphPages<GraphEvent>(token, url, "Outlook calendar", CALENDAR_MAX, { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' });
  const result: SyncResult = { items: 0, stored: [], proposals: [], triage: [], account };
  const seen: string[] = [];
  const self = [account, ctx.settings.email];
  for (const event of events) {
    const input = outlookEventInput(event);
    if (!input) continue;
    for (const attendee of event.attendees ?? []) {
      await upsertPerson(
        ctx.userId,
        { email: attendee.emailAddress?.address, name: attendee.emailAddress?.name, at: input.ts, evidence: `outlook_calendar:${event.id}` },
        self,
      );
    }
    const stored = await upsertArtifact(ctx.userId, input);
    seen.push(input.externalId);
    result.items += 1;
    result.stored.push(stored);
  }
  // Events moved out of the window or cancelled at the source leave the Today calendar.
  await prisma.artifact.updateMany({
    where: { userId: ctx.userId, kind: "event", ts: { gte: from, lt: to }, externalId: { notIn: seen }, deletedAt: null, metadata: { path: ["source"], equals: "outlook" } },
    data: { deletedAt: new Date() },
  });
  return result;
}

// ── Teams chats ─────────────────────────────────────────────────────────────

interface ChatMember {
  userId?: string | null;
  displayName?: string | null;
  email?: string | null;
}

export interface GraphChat {
  id: string;
  topic?: string | null;
  chatType?: "oneOnOne" | "group" | "meeting" | string;
  lastUpdatedDateTime?: string;
  webUrl?: string | null;
  members?: ChatMember[];
}

export interface GraphChatMessage {
  id: string;
  messageType?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  deletedDateTime?: string | null;
  webUrl?: string | null;
  from?: { user?: { id?: string; displayName?: string | null } | null; application?: unknown } | null;
  body?: { contentType?: string; content?: string };
  mentions?: Array<{ mentioned?: { user?: { id?: string } | null } }>;
}

function chatLabel(chat: GraphChat, me: string | null): string {
  if (chat.topic) return chat.topic;
  const others = (chat.members ?? []).filter((member) => member.userId !== me).map((member) => member.displayName).filter(Boolean);
  if (chat.chatType === "oneOnOne") return `Chat with ${others[0] ?? "someone"}`;
  return others.length ? `Group chat with ${others.slice(0, 3).join(", ")}${others.length > 3 ? "…" : ""}` : "Group chat";
}

/** One Teams chat message as an artifact input, or null for system and deleted messages. Exported for tests. */
export function teamsMessageInput(chat: GraphChat, message: GraphChatMessage, me: string | null) {
  if (message.messageType !== "message" || message.deletedDateTime || !message.from?.user?.id) return null;
  const authorId = message.from.user.id;
  const member = chat.members?.find((row) => row.userId === authorId);
  const author = { name: message.from.user.displayName ?? member?.displayName ?? "Someone", email: member?.email?.toLowerCase() ?? null };
  const raw = message.body?.content ?? "";
  const text = message.body?.contentType?.toLowerCase() === "html" ? htmlToText(raw) : raw;
  if (!text.trim()) return null;
  const mine = Boolean(me && authorId === me);
  const mentionsMe = Boolean(me && message.mentions?.some((row) => row.mentioned?.user?.id === me));
  const direct = chat.chatType === "oneOnOne";
  const label = chatLabel(chat, me);
  return {
    mine,
    author,
    authorId,
    asksMe: !mine && (direct || mentionsMe),
    input: {
      kind: "chat_msg" as const,
      externalId: `teams:${chat.id}:${message.id}`,
      threadId: `teams:${chat.id}`,
      url: message.webUrl ?? `https://teams.microsoft.com/l/message/${encodeURIComponent(chat.id)}/${encodeURIComponent(message.id)}`,
      ts: new Date(message.createdDateTime ?? Date.now()),
      title: `${label} · ${author.name}`,
      text,
      authoredByMe: mine,
      participants: [{ name: author.name, email: author.email, handle: `teams:${authorId}` }],
      metadata: { source: "teams", chat: chat.id, chatName: label, chatType: chat.chatType ?? null, mentionsMe, direct },
    },
  };
}

/** Chats with the newest message first. Some tenants refuse the ordering; then take Graph's default order. */
async function recentChats(token: string): Promise<GraphChat[]> {
  const ordered = `${GRAPH}/me/chats?${odata({ $expand: "members", $top: 50, $orderby: "lastMessagePreview/createdDateTime desc" })}`;
  try {
    return await graphPages<GraphChat>(token, ordered, "Teams", CHATS_MAX * 2);
  } catch (error) {
    if (!(error instanceof ConnectorError) || !/answered 400/.test(error.message)) throw error;
    return graphPages<GraphChat>(token, `${GRAPH}/me/chats?${odata({ $expand: "members", $top: 50 })}`, "Teams", CHATS_MAX * 2);
  }
}

export async function syncTeams(ctx: SyncContext): Promise<SyncResult> {
  const graph = await graphAccount(ctx.userId, ["Chat.Read"], "Teams chats");
  const { token, account } = graph;
  let me = graph.graphUserId;
  if (!me) me = (await readJson<{ id?: string }>(await fetch(`${GRAPH}/me?$select=id`, { headers: { Authorization: `Bearer ${token}` } }), "Microsoft 365")).id ?? null;
  const since = ctx.since;
  const chats = (await recentChats(token))
    .filter((chat) => chat.chatType === "oneOnOne" || chat.chatType === "group")
    .slice(0, CHATS_MAX);
  const result: SyncResult = { items: 0, stored: [], proposals: [], triage: [], account };
  const self = [account, ctx.settings.email];
  for (const chat of chats) {
    const url = `${GRAPH}/me/chats/${encodeURIComponent(chat.id)}/messages?${odata({
      $top: MESSAGES_PER_CHAT,
      $orderby: "lastModifiedDateTime desc",
      $filter: `lastModifiedDateTime gt ${since.toISOString()}`,
    })}`;
    const messages = await graphPages<GraphChatMessage>(token, url, "Teams", MESSAGES_PER_CHAT);
    for (const message of messages) {
      const parsed = teamsMessageInput(chat, message, me);
      if (!parsed) continue;
      const personId = parsed.mine
        ? null
        : await upsertPerson(
            ctx.userId,
            { email: parsed.author.email, name: parsed.author.name, handle: `teams:${parsed.authorId}`, at: parsed.input.ts, evidence: `teams:${chat.id}` },
            self,
          );
      const stored = await upsertArtifact(ctx.userId, { ...parsed.input, actorId: personId });
      result.items += 1;
      result.stored.push(stored);
      if (stored.created && parsed.asksMe) result.triage.push({ ...stored, personId });
    }
  }
  return result;
}
