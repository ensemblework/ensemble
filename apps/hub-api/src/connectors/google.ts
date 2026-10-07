/**
 * Gmail and Google Calendar sync (docs/03 §2). Uses the engineer's own
 * Google sign-in from oauth_tokens; never a service account. Sync only reads;
 * calendar writes go through the assistant and wait for Apply.
 */
import { prisma } from "../lib/prisma.js";
import { htmlToText, parseAddress, parseAddressList, upsertArtifact, upsertPerson } from "./ingest.js";
import { GOOGLE_PRODUCT_SCOPES } from "./products.js";
import { hasScopes, syncAccount } from "./tokens.js";
import { ConnectorError, readJson, type SyncContext, type SyncResult } from "./types.js";

const G = "https://www.googleapis.com/auth/";

/** The Google token, and a clear error when the product this sync needs is switched off. */
async function token(userId: string, product: { label: string; anyOf: ReadonlyArray<readonly string[]> }): Promise<{ token: string; account: string | null; scopes: string[] }> {
  const account = await syncAccount(userId, "google");
  if (!account) throw new ConnectorError("Google Workspace is not connected. Connect it in Settings → Connections.", true);
  if (account.scopes.length && !product.anyOf.some((scopes) => hasScopes(account, scopes))) {
    throw new ConnectorError(`${product.label} is switched off for Google Workspace. Turn it on in Settings → Connections and approve the access.`, true);
  }
  return { token: account.accessToken, account: account.account, scopes: account.scopes };
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart & { headers?: Array<{ name: string; value: string }> };
}

const b64url = (data: string): string => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function bodyText(part: GmailPart | undefined): string {
  if (!part) return "";
  const find = (node: GmailPart, type: string): string | null => {
    if (node.mimeType === type && node.body?.data) return b64url(node.body.data);
    for (const child of node.parts ?? []) {
      const found = find(child, type);
      if (found) return found;
    }
    return null;
  };
  const plain = find(part, "text/plain");
  if (plain) return plain;
  const html = find(part, "text/html");
  return html ? htmlToText(html) : "";
}

/** Drops quoted history so the model sees what was actually said this time. */
export function stripQuoted(text: string): string {
  const cut = text.search(/\n(On .{5,120} wrote:|-{2,}\s*Original Message|From: .+\nSent: )/);
  return (cut > 0 ? text.slice(0, cut) : text).split("\n").filter((line) => !line.startsWith(">")).join("\n").trim();
}

export async function syncGmail(ctx: SyncContext): Promise<SyncResult> {
  const { token: access, account } = await token(ctx.userId, { label: "Gmail", anyOf: [GOOGLE_PRODUCT_SCOPES.gmail] });
  const headers = { Authorization: `Bearer ${access}` };
  const after = Math.floor(ctx.since.getTime() / 1000);
  const query = `after:${after} -category:promotions -category:social -category:forums -in:spam -in:trash`;
  const list = await readJson<{ messages?: Array<{ id: string }> }>(
    await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: query, maxResults: "60" })}`, { headers }),
    "Gmail",
  );
  const ids = (list.messages ?? []).map((row) => row.id);
  const known = new Set(
    (
      await prisma.artifact.findMany({
        where: { userId: ctx.userId, kind: "email", externalId: { in: ids } },
        select: { externalId: true },
      })
    ).map((row) => row.externalId),
  );
  const result: SyncResult = { items: 0, stored: [], proposals: [], triage: [], account };
  const self = [account, ctx.settings.email];
  for (const id of ids) {
    if (known.has(id)) continue;
    const message = await readJson<GmailMessage>(
      await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers }),
      "Gmail",
    );
    const header = (name: string): string =>
      message.payload?.headers?.find((row) => row.name.toLowerCase() === name.toLowerCase())?.value ?? "";
    const from = parseAddress(header("From"));
    const to = parseAddressList(header("To"));
    const cc = parseAddressList(header("Cc"));
    const sent = (message.labelIds ?? []).includes("SENT");
    const at = new Date(Number(message.internalDate));
    const personId = sent
      ? null
      : await upsertPerson(ctx.userId, { email: from.email, name: from.name, at, evidence: `gmail:${message.threadId}` }, self);
    for (const recipient of sent ? to : []) {
      await upsertPerson(ctx.userId, { email: recipient.email, name: recipient.name, at, evidence: `gmail:${message.threadId}` }, self);
    }
    const stored = await upsertArtifact(ctx.userId, {
      kind: "email",
      externalId: message.id,
      threadId: message.threadId,
      url: `https://mail.google.com/mail/u/0/#all/${message.threadId}`,
      ts: at,
      title: header("Subject") || "(no subject)",
      text: stripQuoted(bodyText(message.payload)) || message.snippet || "",
      authoredByMe: sent,
      participants: [from, ...to, ...cc],
      actorId: personId,
      metadata: {
        source: "gmail",
        from: header("From"),
        to: header("To"),
        cc: header("Cc"),
        labels: message.labelIds ?? [],
        snippet: message.snippet ?? "",
        directlyToMe: to.some((row) => self.some((mine) => mine && row.email === mine.toLowerCase())),
      },
    });
    result.items += 1;
    result.stored.push(stored);
    if (stored.created && !sent) result.triage.push({ ...stored, personId });
  }
  return result;
}

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  hangoutLink?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; displayName?: string; self?: boolean; responseStatus?: string }>;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
}

interface CalendarListEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  selected?: boolean;
  hidden?: boolean;
  accessRole?: string;
}

const MAX_CALENDARS = 10;

/** The primary calendar plus the ones shown in Google Calendar, when the calendar list may be read. */
async function calendarsToRead(access: string, scopes: string[]): Promise<CalendarListEntry[]> {
  if (!hasScopes({ scopes }, [`${G}calendar.calendarlist.readonly`]) && !hasScopes({ scopes }, [`${G}calendar.readonly`])) {
    return [{ id: "primary", primary: true }];
  }
  const out: CalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ minAccessRole: "reader", maxResults: "250", ...(pageToken ? { pageToken } : {}) });
    const page = await readJson<{ items?: CalendarListEntry[]; nextPageToken?: string }>(
      await fetch(`https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`, { headers: { Authorization: `Bearer ${access}` } }),
      "Google Calendar",
    );
    out.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < 500);
  const chosen = out.filter((row) => row.primary || (row.selected && !row.hidden));
  chosen.sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
  return chosen.length ? chosen.slice(0, MAX_CALENDARS) : [{ id: "primary", primary: true }];
}

export async function syncCalendar(ctx: SyncContext): Promise<SyncResult> {
  const { token: access, account, scopes } = await token(ctx.userId, {
    label: "Google Calendar",
    anyOf: [[`${G}calendar.events`], [`${G}calendar.readonly`]],
  });
  const from = new Date(Date.now() - 7 * 86_400_000);
  const to = new Date(Date.now() + 21 * 86_400_000);
  const events: Array<CalendarEvent & { calendarId: string; calendarName: string | null }> = [];
  const ids = new Set<string>();
  for (const calendar of await calendarsToRead(access, scopes)) {
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await readJson<{ items?: CalendarEvent[]; nextPageToken?: string }>(
        await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events?${params}`, { headers: { Authorization: `Bearer ${access}` } }),
        "Google Calendar",
      );
      for (const event of page.items ?? []) {
        // An invite shows up on every calendar it was added to; keep the first copy.
        if (ids.has(event.id)) continue;
        ids.add(event.id);
        events.push({ ...event, calendarId: calendar.id, calendarName: calendar.summary ?? null });
      }
      pageToken = page.nextPageToken;
    } while (pageToken && events.length < 1000);
  }

  const result: SyncResult = { items: 0, stored: [], proposals: [], triage: [], account };
  const seen: string[] = [];
  const self = [account, ctx.settings.email];
  for (const event of events) {
    if (event.status === "cancelled") continue;
    const allDay = Boolean(event.start?.date && !event.start?.dateTime);
    const start = new Date(event.start?.dateTime ?? `${event.start?.date}T00:00:00`);
    const end = event.end?.dateTime ?? (event.end?.date ? `${event.end.date}T00:00:00` : null);
    const joinUrl =
      event.hangoutLink ?? event.conferenceData?.entryPoints?.find((row) => row.entryPointType === "video")?.uri ?? null;
    const declined = event.attendees?.find((row) => row.self)?.responseStatus === "declined";
    if (declined) continue;
    for (const attendee of event.attendees ?? []) {
      if (!attendee.self) {
        await upsertPerson(ctx.userId, { email: attendee.email, name: attendee.displayName, at: start, evidence: `calendar:${event.id}` }, self);
      }
    }
    const stored = await upsertArtifact(ctx.userId, {
      kind: "event",
      externalId: event.id,
      url: event.htmlLink ?? null,
      ts: start,
      title: event.summary ?? "(busy)",
      text: htmlToText(event.description ?? ""),
      participants: (event.attendees ?? []).map((row) => ({ name: row.displayName ?? null, email: row.email ?? null })),
      authoredByMe: Boolean(event.organizer?.self),
      metadata: {
        source: "google",
        calendarId: event.calendarId,
        calendar: event.calendarName,
        end: end ? new Date(end).toISOString() : null,
        allDay,
        joinUrl,
        location: event.location ?? null,
        organizer: event.organizer?.email ?? null,
      },
    });
    seen.push(event.id);
    result.items += 1;
    result.stored.push(stored);
  }
  // Events moved out of the window or cancelled at the source leave the Today calendar.
  await prisma.artifact.updateMany({
    where: { userId: ctx.userId, kind: "event", ts: { gte: from, lt: to }, externalId: { notIn: seen }, deletedAt: null, metadata: { path: ["source"], equals: "google" } },
    data: { deletedAt: new Date() },
  });
  return result;
}
