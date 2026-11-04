/**
 * The Today calendar end to end on the in-memory database: Google Calendar,
 * Outlook and a calendar link (ICS) synced through mocked providers, the same
 * meeting and holiday from three calendars shown once, groups stored at sync,
 * a switched-off source dropping out while the others keep the event, calendar
 * links (validation, private addresses, isolation, removal) and the assistant's
 * hub_list_events reading the same merged list.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { DEFAULT_SETTINGS } from "@ensemble/shared-types";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { calendarRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

process.env.NODE_ENV = "test";
const harness: HttpHarness = await createHttpHarness();
const db = harness.prisma;
const { saveAccount } = await import("../connectors/accounts.js");
const { saveSettings } = await import("../lib/settings.js");
const { setCalendarFeedFetchForTests } = await import("./feeds.js");
const { getTool } = await import("../assistant/registry.js");

const G = "https://www.googleapis.com/auth/";
const GRAPH = "https://graph.microsoft.com/v1.0";
const TEAMS = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZjE2NGM0%40thread.v2/0?context=%7b%7d";
const covered = new Map<string, Set<RouteCheck>>();

const calls: string[] = [];
const realFetch = globalThis.fetch;
type Reply = (url: URL) => unknown;
const replies: Array<{ match: (url: URL) => boolean; reply: Reply }> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(raw)) return realFetch(input, init);
  calls.push(raw);
  const url = new URL(raw);
  const found = replies.find((row) => row.match(url));
  if (!found) return new Response(JSON.stringify({ error: `unmocked ${raw}` }), { status: 599 });
  return new Response(JSON.stringify(found.reply(url)), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

after(async () => {
  try {
    for (const [route, checks] of Object.entries(calendarRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted calendar coverage claim: ${check} ${route}`);
    }
  } finally {
    globalThis.fetch = realFetch;
    setCalendarFeedFetchForTests(null);
    await harness.close();
  }
});

async function call(user: HttpUser, method: InjectOptions["method"], url: string, route: string | null, check: RouteCheck | null, payload?: unknown) {
  if (route && check) {
    const key = `${method} ${route}`;
    covered.set(key, (covered.get(key) ?? new Set()).add(check));
  }
  return user.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as InjectOptions["payload"] }) });
}

async function verified(email: string): Promise<HttpUser> {
  const user = await harness.asUser(email);
  await db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  return user;
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const D1 = day(1);
const D3 = day(3);
const D4 = day(4);

function mockProviders(): void {
  replies.length = 0;
  calls.length = 0;
  replies.push(
    {
      match: (url) => url.pathname === "/calendar/v3/users/me/calendarList",
      reply: () => ({
        items: [
          { id: "mira@fieldnote.example", summary: "Mira", primary: true, selected: true },
          { id: "en.indian#holiday@group.v.calendar.google.com", summary: "Holidays in India", selected: true },
          { id: "hidden@fieldnote.example", summary: "Hidden", selected: true, hidden: true },
        ],
      }),
    },
    {
      match: (url) => url.pathname.startsWith("/calendar/v3/calendars/"),
      reply: (url) => {
        const id = decodeURIComponent(url.pathname.split("/")[4]!);
        if (id.startsWith("en.indian")) return { items: [{ id: "g-xmas", iCalUID: "20261225_xmas@google.com", summary: "Christmas Day", start: { date: D3 }, end: { date: D4 } }] };
        return {
          items: [
            {
              id: "g-sprint",
              iCalUID: "040000008200E00074C5B7101A82E00800000000SPRINT",
              summary: "Fwd: Sprint review",
              description: `Join the meeting: ${TEAMS}`,
              start: { dateTime: `${D1}T10:00:00+05:30` },
              end: { dateTime: `${D1}T10:30:00+05:30` },
              attendees: [{ email: "arjun@fieldnote.example", displayName: "Arjun Rao" }, { email: "mira@fieldnote.example", self: true, responseStatus: "accepted" }],
            },
            { id: "g-standup", iCalUID: "standup@google.com", summary: "Standup", start: { dateTime: `${D1}T03:30:00Z` }, end: { dateTime: `${D1}T03:45:00Z` } },
            { id: "g-gone", status: "cancelled", summary: "Old sync", start: { dateTime: `${D1}T06:00:00Z` }, end: { dateTime: `${D1}T06:30:00Z` } },
            { id: "g-declined", summary: "Vendor pitch", start: { dateTime: `${D1}T07:00:00Z` }, end: { dateTime: `${D1}T07:30:00Z` }, attendees: [{ email: "mira@fieldnote.example", self: true, responseStatus: "declined" }] },
            { id: "g-where", eventType: "workingLocation", summary: "Home", start: { date: D1 }, end: { date: day(2) } },
          ],
        };
      },
    },
    {
      match: (url) => url.href.startsWith(`${GRAPH}/me/calendars?`),
      reply: () => ({
        value: [
          { id: "cal-main", name: "Calendar", isDefaultCalendar: true, owner: { address: "mira@fieldnote.example" } },
          { id: "cal-holidays", name: "India holidays", isDefaultCalendar: false, owner: { address: "mira@fieldnote.example" } },
          { id: "cal-arjun", name: "Arjun Rao", isDefaultCalendar: false, owner: { address: "arjun@fieldnote.example" } },
        ],
      }),
    },
    {
      match: (url) => url.pathname.endsWith("/calendarView"),
      reply: (url) => {
        if (url.pathname.includes("cal-holidays")) {
          return { value: [{ id: "o-xmas", iCalUId: "outlook-holiday-xmas", subject: "Christmas", isAllDay: true, start: { dateTime: `${D3}T00:00:00.0000000`, timeZone: "UTC" }, end: { dateTime: `${D4}T00:00:00.0000000`, timeZone: "UTC" } }] };
        }
        return {
          value: [
            {
              id: "o-sprint",
              iCalUId: "040000008200e00074c5b7101a82e00800000000sprint",
              subject: "Sprint review",
              start: { dateTime: `${D1}T04:30:00.0000000`, timeZone: "UTC" },
              end: { dateTime: `${D1}T05:00:00.0000000`, timeZone: "UTC" },
              onlineMeeting: { joinUrl: TEAMS },
              location: { displayName: "Microsoft Teams Meeting" },
              attendees: [{ emailAddress: { name: "Lena", address: "Lena@fieldnote.example" } }],
              organizer: { emailAddress: { address: "arjun@fieldnote.example" } },
            },
            { id: "o-critique", subject: "Design critique", start: { dateTime: `${D1}T04:30:00.0000000` }, end: { dateTime: `${D1}T05:00:00.0000000` } },
          ],
        };
      },
    },
  );
}

const compact = (date: string) => date.replace(/-/g, "");
const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "X-WR-CALNAME:Family (iCloud)",
  "BEGIN:VEVENT", "UID:icloud-sprint-copy", `DTSTART:${compact(D1)}T043100Z`, `DTEND:${compact(D1)}T050000Z`, "SUMMARY:Sprint review", "END:VEVENT",
  "BEGIN:VEVENT", "UID:icloud-xmas", `DTSTART;VALUE=DATE:${compact(D3)}`, `DTEND;VALUE=DATE:${compact(D4)}`, "SUMMARY:🎄 Christmas", "END:VEVENT",
  "BEGIN:VEVENT", "UID:lunch@icloud", `DTSTART:${compact(D1)}T073000Z`, `DTEND:${compact(D1)}T083000Z`, "SUMMARY:Team lunch", "END:VEVENT",
  "BEGIN:VEVENT", "UID:lunch@icloud", `DTSTART:${compact(D1)}T073000Z`, `DTEND:${compact(D1)}T083000Z`, "SUMMARY:Team lunch", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

async function connectBoth(userId: string): Promise<void> {
  await saveAccount(userId, "google", {
    accessToken: "google-calendar-access",
    refreshToken: "google-calendar-refresh",
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: ["openid", `${G}calendar.events`, `${G}calendar.calendarlist.readonly`],
    account: "mira@fieldnote.example",
    meta: { via: "oauth" },
  });
  await saveAccount(userId, "microsoft", {
    accessToken: "graph-calendar-access",
    refreshToken: "graph-calendar-refresh",
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: ["Calendars.ReadWrite"],
    account: "mira@fieldnote.example",
    meta: { via: "oauth" },
  });
  await saveSettings(db, userId, { timezone: "UTC", connections: { google_calendar: { enabled: true }, outlook_calendar: { enabled: true } } });
}

type View = { id: string; title: string; allDay: boolean; startDate: string | null; meetingUrl: string | null; memberIds: string[]; sources: Array<{ connector: string; label: string; calendar: string | null }>; attendees: Array<{ email: string | null }> };

async function week(user: HttpUser): Promise<{ events: View[]; sources: Array<{ connector: string; label: string }> }> {
  const from = `${day(0)}T00:00:00.000Z`;
  const to = `${day(7)}T00:00:00.000Z`;
  const response = await user.inject({ method: "GET", url: `/api/calendar?from=${from}&to=${to}&tz=UTC` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test("three calendars become one calendar: the same meeting and holiday once, groups stored, a source switched off drops out", async () => {
  mockProviders();
  setCalendarFeedFetchForTests(async (url) => {
    assert.equal(url, "https://p42-caldav.icloud.example/published/2/secret-token");
    return FEED;
  });
  const mira = await verified("mira.calendar@fieldnote.example");
  await connectBoth(mira.id);

  const added = await call(mira, "POST", "/api/calendar/feeds", "/api/calendar/feeds", "happy-path", { url: "webcal://p42-caldav.icloud.example/published/2/secret-token" });
  assert.equal(added.statusCode, 201, added.body);
  const feed = added.json<{ feed: { id: string; name: string; host: string }; events: number }>();
  assert.equal(feed.feed.name, "Family (iCloud)");
  assert.equal(feed.feed.host, "p42-caldav.icloud.example");
  assert.equal(feed.events, 3, "the feed's duplicate VEVENT is one event");
  assert.ok(!added.body.includes("secret-token"), "the link is never returned");
  const stored = await db.calendarFeed.findUniqueOrThrow({ where: { id: feed.feed.id } });
  assert.match(stored.secret, /^v1:/, "the link is stored encrypted");

  const synced = await call(mira, "POST", "/api/calendar/sync", "/api/calendar/sync", "happy-path");
  assert.equal(synced.statusCode, 200, synced.body);
  const outcomes = synced.json<{ outcomes: Array<{ connector: string; ok: boolean; items: number; message: string }> }>().outcomes;
  assert.deepEqual(outcomes.map((row) => [row.connector, row.ok]), [["google_calendar", true], ["outlook_calendar", true], ["ics_calendar", true]], JSON.stringify(outcomes));
  assert.ok(!calls.some((url) => url.includes("hidden%40") || url.includes("cal-arjun")), "hidden Google calendars and colleagues' Outlook calendars are not read");

  const { events, sources } = await week(mira);
  assert.deepEqual(sources.map((row) => row.label), ["Google", "Outlook", "Family (iCloud)"]);
  assert.deepEqual(events.map((row) => row.title).sort(), ["Christmas Day", "Design critique", "Sprint review", "Standup", "Team lunch"].sort(), "titles come from the provider copy, not the calendar link");
  const sprint = events.find((row) => row.title === "Sprint review")!;
  assert.deepEqual(sprint.sources.map((row) => row.connector).sort(), ["google_calendar", "ics_calendar", "outlook_calendar"]);
  assert.equal(sprint.meetingUrl, TEAMS);
  assert.deepEqual(sprint.attendees.map((row) => row.email).sort(), ["arjun@fieldnote.example", "lena@fieldnote.example", "mira@fieldnote.example"]);
  const christmas = events.find((row) => row.allDay)!;
  assert.equal(christmas.startDate, D3);
  assert.deepEqual(christmas.sources.map((row) => row.calendar).sort(), ["Family (iCloud)", "Holidays in India", "India holidays"]);

  const rows = await db.artifact.findMany({ where: { userId: mira.id, kind: "event", id: { in: sprint.memberIds } }, select: { id: true, metadata: true } });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => (row.metadata as { dedupeKey?: string }).dedupeKey === sprint.id), "every copy stores the group's key");

  // The assistant reads the same merged calendar.
  const listEvents = getTool("hub_list_events")!;
  const listed = (await listEvents.run({ app: harness.app, prisma: db, userId: mira.id, actor: "agent", settings: { ...DEFAULT_SETTINGS, timezone: "UTC" } }, listEvents.input.parse({ from: day(0), to: day(6) }))).data as { events: Array<{ title: string; calendar: string; mergedFrom?: number }> };
  assert.equal(listed.events.filter((row) => row.title === "Sprint review").length, 1);
  assert.equal(listed.events.find((row) => row.title === "Sprint review")!.mergedFrom, 3);

  // Switching Google off keeps the meeting from Outlook and the link; Google-only events leave.
  await saveSettings(db, mira.id, { connections: { google_calendar: { enabled: false } } });
  const after = await week(mira);
  assert.ok(!after.events.some((row) => row.title === "Standup"));
  assert.deepEqual(after.events.find((row) => row.title === "Sprint review")!.sources.map((row) => row.connector).sort(), ["ics_calendar", "outlook_calendar"]);
  assert.equal(after.events.filter((row) => row.allDay).length, 1);

  // Another account sees none of it, and cannot touch the link.
  const arjun = await verified("arjun.calendar@fieldnote.example");
  assert.deepEqual((await week(arjun)).events, []);
  const theirs = await call(arjun, "GET", "/api/calendar/feeds", "/api/calendar/feeds", "isolation");
  assert.deepEqual(theirs.json<{ feeds: unknown[] }>().feeds, []);
  assert.equal((await call(arjun, "PATCH", `/api/calendar/feeds/${feed.feed.id}`, "/api/calendar/feeds/:id", "isolation", { name: "Mine now" })).statusCode, 404);
  assert.equal((await call(arjun, "DELETE", `/api/calendar/feeds/${feed.feed.id}`, "/api/calendar/feeds/:id", "isolation")).statusCode, 404);
  const arjunSync = await call(arjun, "POST", "/api/calendar/sync", "/api/calendar/sync", "isolation");
  assert.deepEqual(arjunSync.json<{ outcomes: unknown[] }>().outcomes, []);

  const listedFeeds = await call(mira, "GET", "/api/calendar/feeds", "/api/calendar/feeds", "happy-path");
  assert.equal(listedFeeds.json<{ feeds: Array<{ id: string }> }>().feeds[0]!.id, feed.feed.id);
  assert.ok(!listedFeeds.body.includes("secret"), "neither the link nor its ciphertext is listed");
  const renamed = await call(mira, "PATCH", `/api/calendar/feeds/${feed.feed.id}`, "/api/calendar/feeds/:id", "happy-path", { name: "Family" });
  assert.equal(renamed.json<{ feed: { name: string } }>().feed.name, "Family");
  assert.equal((await call(mira, "PATCH", `/api/calendar/feeds/${feed.feed.id}`, "/api/calendar/feeds/:id", "invalid-input", { name: " " })).statusCode, 400);
  assert.equal((await call(mira, "PATCH", "/api/calendar/feeds/00000000-0000-4000-8000-000000000000", "/api/calendar/feeds/:id", "unknown-id", { name: "x" })).statusCode, 404);

  // Removing the link removes its events; Outlook keeps the meeting.
  assert.equal((await call(mira, "DELETE", "/api/calendar/feeds/00000000-0000-4000-8000-000000000000", "/api/calendar/feeds/:id", "unknown-id")).statusCode, 404);
  assert.equal((await call(mira, "DELETE", `/api/calendar/feeds/${feed.feed.id}`, "/api/calendar/feeds/:id", "happy-path")).statusCode, 204);
  const last = await week(mira);
  assert.ok(!last.events.some((row) => row.title === "Team lunch"));
  assert.deepEqual(last.events.find((row) => row.title === "Sprint review")!.sources.map((row) => row.connector), ["outlook_calendar"]);
});

test("calendar links: only https or webcal, no private addresses, no duplicates; hosted needs a verified email", async (t) => {
  const mira = await verified("mira.links@fieldnote.example");
  setCalendarFeedFetchForTests(async () => FEED);
  for (const url of ["http://calendar.example/feed.ics", "not a link", "https://user:pass@calendar.example/feed.ics"]) {
    const refused = await call(mira, "POST", "/api/calendar/feeds", "/api/calendar/feeds", "invalid-input", { url });
    assert.equal(refused.statusCode, 400, `${url}: ${refused.body}`);
  }
  assert.equal((await call(mira, "POST", "/api/calendar/feeds", "/api/calendar/feeds", "invalid-input", {})).statusCode, 400);
  const first = await call(mira, "POST", "/api/calendar/feeds", "/api/calendar/feeds", "happy-path", { url: "https://calendar.example/holidays.ics", name: "Holidays" });
  assert.equal(first.statusCode, 201, first.body);
  const again = await call(mira, "POST", "/api/calendar/feeds", "/api/calendar/feeds", "invalid-input", { url: "webcal://calendar.example/holidays.ics" });
  assert.equal(again.statusCode, 409, again.body);
  setCalendarFeedFetchForTests(async () => "<html>Sign in</html>");
  const page = await call(mira, "POST", "/api/calendar/feeds", "/api/calendar/feeds", "invalid-input", { url: "https://calendar.example/other.ics" });
  assert.equal(page.statusCode, 400);
  assert.match(page.json<{ error: string }>().error, /did not return a calendar/);

  setCalendarFeedFetchForTests(null);
  const internal = await call(mira, "POST", "/api/calendar/feeds", "/api/calendar/feeds", "invalid-input", { url: "https://127.0.0.1/feed.ics" });
  assert.equal(internal.statusCode, 400, internal.body);
  assert.match(internal.json<{ error: string }>().error, /private address/);

  const unverified = await harness.asUser("new.calendar@fieldnote.example");
  process.env.NODE_ENV = "production";
  t.after(() => {
    process.env.NODE_ENV = "test";
  });
  assert.equal((await call(unverified, "POST", "/api/calendar/feeds", "/api/calendar/feeds", "hosted-verification", { url: "https://calendar.example/x.ics" })).statusCode, 403);
  assert.equal((await call(unverified, "POST", "/api/calendar/sync", "/api/calendar/sync", "hosted-verification")).statusCode, 403);
});

test("meeting cues, the tile feed and Today's first load list one meeting once", async () => {
  const lena = await verified("lena.calendar@fieldnote.example");
  const start = new Date(Date.now() + 2 * 3600_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  const copy = (source: string, externalId: string, title: string) =>
    db.artifact.create({
      data: {
        userId: lena.id,
        kind: "event",
        externalId,
        ts: start,
        title,
        participants: [{ name: "Arjun Rao", email: "arjun@fieldnote.example" }],
        metadata: { source, end: end.toISOString(), allDay: false, uid: "roadmap-sync@fieldnote.example", joinUrl: "https://meet.google.com/abc-defg-hij" },
      },
    });
  await copy("google", "g-roadmap", "Roadmap sync");
  const outlook = await copy("outlook", "outlook:o-roadmap", "Updated invitation: Roadmap sync");
  await db.meetingSession.create({ data: { userId: lena.id, title: "Roadmap notes", artifactId: outlook.id, status: "live" } });

  const cues = (await lena.inject({ method: "GET", url: "/api/meetings/cues" })).json<{ cues: Array<{ title: string; session: { title: string } | null }> }>().cues;
  const roadmap = cues.filter((row) => row.title === "Roadmap sync");
  assert.equal(roadmap.length, 1, JSON.stringify(cues));
  assert.equal(roadmap[0]!.session?.title, "Roadmap notes", "a session on either copy belongs to the one cue");
  assert.equal(cues.length, 1, "the live session is not listed again on its own");

  const feed = (await lena.inject({ method: "GET", url: "/api/widgets/feed" })).json<{ events: Array<{ title: string }> }>();
  assert.deepEqual(feed.events.map((row) => row.title), ["Roadmap sync"]);

  const from = new Date(Date.now() - 3600_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();
  const home = (await lena.inject({ method: "GET", url: `/api/today/home?from=${from}&to=${to}` })).json<{ events: Array<{ title: string; sources: unknown[] }>; calendarSources: unknown[] }>();
  assert.equal(home.events.length, 1);
  assert.equal(home.events[0]!.sources.length, 2);
  assert.deepEqual(home.calendarSources, [], "events kept by hand show without a connected calendar");
});
