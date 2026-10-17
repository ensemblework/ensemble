import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import "../../runtime/test-env.js";
import { DEFAULT_SETTINGS } from "@ensemble/shared-types";
import { calendarManagementTools, googleRecurrence, outlookRecurrence } from "./calendar-management.js";
import { googleWorkspaceTools } from "./google-workspace.js";
import { microsoft365Tools } from "./microsoft-365.js";
import { setAppTokenResolverForTests } from "./apps-common.js";
import type { ToolContext } from "../types.js";
const originalFetch = globalThis.fetch;
const seen: Array<{ url: string; method: string; body: any; headers: Headers }> = [];
let reply: (row: typeof seen[number]) => Response;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const ctx = { userId: "mira", actor: "agent", settings: { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata" }, app: { log: { warn() {}, error() {} } } } as unknown as ToolContext;
const tool = (name: string) => [...calendarManagementTools, ...googleWorkspaceTools, ...microsoft365Tools].find(item => item.name === name)!;
const run = (name: string, input: unknown) => { const item = tool(name); return item.run(ctx, item.input.parse(input)); };
beforeEach(() => {
 seen.length = 0;
 setAppTokenResolverForTests(async () => ({ token: "test-token", account: "mira@fieldnote.example", scopes: ["Calendars.ReadWrite", "https://www.googleapis.com/auth/calendar"] }));
 reply = row => row.method === "GET" ? json({ id: "event-1", summary: "Review", subject: "Review", organizer: { self: true }, isOrganizer: true, start: { dateTime: "2026-10-19T10:00:00" }, end: { dateTime: "2026-10-19T11:00:00" }, etag: "v1", "@odata.etag": "v1" }) : json({ id: "event-1", htmlLink: "https://calendar.google.com/event-1", webLink: "https://outlook.office.com/event-1" });
 globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => { const row = { url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, headers: new Headers(init?.headers) }; seen.push(row); return reply(row); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; setAppTokenResolverForTests(null); });

test("Outlook rescheduling preserves unrelated properties and uses absolute UTC time", async () => {
 await run("outlook_calendar_manage_event", { action: "update", eventId: "event-1", matchTitle: "Review", start: "2026-10-19T15:00", end: "2026-10-19T15:45" });
 const patch = seen.find(row => row.method === "PATCH")!;
 assert.equal(patch.body.start.dateTime, "2026-10-19T09:30:00.000");
 assert.equal(patch.body.end.dateTime, "2026-10-19T10:15:00.000");
 assert.equal(patch.body.attendees, undefined); assert.equal(patch.body.body, undefined); assert.equal(patch.headers.get("if-match"), "v1");
});

test("Google cancellation targets the selected occurrence and requests attendee updates", async () => {
 await run("calendar_manage_event", { action: "cancel", eventId: "instance-2", matchTitle: "Review" });
 const sent = seen.find(row => row.method === "DELETE")!;
 assert.ok(sent.url.includes("/events/instance-2?sendUpdates=all"));
});

test("series edits resolve the master and title mismatch refuses all writes", async () => {
 reply = row => row.method === "GET" ? json({ id: "event-1", summary: "Review", recurringEventId: row.url.includes("instance") ? "master-1" : undefined }) : json({ id: "master-1" });
 await run("calendar_manage_event", { action: "set_recurrence", scope: "series", eventId: "instance-1", matchTitle: "Review", recurrence: { frequency: "weekly", interval: 2, weekdays: ["MO"], count: 6 } });
 const patch = seen.find(row => row.method === "PATCH")!; assert.ok(patch.url.includes("/events/master-1")); assert.deepEqual(patch.body.recurrence, ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=6"]);
 seen.length = 0;
 await assert.rejects(run("calendar_manage_event", { action: "cancel", eventId: "event-1", matchTitle: "Wrong" }), /title/); assert.equal(seen.some(row => row.method !== "GET"), false);
});

test("Outlook RSVP is an event response and not a separate email send", async () => {
 await run("outlook_calendar_manage_event", { action: "respond", eventId: "event-1", matchTitle: "Review", response: "tentative" });
 const sent = seen.find(row => row.method === "POST")!; assert.ok(sent.url.endsWith("/events/event-1/tentativelyAccept")); assert.deepEqual(sent.body, { sendResponse: true });
});

test("availability retains provider errors rather than treating inaccessible calendars as free", async () => {
 reply = () => json({ calendars: { "mira@fieldnote.example": { busy: [{ start: "2026-10-19T09:00:00Z", end: "2026-10-19T10:00:00Z" }] }, "rowan@fieldnote.example": { errors: [{ reason: "notFound" }] } } });
 const result = await run("calendar_free_busy", { addresses: ["mira@fieldnote.example", "rowan@fieldnote.example"], start: "2026-10-19T00:00:00Z", end: "2026-10-20T00:00:00Z" });
 assert.match(JSON.stringify(result.data), /notFound/); assert.equal(seen[0]!.body.items.length, 2);
 await assert.rejects(run("calendar_free_busy", { addresses: ["primary"], start: "2026-10-20T00:00:00Z", end: "2026-10-19T00:00:00Z" }), /range/);
});

test("recurring event schemas and provider mappings preserve weekly weekdays and bounded duration", () => {
 assert.deepEqual(googleRecurrence({ frequency: "weekly", interval: 1, weekdays: ["MO", "FR"], count: 4 }), ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,FR;COUNT=4"]);
 const graph = outlookRecurrence({ frequency: "monthly", interval: 1, until: "2027-01-01" }, "2026-10-19", "Asia/Kolkata");
 assert.equal(graph.pattern.type, "absoluteMonthly"); assert.equal(graph.pattern.dayOfMonth, 19); assert.equal(graph.range.type, "endDate");
 assert.equal(tool("calendar_create_event").input.safeParse({ title: "Review", start: "2026-10-19T10:00", recurrence: { frequency: "weekly", count: 2, until: "2027-01-01" } }).success, false);
});

test("all-day Outlook moves use calendar days across DST, and Google recurrence ends in the chosen zone", async () => {
 await run("outlook_calendar_manage_event", { action: "update", eventId: "event-1", matchTitle: "Review", start: "2026-11-01", end: "2026-11-01", timeZone: "America/Los_Angeles" });
 const patch = seen.find(row => row.method === "PATCH")!;
 assert.equal(patch.body.start.dateTime, "2026-11-01T07:00:00.000");
 assert.equal(patch.body.end.dateTime, "2026-11-02T08:00:00.000");
 assert.deepEqual(googleRecurrence({ frequency: "daily", interval: 1, until: "2026-11-01" }, "America/Los_Angeles"), ["RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261102T075959Z"]);
 assert.deepEqual(googleRecurrence({ frequency: "daily", interval: 1, until: "2026-11-01" }, "America/Los_Angeles", true), ["RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261101"]);
});
