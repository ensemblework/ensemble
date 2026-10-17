import { zonedDateTimeToUtc } from "../../lib/clock.js";
import { redact, htmlToText } from "../../connectors/ingest.js";
import type { ToolContext } from "../types.js";

function instant(value: { dateTime?: string; date?: string; timeZone?: string } | undefined, zone: string): Date | null {
  const raw = value?.dateTime ?? value?.date;
  if (!raw) return null;
  if (/Z|[+-]\d{2}:\d{2}$/.test(raw)) return new Date(raw);
  return zonedDateTimeToUtc(raw.slice(0, 10), raw.includes("T") ? raw.slice(11, 16) : "00:00", value?.timeZone ?? zone);
}

/** Keep the explicitly changed event visible in Ensemble, without fetching unrelated calendar content. */
export async function calendarReceipt(ctx: ToolContext, provider: "google" | "microsoft", event: Record<string, any>, removed = false): Promise<string | null> {
  const externalId = provider === "google" ? event.id : `outlook:${event.id}`;
  try {
    if (!event.id) return null;
    if (removed) { await ctx.prisma.artifact.updateMany({ where: { userId: ctx.userId, kind: "event", externalId }, data: { deletedAt: new Date() } }); return null; }
    const start = instant(event.start, provider === "microsoft" ? "UTC" : ctx.settings.timezone);
    if (!start || Number.isNaN(start.getTime())) return null;
    const end = instant(event.end, provider === "microsoft" ? "UTC" : ctx.settings.timezone);
    const participants = (event.attendees ?? []).map((row: any) => ({ email: row.email ?? row.emailAddress?.address ?? null, name: row.displayName ?? row.emailAddress?.name ?? null }));
    const data = { title: event.summary ?? event.subject ?? "Meeting", ts: start, url: event.htmlLink ?? event.webLink ?? null, text: redact(htmlToText(event.description ?? event.body?.content ?? "")), participants, deletedAt: null, metadata: { source: provider === "google" ? "google" : "outlook", eventId: event.id, calendarId: event.calendarId ?? null, end: end?.toISOString() ?? null, allDay: Boolean(event.start?.date ?? event.isAllDay), joinUrl: event.hangoutLink ?? event.onlineMeeting?.joinUrl ?? null, location: typeof event.location === "string" ? event.location : event.location?.displayName ?? null, via: "assistant" } };
    const row = await ctx.prisma.artifact.upsert({ where: { userId_kind_externalId: { userId: ctx.userId, kind: "event", externalId } }, create: { userId: ctx.userId, kind: "event", externalId, ...data }, update: data });
    return row.id;
  } catch (error) {
    // The provider already changed the calendar; a local refresh failure must never invite a duplicate event.
    ctx.app.log.error({ err: error }, "Could not save the changed calendar event in Ensemble");
    return null;
  }
}
