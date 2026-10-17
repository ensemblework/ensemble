import { calendarReceipt } from "./calendar-receipts.js";
import { z } from "zod";
import { defineTool, toolOk, type ToolContext } from "../types.js";
import { appFetch, appToken, emailList, eventSpan, spanStartInstant, When } from "./apps-common.js";
import { CALENDAR_API, CALENDAR_READ, CALENDAR_WRITE } from "./google/meta.js";
import { GRAPH, OUTLOOK_CALENDAR_READ, OUTLOOK_CALENDAR_WRITE } from "./microsoft/meta.js";

const Repeat = z.object({ frequency: z.enum(["daily", "weekly", "monthly", "yearly"]), interval: z.number().int().min(1).max(99).default(1), weekdays: z.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])).max(7).optional(), count: z.number().int().min(1).max(500).optional(), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).refine(row => !(row.count && row.until), "Choose count or until.");
export const CalendarRepeat = Repeat;
const DAYS = { MO: "monday", TU: "tuesday", WE: "wednesday", TH: "thursday", FR: "friday", SA: "saturday", SU: "sunday" };
export function googleRecurrence(input: z.infer<typeof Repeat>): string[] {
  return [`RRULE:FREQ=${input.frequency.toUpperCase()};INTERVAL=${input.interval}${input.weekdays?.length ? `;BYDAY=${input.weekdays.join(",")}` : ""}${input.count ? `;COUNT=${input.count}` : input.until ? `;UNTIL=${input.until.replaceAll("-", "")}T235959Z` : ""}`];
}
export function outlookRecurrence(input: z.infer<typeof Repeat>, date: string, timeZone: string) {
  const at = new Date(`${date}T12:00:00Z`);
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][at.getUTCDay()];
  const type = input.frequency === "monthly" ? "absoluteMonthly" : input.frequency === "yearly" ? "absoluteYearly" : input.frequency;
  return { pattern: { type, interval: input.interval, ...(input.frequency === "weekly" ? { daysOfWeek: input.weekdays?.length ? input.weekdays.map(day => DAYS[day]) : [weekday], firstDayOfWeek: "monday" } : {}), ...(["monthly", "yearly"].includes(input.frequency) ? { dayOfMonth: at.getUTCDate() } : {}), ...(input.frequency === "yearly" ? { month: at.getUTCMonth() + 1 } : {}) }, range: { type: input.count ? "numbered" : input.until ? "endDate" : "noEnd", startDate: date, recurrenceTimeZone: timeZone, ...(input.count ? { numberOfOccurrences: input.count } : input.until ? { endDate: input.until } : {}) } };
}

function toolsFor(provider: "google" | "microsoft") {
  const google = provider === "google";
  const prefix = google ? "calendar" : "outlook_calendar";
  const read = google ? CALENDAR_READ : OUTLOOK_CALENDAR_READ;
  const listAccess = google ? { ...read, scopes: [["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar"]] } : read;
  const busyAccess = google ? { ...read, scopes: [["https://www.googleapis.com/auth/calendar.freebusy", "https://www.googleapis.com/auth/calendar.events.freebusy", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar"]] } : read;
  const write = google ? CALENDAR_WRITE : OUTLOOK_CALENDAR_WRITE;
  const Input = z.object({ action: z.enum(["update", "cancel", "respond", "set_recurrence"]), eventId: z.string().min(1).max(500), matchTitle: z.string().min(1).max(300), calendarId: z.string().min(1).max(300).default(google ? "primary" : "default"), scope: z.enum(["event", "series"]).default("event"), title: z.string().min(1).max(300).optional(), start: When.optional(), end: When.optional(), timeZone: z.string().max(64).optional(), location: z.string().max(500).optional(), attendees: emailList.optional().describe("Replace the complete guest list; omit to keep guests."), response: z.enum(["accepted", "tentative", "declined"]).optional(), recurrence: Repeat.nullable().optional() });
  type Input = z.infer<typeof Input>;
  const eventUrl = (input: Input) => google ? `${CALENDAR_API}/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}` : `${GRAPH}/me/events/${encodeURIComponent(input.eventId)}`;
  async function load(ctx: ToolContext, input: Input) {
    const token = await appToken(ctx, write);
    let url = eventUrl(input);
    let event = await appFetch<Record<string, any>>(ctx, write, token, url, { headers: google ? {} : { Prefer: 'outlook.timezone="UTC"' } });
    if ((google ? event.summary : event.subject) !== input.matchTitle) throw new Error("The event title changed or the wrong event was selected. List events again.");
    if (input.action === "cancel" && (google ? event.organizer?.self === false : event.isOrganizer === false)) throw new Error("Only the organizer can cancel this meeting for everyone. Use respond to decline your invitation.");
    const master = google ? event.recurringEventId : event.seriesMasterId;
    if (input.scope === "series" && master) { url = eventUrl({ ...input, eventId: master }); event = await appFetch(ctx, write, token, url); }
    if (input.action === "set_recurrence" && input.scope !== "series") throw new Error("Changing recurrence needs scope series. Confirm that the person asked to change the series.");
    if (input.action === "respond" && !input.response) throw new Error("Send accepted, tentative or declined as response.");
    if (input.action === "set_recurrence" && input.recurrence === undefined) throw new Error("Send recurrence, or null to stop repeating.");
    if (input.start && !input.end || input.end && !input.start) throw new Error("Send both start and end to change an event's time.");
    return { event, token, url };
  }
  return [
    defineTool({ name: `${prefix}_list_calendars`, area: "apps", app: listAccess, description: `List accessible ${google ? "Google" : "Outlook"} calendars and IDs.`, input: z.object({}), isWrite: false, risk: "low", async run(ctx) {
      const token = await appToken(ctx, listAccess);
      const result = await appFetch<Record<string, any>>(ctx, listAccess, token, google ? `${CALENDAR_API}/users/me/calendarList?maxResults=50` : `${GRAPH}/me/calendars?$top=50`);
      return toolOk("Read calendars.", { calendars: (google ? result.items : result.value)?.map((row: any) => ({ id: row.id, name: row.summary ?? row.name, canWrite: row.canEdit ?? ["owner", "writer"].includes(row.accessRole), primary: row.primary ?? row.isDefaultCalendar })) ?? [], more: Boolean(result.nextPageToken ?? result["@odata.nextLink"]) });
    } }),
    defineTool({ name: `${prefix}_free_busy`, area: "apps", app: busyAccess, description: `Check ${google ? "Google calendar IDs (often email addresses)" : "Outlook work/school email addresses"} for busy intervals. Returns per-person permission/errors; missing availability is unknown, never free.`, input: z.object({ addresses: z.array(z.string().min(1).max(320)).min(1).max(20), start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }), isWrite: false, risk: "low", async run(ctx, input) {
      const span = Date.parse(input.end) - Date.parse(input.start); if (span <= 0 || span > 62 * 86400000) throw new Error("Choose a range of 1 to 62 days.");
      const token = await appToken(ctx, busyAccess);
      const body = google ? { timeMin: input.start, timeMax: input.end, items: input.addresses.map(id => ({ id })) } : { schedules: input.addresses, startTime: { dateTime: new Date(input.start).toISOString().replace("Z", ""), timeZone: "UTC" }, endTime: { dateTime: new Date(input.end).toISOString().replace("Z", ""), timeZone: "UTC" }, availabilityViewInterval: 30 };
      return toolOk("Read availability; respect any per-calendar errors.", await appFetch(ctx, busyAccess, token, google ? `${CALENDAR_API}/freeBusy` : `${GRAPH}/me/calendar/getSchedule`, { method: "POST", body }));
    } }),
    defineTool({ name: `${prefix}_manage_event`, area: "apps", app: write, description: `Update, cancel, RSVP or change recurrence of a ${google ? "Google" : "Outlook"} event. Use ID/title from live events. scope event changes one occurrence; series changes the whole series. Updates notify guests. Read first; provide both start/end for a move.`, input: Input, isWrite: true, risk: "medium",
      async preview(ctx, input) { const { event } = await load(ctx, input); return `${input.action.replaceAll("_", " ")} ${google ? "Google" : "Outlook"} event “${input.matchTitle}” (${input.scope === "series" ? "entire series" : "selected occurrence"}). ${input.action === "cancel" ? "Cancels/removes the event and notifies attendees." : input.action === "respond" ? `Your response: ${input.response}.` : `${input.title ? `Title: ${input.title}. ` : ""}${input.start ? `${input.start} to ${input.end} (${input.timeZone ?? ctx.settings.timezone}). ` : ""}${input.attendees ? `Replace guests with: ${input.attendees.join(", ")}. ` : ""}${input.location ? `Location: ${input.location}. ` : ""}${input.recurrence !== undefined ? `Repeat: ${JSON.stringify(input.recurrence)}. ` : ""}Attendees receive updates.`} Current organizer: ${JSON.stringify(event.organizer ?? "")}`; },
      async run(ctx, input) {
        const { event, url, token } = await load(ctx, input);
        if (input.action === "cancel") { await appFetch(ctx, write, token, google ? `${url}?sendUpdates=all` : url, { method: "DELETE" }); await calendarReceipt(ctx, provider, event, true); return toolOk(`Cancelled “${input.matchTitle}” (${input.scope}).`, { id: input.eventId }, { invalidate: ["calendar", "desk-live", "context"] }); }
        if (input.action === "respond") {
          if (google) { const attendees = event.attendees ?? []; const self = attendees.find((row: any) => row.self); if (!self) throw new Error("This account is not an attendee. Respond in Calendar."); self.responseStatus = input.response; await appFetch(ctx, write, token, `${url}?sendUpdates=all`, { method: "PATCH", body: { attendees }, headers: event.etag ? { "If-Match": event.etag } : {} }); }
          else { const method = { accepted: "accept", tentative: "tentativelyAccept", declined: "decline" }[input.response!]; await appFetch(ctx, write, token, `${url}/${method}`, { method: "POST", body: { sendResponse: true } }); }
          await calendarReceipt(ctx, provider, event, input.response === "declined");
          return toolOk(`Responded ${input.response} to “${input.matchTitle}”.`, { id: input.eventId }, { invalidate: ["calendar", "desk-live", "context"] });
        }
        const body: Record<string, unknown> = {};
        if (input.title) body[google ? "summary" : "subject"] = input.title;
        if (input.location !== undefined) body.location = google ? input.location : { displayName: input.location };
        if (input.attendees) body.attendees = input.attendees.map(address => google ? { email: address } : { emailAddress: { address }, type: "required" });
        if (input.start) {
          const span = eventSpan(input.start, input.end, input.timeZone ?? ctx.settings.timezone);
          if (google) { body.start = span.allDay ? { date: span.start.date } : { dateTime: `${span.start.date}T${span.start.time}:00`, timeZone: span.timeZone }; body.end = span.allDay ? { date: new Date(Date.parse(`${span.end.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) } : { dateTime: `${span.end.date}T${span.end.time}:00`, timeZone: span.timeZone }; }
          else { body.start = { dateTime: spanStartInstant(span).toISOString().replace("Z", ""), timeZone: "UTC" }; const end = eventSpan(`${span.end.date}${span.end.time ? `T${span.end.time}` : ""}`, undefined, span.timeZone); body.end = { dateTime: new Date(spanStartInstant(end).getTime() + (span.allDay ? 86400000 : 0)).toISOString().replace("Z", ""), timeZone: "UTC" }; body.isAllDay = span.allDay; }
        }
        if (input.recurrence !== undefined) body.recurrence = google ? input.recurrence ? googleRecurrence(input.recurrence) : [] : input.recurrence ? outlookRecurrence(input.recurrence, input.start?.slice(0, 10) ?? event.start?.dateTime?.slice(0, 10), input.timeZone ?? ctx.settings.timezone) : null;
        if (!Object.keys(body).length) throw new Error("Send the event fields to change.");
        const updated = await appFetch<Record<string, any>>(ctx, write, token, google ? `${url}?sendUpdates=all` : url, { method: "PATCH", body, headers: (event.etag ?? event["@odata.etag"]) ? { "If-Match": event.etag ?? event["@odata.etag"] } : {} });
        const hubEventId = await calendarReceipt(ctx, provider, { ...event, ...body, ...updated });
        return toolOk(`Updated “${input.matchTitle}” (${input.scope}).`, { id: updated.id, hubEventId, link: updated.htmlLink ?? updated.webLink }, { href: updated.htmlLink ?? updated.webLink, invalidate: ["calendar", "desk-live", "context"] });
      }
    }),
  ];
}

export const calendarManagementTools = [...toolsFor("google"), ...toolsFor("microsoft")];
