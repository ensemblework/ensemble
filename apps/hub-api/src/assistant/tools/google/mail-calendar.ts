/** Gmail (read) and Google Calendar (read, create, update). */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zonedParts } from "../../../lib/clock.js";
import { clip, htmlToText } from "../../../lib/office/text.js";
import { defineTool, toolOk, type ToolContext } from "../../types.js";
import {
  UNTRUSTED_NOTE,
  When,
  addDays,
  addMinutes,
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
import { CALENDAR_API, CALENDAR_READ, CALENDAR_WRITE, GMAIL, GMAIL_API } from "./meta.js";

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: Array<{ name: string; value: string }>;
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

const header = (message: GmailMessage, name: string): string =>
  message.payload?.headers?.find((row) => row.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const b64url = (data: string): string => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

export function gmailBody(part: GmailPart | undefined): string {
  if (!part) return "";
  const find = (node: GmailPart, type: string): string | null => {
    if (node.mimeType === type && node.body?.data && !node.filename) return b64url(node.body.data);
    for (const child of node.parts ?? []) {
      const found = find(child, type);
      if (found) return found;
    }
    return null;
  };
  const plain = find(part, "text/plain");
  if (plain) return plain.replace(/\r\n/g, "\n").trim();
  const html = find(part, "text/html");
  return html ? htmlToText(html) : "";
}

function attachments(part: GmailPart | undefined, out: string[] = []): string[] {
  if (!part) return out;
  if (part.filename) out.push(part.filename);
  for (const child of part.parts ?? []) attachments(child, out);
  return out;
}

const threadLink = (threadId: string) => `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;

export const gmailSearch = defineTool({
  name: "gmail_search",
  area: "apps",
  app: GMAIL,
  description: "Search the person's Gmail with Gmail search syntax. Returns sender, subject, date and snippet.",
  input: z.object({
    query: z.string().max(500).default("").describe("Gmail search, e.g. from:sam@fieldnote.example newer_than:7d"),
    max: z.number().int().min(1).max(20).default(10),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, GMAIL);
    const params = new URLSearchParams({ maxResults: String(input.max) });
    if (input.query.trim()) params.set("q", input.query.trim());
    const list = await appFetch<{ messages?: Array<{ id: string }> }>(ctx, GMAIL, token, `${GMAIL_API}/messages?${params}`);
    const metadata = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
    const rows = await Promise.all(
      (list.messages ?? []).map((row) =>
        appFetch<GmailMessage>(ctx, GMAIL, token, `${GMAIL_API}/messages/${encodeURIComponent(row.id)}?${metadata}`),
      ),
    );
    const messages = rows.map((message) => ({
      id: message.id,
      threadId: message.threadId,
      from: header(message, "From"),
      to: header(message, "To"),
      subject: header(message, "Subject"),
      date: header(message, "Date"),
      snippet: message.snippet ?? "",
      unread: message.labelIds?.includes("UNREAD") ?? false,
    }));
    return toolOk(`Found ${plural(messages.length, "email")} in Gmail${input.query.trim() ? ` for ${quote(input.query)}` : ""}.`, {
      messages,
      note: UNTRUSTED_NOTE,
    });
  },
});

export const gmailRead = defineTool({
  name: "gmail_read",
  area: "apps",
  app: GMAIL,
  description: "Read one Gmail message by id (from gmail_search): headers and plain-text body.",
  input: z.object({
    id: z.string().min(1).max(200),
    offset: z.number().int().min(0).default(0).describe("Character offset for long bodies; use nextOffset from the last read."),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const token = await appToken(ctx, GMAIL);
    const message = await appFetch<GmailMessage>(ctx, GMAIL, token, `${GMAIL_API}/messages/${encodeURIComponent(input.id)}?format=full`);
    const body = clip(gmailBody(message.payload), input.offset, 5000);
    const subject = header(message, "Subject");
    return toolOk(
      `Read the email ${quote(subject || "(no subject)")} from ${header(message, "From") || "an unknown sender"}.`,
      {
        id: message.id,
        threadId: message.threadId,
        from: header(message, "From"),
        to: header(message, "To"),
        cc: header(message, "Cc"),
        subject,
        date: header(message, "Date"),
        attachments: attachments(message.payload),
        body: body.text,
        offset: body.offset,
        total: body.total,
        ...(body.nextOffset !== undefined ? { nextOffset: body.nextOffset } : {}),
        link: threadLink(message.threadId),
        note: UNTRUSTED_NOTE,
      },
      { href: threadLink(message.threadId) },
    );
  },
});

interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string; self?: boolean; organizer?: boolean }>;
  organizer?: { email?: string; displayName?: string };
}

const CalendarId = z.string().min(1).max(300).default("primary").describe("Calendar id; primary is the person's main calendar.");
const TimeZone = z.string().min(1).max(64).optional().describe("IANA zone such as Asia/Kolkata. Defaults to the person's zone.");

function eventRow(event: GoogleEvent, timeZone: string) {
  const allDay = Boolean(event.start?.date);
  return {
    id: event.id,
    title: event.summary ?? "(no title)",
    start: allDay ? event.start?.date : localStamp(event.start?.dateTime, timeZone),
    end: allDay ? addDays(event.end?.date ?? event.start?.date ?? "", -1) : localStamp(event.end?.dateTime, timeZone),
    allDay,
    status: event.status,
    location: event.location ?? undefined,
    organizer: event.organizer?.email,
    attendees: (event.attendees ?? []).slice(0, 12).map((row) => `${row.email ?? row.displayName ?? "?"} (${row.responseStatus ?? "needsAction"})`),
    meetLink: event.hangoutLink,
    link: event.htmlLink,
  };
}

export const calendarListEvents = defineTool({
  name: "calendar_list_events",
  area: "apps",
  app: CALENDAR_READ,
  description: "List Google Calendar events between two dates (inclusive), in the person's time zone.",
  input: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; defaults to today."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, inclusive; defaults to six days after from."),
    calendarId: CalendarId,
    query: z.string().max(200).optional(),
    max: z.number().int().min(1).max(50).default(25),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const zone = ctx.settings.timezone;
    const today = zonedParts(zone).date;
    const { start, end } = rangeInstants(input.from, input.to, zone, today);
    const token = await appToken(ctx, CALENDAR_READ);
    const params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(input.max),
      timeZone: zone,
    });
    if (input.query) params.set("q", input.query);
    const body = await appFetch<{ items?: GoogleEvent[] }>(
      ctx,
      CALENDAR_READ,
      token,
      `${CALENDAR_API}/calendars/${encodeURIComponent(input.calendarId)}/events?${params}`,
    );
    const events = (body.items ?? []).filter((event) => event.status !== "cancelled").map((event) => eventRow(event, zone));
    const from = input.from ?? today;
    return toolOk(`Read ${plural(events.length, "event")} from Google Calendar (${from} to ${input.to ?? addDays(from, 6)}).`, {
      timeZone: zone,
      events,
      note: UNTRUSTED_NOTE,
    });
  },
});

const eventTime = (span: EventSpan, which: "start" | "end") => {
  if (span.allDay) return { date: which === "start" ? span.start.date : addDays(span.end.date, 1) };
  const wall = span[which];
  return { dateTime: `${wall.date}T${wall.time}:00`, timeZone: span.timeZone };
};

const CreateEvent = z.object({
  title: z.string().trim().min(1).max(300),
  start: When.describe("Local start, YYYY-MM-DDTHH:MM, or YYYY-MM-DD for an all-day event."),
  end: When.optional().describe("Local end (same format). Timed events default to 30 minutes; all-day events to one day (inclusive last day)."),
  timeZone: TimeZone,
  attendees: emailList.default([]).describe("Guest email addresses. Google emails them an invite."),
  description: z.string().max(8000).optional(),
  location: z.string().max(500).optional(),
  googleMeet: z.boolean().default(false).describe("Add a Google Meet video link."),
  notifyAttendees: z.boolean().default(true),
  calendarId: CalendarId,
});

function calendarName(calendarId: string, owner: string): string {
  return calendarId === "primary" ? owner : `the calendar ${calendarId}`;
}

export const calendarCreateEvent = defineTool({
  name: "calendar_create_event",
  area: "apps",
  app: CALENDAR_WRITE,
  description: "Create a Google Calendar event; with attendees, Google emails them invites. Can add a Meet link.",
  input: CreateEvent,
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const span = eventSpan(input.start, input.end, input.timeZone ?? ctx.settings.timezone);
    const where = calendarName(input.calendarId, await whose(ctx, "google", "calendar"));
    const guests = input.attendees.length
      ? input.notifyAttendees
        ? ` and email invites to ${listWords(input.attendees)}`
        : ` with ${listWords(input.attendees)} as guests (no emails sent)`
      : "";
    return [
      `Create event ${quote(input.title)} ${describeSpan(span)} in ${where}${guests}.${pastWarning(span)}`,
      input.googleMeet ? "Adds a Google Meet link." : "",
      input.location ? `Location: ${input.location}` : "",
      input.description ? `Description: ${quote(input.description)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
  async run(ctx, input) {
    const span = eventSpan(input.start, input.end, input.timeZone ?? ctx.settings.timezone);
    const token = await appToken(ctx, CALENDAR_WRITE);
    const notify = input.attendees.length > 0 && input.notifyAttendees;
    const params = new URLSearchParams({ sendUpdates: notify ? "all" : "none" });
    if (input.googleMeet) params.set("conferenceDataVersion", "1");
    const created = await appFetch<GoogleEvent>(ctx, CALENDAR_WRITE, token, `${CALENDAR_API}/calendars/${encodeURIComponent(input.calendarId)}/events?${params}`, {
      method: "POST",
      body: {
        summary: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.location ? { location: input.location } : {}),
        start: eventTime(span, "start"),
        end: eventTime(span, "end"),
        ...(input.attendees.length ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
        ...(input.googleMeet
          ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } }
          : {}),
      },
    });
    return toolOk(
      `Created ${quote(input.title)} ${describeSpan(span)} in Google Calendar${notify ? `; invites sent to ${listWords(input.attendees)}` : ""}.`,
      { id: created.id, link: created.htmlLink, meetLink: created.hangoutLink ?? null },
      created.htmlLink ? { href: created.htmlLink } : {},
    );
  },
});

const UpdateEvent = z
  .object({
    eventId: z.string().min(1).max(300),
    calendarId: CalendarId,
    title: z.string().trim().min(1).max(300).optional(),
    start: When.optional(),
    end: When.optional(),
    timeZone: TimeZone,
    description: z.string().max(8000).optional(),
    location: z.string().max(500).optional(),
    addAttendees: emailList.default([]),
    removeAttendees: emailList.default([]),
    googleMeet: z.boolean().optional().describe("true adds a Google Meet link if the event has none."),
    notifyAttendees: z.boolean().default(true),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.start !== undefined ||
      input.end !== undefined ||
      input.description !== undefined ||
      input.location !== undefined ||
      input.addAttendees.length > 0 ||
      input.removeAttendees.length > 0 ||
      input.googleMeet === true,
    "Say what to change.",
  );
type UpdateEventInput = z.infer<typeof UpdateEvent>;

function minutesBetween(event: GoogleEvent): number | null {
  const start = event.start?.dateTime ? Date.parse(event.start.dateTime) : NaN;
  const end = event.end?.dateTime ? Date.parse(event.end.dateTime) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.round((end - start) / 60_000) : null;
}

/** The new span, keeping the event's length when only the start moves. */
function updatedSpan(current: GoogleEvent, input: UpdateEventInput, zone: string): EventSpan | null {
  if (!input.start && !input.end) return null;
  if (input.start && !input.end && input.start.includes("T")) {
    const length = minutesBetween(current) ?? 30;
    const start = eventSpan(input.start, undefined, zone).start as { date: string; time: string };
    const end = addMinutes(start, length);
    return eventSpan(input.start, `${end.date}T${end.time}`, zone);
  }
  const start = input.start ?? (current.start?.date ? current.start.date : current.start?.dateTime?.slice(0, 16));
  if (!start) throw new Error("Give the new start as well.");
  return eventSpan(start, input.end, zone);
}

function mergedAttendees(current: GoogleEvent, input: UpdateEventInput) {
  const removed = new Set(input.removeAttendees.map((email) => email.toLowerCase()));
  const kept = (current.attendees ?? []).filter((row) => !row.email || !removed.has(row.email.toLowerCase()));
  const known = new Set(kept.map((row) => row.email?.toLowerCase()));
  return [...kept, ...input.addAttendees.filter((email) => !known.has(email.toLowerCase())).map((email) => ({ email }))];
}

async function loadEvent(ctx: ToolContext, token: string, calendarId: string, eventId: string): Promise<GoogleEvent> {
  return appFetch<GoogleEvent>(
    ctx,
    CALENDAR_WRITE,
    token,
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  );
}

export const calendarUpdateEvent = defineTool({
  name: "calendar_update_event",
  area: "apps",
  app: CALENDAR_WRITE,
  description: "Change a Google Calendar event (time, title, guests, place, Meet link) by id from calendar_list_events.",
  input: UpdateEvent,
  isWrite: true,
  risk: "medium",
  async preview(ctx, input) {
    const token = await appToken(ctx, CALENDAR_WRITE);
    const current = await loadEvent(ctx, token, input.calendarId, input.eventId);
    const zone = input.timeZone ?? current.start?.timeZone ?? ctx.settings.timezone;
    const span = updatedSpan(current, input, zone);
    const when = current.start?.date ?? localStamp(current.start?.dateTime, ctx.settings.timezone);
    const changes = [
      span ? `move it to ${describeSpan(span)}` : "",
      input.title ? `rename it to ${quote(input.title)}` : "",
      input.addAttendees.length ? `add ${listWords(input.addAttendees)}` : "",
      input.removeAttendees.length ? `remove ${listWords(input.removeAttendees)}` : "",
      input.location !== undefined ? `set the place to ${quote(input.location || "none")}` : "",
      input.description !== undefined ? "replace the description" : "",
      input.googleMeet && !current.hangoutLink ? "add a Google Meet link" : "",
    ].filter(Boolean);
    const guests = mergedAttendees(current, input).length + input.removeAttendees.length;
    const notify = input.notifyAttendees && guests > 0 ? " Google emails the update to the guests." : "";
    const where = calendarName(input.calendarId, await whose(ctx, "google", "calendar"));
    return `Update ${quote(current.summary ?? "(no title)")} (${when}) in ${where}: ${changes.join("; ") || "no visible change"}.${notify}${span ? pastWarning(span) : ""}`;
  },
  async run(ctx, input) {
    const token = await appToken(ctx, CALENDAR_WRITE);
    const current = await loadEvent(ctx, token, input.calendarId, input.eventId);
    const zone = input.timeZone ?? current.start?.timeZone ?? ctx.settings.timezone;
    const span = updatedSpan(current, input, zone);
    const attendees = mergedAttendees(current, input);
    const touchedGuests = input.addAttendees.length > 0 || input.removeAttendees.length > 0;
    const notify = input.notifyAttendees && (attendees.length > 0 || input.removeAttendees.length > 0);
    const addMeet = Boolean(input.googleMeet && !current.hangoutLink);
    const params = new URLSearchParams({ sendUpdates: notify ? "all" : "none" });
    if (addMeet) params.set("conferenceDataVersion", "1");
    const updated = await appFetch<GoogleEvent>(
      ctx,
      CALENDAR_WRITE,
      token,
      `${CALENDAR_API}/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}?${params}`,
      {
        method: "PATCH",
        body: {
          ...(input.title ? { summary: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(span ? { start: eventTime(span, "start"), end: eventTime(span, "end") } : {}),
          ...(touchedGuests ? { attendees } : {}),
          ...(addMeet ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
        },
      },
    );
    return toolOk(
      `Updated ${quote(updated.summary ?? current.summary ?? "the event")}${span ? ` to ${describeSpan(span)}` : ""}${notify ? "; guests were emailed" : ""}.`,
      { id: updated.id, link: updated.htmlLink, meetLink: updated.hangoutLink ?? null },
      updated.htmlLink ? { href: updated.htmlLink } : {},
    );
  },
});

export const googleMailCalendarTools = [gmailSearch, gmailRead, calendarListEvents, calendarCreateEvent, calendarUpdateEvent];
