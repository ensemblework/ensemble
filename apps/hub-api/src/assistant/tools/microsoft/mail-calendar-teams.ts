/** Outlook mail (read), Outlook calendar (read, create with invites), Teams chats (read), via Microsoft Graph. */
import { z } from "zod";
import { zonedParts } from "../../../lib/clock.js";
import { clip, htmlToText } from "../../../lib/office/text.js";
import { defineTool, toolOk } from "../../types.js";
import {
  UNTRUSTED_NOTE,
  When,
  addDays,
  appFetch,
  appToken,
  describeSpan,
  emailList,
  eventSpan,
  listWords,
  localStamp,
  pastWarning,
  plural,
  quote,
  rangeInstants,
  whose,
  type EventSpan,
} from "../apps-common.js";
import { GRAPH, OUTLOOK_CALENDAR_READ, OUTLOOK_CALENDAR_WRITE, OUTLOOK_MAIL, TEAMS } from "./meta.js";

/** OData query string. Graph wants a literal `$`; values are encoded. */
export function odata(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

interface Recipient {
  emailAddress?: { name?: string; address?: string };
}

const person = (row: Recipient | undefined): string => {
  const name = row?.emailAddress?.name;
  const address = row?.emailAddress?.address;
  return name && address && name !== address ? `${name} <${address}>` : address ?? name ?? "";
};

interface GraphMessage {
  id: string;
  subject?: string;
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  webLink?: string;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
}

const MESSAGE_FIELDS = "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,webLink";

export const outlookSearchMail = defineTool({
  name: "outlook_search_mail",
  area: "apps",
  app: OUTLOOK_MAIL,
  description: "Search the person's Outlook mail by words, sender or subject; without a query, the latest inbox mail.",
  input: z.object({
    query: z.string().max(300).default("").describe('Words to search for, e.g. "budget from:sam@fieldnote.example".'),
    max: z.number().int().min(1).max(25).default(10),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, OUTLOOK_MAIL);
    const query = input.query.replace(/"/g, " ").trim();
    const url = query
      ? `${GRAPH}/me/messages${odata({ $search: `"${query}"`, $top: input.max, $select: MESSAGE_FIELDS })}`
      : `${GRAPH}/me/mailFolders/inbox/messages${odata({ $top: input.max, $orderby: "receivedDateTime desc", $select: MESSAGE_FIELDS })}`;
    const body = await appFetch<{ value?: GraphMessage[] }>(ctx, OUTLOOK_MAIL, token, url);
    const messages = (body.value ?? []).map((message) => ({
      id: message.id,
      from: person(message.from),
      to: (message.toRecipients ?? []).map(person).slice(0, 8),
      subject: message.subject ?? "",
      received: localStamp(message.receivedDateTime, ctx.settings.timezone),
      preview: message.bodyPreview ?? "",
      unread: message.isRead === false,
      link: message.webLink,
    }));
    return toolOk(`Found ${plural(messages.length, "email")} in Outlook${query ? ` for ${quote(query)}` : ""}.`, { messages, note: UNTRUSTED_NOTE });
  },
});

export const outlookReadMessage = defineTool({
  name: "outlook_read_message",
  area: "apps",
  app: OUTLOOK_MAIL,
  description: "Read one Outlook email by id (from outlook_search_mail): headers and plain-text body.",
  input: z.object({
    id: z.string().min(1).max(400),
    offset: z.number().int().min(0).default(0).describe("Character offset for long bodies; use nextOffset from the last read."),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, OUTLOOK_MAIL);
    const message = await appFetch<GraphMessage>(
      ctx,
      OUTLOOK_MAIL,
      token,
      `${GRAPH}/me/messages/${encodeURIComponent(input.id)}${odata({ $select: "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,webLink,hasAttachments" })}`,
      { headers: { Prefer: 'outlook.body-content-type="text"' } },
    );
    const raw = message.body?.content ?? "";
    const text = message.body?.contentType?.toLowerCase() === "html" ? htmlToText(raw) : raw.replace(/\r\n/g, "\n").trim();
    const body = clip(text, input.offset, 5000);
    return toolOk(
      `Read the email ${quote(message.subject || "(no subject)")} from ${person(message.from) || "an unknown sender"}.`,
      {
        id: message.id,
        from: person(message.from),
        to: (message.toRecipients ?? []).map(person),
        cc: (message.ccRecipients ?? []).map(person),
        subject: message.subject ?? "",
        received: localStamp(message.receivedDateTime, ctx.settings.timezone),
        hasAttachments: message.hasAttachments ?? false,
        body: body.text,
        offset: body.offset,
        total: body.total,
        ...(body.nextOffset !== undefined ? { nextOffset: body.nextOffset } : {}),
        link: message.webLink,
        note: UNTRUSTED_NOTE,
      },
      message.webLink ? { href: message.webLink } : {},
    );
  },
});

interface GraphEvent {
  id: string;
  subject?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  organizer?: Recipient;
  attendees?: Array<Recipient & { status?: { response?: string } }>;
  webLink?: string;
  onlineMeeting?: { joinUrl?: string } | null;
}

/** Graph returns UTC wall times without a zone suffix when no Prefer header is sent. */
const graphInstant = (value: { dateTime?: string; timeZone?: string } | undefined): string | undefined => {
  if (!value?.dateTime) return undefined;
  return /Z|[+-]\d{2}:\d{2}$/.test(value.dateTime) || (value.timeZone && value.timeZone !== "UTC") ? value.dateTime : `${value.dateTime}Z`;
};

export const outlookCalendarListEvents = defineTool({
  name: "outlook_calendar_list_events",
  area: "apps",
  app: OUTLOOK_CALENDAR_READ,
  description: "List Outlook calendar events between two dates (inclusive), in the person's time zone.",
  input: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; defaults to today."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, inclusive; defaults to six days after from."),
    max: z.number().int().min(1).max(50).default(25),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const zone = ctx.settings.timezone;
    const today = zonedParts(zone).date;
    const { start, end } = rangeInstants(input.from, input.to, zone, today);
    const token = await appToken(ctx, OUTLOOK_CALENDAR_READ);
    const body = await appFetch<{ value?: GraphEvent[] }>(
      ctx,
      OUTLOOK_CALENDAR_READ,
      token,
      `${GRAPH}/me/calendarView${odata({
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
        $top: input.max,
        $orderby: "start/dateTime",
        $select: "id,subject,isAllDay,isCancelled,start,end,location,organizer,attendees,webLink,onlineMeeting",
      })}`,
    );
    const events = (body.value ?? [])
      .filter((event) => !event.isCancelled)
      .map((event) => ({
        id: event.id,
        title: event.subject ?? "(no title)",
        start: event.isAllDay ? event.start?.dateTime?.slice(0, 10) : localStamp(graphInstant(event.start), zone),
        end: event.isAllDay ? addDays(event.end?.dateTime?.slice(0, 10) ?? "", -1) : localStamp(graphInstant(event.end), zone),
        allDay: event.isAllDay ?? false,
        location: event.location?.displayName || undefined,
        organizer: person(event.organizer),
        attendees: (event.attendees ?? []).slice(0, 12).map((row) => `${person(row)} (${row.status?.response ?? "none"})`),
        teamsLink: event.onlineMeeting?.joinUrl,
        link: event.webLink,
      }));
    const from = input.from ?? today;
    return toolOk(`Read ${plural(events.length, "event")} from the Outlook calendar (${from} to ${input.to ?? addDays(from, 6)}).`, {
      timeZone: zone,
      events,
      note: UNTRUSTED_NOTE,
    });
  },
});

const graphTime = (span: EventSpan, which: "start" | "end") => {
  if (span.allDay) {
    const date = which === "start" ? span.start.date : addDays(span.end.date, 1);
    return { dateTime: `${date}T00:00:00`, timeZone: span.timeZone };
  }
  const wall = span[which];
  return { dateTime: `${wall.date}T${wall.time}:00`, timeZone: span.timeZone };
};

export const outlookCalendarCreateEvent = defineTool({
  name: "outlook_calendar_create_event",
  area: "apps",
  app: OUTLOOK_CALENDAR_WRITE,
  description: "Create an Outlook calendar event; with attendees, Outlook emails them invites. Can add a Teams meeting.",
  input: z.object({
    title: z.string().trim().min(1).max(300),
    start: When.describe("Local start, YYYY-MM-DDTHH:MM, or YYYY-MM-DD for an all-day event."),
    end: When.optional().describe("Local end (same format). Timed events default to 30 minutes; all-day events to one day (inclusive last day)."),
    timeZone: z.string().min(1).max(64).optional().describe("IANA zone such as Asia/Kolkata. Defaults to the person's zone."),
    attendees: emailList.default([]).describe("Guest email addresses. Outlook emails them an invite."),
    description: z.string().max(8000).optional(),
    location: z.string().max(500).optional(),
    teamsMeeting: z.boolean().default(false).describe("Add a Microsoft Teams meeting link (work or school accounts)."),
  }),
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const span = eventSpan(input.start, input.end, input.timeZone ?? ctx.settings.timezone);
    const where = await whose(ctx, "microsoft", "Outlook calendar");
    const guests = input.attendees.length ? ` and Outlook emails invites to ${listWords(input.attendees)}` : "";
    return [
      `Create event ${quote(input.title)} ${describeSpan(span)} in ${where}${guests}.${pastWarning(span)}`,
      input.teamsMeeting ? "Adds a Microsoft Teams meeting link." : "",
      input.location ? `Location: ${input.location}` : "",
      input.description ? `Description: ${quote(input.description)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
  async run(ctx, input) {
    const span = eventSpan(input.start, input.end, input.timeZone ?? ctx.settings.timezone);
    const token = await appToken(ctx, OUTLOOK_CALENDAR_WRITE);
    const created = await appFetch<GraphEvent>(ctx, OUTLOOK_CALENDAR_WRITE, token, `${GRAPH}/me/events`, {
      method: "POST",
      body: {
        subject: input.title,
        ...(input.description ? { body: { contentType: "text", content: input.description } } : {}),
        start: graphTime(span, "start"),
        end: graphTime(span, "end"),
        isAllDay: span.allDay,
        ...(input.location ? { location: { displayName: input.location } } : {}),
        ...(input.attendees.length ? { attendees: input.attendees.map((address) => ({ emailAddress: { address }, type: "required" })) } : {}),
        ...(input.teamsMeeting ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
      },
    });
    return toolOk(
      `Created ${quote(input.title)} ${describeSpan(span)} in the Outlook calendar${input.attendees.length ? `; Outlook sent invites to ${listWords(input.attendees)}` : ""}.`,
      { id: created.id, link: created.webLink, teamsLink: created.onlineMeeting?.joinUrl ?? null },
      created.webLink ? { href: created.webLink } : {},
    );
  },
});

interface GraphChat {
  id: string;
  topic?: string | null;
  chatType?: string;
  lastUpdatedDateTime?: string;
  webUrl?: string;
  members?: Array<{ displayName?: string; email?: string }>;
}

export const teamsListChats = defineTool({
  name: "teams_list_chats",
  area: "apps",
  app: TEAMS,
  description: "List the person's recent Microsoft Teams chats with their members.",
  input: z.object({ max: z.number().int().min(1).max(50).default(20) }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, TEAMS);
    const body = await appFetch<{ value?: GraphChat[] }>(ctx, TEAMS, token, `${GRAPH}/me/chats${odata({ $top: input.max, $expand: "members" })}`);
    const chats = (body.value ?? [])
      .sort((a, b) => (b.lastUpdatedDateTime ?? "").localeCompare(a.lastUpdatedDateTime ?? ""))
      .map((chat) => ({
        id: chat.id,
        topic: chat.topic || (chat.members ?? []).map((member) => member.displayName).filter(Boolean).slice(0, 6).join(", ") || "(untitled chat)",
        kind: chat.chatType,
        lastActive: localStamp(chat.lastUpdatedDateTime, ctx.settings.timezone),
        link: chat.webUrl,
      }));
    return toolOk(`Found ${plural(chats.length, "Teams chat")}.`, { chats });
  },
});

interface GraphChatMessage {
  id: string;
  messageType?: string;
  createdDateTime?: string;
  from?: { user?: { displayName?: string } | null; application?: { displayName?: string } | null } | null;
  body?: { contentType?: string; content?: string };
}

export const teamsReadChat = defineTool({
  name: "teams_read_chat",
  area: "apps",
  app: TEAMS,
  description: "Read the latest messages in one Microsoft Teams chat by id (from teams_list_chats), oldest first.",
  input: z.object({ chatId: z.string().min(1).max(400), max: z.number().int().min(1).max(50).default(30) }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, TEAMS);
    const body = await appFetch<{ value?: GraphChatMessage[] }>(
      ctx,
      TEAMS,
      token,
      `${GRAPH}/me/chats/${encodeURIComponent(input.chatId)}/messages${odata({ $top: input.max })}`,
    );
    const messages = (body.value ?? [])
      .filter((message) => (message.messageType ?? "message") === "message")
      .map((message) => ({
        from: message.from?.user?.displayName ?? message.from?.application?.displayName ?? "Someone",
        at: localStamp(message.createdDateTime, ctx.settings.timezone),
        sortKey: message.createdDateTime ?? "",
        text: (message.body?.contentType === "html" ? htmlToText(message.body.content ?? "") : (message.body?.content ?? "")).slice(0, 1500),
      }))
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map(({ sortKey: _sortKey, ...rest }) => rest);
    return toolOk(`Read ${plural(messages.length, "message")} from the Teams chat.`, { messages, note: UNTRUSTED_NOTE });
  },
});

export const microsoftMailCalendarTools = [outlookSearchMail, outlookReadMessage, outlookCalendarListEvents, outlookCalendarCreateEvent, teamsListChats, teamsReadChat];
