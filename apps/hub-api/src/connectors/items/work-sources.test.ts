/**
 * Item sources for Jira, Trello, Asana, Todoist, ClickUp, monday.com, Slack,
 * Google Workspace and Microsoft 365. No network: ctx.fetch is mocked with vendor-shaped JSON.
 */
import "../../runtime/test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { markdownToDocx } from "../../lib/office/docx.js";
import { ConnectorNotConnectedError, type ProviderToken } from "../tokens.js";
import { adfDoc, atlassianItems, jiraRef } from "./sources/atlassian.js";
import { asanaItems, asanaRef } from "./sources/asana.js";
import { clickupItems } from "./sources/clickup.js";
import { googleItems } from "./sources/google.js";
import { microsoftItems } from "./sources/microsoft.js";
import { mondayItems } from "./sources/monday.js";
import { slackItems, slackText } from "./sources/slack.js";
import { todoistItems, todoistRef } from "./sources/todoist.js";
import { trelloItems, trelloRef } from "./sources/trello.js";
import { WORK_ITEM_SOURCES } from "./sources/work.js";
import { ItemError, type ItemContext } from "./types.js";

const SECRET = "fieldnote_SECRET_token_7c1e2d9a";
const G = "https://www.googleapis.com/auth/";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

type Reply = unknown | ((call: Call) => unknown);
type Route = [method: string, match: RegExp, reply: Reply];

function mockFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: { ...(init.headers as Record<string, string>) }, body: typeof init.body === "string" ? init.body : undefined };
    calls.push(call);
    const route = routes.find(([method, match]) => method === call.method && match.test(call.url));
    if (!route) return new Response(JSON.stringify({ message: `unmatched ${call.method} ${call.url}` }), { status: 418 });
    const value = typeof route[2] === "function" ? (route[2] as (call: Call) => unknown)(call) : route[2];
    if (value instanceof Response) return value;
    return new Response(typeof value === "string" ? value : JSON.stringify(value), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function context(fetch: typeof globalThis.fetch, token: Partial<ProviderToken> = {}): ItemContext {
  return {
    userId: "user-mira",
    token: { token: SECRET, account: "mira@fieldnote.example", scopes: [], extra: {}, meta: {}, ...token },
    fetch,
    signal: AbortSignal.timeout(5000),
  };
}

const jsonBody = (call: Call | undefined) => JSON.parse(call?.body ?? "null") as Record<string, unknown>;
const params = (call: Call | undefined) => new URL(call!.url).searchParams;

// Jira -----------------------------------------------------------------------

const JIRA_BASIC = { token: `mira@fieldnote.example:${SECRET}`, extra: { auth: "basic", site: "fieldnote.atlassian.net", email: "mira@fieldnote.example" } };
const JIRA_OAUTH = { scopes: ["read:jira-work", "read:jira-user", "offline_access"], extra: { auth: "bearer", cloudId: "c0ffee-1234", site: "fieldnote.atlassian.net" } };

const jiraIssue = {
  id: "10042",
  key: "WEB-42",
  fields: {
    summary: "Checkout button overlaps the footer on mobile",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    assignee: { accountId: "5f1-mira", displayName: "Mira Chen", emailAddress: "mira@fieldnote.example" },
    reporter: { accountId: "5f1-arjun", displayName: "Arjun Rao" },
    duedate: "2026-10-20",
    labels: ["mobile", "checkout"],
    priority: { name: "High" },
    project: { key: "WEB", name: "Fieldnote Web" },
    issuetype: { name: "Bug" },
    updated: "2026-10-10T09:15:00.000+0000",
    description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "On iPhone 15 the button sits under the footer." }] }] },
  },
};

test("Jira search uses JQL text search with Basic auth, and finds projects and Confluence pages for an API token", async () => {
  const { fetch, calls } = mockFetch([
    ["POST", /fieldnote\.atlassian\.net\/rest\/api\/3\/search\/jql$/, { issues: [jiraIssue] }],
    ["GET", /\/rest\/api\/3\/project\/search\?/, { values: [{ id: "100", key: "WEB", name: "Fieldnote Web", insight: { lastIssueUpdateTime: "2026-10-10T09:15:00.000+0000" } }] }],
    [
      "GET",
      /\/wiki\/rest\/api\/search\?/,
      {
        results: [
          {
            content: { id: "98765", type: "page", title: "Checkout redesign", _links: { webui: "/spaces/WEB/pages/98765/Checkout+redesign" } },
            title: "@@@hl@@@Checkout@@@endhl@@@ redesign",
            lastModified: "2026-10-08T12:00:00.000Z",
            resultGlobalContainer: { title: "Web team" },
          },
        ],
      },
    ],
  ]);
  const items = await atlassianItems.search(context(fetch, JIRA_BASIC), { q: "checkout", limit: 5 });
  assert.deepEqual(
    items.map((item) => [item.kind, item.id, item.url]),
    [
      ["issue", "WEB-42", "https://fieldnote.atlassian.net/browse/WEB-42"],
      ["project", "WEB", "https://fieldnote.atlassian.net/browse/WEB"],
      ["page", "98765", "https://fieldnote.atlassian.net/wiki/spaces/WEB/pages/98765/Checkout+redesign"],
    ],
  );
  assert.equal(items[0]!.title, "WEB-42 Checkout button overlaps the footer on mobile");
  assert.equal(items[2]!.title, "Checkout redesign");
  const search = calls[0]!;
  assert.equal(search.headers.Authorization, `Basic ${Buffer.from(`mira@fieldnote.example:${SECRET}`).toString("base64")}`);
  assert.equal(jsonBody(search).jql, 'text ~ "checkout" ORDER BY updated DESC');
  assert.match(params(calls[2]).get("cql") ?? "", /^type = page AND text ~ "checkout"$/);
});

test("Jira over OAuth goes through api.atlassian.com, skips Confluence, and lists my open issues for an empty search", async () => {
  const { fetch, calls } = mockFetch([
    ["POST", /^https:\/\/api\.atlassian\.com\/ex\/jira\/c0ffee-1234\/rest\/api\/3\/search\/jql$/, { issues: [jiraIssue] }],
    ["GET", /^https:\/\/api\.atlassian\.com\/ex\/jira\/c0ffee-1234\/rest\/api\/3\/project\/search/, { values: [] }],
  ]);
  const items = await atlassianItems.search(context(fetch, JIRA_OAUTH), { q: "", limit: 5 });
  assert.equal(items.length, 1);
  assert.equal(calls[0]!.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(jsonBody(calls[0]).jql, "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
  assert.ok(!calls.some((call) => call.url.includes("/wiki/")));
  await assert.rejects(atlassianItems.read(context(fetch, JIRA_OAUTH), { kind: "page", id: "98765" }), (error: unknown) => error instanceof ItemError && error.statusCode === 400);
});

test("Jira reads an issue with its description and latest comments, oldest first", async () => {
  const { fetch } = mockFetch([
    [
      "GET",
      /\/rest\/api\/3\/issue\/WEB-42\/comment\?orderBy=-created&maxResults=10$/,
      {
        comments: [
          { author: { displayName: "Arjun Rao" }, created: "2026-10-09T10:00:00.000+0000", body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Seen on Android too." }] }] } },
          { author: { displayName: "Mira Chen" }, created: "2026-10-08T10:00:00.000+0000", body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Reproduced." }] }] } },
        ],
      },
    ],
    ["GET", /\/rest\/api\/3\/issue\/WEB-42\?fields=/, jiraIssue],
  ]);
  const content = await atlassianItems.read(context(fetch, JIRA_BASIC), { kind: "issue", id: "web-42" });
  assert.equal(content.id, "WEB-42");
  assert.equal(content.facts?.Status, "In Progress");
  assert.equal(content.facts?.Due, "2026-10-20");
  assert.match(content.text, /On iPhone 15 the button sits under the footer\./);
  assert.ok(content.text.indexOf("Reproduced.") < content.text.indexOf("Seen on Android too."));
  assert.deepEqual(content.people, [
    { name: "Mira Chen", email: "mira@fieldnote.example", handle: "5f1-mira" },
    { name: "Arjun Rao", handle: "5f1-arjun" },
  ]);
});

test("Jira comments are Atlassian Document Format with one paragraph per line", async () => {
  const { fetch, calls } = mockFetch([["POST", /\/rest\/api\/3\/issue\/WEB-42\/comment$/, { id: "20001" }]]);
  const posted = await atlassianItems.comment!(context(fetch, JIRA_BASIC), { kind: "issue", id: "WEB-42" }, "Fixed in #311.\n\nShips Friday.");
  assert.equal(posted.url, "https://fieldnote.atlassian.net/browse/WEB-42?focusedCommentId=20001");
  assert.deepEqual(jsonBody(calls[0]), {
    body: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Fixed in #311." }] },
        { type: "paragraph", content: [] },
        { type: "paragraph", content: [{ type: "text", text: "Ships Friday." }] },
      ],
    },
  });
  assert.deepEqual(adfDoc("one").content, [{ type: "paragraph", content: [{ type: "text", text: "one" }] }]);
});

test("Jira refuses to comment over a read-only OAuth connection without calling Jira", async () => {
  const { fetch, calls } = mockFetch([]);
  await assert.rejects(atlassianItems.comment!(context(fetch, JIRA_OAUTH), { kind: "issue", id: "WEB-42" }, "Done"), (error: unknown) => error instanceof ItemError && error.statusCode === 403);
  assert.equal(calls.length, 0);
});

test("Jira people are active Atlassian accounts with the account id as handle", async () => {
  const { fetch } = mockFetch([
    [
      "GET",
      /\/rest\/api\/3\/users\/search\?maxResults=200&startAt=0$/,
      [
        { accountId: "5f1-mira", accountType: "atlassian", displayName: "Mira Chen", emailAddress: "mira@fieldnote.example", active: true },
        { accountId: "5f1-bot", accountType: "app", displayName: "Automation for Jira", active: true },
        { accountId: "5f1-old", accountType: "atlassian", displayName: "Former Teammate", active: false },
        { accountId: "5f1-arjun", accountType: "atlassian", displayName: "Arjun Rao", active: true },
      ],
    ],
    ["GET", /\/rest\/api\/3\/users\/search\?maxResults=200&startAt=200$/, []],
  ]);
  assert.deepEqual(await atlassianItems.people!(context(fetch, JIRA_BASIC)), [
    { name: "Mira Chen", email: "mira@fieldnote.example", handle: "5f1-mira" },
    { name: "Arjun Rao", handle: "5f1-arjun" },
  ]);
});

test("Jira links and keys resolve to issues, projects and pages", () => {
  assert.deepEqual(jiraRef("WEB-42"), { kind: "issue", id: "WEB-42" });
  assert.deepEqual(jiraRef("https://fieldnote.atlassian.net/browse/web-42"), { kind: "issue", id: "WEB-42" });
  assert.deepEqual(jiraRef("https://fieldnote.atlassian.net/jira/software/projects/WEB/boards/1?selectedIssue=WEB-7"), { kind: "issue", id: "WEB-7" });
  assert.deepEqual(jiraRef("https://fieldnote.atlassian.net/jira/software/projects/WEB/boards/1"), { kind: "project", id: "WEB" });
  assert.deepEqual(jiraRef("https://fieldnote.atlassian.net/wiki/spaces/WEB/pages/98765/Checkout"), { kind: "page", id: "98765" });
  assert.equal(jiraRef("checkout bug"), null);
  assert.deepEqual(atlassianItems.fromUrl!("https://fieldnote.atlassian.net/browse/WEB-42"), { kind: "issue", id: "WEB-42" });
  assert.equal(atlassianItems.fromUrl!("https://example.com/browse/WEB-42"), null);
});

// Trello ---------------------------------------------------------------------

const TRELLO = { extra: { key: "fieldnotekey123", via: "token" } };

test("Trello search sends key and token in the Authorization header, never the URL", async () => {
  const { fetch, calls } = mockFetch([
    [
      "GET",
      /^https:\/\/api\.trello\.com\/1\/search\?/,
      {
        cards: [{ id: "64f0c0ffee0000000000c4d1", name: "Launch checklist", shortUrl: "https://trello.com/c/Ab12Cd34", dateLastActivity: "2026-10-09T08:00:00.000Z", board: { name: "Fieldnote launch" }, list: { name: "Doing" } }],
        boards: [{ id: "64f0c0ffee0000000000b0a1", name: "Fieldnote launch", url: "https://trello.com/b/Zz98Yy76/fieldnote-launch" }],
      },
    ],
  ]);
  const items = await trelloItems.search(context(fetch, TRELLO), { q: "launch", limit: 5 });
  assert.deepEqual(
    items.map((item) => [item.kind, item.title, item.subtitle]),
    [
      ["card", "Launch checklist", "Fieldnote launch · Doing"],
      ["board", "Fieldnote launch", "Board"],
    ],
  );
  assert.equal(calls[0]!.headers.Authorization, `OAuth oauth_consumer_key="fieldnotekey123", oauth_token="${SECRET}"`);
  assert.ok(!calls[0]!.url.includes(SECRET));
  assert.equal(params(calls[0]).get("modelTypes"), "cards,boards");
});

test("Trello reads a card by shortLink with its list, checklist and comments", async () => {
  const { fetch } = mockFetch([
    [
      "GET",
      /\/1\/cards\/Ab12Cd34\/actions\?filter=commentCard&limit=10$/,
      [
        { date: "2026-10-09T09:00:00.000Z", memberCreator: { fullName: "Arjun Rao" }, data: { text: "Copy is final." } },
        { date: "2026-10-08T09:00:00.000Z", memberCreator: { fullName: "Mira Chen" }, data: { text: "Draft is up." } },
      ],
    ],
    [
      "GET",
      /\/1\/cards\/Ab12Cd34\?/,
      {
        id: "64f0c0ffee0000000000c4d1",
        name: "Launch checklist",
        desc: "Everything before we ship.",
        due: "2026-10-20T16:00:00.000Z",
        shortUrl: "https://trello.com/c/Ab12Cd34",
        labels: [{ name: "Launch", color: "green" }],
        list: { name: "Doing" },
        board: { name: "Fieldnote launch" },
        members: [{ id: "m1", fullName: "Mira Chen", username: "mirachen" }],
        checklists: [{ name: "Before launch", checkItems: [{ name: "Press kit", state: "complete", pos: 2 }, { name: "Pricing page", state: "incomplete", pos: 1 }] }],
      },
    ],
  ]);
  const content = await trelloItems.read(context(fetch, TRELLO), { kind: "card", id: "Ab12Cd34" });
  assert.equal(content.facts?.List, "Doing");
  assert.equal(content.facts?.Due, "2026-10-20");
  assert.match(content.text, /- \[ \] Pricing page\n- \[x\] Press kit/);
  assert.ok(content.text.indexOf("Draft is up.") < content.text.indexOf("Copy is final."));
  assert.deepEqual(content.people, [{ name: "Mira Chen", handle: "mirachen" }]);
});

test("Trello comments post the text to the card's comment action", async () => {
  const { fetch, calls } = mockFetch([["POST", /\/1\/cards\/64f0c0ffee0000000000c4d1\/actions\/comments\?/, { id: "act1", data: { card: { shortLink: "Ab12Cd34" } } }]]);
  const posted = await trelloItems.comment!(context(fetch, TRELLO), { kind: "card", id: "64f0c0ffee0000000000c4d1" }, "Agent finished the press kit.");
  assert.equal(params(calls[0]).get("text"), "Agent finished the press kit.");
  assert.equal(calls[0]!.headers.Authorization, `OAuth oauth_consumer_key="fieldnotekey123", oauth_token="${SECRET}"`);
  assert.equal(posted.url, "https://trello.com/c/Ab12Cd34#comment-act1");
  assert.deepEqual(trelloRef("https://trello.com/c/Ab12Cd34/12-launch-checklist"), { kind: "card", id: "Ab12Cd34" });
  assert.deepEqual(trelloItems.fromUrl!("https://trello.com/c/Ab12Cd34"), { kind: "card", id: "Ab12Cd34" });
});

test("Trello without a saved key asks to connect again", async () => {
  const { fetch } = mockFetch([]);
  await assert.rejects(trelloItems.search(context(fetch), { q: "launch", limit: 5 }), ConnectorNotConnectedError);
});

// Asana ----------------------------------------------------------------------

test("Asana searches tasks and projects in each workspace with typeahead", async () => {
  const { fetch, calls } = mockFetch([
    ["GET", /\/api\/1\.0\/workspaces\?/, { data: [{ gid: "1201", name: "Fieldnote" }] }],
    [
      "GET",
      /\/workspaces\/1201\/typeahead\?.*resource_type=task/,
      { data: [{ gid: "1209001", name: "Write the launch brief", completed: false, due_on: "2026-10-15", permalink_url: "https://app.asana.com/1/1201/task/1209001", projects: [{ name: "Launch" }] }] },
    ],
    ["GET", /\/workspaces\/1201\/typeahead\?.*resource_type=project/, { data: [{ gid: "1208000", name: "Launch", permalink_url: "https://app.asana.com/1/1201/project/1208000" }] }],
  ]);
  const items = await asanaItems.search(context(fetch), { q: "launch", limit: 5 });
  assert.deepEqual(
    items.map((item) => [item.kind, item.id, item.subtitle]),
    [
      ["task", "1209001", "Launch · due 2026-10-15"],
      ["project", "1208000", "Project"],
    ],
  );
  assert.equal(calls[0]!.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(params(calls[1]).get("query"), "launch");
});

test("Asana reads a task with only comment stories, and posts comments as stories", async () => {
  const { fetch, calls } = mockFetch([
    [
      "GET",
      /\/tasks\/1209001\/stories\?/,
      {
        data: [
          { type: "system", text: "Mira Chen added to Launch", created_at: "2026-10-01T09:00:00.000Z" },
          { type: "comment", text: "Outline is in the doc.", created_at: "2026-10-02T09:00:00.000Z", created_by: { name: "Arjun Rao" } },
        ],
        next_page: null,
      },
    ],
    [
      "GET",
      /\/tasks\/1209001\?/,
      {
        data: {
          gid: "1209001",
          name: "Write the launch brief",
          notes: "One page, for the press.",
          completed: false,
          due_on: "2026-10-15",
          assignee: { name: "Mira Chen", email: "mira@fieldnote.example" },
          projects: [{ name: "Launch" }],
          memberships: [{ section: { name: "This week" } }],
          custom_fields: [{ name: "Effort", display_value: "Small" }],
        },
      },
    ],
    ["POST", /\/tasks\/1209001\/stories$/, { data: { gid: "story1" } }],
  ]);
  const content = await asanaItems.read(context(fetch), { kind: "task", id: "1209001" });
  assert.equal(content.facts?.Section, "This week");
  assert.equal(content.facts?.Effort, "Small");
  assert.match(content.text, /\*\*Arjun Rao\*\* \(2026-10-02\):\nOutline is in the doc\./);
  assert.ok(!content.text.includes("added to Launch"));
  await asanaItems.comment!(context(fetch), { kind: "task", id: "1209001" }, "Brief sent.");
  assert.deepEqual(jsonBody(calls.at(-1)), { data: { text: "Brief sent." } });
  assert.deepEqual(asanaRef("https://app.asana.com/0/1208000/1209001/f"), { kind: "task", id: "1209001" });
  assert.deepEqual(asanaRef("https://app.asana.com/1/1201/project/1208000/task/1209001"), { kind: "task", id: "1209001" });
  assert.deepEqual(asanaRef("https://app.asana.com/0/1208000/list"), { kind: "project", id: "1208000" });
});

// Todoist --------------------------------------------------------------------

test("Todoist searches tasks with the search filter and matches project names", async () => {
  const { fetch, calls } = mockFetch([
    ["GET", /\/api\/v1\/projects\?/, { results: [{ id: "6Jf8VQXxpwv56VQ7", name: "Launch" }, { id: "6Jf8VQXxpwv56VQ8", name: "Home" }] }],
    ["GET", /\/api\/v1\/tasks\/filter\?/, { results: [{ id: "6X7rM8997g3RQmvh", content: "Write launch brief", project_id: "6Jf8VQXxpwv56VQ7", due: { date: "2026-10-15" } }] }],
  ]);
  const items = await todoistItems.search(context(fetch), { q: "launch", limit: 5 });
  assert.deepEqual(
    items.map((item) => [item.kind, item.id, item.subtitle]),
    [
      ["task", "6X7rM8997g3RQmvh", "Launch · due 2026-10-15"],
      ["project", "6Jf8VQXxpwv56VQ7", "Project"],
    ],
  );
  assert.equal(params(calls[1]).get("query"), "search: launch");
  assert.equal(items[0]!.url, "https://app.todoist.com/app/task/6X7rM8997g3RQmvh");
});

test("Todoist reads a task with comments and posts a comment", async () => {
  const { fetch, calls } = mockFetch([
    ["GET", /\/api\/v1\/tasks\/6X7rM8997g3RQmvh$/, { id: "6X7rM8997g3RQmvh", content: "Write launch brief", description: "Keep it short.", project_id: "6Jf8VQXxpwv56VQ7", priority: 4, labels: ["writing"], due: { date: "2026-10-15" } }],
    ["GET", /\/api\/v1\/comments\?/, { results: [{ content: "Started the outline.", posted_at: "2026-10-09T10:00:00.000000Z" }] }],
    ["GET", /\/api\/v1\/projects\/6Jf8VQXxpwv56VQ7$/, { id: "6Jf8VQXxpwv56VQ7", name: "Launch" }],
    ["POST", /\/api\/v1\/comments$/, { id: "c1" }],
  ]);
  const content = await todoistItems.read(context(fetch), { kind: "task", id: "6X7rM8997g3RQmvh" });
  assert.deepEqual(content.facts, { Project: "Launch", Due: "2026-10-15", Priority: "P1", Labels: "writing" });
  assert.match(content.text, /Started the outline\./);
  await todoistItems.comment!(context(fetch), { kind: "task", id: "6X7rM8997g3RQmvh" }, "Brief is done.");
  assert.deepEqual(jsonBody(calls.at(-1)), { task_id: "6X7rM8997g3RQmvh", content: "Brief is done." });
  assert.deepEqual(todoistRef("https://app.todoist.com/app/task/write-launch-brief-6X7rM8997g3RQmvh"), { kind: "task", id: "6X7rM8997g3RQmvh" });
});

// ClickUp --------------------------------------------------------------------

test("ClickUp matches names among recently updated tasks, and reads a task with comments", async () => {
  const { fetch, calls } = mockFetch([
    ["GET", /\/api\/v2\/team$/, { teams: [{ id: "9012", name: "Fieldnote", members: [{ user: { id: 1, username: "Mira Chen", email: "mira@fieldnote.example" } }] }] }],
    [
      "GET",
      /\/api\/v2\/team\/9012\/task\?/,
      {
        tasks: [
          { id: "86b1abc", name: "Fix checkout spacing", status: { status: "in progress" }, list: { name: "Web" }, url: "https://app.clickup.com/t/86b1abc", date_updated: "1791622800000" },
          { id: "86b1abd", name: "Plan offsite", status: { status: "to do" }, list: { name: "Ops" }, url: "https://app.clickup.com/t/86b1abd", date_updated: "1791536400000" },
        ],
        last_page: true,
      },
    ],
    [
      "GET",
      /\/api\/v2\/task\/86b1abc\?include_markdown_description=true$/,
      {
        id: "86b1abc",
        name: "Fix checkout spacing",
        markdown_description: "The **footer** overlaps.",
        status: { status: "in progress" },
        priority: { priority: "high" },
        due_date: "1792454400000",
        assignees: [{ username: "Mira Chen", email: "mira@fieldnote.example" }],
        list: { name: "Web" },
        url: "https://app.clickup.com/t/86b1abc",
      },
    ],
    ["GET", /\/api\/v2\/task\/86b1abc\/comment$/, { comments: [{ comment_text: "Pushed a fix.", date: "1791626400000", user: { username: "Arjun Rao" } }] }],
    ["POST", /\/api\/v2\/task\/86b1abc\/comment$/, { id: "90120001" }],
  ]);
  const ctx = context(fetch, { token: `pk_${SECRET}` });
  const items = await clickupItems.search(ctx, { q: "checkout", limit: 5 });
  assert.deepEqual(items.map((item) => [item.id, item.subtitle]), [["86b1abc", "Web · in progress"]]);
  assert.equal(calls[0]!.headers.Authorization, `pk_${SECRET}`);
  assert.equal(params(calls[1]).get("order_by"), "updated");
  const content = await clickupItems.read(ctx, { kind: "task", id: "86b1abc" });
  assert.equal(content.facts?.Due, "2026-10-20");
  assert.match(content.text, /The \*\*footer\*\* overlaps\./);
  assert.match(content.text, /Pushed a fix\./);
  await clickupItems.comment!(ctx, { kind: "task", id: "86b1abc" }, "Merged.");
  assert.deepEqual(jsonBody(calls.at(-1)), { comment_text: "Merged.", notify_all: false });
  assert.deepEqual(await clickupItems.people!(ctx), [{ name: "Mira Chen", email: "mira@fieldnote.example" }]);
});

// monday.com -----------------------------------------------------------------

test("monday.com searches boards by name and items with a contains_text rule", async () => {
  const { fetch, calls } = mockFetch([
    [
      "POST",
      /^https:\/\/api\.monday\.com\/v2$/,
      (call: Call) => {
        const query = String(jsonBody(call).query);
        if (query.includes("order_by: used_at")) {
          return { data: { boards: [{ id: "3001", name: "Launch plan", type: "board", url: "https://fieldnote.monday.com/boards/3001", workspace: { name: "Marketing" } }, { id: "3002", name: "Hiring", type: "board" }] } };
        }
        return { data: { boards: [{ name: "Launch plan", items_page: { items: [{ id: "4001", name: "Launch video", url: "https://fieldnote.monday.com/boards/3001/pulses/4001", updated_at: "2026-10-09T10:00:00Z", group: { title: "This week" } }] } }] } };
      },
    ],
  ]);
  const items = await mondayItems.search(context(fetch), { q: "launch", limit: 5 });
  assert.deepEqual(
    items.map((item) => [item.kind, item.id, item.subtitle]),
    [
      ["task", "4001", "Launch plan · This week"],
      ["board", "3001", "Board · Marketing"],
    ],
  );
  assert.equal(calls[0]!.headers.Authorization, SECRET);
  assert.ok(calls[0]!.headers["API-Version"]);
  const itemQuery = jsonBody(calls[1]);
  assert.match(String(itemQuery.query), /compare_value: \["launch"\], operator: contains_text/);
  assert.deepEqual(itemQuery.variables, { ids: ["3001", "3002"] });
});

test("monday.com reads an item with columns and updates, and posts an update as HTML paragraphs", async () => {
  const { fetch, calls } = mockFetch([
    [
      "POST",
      /^https:\/\/api\.monday\.com\/v2$/,
      (call: Call) => {
        if (String(jsonBody(call).query).startsWith("mutation")) return { data: { create_update: { id: "u9" } } };
        return {
          data: {
            items: [
              {
                id: "4001",
                name: "Launch video",
                url: "https://fieldnote.monday.com/boards/3001/pulses/4001",
                group: { title: "This week" },
                board: { id: "3001", name: "Launch plan" },
                creator: { name: "Mira Chen", email: "mira@fieldnote.example" },
                column_values: [
                  { id: "status", type: "status", text: "Working on it", column: { title: "Status" } },
                  { id: "date4", type: "date", text: "2026-10-20", column: { title: "Due date" } },
                  { id: "text", type: "text", text: "", column: { title: "Notes" } },
                ],
                updates: [
                  { text_body: "Final cut is ready.", created_at: "2026-10-09T10:00:00Z", creator: { name: "Arjun Rao" } },
                  { text_body: "Storyboard approved.", created_at: "2026-10-07T10:00:00Z", creator: { name: "Mira Chen" } },
                ],
              },
            ],
          },
        };
      },
    ],
  ]);
  const content = await mondayItems.read(context(fetch), { kind: "task", id: "4001" });
  assert.deepEqual(content.facts, { Board: "Launch plan", Group: "This week", Due: "2026-10-20", Status: "Working on it" });
  assert.ok(content.text.indexOf("Storyboard approved.") < content.text.indexOf("Final cut is ready."));
  await mondayItems.comment!(context(fetch), { kind: "task", id: "4001" }, "Uploaded <final> cut\nto Drive");
  assert.deepEqual(jsonBody(calls.at(-1)).variables, { id: "4001", body: "<p>Uploaded &lt;final&gt; cut</p><p>to Drive</p>" });
});

// Slack ----------------------------------------------------------------------

const SLACK = { extra: { url: "https://fieldnote.slack.com/", teamId: "T0FIELD", slackUserId: "U0MIRA001" } };

test("Slack searches channels by name and people by name or email", async () => {
  const { fetch, calls } = mockFetch([
    [
      "GET",
      /\/api\/conversations\.list\?/,
      { ok: true, channels: [{ id: "C0DESIGN1", name: "design", is_member: true, num_members: 12, purpose: { value: "Design reviews" } }, { id: "C0RANDOM1", name: "random", num_members: 40 }], response_metadata: { next_cursor: "" } },
    ],
    [
      "GET",
      /\/api\/users\.list\?/,
      {
        ok: true,
        members: [
          { id: "U0MIRA001", name: "mira", real_name: "Mira Chen", profile: { real_name: "Mira Chen", title: "Design lead", email: "mira@fieldnote.example" } },
          { id: "U0BOT0001", name: "designbot", is_bot: true, profile: { real_name: "Design Bot" } },
        ],
      },
    ],
  ]);
  const items = await slackItems.search(context(fetch, SLACK), { q: "#design", limit: 5 });
  assert.deepEqual(
    items.map((item) => [item.kind, item.id, item.title, item.url]),
    [
      ["channel", "C0DESIGN1", "#design", "https://fieldnote.slack.com/archives/C0DESIGN1"],
      ["person", "U0MIRA001", "Mira Chen", "https://fieldnote.slack.com/team/U0MIRA001"],
    ],
  );
  assert.equal(calls[0]!.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(params(calls[0]).get("types"), "public_channel,private_channel");
});

test("Slack reads a channel's latest messages oldest first, with names resolved", async () => {
  const { fetch } = mockFetch([
    ["GET", /\/api\/conversations\.info\?/, { ok: true, channel: { id: "C0DESIGN1", name: "design", num_members: 12, topic: { value: "Launch week" } } }],
    [
      "GET",
      /\/api\/conversations\.history\?/,
      {
        ok: true,
        messages: [
          { ts: "1791630000.000200", user: "U0ARJUN01", text: "Looks good <@U0MIRA001>, see <https://fieldnote.example/spec|the spec>", reply_count: 2 },
          { ts: "1791626400.000100", user: "U0MIRA001", text: "New checkout mock is up" },
          { ts: "1791622000.000100", user: "U0ARJUN01", subtype: "channel_join", text: "<@U0ARJUN01> has joined the channel" },
        ],
      },
    ],
    ["GET", /\/api\/users\.info\?user=U0MIRA001/, { ok: true, user: { id: "U0MIRA001", real_name: "Mira Chen", profile: { real_name: "Mira Chen" } } }],
    ["GET", /\/api\/users\.info\?user=U0ARJUN01/, { ok: true, user: { id: "U0ARJUN01", real_name: "Arjun Rao", profile: { real_name: "Arjun Rao" } } }],
  ]);
  const content = await slackItems.read(context(fetch, SLACK), { kind: "channel", id: "C0DESIGN1" });
  assert.equal(content.title, "#design");
  assert.equal(content.facts?.Topic, "Launch week");
  assert.ok(content.text.indexOf("New checkout mock is up") < content.text.indexOf("Looks good @Mira Chen"));
  assert.match(content.text, /the spec \(https:\/\/fieldnote\.example\/spec\) \(2 replies\)/);
  assert.ok(!content.text.includes("has joined"));
  assert.equal(slackText("<!here> <#C0DESIGN1|design>", new Map()), "@here #design");
});

test("Slack ok:false errors become clear errors and never carry the token", async () => {
  const reply = (body: object) => mockFetch([["GET", /slack\.com\/api\//, { ok: false, ...body }]]).fetch;
  await assert.rejects(slackItems.search(context(reply({ error: "missing_scope", needed: "channels:read", provided: "channels:history" }), SLACK), { q: "design", kind: "channel", limit: 5 }), (error: unknown) => {
    assert.ok(error instanceof ItemError);
    assert.equal(error.statusCode, 403);
    assert.match(error.message, /channels:read/);
    return true;
  });
  await assert.rejects(slackItems.read(context(reply({ error: "not_in_channel" }), SLACK), { kind: "channel", id: "C0DESIGN1" }), /not in that Slack channel/);
  await assert.rejects(slackItems.people!(context(reply({ error: "invalid_auth" }), SLACK)), (error: unknown) => error instanceof ConnectorNotConnectedError && error.provider === "slack" && !error.message.includes(SECRET));
});

test("Slack people skip bots, deactivated accounts and Slackbot", async () => {
  const { fetch } = mockFetch([
    [
      "GET",
      /\/api\/users\.list\?/,
      {
        ok: true,
        members: [
          { id: "USLACKBOT", name: "slackbot", real_name: "Slackbot" },
          { id: "U0MIRA001", name: "mira", real_name: "Mira Chen", profile: { real_name: "Mira Chen", email: "mira@fieldnote.example", title: "Design lead" } },
          { id: "U0GONE001", name: "gone", deleted: true },
          { id: "U0BOT0001", name: "ci", is_bot: true },
        ],
        response_metadata: { next_cursor: "" },
      },
    ],
  ]);
  assert.deepEqual(await slackItems.people!(context(fetch, SLACK)), [{ name: "Mira Chen", handle: "U0MIRA001", email: "mira@fieldnote.example", title: "Design lead" }]);
});

// Google ---------------------------------------------------------------------

test("Google is usable with Drive or Gmail access only", () => {
  const token = (scopes: string[]) => ({ token: "", account: null, scopes });
  assert.equal(googleItems.usable!(token(["openid", "email", `${G}calendar.events`])), false);
  assert.equal(googleItems.usable!(token([`${G}drive.file`])), true);
  assert.equal(googleItems.usable!(token([`${G}drive`])), true);
  assert.equal(googleItems.usable!(token([`${G}gmail.readonly`])), true);
});

test("Google Drive with only picked files says so when a search finds nothing", async () => {
  const { fetch, calls } = mockFetch([["GET", /\/drive\/v3\/files\?/, { files: [] }]]);
  await assert.rejects(googleItems.search(context(fetch, { scopes: [`${G}drive.file`] }), { q: "budget", limit: 5 }), (error: unknown) => {
    assert.ok(error instanceof ItemError);
    assert.match(error.message, /files it created or that you picked/);
    return true;
  });
  const q = params(calls[0]).get("q") ?? "";
  assert.match(q, /name contains 'budget'/);
  assert.match(q, /trashed = false/);
  assert.equal(params(calls[0]).get("orderBy"), "modifiedTime desc");
});

test("Google searches Drive and Gmail threads, and reads a Doc as Markdown", async () => {
  const { fetch, calls } = mockFetch([
    ["GET", /\/drive\/v3\/files\?/, { files: [{ id: "1AbCdEfGhIjKlMn", name: "Launch brief", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/document/d/1AbCdEfGhIjKlMn/edit", modifiedTime: "2026-10-09T10:00:00.000Z", owners: [{ displayName: "Mira Chen" }] }] }],
    ["GET", /\/gmail\/v1\/users\/me\/threads\?/, { threads: [{ id: "18f2a3b4c5d6e7f8" }] }],
    [
      "GET",
      /\/threads\/18f2a3b4c5d6e7f8\?format=metadata/,
      { id: "18f2a3b4c5d6e7f8", messages: [{ id: "m1", internalDate: "1791626400000", payload: { headers: [{ name: "Subject", value: "Launch brief review" }, { name: "From", value: "Arjun Rao <arjun@fieldnote.example>" }] } }] },
    ],
    ["GET", /\/drive\/v3\/files\/1AbCdEfGhIjKlMn\/export\?mimeType=text%2Fmarkdown$/, "# Launch brief\n\nShip on **Friday**."],
    ["GET", /\/drive\/v3\/files\/1AbCdEfGhIjKlMn\?fields=/, { id: "1AbCdEfGhIjKlMn", name: "Launch brief", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/document/d/1AbCdEfGhIjKlMn/edit", owners: [{ displayName: "Mira Chen", emailAddress: "mira@fieldnote.example" }] }],
  ]);
  const ctx = context(fetch, { scopes: [`${G}drive.readonly`, `${G}gmail.readonly`] });
  const items = await googleItems.search(ctx, { q: "launch", limit: 5 });
  assert.deepEqual(
    items.map((item) => [item.kind, item.id, item.title]),
    [
      ["file", "1AbCdEfGhIjKlMn", "Launch brief"],
      ["conversation", "18f2a3b4c5d6e7f8", "Launch brief review"],
    ],
  );
  assert.equal(params(calls[1]).get("q"), "launch");
  const doc = await googleItems.read(ctx, { kind: "file", id: "1AbCdEfGhIjKlMn" });
  assert.match(doc.text, /Ship on \*\*Friday\*\*\./);
  const linked = await googleItems.search(ctx, { q: "https://docs.google.com/document/d/1AbCdEfGhIjKlMn/edit", limit: 5 });
  assert.equal(linked[0]!.id, "1AbCdEfGhIjKlMn");
});

test("Google reads a Gmail thread with quoted history trimmed", async () => {
  const b64 = (text: string) => Buffer.from(text).toString("base64url");
  const { fetch } = mockFetch([
    [
      "GET",
      /\/threads\/18f2a3b4c5d6e7f8\?format=full$/,
      {
        id: "18f2a3b4c5d6e7f8",
        messages: [
          {
            id: "m1",
            internalDate: "1791626400000",
            payload: {
              mimeType: "multipart/alternative",
              headers: [
                { name: "Subject", value: "Launch brief review" },
                { name: "From", value: "Arjun Rao <arjun@fieldnote.example>" },
                { name: "To", value: "Mira Chen <mira@fieldnote.example>" },
                { name: "Date", value: "Fri, 10 Oct 2026 10:00:00 +0000" },
              ],
              parts: [{ mimeType: "text/plain", body: { data: b64("Two small edits, then ship.\n\nOn Thu, Oct 9, 2026 Mira Chen wrote:\n> Here is the brief") } }],
            },
          },
        ],
      },
    ],
  ]);
  const content = await googleItems.read(context(fetch, { scopes: [`${G}gmail.readonly`] }), { kind: "conversation", id: "18f2a3b4c5d6e7f8" });
  assert.equal(content.title, "Launch brief review");
  assert.match(content.text, /Two small edits, then ship\./);
  assert.ok(!content.text.includes("Here is the brief"));
  assert.deepEqual(
    content.people?.map((row) => row.email),
    ["arjun@fieldnote.example", "mira@fieldnote.example"],
  );
});

// Microsoft ------------------------------------------------------------------

test("Microsoft is usable with OneDrive or Outlook mail access only", () => {
  const token = (scopes: string[]) => ({ token: "", account: null, scopes });
  assert.equal(microsoftItems.usable!(token(["openid", "User.Read", "Calendars.ReadWrite"])), false);
  assert.equal(microsoftItems.usable!(token(["Files.ReadWrite"])), true);
  assert.equal(microsoftItems.usable!(token(["Mail.Read"])), true);
});

test("Microsoft searches OneDrive and Outlook, and reads a Word file and a message", async () => {
  const docx = await markdownToDocx("# Launch plan\n\nShip the checkout fix on Friday.");
  const { fetch, calls } = mockFetch([
    ["GET", /\/me\/drive\/root\/search\(q='launch'\)\?/, { value: [{ id: "01FIELDNOTE1", name: "Launch plan.docx", webUrl: "https://fieldnote-my.sharepoint.com/launch", file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }] }],
    ["GET", /\/me\/messages\?\$search=/, { value: [{ id: "AAMkAD1fieldnote=", subject: "Launch timing", from: { emailAddress: { name: "Arjun Rao", address: "arjun@fieldnote.example" } }, receivedDateTime: "2026-10-09T10:00:00Z" }] }],
    ["GET", /\/me\/drive\/items\/01FIELDNOTE1\/content$/, () => new Response(docx)],
    ["GET", /\/me\/drive\/items\/01FIELDNOTE1\?/, { id: "01FIELDNOTE1", name: "Launch plan.docx", size: docx.byteLength, file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }],
    [
      "GET",
      /\/me\/messages\/AAMkAD1fieldnote%3D\?/,
      {
        id: "AAMkAD1fieldnote=",
        subject: "Launch timing",
        from: { emailAddress: { name: "Arjun Rao", address: "arjun@fieldnote.example" } },
        toRecipients: [{ emailAddress: { name: "Mira Chen", address: "mira@fieldnote.example" } }],
        receivedDateTime: "2026-10-09T10:00:00Z",
        body: { contentType: "text", content: "Friday works.\n\nOn Thu, Oct 9, 2026 Mira Chen wrote:\nolder text" },
      },
    ],
  ]);
  const ctx = context(fetch, { scopes: ["Files.Read", "Mail.Read"] });
  const items = await microsoftItems.search(ctx, { q: "launch", limit: 5 });
  assert.deepEqual(
    items.map((item) => [item.kind, item.id]),
    [
      ["file", "01FIELDNOTE1"],
      ["conversation", "AAMkAD1fieldnote="],
    ],
  );
  assert.equal(params(calls[1]).get("$search"), '"launch"');
  const file = await microsoftItems.read(ctx, { kind: "file", id: "01FIELDNOTE1" });
  assert.match(file.text, /Ship the checkout fix on Friday\./);
  const message = await microsoftItems.read(ctx, { kind: "conversation", id: "AAMkAD1fieldnote=" });
  assert.equal(calls.at(-1)!.headers.Prefer, 'outlook.body-content-type="text"');
  assert.match(message.text, /Friday works\./);
  assert.ok(!message.text.includes("older text"));
  assert.equal(message.facts?.From, "Arjun Rao <arjun@fieldnote.example>");
});

// Every source ---------------------------------------------------------------

test("errors from every source never contain the token, even when the app echoes it", async () => {
  const echo = mockFetch([
    ["GET", /./, (call: Call) => new Response(JSON.stringify({ message: `bad credentials ${SECRET} / ${call.headers.Authorization}`, errors: [{ message: SECRET }], error_message: SECRET, ok: false, error: SECRET }), { status: 400 })],
    ["POST", /./, (call: Call) => new Response(JSON.stringify({ message: `bad credentials ${SECRET} / ${call.headers.Authorization}`, errors: [{ message: SECRET }], error_message: SECRET }), { status: 400 })],
  ]).fetch;
  const token: Partial<ProviderToken> = { scopes: [`${G}drive.readonly`, `${G}gmail.readonly`, "Files.Read", "Mail.Read"], extra: { key: "fieldnotekey123", auth: "bearer", cloudId: "c0ffee-1234", site: "fieldnote.atlassian.net" } };
  for (const source of WORK_ITEM_SOURCES) {
    await assert.rejects(source.search(context(echo, token), { q: "launch", limit: 5 }), (error: unknown) => {
      assert.ok(error instanceof Error, source.id);
      assert.ok(!error.message.includes(SECRET), `${source.id}: ${error.message}`);
      return true;
    });
  }
  const gone = mockFetch([["GET", /./, new Response(JSON.stringify({ message: SECRET }), { status: 401 })]]).fetch;
  await assert.rejects(asanaItems.search(context(gone), { q: "launch", limit: 5 }), (error: unknown) => error instanceof ConnectorNotConnectedError && !error.message.includes(SECRET));
  const offline = (async () => {
    throw new Error(`connect ECONNREFUSED with ${SECRET}`);
  }) as typeof globalThis.fetch;
  await assert.rejects(todoistItems.search(context(offline), { q: "launch", limit: 5 }), (error: unknown) => error instanceof ItemError && !error.message.includes(SECRET));
});

test("work sources are listed in order with the catalog ids", () => {
  assert.deepEqual(
    WORK_ITEM_SOURCES.map((source) => source.id),
    ["atlassian", "trello", "asana", "todoist", "clickup", "monday", "slack", "google_workspace", "microsoft_365"],
  );
});
