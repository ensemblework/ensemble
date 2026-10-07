/**
 * Zoom, Docusign and Jira read tools: request shapes, mapping and errors,
 * against a mocked fetch. Nothing here reaches the vendors.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import "../../runtime/test-env.js";
import { DEFAULT_SETTINGS } from "@ensemble/shared-types";
import { ConnectorNotConnectedError, type ProviderToken } from "../../connectors/tokens.js";
import { appToolsFor } from "../apps.js";
import type { ToolContext } from "../types.js";
import { AppRequestError, setAppTokenResolverForTests, type AppProvider } from "./apps-common.js";
import { docusignTools } from "./docusign.js";
import { jiraTools } from "./jira.js";
import { vttToText, zoomMeetingPath, zoomSummaryText, zoomTools } from "./zoom.js";

const ZOOM_SCOPES = ["user:read:user", "meeting:read:list_meetings", "meeting:read:summary", "cloud_recording:read:list_user_recordings", "cloud_recording:read:meeting_transcript"];

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let seen: Seen[] = [];
let respond: (request: Seen) => Response | Promise<Response> = () => json({});
let tokens: Partial<Record<AppProvider, ProviderToken | null>> = {};
const originalFetch = globalThis.fetch;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  seen = [];
  tokens = {
    zoom: { token: "zoom-token", account: "mira@fieldnote.example", scopes: ZOOM_SCOPES, extra: { zoomUserId: "u1" } },
    docusign: {
      token: "docusign-token",
      account: "mira@fieldnote.example",
      scopes: ["signature"],
      extra: { accountId: "acct-1", baseUri: "https://demo.docusign.net", env: "demo" },
    },
    atlassian: {
      token: "jira-bearer",
      account: "Fieldnote",
      scopes: ["read:jira-work", "read:jira-user", "offline_access"],
      extra: { cloudId: "cloud-1", site: "fieldnote.atlassian.net", siteName: "Fieldnote", auth: "bearer" },
    },
  };
  setAppTokenResolverForTests(async (_userId, provider, label) => {
    const token = tokens[provider];
    if (!token) throw new ConnectorNotConnectedError(provider, `${label} is not connected. Connect it in Settings → Connections.`);
    return token;
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body;
    let body: unknown = raw;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const request = { method: init?.method ?? "GET", url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body };
    seen.push(request);
    return respond(request);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setAppTokenResolverForTests(null);
});

function ctx(grants: Array<{ provider: string; account: string | null; scopes: string[] }> = []): ToolContext {
  const prisma = {
    authToken: { findMany: async () => grants, findUnique: async () => null },
    user: { findUnique: async () => ({ name: "Mira Chen" }) },
  };
  return {
    app: { log: { error() {} } } as never,
    prisma: prisma as never,
    userId: "user-mira",
    actor: "agent",
    settings: { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata" },
  };
}

const ALL = [...zoomTools, ...docusignTools, ...jiraTools];

async function run(name: string, input: Record<string, unknown>) {
  const tool = ALL.find((candidate) => candidate.name === name);
  assert.ok(tool, name);
  return tool.run(ctx(), tool.input.parse(input));
}

test("the Zoom, Docusign and Jira tools only read, and are offered only when their account is connected", async () => {
  assert.deepEqual(ALL.map((tool) => tool.name), [
    "zoom_list_meetings",
    "zoom_get_meeting_summary",
    "zoom_list_recordings",
    "zoom_get_transcript",
    "docusign_list_envelopes",
    "docusign_get_envelope",
    "jira_search",
    "jira_get_issue",
  ]);
  for (const tool of ALL) {
    assert.equal(tool.isWrite, false, tool.name);
    assert.equal(tool.area, "apps", tool.name);
    assert.ok(tool.app, tool.name);
    assert.ok(tool.description.length >= 40 && tool.description.length <= 160, tool.name);
  }
  const offered = async (grants: Array<{ provider: string; account: string | null; scopes: string[] }>) => new Set((await appToolsFor(ctx(grants))).map((tool) => tool.name));
  const none = await offered([]);
  assert.equal(ALL.some((tool) => none.has(tool.name)), false);
  const zoomOnly = await offered([{ provider: "zoom", account: "mira@fieldnote.example", scopes: ZOOM_SCOPES }]);
  assert.ok(zoomTools.every((tool) => zoomOnly.has(tool.name)));
  assert.equal([...docusignTools, ...jiraTools].some((tool) => zoomOnly.has(tool.name)), false);
  const all = await offered([
    { provider: "docusign", account: null, scopes: [] },
    { provider: "atlassian", account: null, scopes: [] },
  ]);
  assert.ok([...docusignTools, ...jiraTools].every((tool) => all.has(tool.name)));
});

test("not connected and missing access are reported before anything is sent", async () => {
  tokens = {};
  await assert.rejects(() => run("zoom_list_meetings", {}), /^ConnectorNotConnectedError: Zoom is not connected\. Connect it in Settings → Connections\.$/);
  await assert.rejects(() => run("docusign_list_envelopes", {}), /Docusign is not connected/);
  await assert.rejects(() => run("jira_search", {}), /Jira is not connected/);
  tokens.zoom = { token: "zoom-token", account: null, scopes: ["meeting:read:list_meetings"] };
  await assert.rejects(
    () => run("zoom_get_meeting_summary", { meetingId: "123" }),
    (error: unknown) => error instanceof ConnectorNotConnectedError && error.statusCode === 409 && /^Zoom is connected without the access this needs\./.test(error.message),
  );
  tokens.atlassian = { token: "jira-bearer", account: null, scopes: ["offline_access"], extra: { cloudId: "cloud-1", auth: "bearer" } };
  await assert.rejects(() => run("jira_search", {}), /Jira is connected without the access this needs/);
  tokens.docusign = { token: "t", account: null, scopes: ["signature"], extra: { accountId: "acct-1", baseUri: "https://docusign.example.org" } };
  await assert.rejects(() => run("docusign_list_envelopes", {}), /points outside Docusign/);
  assert.equal(seen.length, 0);
});

test("zoom_list_meetings asks for upcoming or previous meetings in the person's zone", async () => {
  respond = () =>
    json({
      meetings: [{ id: 97763643886, uuid: "aDYlohsHRtCd4ii1uC2+hA==", topic: "Design review", start_time: "2026-10-14T09:30:00Z", duration: 30, join_url: "https://zoom.us/j/97763643886" }],
      next_page_token: "next-1",
    });
  const upcoming = await run("zoom_list_meetings", {});
  assert.equal(seen[0]!.url, "https://api.zoom.us/v2/users/me/meetings?type=upcoming&page_size=30");
  assert.equal(seen[0]!.headers.authorization, "Bearer zoom-token");
  assert.deepEqual(upcoming.data, {
    meetings: [{ id: 97763643886, uuid: "aDYlohsHRtCd4ii1uC2+hA==", topic: "Design review", start: "Wed 14 Oct 15:00", durationMinutes: 30, agenda: undefined, joinUrl: "https://zoom.us/j/97763643886" }],
    nextPageToken: "next-1",
  });
  await run("zoom_list_meetings", { when: "past", from: "2026-10-01", to: "2026-10-06", nextPageToken: "next-1" });
  assert.equal(seen[1]!.url, "https://api.zoom.us/v2/users/me/meetings?type=previous_meetings&page_size=30&from=2026-10-01&to=2026-10-06&next_page_token=next-1");
});

test("zoom_get_meeting_summary reads the AI Companion summary and says when the plan does not include it", async () => {
  assert.equal(zoomMeetingPath("97763643886"), "97763643886");
  assert.equal(zoomMeetingPath("aDYl+hA=="), "aDYl%2BhA%3D%3D");
  assert.equal(zoomMeetingPath("/ajXp112QmuoKj4854875=="), "%252FajXp112QmuoKj4854875%253D%253D");
  respond = () => json({ summary_title: "Design review", meeting_start_time: "2026-10-14T09:30:00Z", summary_content: "## Key takeaways\n- Ship the store", summary_doc_url: "https://docs.zoom.us/doc/abc" });
  const result = await run("zoom_get_meeting_summary", { meetingId: "/ajXp112QmuoKj4854875==" });
  assert.equal(seen[0]!.url, "https://api.zoom.us/v2/meetings/%252FajXp112QmuoKj4854875%253D%253D/meeting_summary");
  const data = result.data as { summary: string; title: string; link: string };
  assert.equal(data.summary, "## Key takeaways\n- Ship the store");
  assert.equal(data.title, "Design review");
  assert.equal(result.href, "https://docs.zoom.us/doc/abc");
  assert.equal(
    zoomSummaryText({ summary_overview: "We agreed the launch date.", summary_details: [{ label: "Launch", summary: "Oct 20." }], next_steps: ["Sam books the room"] }),
    "We agreed the launch date.\n\n## Launch\nOct 20.\n\n## Next steps\n- Sam books the room",
  );
  respond = () => json({ code: 200, message: "Only available for Paid account." }, 400);
  await assert.rejects(
    () => run("zoom_get_meeting_summary", { meetingId: "123" }),
    (error: unknown) => error instanceof AppRequestError && /need a paid Zoom plan \(Pro or higher\)/.test(error.message),
  );
  respond = () => json({ code: 4711, message: "Invalid access token, does not contain scopes:[meeting:read:summary]." }, 400);
  await assert.rejects(() => run("zoom_get_meeting_summary", { meetingId: "123" }), ConnectorNotConnectedError);
});

test("zoom_list_recordings keeps the range within a month and marks recordings with transcripts", async () => {
  respond = () =>
    json({
      meetings: [
        {
          id: 1,
          uuid: "u==",
          topic: "Design review",
          start_time: "2026-10-01T09:30:00Z",
          duration: 31,
          share_url: "https://zoom.us/rec/share/abc",
          recording_files: [{ file_type: "MP4" }, { file_type: "TRANSCRIPT" }, { file_type: "MP4" }],
        },
      ],
    });
  const result = await run("zoom_list_recordings", { from: "2026-08-01", to: "2026-10-07" });
  assert.equal(seen[0]!.url, "https://api.zoom.us/v2/users/me/recordings?from=2026-09-07&to=2026-10-07&page_size=30");
  const data = result.data as { recordings: Array<{ files: string[]; hasTranscript: boolean; start: string }>; note?: string; from: string };
  assert.equal(data.from, "2026-09-07");
  assert.deepEqual(data.recordings[0]?.files, ["MP4", "TRANSCRIPT"]);
  assert.equal(data.recordings[0]?.hasTranscript, true);
  assert.match(data.note ?? "", /at most 30 days/);
  respond = () => json({ code: 200, message: "No permission." }, 400);
  await assert.rejects(() => run("zoom_list_recordings", {}), /need a paid Zoom plan/);
});

const VTT = `WEBVTT

1
00:00:01.200 --> 00:00:04.000
Mira Chen: Morning, everyone.

2
00:00:04.500 --> 00:00:06.000
Mira Chen: Quick one today.

3
00:01:02.000 --> 00:01:05.000
Sam Ortiz: The store ships <i>Monday</i>.

4
01:00:00.000 --> 01:00:02.000
Thanks all.
`;

test("zoom_get_transcript turns the VTT into speaker lines, and follows only zoom.us download links", async () => {
  assert.equal(vttToText(VTT), "[00:01] Mira Chen: Morning, everyone. Quick one today.\n[01:02] Sam Ortiz: The store ships Monday.\n[1:00:00] Thanks all.");
  respond = ({ url }) =>
    url.endsWith("/transcript")
      ? json({ meeting_id: "u==", can_download: true, download_url: "https://zoom.us/rec/meeting/transcript/download/xyz" })
      : new Response(VTT, { headers: { "content-type": "text/vtt" } });
  const result = await run("zoom_get_transcript", { meetingId: "u==" });
  assert.equal(seen[0]!.url, "https://api.zoom.us/v2/meetings/u%3D%3D/transcript");
  assert.equal(seen[1]!.url, "https://zoom.us/rec/meeting/transcript/download/xyz");
  assert.equal(seen[1]!.headers.authorization, "Bearer zoom-token");
  const data = result.data as { speakers: string[]; transcript: string };
  assert.deepEqual(data.speakers, ["Mira Chen", "Sam Ortiz"]);
  assert.match(data.transcript, /^\[00:01\] Mira Chen: Morning/);

  seen = [];
  respond = () => json({ can_download: false, download_restriction_reason: "NOT_READY" });
  await assert.rejects(() => run("zoom_get_transcript", { meetingId: "123" }), /still processing this transcript/);
  respond = () => json({ can_download: true, download_url: "https://zoom.evil.example/rec/x" });
  seen = [];
  await assert.rejects(() => run("zoom_get_transcript", { meetingId: "123" }), /outside zoom\.us/);
  assert.equal(seen.length, 1, "the token is never sent to another host");
  respond = () => json({ code: 3322, message: "This meeting transcript does not exist." }, 404);
  await assert.rejects(() => run("zoom_get_transcript", { meetingId: "123" }), /Zoom could not find that item \(no transcript for that meeting/);
});

test("docusign_list_envelopes and docusign_get_envelope read the account's envelopes and who they wait on", async () => {
  const recipients = {
    signers: [
      { name: "Sam Ortiz", email: "sam@fieldnote.example", status: "completed", routingOrder: "1", signedDateTime: "2026-10-05T06:00:00Z" },
      { name: "Lee Park", email: "lee@fieldnote.example", status: "delivered", routingOrder: "2" },
      { name: "Ana Ruiz", email: "ana@fieldnote.example", status: "created", routingOrder: "3" },
    ],
    carbonCopies: [{ name: "Mira Chen", email: "mira@fieldnote.example", status: "created", routingOrder: "4" }],
  };
  const envelope = {
    envelopeId: "1b2c3d4e-0000-4000-8000-000000000001",
    status: "sent",
    emailSubject: "Please sign: Fieldnote MSA",
    sentDateTime: "2026-10-04T04:30:00Z",
    statusChangedDateTime: "2026-10-05T06:00:00Z",
    sender: { userName: "Mira Chen", email: "mira@fieldnote.example" },
    recipients,
  };
  respond = ({ url }) => (url.includes("/envelopes?") ? json({ envelopes: [envelope], totalSetSize: "1" }) : json(envelope));
  const list = await run("docusign_list_envelopes", { status: "waiting", from: "2026-10-01", needsMySignature: true, query: "MSA" });
  const url = new URL(seen[0]!.url);
  assert.equal(url.origin + url.pathname, "https://demo.docusign.net/restapi/v2.1/accounts/acct-1/envelopes");
  assert.equal(url.searchParams.get("from_date"), "2026-09-30T18:30:00.000Z");
  assert.equal(url.searchParams.get("status"), "sent,delivered");
  assert.equal(url.searchParams.get("include"), "recipients");
  assert.equal(url.searchParams.get("folder_types"), "awaiting_my_signatures");
  assert.equal(url.searchParams.get("search_text"), "MSA");
  assert.equal(seen[0]!.headers.authorization, "Bearer docusign-token");
  const row = (list.data as { envelopes: Array<Record<string, unknown>> }).envelopes[0]!;
  assert.deepEqual(row.waitingOn, ["Lee Park <lee@fieldnote.example>"]);
  assert.equal(row.link, "https://appdemo.docusign.com/documents/details/1b2c3d4e-0000-4000-8000-000000000001");

  const one = await run("docusign_get_envelope", { envelopeId: "1b2c3d4e-0000-4000-8000-000000000001" });
  assert.equal(seen[1]!.url, "https://demo.docusign.net/restapi/v2.1/accounts/acct-1/envelopes/1b2c3d4e-0000-4000-8000-000000000001?include=recipients");
  assert.equal(one.summary, "“Please sign: Fieldnote MSA” is sent, waiting on Lee Park <lee@fieldnote.example>.");
  const data = one.data as { recipients: Array<{ name: string; role: string; status: string; signed?: string }> };
  assert.deepEqual(
    data.recipients.map((person) => [person.name, person.role, person.status]),
    [
      ["Sam Ortiz", "signer", "completed"],
      ["Lee Park", "signer", "delivered"],
      ["Ana Ruiz", "signer", "created"],
      ["Mira Chen", "gets a copy", "created"],
    ],
  );
  assert.equal(data.recipients[0]?.signed, "Mon 5 Oct 11:30");
  assert.equal(one.href, "https://appdemo.docusign.com/documents/details/1b2c3d4e-0000-4000-8000-000000000001");
  assert.throws(() => docusignTools[1]!.input.parse({ envelopeId: "../../users" }));
});

const ADF = {
  type: "doc",
  version: 1,
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Scope" }] },
    { type: "paragraph", content: [{ type: "text", text: "Ship the store page." }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Logos" }] }] }] },
  ],
};

test("jira_search posts JQL to the cloud API with the OAuth token and maps the issues", async () => {
  respond = () =>
    json({
      issues: [
        {
          id: "10042",
          key: "WEB-42",
          fields: {
            summary: "Store page",
            status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
            assignee: { displayName: "Mira Chen" },
            duedate: "2026-10-20",
            labels: ["launch"],
            priority: { name: "High" },
            project: { key: "WEB", name: "Website" },
            issuetype: { name: "Story" },
          },
        },
      ],
      nextPageToken: "page-2",
      isLast: false,
    });
  const result = await run("jira_search", {});
  const request = seen[0]!;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/search/jql");
  assert.equal(request.headers.authorization, "Bearer jira-bearer");
  assert.deepEqual(request.body, {
    jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
    maxResults: 20,
    fields: ["summary", "status", "assignee", "duedate", "labels", "priority", "project", "issuetype", "updated"],
  });
  const data = result.data as { issues: Array<Record<string, unknown>>; nextPageToken?: string };
  assert.deepEqual(data.issues[0], {
    key: "WEB-42",
    summary: "Store page",
    status: "In Progress",
    done: false,
    type: "Story",
    assignee: "Mira Chen",
    due: "2026-10-20",
    priority: "High",
    labels: ["launch"],
    project: "WEB Website",
    updated: undefined,
    link: "https://fieldnote.atlassian.net/browse/WEB-42",
  });
  assert.equal(data.nextPageToken, "page-2");
  await run("jira_search", { jql: "project = WEB", max: 5, nextPageToken: "page-2" });
  assert.deepEqual((seen[1]!.body as Record<string, unknown>).nextPageToken, "page-2");
  respond = () => json({ errorMessages: ["Error in the JQL Query: Expecting operator but got 'banana'."], errors: {} }, 400);
  await assert.rejects(() => run("jira_search", { jql: "project banana" }), /Jira refused the request \(HTTP 400\): Error in the JQL Query/);
});

test("jira_get_issue works with a pasted token against the site and turns the description into Markdown", async () => {
  tokens.atlassian = {
    token: "mira@fieldnote.example:atl-token",
    account: "mira@fieldnote.example @ fieldnote.atlassian.net",
    scopes: [],
    extra: { via: "token", auth: "basic", site: "fieldnote.atlassian.net", email: "mira@fieldnote.example" },
  };
  respond = () =>
    json({
      id: "10042",
      key: "WEB-42",
      fields: {
        summary: "Store page",
        status: { name: "Done", statusCategory: { key: "done" } },
        reporter: { displayName: "Sam Ortiz" },
        description: ADF,
        comment: { total: 7, comments: [{ author: { displayName: "Sam Ortiz" }, created: "2026-10-05T06:00:00Z", body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good." }] }] } }] },
      },
    });
  const result = await run("jira_get_issue", { key: "web-42" });
  const request = seen[0]!;
  assert.equal(request.url, "https://fieldnote.atlassian.net/rest/api/3/issue/WEB-42?fields=summary,status,assignee,duedate,labels,priority,project,issuetype,updated,description,reporter,created,parent,comment");
  assert.equal(request.headers.authorization, `Basic ${Buffer.from("mira@fieldnote.example:atl-token").toString("base64")}`);
  const data = result.data as { description: string; comments: Array<{ author: string; text: string; at: string }>; commentCount: number; done: boolean; link: string };
  assert.match(data.description, /Scope/);
  assert.match(data.description, /Ship the store page\./);
  assert.match(data.description, /- Logos/);
  assert.deepEqual(data.comments, [{ author: "Sam Ortiz", at: "Mon 5 Oct 11:30", text: "Looks good." }]);
  assert.equal(data.commentCount, 7);
  assert.equal(data.done, true);
  assert.equal(result.href, "https://fieldnote.atlassian.net/browse/WEB-42");
  assert.equal(result.summary, "Read WEB-42 “Store page” (Done).");

  respond = () => json({ errorMessages: ["Issue does not exist or you do not have permission to see it."] }, 404);
  await assert.rejects(() => run("jira_get_issue", { key: "WEB-404" }), /Jira could not find that item \(check the key, and that this Jira account can see it\)/);
  tokens.atlassian = { ...tokens.atlassian, extra: { auth: "basic", site: "evil.example.com" } };
  seen = [];
  await assert.rejects(() => run("jira_get_issue", { key: "WEB-1" }), /no site saved/);
  assert.equal(seen.length, 0);
  assert.throws(() => jiraTools[1]!.input.parse({ key: "../../admin" }));
});
