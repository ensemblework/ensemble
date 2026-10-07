/**
 * Microsoft Graph parsing, paging and scope checks. No network: fetch is mocked.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "../runtime/test-env.js";
import { GRAPH, graphPages, odata, outlookEventInput, outlookMessageInput, teamsMessageInput, type GraphChat } from "./microsoft.js";
import { normalizeScopes } from "./oauth.js";
import { productState, scopesFor, sourceToggles, SUITES } from "./products.js";
import { hasScopes, missingScopes } from "./tokens.js";
import { ConnectorError } from "./types.js";

const ME = "mira@fieldnote.example";

test("Outlook messages become email artifacts with quoted history removed", () => {
  const parsed = outlookMessageInput(
    {
      id: "AAMkAD1",
      conversationId: "conv-1",
      subject: "Q3 launch checklist",
      bodyPreview: "Can you send the checklist by Friday?",
      body: { contentType: "html", content: "<p>Can you send the checklist by Friday?</p><div>On Mon, Oct 5, 2026 Mira Chen wrote:</div><p>older text</p>" },
      from: { emailAddress: { name: "Arjun Rao", address: "Arjun@Fieldnote.example" } },
      toRecipients: [{ emailAddress: { name: "Mira Chen", address: ME } }],
      ccRecipients: [{ emailAddress: { name: "", address: "ops@fieldnote.example" } }],
      receivedDateTime: "2026-10-06T09:30:00Z",
      webLink: "https://outlook.office365.com/owa/?ItemID=AAMkAD1",
    },
    "inbox",
    [ME, null],
  );
  assert.equal(parsed.sent, false);
  assert.equal(parsed.from.email, "arjun@fieldnote.example");
  assert.equal(parsed.input.externalId, "outlook:AAMkAD1");
  assert.equal(parsed.input.threadId, "outlook:conv-1");
  assert.equal(parsed.input.kind, "email");
  assert.equal(parsed.input.text, "Can you send the checklist by Friday?");
  assert.equal(parsed.input.metadata.source, "outlook");
  assert.equal(parsed.input.metadata.directlyToMe, true);
  assert.equal(parsed.input.metadata.from, "Arjun Rao <arjun@fieldnote.example>");
  assert.equal(parsed.input.participants.length, 3);
  assert.equal(parsed.input.ts.toISOString(), "2026-10-06T09:30:00.000Z");

  const sent = outlookMessageInput({ id: "s1", subject: null, sentDateTime: "2026-10-06T10:00:00Z", toRecipients: [] }, "sent", [ME]);
  assert.equal(sent.sent, true);
  assert.equal(sent.input.title, "(no subject)");
  assert.equal(sent.input.authoredByMe, true);
});

test("Outlook calendar events keep join links and skip declined and cancelled meetings", () => {
  const event = outlookEventInput({
    id: "evt-1",
    subject: "Design review",
    start: { dateTime: "2026-10-08T05:30:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-10-08T06:00:00.0000000", timeZone: "UTC" },
    onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
    location: { displayName: "Room 4" },
    isOrganizer: true,
    attendees: [{ emailAddress: { name: "Arjun Rao", address: "ARJUN@fieldnote.example" } }],
    organizer: { emailAddress: { address: ME } },
  });
  assert.ok(event);
  assert.equal(event.externalId, "outlook:evt-1");
  assert.equal(event.ts.toISOString(), "2026-10-08T05:30:00.000Z");
  assert.equal(event.metadata.end, "2026-10-08T06:00:00.000Z");
  assert.equal(event.metadata.joinUrl, "https://teams.microsoft.com/l/meetup-join/abc");
  assert.equal(event.metadata.source, "outlook");
  assert.equal(event.metadata.location, "Room 4");
  assert.equal(event.authoredByMe, true);
  assert.equal(event.participants[0]!.email, "arjun@fieldnote.example");
  assert.equal(outlookEventInput({ id: "x", isCancelled: true, start: { dateTime: "2026-10-08T05:30:00" } }), null);
  assert.equal(outlookEventInput({ id: "y", responseStatus: { response: "declined" }, start: { dateTime: "2026-10-08T05:30:00" } }), null);
  assert.equal(outlookEventInput({ id: "z" }), null);
});

test("Teams messages: direct chats and mentions ask something of me, system and own messages do not", () => {
  const me = "user-mira";
  const oneOnOne: GraphChat = {
    id: "19:chat-1",
    chatType: "oneOnOne",
    members: [
      { userId: me, displayName: "Mira Chen", email: ME },
      { userId: "user-arjun", displayName: "Arjun Rao", email: "Arjun@fieldnote.example" },
    ],
  };
  const direct = teamsMessageInput(oneOnOne, {
    id: "m1",
    messageType: "message",
    createdDateTime: "2026-10-06T08:00:00Z",
    from: { user: { id: "user-arjun", displayName: "Arjun Rao" } },
    body: { contentType: "html", content: "<p>Could you review the brief today?</p>" },
  }, me);
  assert.ok(direct);
  assert.equal(direct.asksMe, true);
  assert.equal(direct.mine, false);
  assert.equal(direct.author.email, "arjun@fieldnote.example");
  assert.equal(direct.input.text, "Could you review the brief today?");
  assert.equal(direct.input.title, "Chat with Arjun Rao · Arjun Rao");
  assert.equal(direct.input.externalId, "teams:19:chat-1:m1");
  assert.equal(direct.input.metadata.source, "teams");
  assert.equal(direct.input.metadata.direct, true);

  const group: GraphChat = { id: "19:group", chatType: "group", topic: "Launch crew", members: oneOnOne.members };
  const chatter = teamsMessageInput(group, { id: "m2", messageType: "message", from: { user: { id: "user-arjun" } }, body: { content: "Lunch at noon" } }, me);
  assert.equal(chatter?.asksMe, false);
  assert.equal(chatter?.input.title, "Launch crew · Arjun Rao");
  const mention = teamsMessageInput(
    group,
    { id: "m3", messageType: "message", from: { user: { id: "user-arjun" } }, body: { content: "Mira, can you sign off?" }, mentions: [{ mentioned: { user: { id: me } } }] },
    me,
  );
  assert.equal(mention?.asksMe, true);
  assert.equal(mention?.input.metadata.mentionsMe, true);
  const own = teamsMessageInput(group, { id: "m4", messageType: "message", from: { user: { id: me } }, body: { content: "Sure" } }, me);
  assert.equal(own?.mine, true);
  assert.equal(own?.asksMe, false);
  assert.equal(teamsMessageInput(group, { id: "m5", messageType: "systemEventMessage", from: null, body: { content: "added" } }, me), null);
  assert.equal(teamsMessageInput(group, { id: "m6", messageType: "message", deletedDateTime: "2026-10-06T08:00:00Z", from: { user: { id: "user-arjun" } } }, me), null);
});

test("odata keeps the $ of query options and encodes values", () => {
  assert.equal(odata({ $filter: "receivedDateTime ge 2026-10-01T00:00:00.000Z", $top: 50, skip: undefined }), "$filter=receivedDateTime%20ge%202026-10-01T00%3A00%3A00.000Z&$top=50");
});

test("graphPages follows nextLink on Graph only and stops at the cap", async (t) => {
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer graph-token");
    if (url.endsWith("page=1")) return Response.json({ value: [{ id: 1 }, { id: 2 }], "@odata.nextLink": `${GRAPH}/me/messages?page=2` });
    if (url.endsWith("page=2")) return Response.json({ value: [{ id: 3 }], "@odata.nextLink": "https://evil.example/steal" });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  const rows = await graphPages<{ id: number }>("graph-token", `${GRAPH}/me/messages?page=1`, "Outlook", 10);
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3]);
  assert.equal(seen.length, 2);
  const capped = await graphPages<{ id: number }>("graph-token", `${GRAPH}/me/messages?page=1`, "Outlook", 2);
  assert.deepEqual(capped.map((row) => row.id), [1, 2]);

  globalThis.fetch = (async () => new Response("denied", { status: 403 })) as typeof fetch;
  await assert.rejects(graphPages("graph-token", `${GRAPH}/me/messages`, "Outlook", 5), (error: unknown) => error instanceof ConnectorError && error.needsReconnect);
});

test("Graph scopes match with or without the resource prefix, and broader grants cover narrower ones", () => {
  const scopes = normalizeScopes("https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Files.ReadWrite openid profile", []);
  assert.deepEqual(scopes, ["Mail.Read", "Files.ReadWrite", "openid", "profile"]);
  assert.equal(hasScopes({ scopes }, ["mail.read"]), true);
  assert.equal(hasScopes({ scopes }, ["Files.Read"]), true);
  assert.deepEqual(missingScopes({ scopes }, ["Mail.Read", "Chat.Read", "Calendars.ReadWrite"]), ["Chat.Read", "Calendars.ReadWrite"]);
  assert.deepEqual(normalizeScopes("repo,read:org", []), ["repo", "read:org"]);
  assert.deepEqual(normalizeScopes(undefined, ["read"]), ["read"]);
  assert.deepEqual(normalizeScopes(["read", "write"], []), ["read", "write"]);
});

test("suite products choose scopes and sources", () => {
  const google = SUITES.google_workspace!;
  const defaults = productState(google, { connectorProducts: {} });
  assert.deepEqual(defaults, { gmail: true, calendar: true, drive_docs: true, drive_search: false });
  const scopes = scopesFor(google, { ...defaults, gmail: false });
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.events"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.calendarlist.readonly"));
  assert.ok(!scopes.includes("https://www.googleapis.com/auth/gmail.readonly"));
  assert.ok(!scopes.includes("https://www.googleapis.com/auth/drive.readonly"));
  assert.ok(!scopes.includes("https://www.googleapis.com/auth/calendar.readonly"));
  const microsoft = SUITES.microsoft_365!;
  assert.deepEqual(sourceToggles(microsoft, { outlook_mail: true, outlook_calendar: false, teams: true }), { outlook: true, outlook_calendar: false, teams: true });
  const saved = productState(microsoft, { connectorProducts: { microsoft_365: { teams: true, office: false } } });
  assert.equal(saved.teams, true);
  assert.equal(saved.office, false);
  assert.equal(saved.outlook_mail, true);
});
