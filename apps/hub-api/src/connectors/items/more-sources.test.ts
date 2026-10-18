/**
 * App item sources for Figma, Vercel, Azure DevOps, Zendesk, Front, HubSpot, Dropbox,
 * Box, Xero, Discord and Zotero: request shapes, mapping, comment payloads and refusals,
 * against a fetch passed in through the item context. Nothing reaches the vendors.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "../../runtime/test-env.js";
import { discordGuilds } from "../oauth.js";
import type { ProviderToken } from "../tokens.js";
import { azureDevopsItems, azureWorkItemRef } from "./sources/azure-devops.js";
import { boxItems } from "./sources/box.js";
import { discordItems } from "./sources/discord.js";
import { dropboxArg, dropboxItems } from "./sources/dropbox.js";
import { figmaFileKey, figmaItems } from "./sources/figma.js";
import { frontItems } from "./sources/front.js";
import { hubspotItems } from "./sources/hubspot.js";
import { MORE_ITEM_SOURCES } from "./sources/more.js";
import { vercelItems, vercelLogLines } from "./sources/vercel.js";
import { xeroDate, xeroItems } from "./sources/xero.js";
import { zendeskItems } from "./sources/zendesk.js";
import { zoteroDoi, zoteroItems, zoteroNoteHtml, zoteroRef } from "./sources/zotero.js";
import { ItemError, type ItemContext } from "./types.js";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const text = (data: string, status = 200) => new Response(data, { status, headers: { "content-type": "text/plain" } });

function context(token: Omit<ProviderToken, "scopes" | "account"> & { account?: string | null }, respond: (request: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const request: Seen = { method: init?.method ?? "GET", url: input instanceof Request ? input.url : String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body };
    seen.push(request);
    return respond(request);
  }) as typeof fetch;
  const ctx: ItemContext = { userId: "user-mira", token: { account: null, scopes: [], ...token }, fetch: fetchImpl, signal: new AbortController().signal };
  return { ctx, seen };
}

async function refusedWith(promise: Promise<unknown>, pattern: RegExp, secret?: string): Promise<ItemError> {
  let caught: unknown;
  await assert.rejects(promise, (error: unknown) => {
    caught = error;
    return true;
  });
  assert.ok(caught instanceof ItemError, `expected ItemError, got ${String(caught)}`);
  assert.match(caught.message, pattern);
  if (secret) assert.ok(!caught.message.includes(secret), "the token never appears in the error");
  return caught;
}

const savedBotToken = process.env.DISCORD_BOT_TOKEN;
afterEach(() => {
  if (savedBotToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = savedBotToken;
});

test("the new sources are listed in order with their own providers", () => {
  assert.deepEqual(
    MORE_ITEM_SOURCES.map((source) => source.id),
    ["figma", "vercel", "azure_devops", "zendesk", "front", "hubspot", "dropbox", "box", "xero", "discord", "zotero"],
  );
  for (const source of MORE_ITEM_SOURCES) assert.equal(source.provider, source.id);
});

test("Figma: team files by name, a file's outline and comments, and posting a comment", async () => {
  const token = "figd_mira_secret_0001";
  const { ctx, seen } = context({ token, meta: { teamId: "1234567" } }, ({ url, method }) => {
    if (url === "https://api.figma.com/v1/teams/1234567/projects") return json({ name: "Fieldnote", projects: [{ id: "88", name: "Atlas app" }, { id: "89", name: "Brand" }] });
    if (url === "https://api.figma.com/v1/projects/88/files") {
      return json({ name: "Atlas app", files: [{ key: "AbCdEf123456", name: "Onboarding flow", last_modified: "2026-10-01T10:00:00Z" }, { key: "QwErTy123456", name: "Settings", last_modified: "2026-10-09T10:00:00Z" }] });
    }
    if (url === "https://api.figma.com/v1/projects/89/files") return json({ name: "Brand", files: [{ key: "ZxCvBn123456", name: "Onboarding emails", last_modified: "2026-10-08T10:00:00Z" }] });
    if (url === "https://api.figma.com/v1/files/AbCdEf123456?depth=2") {
      return json({
        name: "Onboarding flow",
        lastModified: "2026-10-01T10:00:00Z",
        editorType: "figma",
        document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [{ id: "1:0", name: "Cover", type: "CANVAS", children: [{ id: "1:1", name: "Welcome", type: "FRAME" }, { id: "1:2", name: "Sign in", type: "COMPONENT_SET" }] }] },
      });
    }
    if (url === "https://api.figma.com/v1/files/AbCdEf123456/comments" && method === "GET") {
      return json({ comments: [{ id: "c2", message: "Ship it", created_at: "2026-10-05T09:00:00Z", user: { handle: "Mira Chen" } }, { id: "c1", message: "Spacing is off on Welcome", created_at: "2026-10-02T09:00:00Z", user: { handle: "Arjun Rao" } }] });
    }
    if (url === "https://api.figma.com/v1/files/AbCdEf123456/comments" && method === "POST") return json({ id: "c3" });
    if (url === "https://api.figma.com/v1/files/AbCdEf123456?depth=1") return json({ name: "Onboarding flow", lastModified: "2026-10-01T10:00:00Z", editorType: "figma" });
    return json({ status: 404, err: "Not found" }, 404);
  });

  const found = await figmaItems.search(ctx, { q: "onboarding", limit: 10 });
  assert.deepEqual(
    found.map((item) => [item.kind, item.id, item.title]),
    [
      ["design", "ZxCvBn123456", "Onboarding emails"],
      ["design", "AbCdEf123456", "Onboarding flow"],
    ],
  );
  assert.equal(found[1]!.url, "https://www.figma.com/design/AbCdEf123456");
  assert.ok(seen.every((request) => request.headers["x-figma-token"] === token));

  const projects = await figmaItems.search(ctx, { q: "brand", kind: "project", limit: 10 });
  assert.deepEqual(projects.map((item) => [item.kind, item.id]), [["project", "89"]]);

  const byLink = await figmaItems.search(ctx, { q: "https://www.figma.com/design/AbCdEf123456/Onboarding?node-id=1-2", limit: 10 });
  assert.equal(byLink.length, 1);
  assert.equal(byLink[0]!.title, "Onboarding flow");

  const read = await figmaItems.read(ctx, { kind: "design", id: "AbCdEf123456" });
  assert.match(read.text, /## Cover\n\n- Welcome \(frame\)\n- Sign in \(component set\)/);
  assert.ok(read.text.indexOf("Spacing is off") < read.text.indexOf("Ship it"), "comments read oldest first");
  assert.equal(read.facts?.Pages, "1");
  assert.deepEqual(read.people?.map((person) => person.name), ["Arjun Rao", "Mira Chen"]);

  seen.length = 0;
  assert.deepEqual(await figmaItems.comment!(ctx, { kind: "design", id: "AbCdEf123456" }, "Looks good"), { url: "https://www.figma.com/design/AbCdEf123456" });
  assert.deepEqual(seen[0]!.body, { message: "Looks good" });
  assert.equal(figmaFileKey("https://www.figma.com/file/AbCdEf123456/Old-link"), "AbCdEf123456");
  assert.deepEqual(figmaItems.fromUrl!("https://www.figma.com/board/AbCdEf123456/Retro"), { kind: "design", id: "AbCdEf123456" });

  const noTeam = context({ token, meta: {} }, () => json({}, 500));
  assert.deepEqual(await figmaItems.search(noTeam.ctx, { q: "", limit: 5 }), []);
  await refusedWith(figmaItems.search(noTeam.ctx, { q: "onboarding", limit: 5 }), /team link/);
  assert.equal(noTeam.seen.length, 0);
});

test("Vercel: projects and deployments across teams, and why a deployment failed", async () => {
  const token = "vercel-mira-secret-0002";
  const { ctx, seen } = context({ token, meta: { username: "mira-fieldnote", teams: [{ id: "team_fieldnote01", slug: "fieldnote" }] } }, ({ url }) => {
    const team = url.includes("teamId=team_fieldnote01");
    if (url.startsWith("https://api.vercel.com/v10/projects?")) {
      return json({ projects: team ? [{ id: "prj_atlas0001", name: "atlas-web", framework: "nextjs", updatedAt: Date.parse("2026-10-10T08:00:00Z") }] : [] });
    }
    if (url.startsWith("https://api.vercel.com/v6/deployments?limit=20")) {
      return json({
        deployments: team
          ? [
              { uid: "dpl_ok000001", name: "docs", state: "READY", target: null, created: Date.parse("2026-10-11T08:00:00Z"), meta: { githubCommitMessage: "Docs", githubCommitRef: "main" } },
              { uid: "dpl_fail0001", name: "atlas-web", state: "ERROR", target: "production", created: Date.parse("2026-10-11T09:00:00Z"), inspectorUrl: "https://vercel.com/fieldnote/atlas-web/abc", meta: { githubCommitMessage: "Fix atlas build\n\nmore", githubCommitRef: "main" } },
            ]
          : [],
      });
    }
    if (url === "https://api.vercel.com/v13/deployments/dpl_fail0001?teamId=team_fieldnote01") {
      return json({ id: "dpl_fail0001", name: "atlas-web", readyState: "ERROR", target: "production", createdAt: Date.parse("2026-10-11T09:00:00Z"), errorMessage: "Command \"pnpm build\" exited with 1", creator: { username: "mira-fieldnote" }, meta: { githubCommitMessage: "Fix atlas build", githubCommitRef: "main" }, inspectorUrl: "https://vercel.com/fieldnote/atlas-web/abc" });
    }
    if (url.startsWith("https://api.vercel.com/v3/deployments/dpl_fail0001/events?") && team) {
      const events = [
        { type: "stderr", created: 3, payload: { text: "\u001b[31mError: Cannot find module 'zod'\u001b[39m" } },
        { type: "stdout", created: 1, payload: { text: "Running \"pnpm build\"" } },
        { type: "stdout", created: 2, payload: { text: "Compiling…" } },
      ];
      return text(events.map((event) => JSON.stringify(event)).join("\n"));
    }
    return json({ error: { message: "Not found" } }, 404);
  });

  const found = await vercelItems.search(ctx, { q: "atlas", limit: 10 });
  assert.deepEqual(
    found.map((item) => [item.kind, item.id]),
    [
      ["project", "team_fieldnote01/prj_atlas0001"],
      ["deployment", "team_fieldnote01/dpl_fail0001"],
    ],
  );
  assert.equal(found[0]!.url, "https://vercel.com/fieldnote/atlas-web");
  assert.equal(found[1]!.title, "atlas-web: Fix atlas build");
  assert.match(found[1]!.subtitle ?? "", /^ERROR · production · main$/);
  assert.ok(seen.every((request) => request.headers.authorization === `Bearer ${token}`));

  const read = await vercelItems.read(ctx, { kind: "deployment", id: "team_fieldnote01/dpl_fail0001" });
  assert.equal(read.facts?.State, "ERROR");
  assert.equal(read.facts?.Error, 'Command "pnpm build" exited with 1');
  assert.match(read.text, /## Errors\n\n```\nError: Cannot find module 'zod'\n```/);
  assert.match(read.text, /Running "pnpm build"\nCompiling…\nError: Cannot find module 'zod'/, "the log is in time order, without colour codes");

  await refusedWith(vercelItems.read(ctx, { kind: "deployment", id: "../../v2/user" }), /not a Vercel id/);
  assert.deepEqual(vercelLogLines(JSON.stringify([{ type: "stdout", created: 1, text: "Build ok" }])), [{ type: "stdout", text: "Build ok" }]);
});

test("Azure DevOps: WIQL search, a work item with comments, and a comment posted as HTML", async () => {
  const token = "azure-pat-mira-secret-0003";
  const description = "<div>Login fails on <b>Safari</b></div>";
  const { ctx, seen } = context({ token, meta: { org: "fieldnote" } }, ({ url, method }) => {
    if (url === "https://dev.azure.com/fieldnote/_apis/wit/wiql?$top=10&api-version=7.1" && method === "POST") return json({ workItems: [{ id: 42 }, { id: 43 }] });
    if (url.startsWith("https://dev.azure.com/fieldnote/_apis/wit/workitems?ids=42,43&")) {
      return json({
        value: [
          { id: 43, fields: { "System.Title": "Logout button", "System.State": "Active", "System.WorkItemType": "Task", "System.TeamProject": "Field App" } },
          { id: 42, fields: { "System.Title": "Login fails", "System.State": "New", "System.WorkItemType": "Bug", "System.TeamProject": "Field App", "System.AssignedTo": { displayName: "Mira Chen", uniqueName: "mira@fieldnote.example" } } },
        ],
      });
    }
    if (url === "https://dev.azure.com/fieldnote/Field%20App/_apis/wit/workitems/42?api-version=7.1") {
      return json({
        id: 42,
        fields: {
          "System.Title": "Login fails",
          "System.State": "New",
          "System.WorkItemType": "Bug",
          "System.TeamProject": "Field App",
          "System.Description": description,
          "System.AssignedTo": { displayName: "Mira Chen", uniqueName: "mira@fieldnote.example" },
          "Microsoft.VSTS.Scheduling.DueDate": "2026-10-20T00:00:00Z",
        },
      });
    }
    if (url.startsWith("https://dev.azure.com/fieldnote/Field%20App/_apis/wit/workItems/42/comments?") && method === "GET") {
      return json({ comments: [{ text: "<p>Fixed on main</p>", createdBy: { displayName: "Arjun Rao" }, createdDate: "2026-10-11T10:00:00Z" }, { text: "<p>Repro on Safari 18</p>", createdBy: { displayName: "Mira Chen" }, createdDate: "2026-10-10T10:00:00Z" }] });
    }
    if (url === "https://dev.azure.com/fieldnote/Field%20App/_apis/wit/workItems/42/comments?api-version=7.1-preview.4" && method === "POST") return json({ id: 7 });
    return json({ message: "not found" }, 404);
  });

  const found = await azureDevopsItems.search(ctx, { q: "login's", kind: "work_item", limit: 10 });
  assert.match(String((seen[0]!.body as { query: string }).query), /\[System\.Title\] CONTAINS 'login''s'/);
  assert.deepEqual(found.map((item) => item.id), ["Field App/42", "Field App/43"], "WIQL order is kept");
  assert.equal(found[0]!.title, "Bug 42: Login fails");
  assert.equal(found[0]!.url, "https://dev.azure.com/fieldnote/Field%20App/_workitems/edit/42");
  assert.equal(seen[0]!.headers.authorization, `Basic ${Buffer.from(`:${token}`).toString("base64")}`);

  const read = await azureDevopsItems.read(ctx, { kind: "work_item", id: "Field App/42" });
  assert.equal(read.facts?.Due, "2026-10-20");
  assert.match(read.text, /Login fails on Safari/);
  assert.ok(read.text.indexOf("Repro on Safari 18") < read.text.indexOf("Fixed on main"));
  assert.deepEqual(read.people, [{ name: "Mira Chen", email: "mira@fieldnote.example" }]);

  seen.length = 0;
  const posted = await azureDevopsItems.comment!(ctx, { kind: "work_item", id: "Field App/42" }, "Fixed in build 12\nShips <today>");
  assert.equal(posted.url, "https://dev.azure.com/fieldnote/Field%20App/_workitems/edit/42");
  assert.equal(seen[0]!.method, "POST");
  assert.deepEqual(seen[0]!.body, { text: "Fixed in build 12<br>Ships &lt;today&gt;" });

  const link = "https://dev.azure.com/fieldnote/Field%20App/_workitems/edit/42";
  assert.equal(azureWorkItemRef(link), "fieldnote/Field App/42");
  assert.deepEqual(azureDevopsItems.fromUrl!(link), { kind: "work_item", id: "fieldnote/Field App/42" });
  seen.length = 0;
  await azureDevopsItems.comment!(ctx, { kind: "work_item", id: "fieldnote/Field App/42" }, "ok");
  assert.equal(seen.length, 1);
  seen.length = 0;
  await refusedWith(azureDevopsItems.comment!(ctx, { kind: "work_item", id: "contoso/Field App/42" }, "ok"), /contoso organization/);
  assert.equal(seen.length, 0, "nothing is posted to another organization's work item");
});

test("Zendesk: open tickets, a ticket thread, internal notes, agents, and no token in errors", async () => {
  const token = "mira@fieldnote.example/token:zd-secret-0004";
  const { ctx, seen } = context({ token, meta: { site: "fieldnote.zendesk.com" } }, ({ url, method }) => {
    if (url.startsWith("https://fieldnote.zendesk.com/api/v2/search.json?")) {
      return json({ results: [{ id: 501, subject: "Export is empty", status: "open", priority: "high", updated_at: "2026-10-11T08:00:00Z", result_type: "ticket" }] });
    }
    if (url === "https://fieldnote.zendesk.com/api/v2/tickets/501.json?include=users") {
      return json({
        ticket: { id: 501, subject: "Export is empty", description: "My CSV export has no rows.", status: "open", priority: "high", requester_id: 1, assignee_id: 2, tags: ["export"], updated_at: "2026-10-11T08:00:00Z" },
        users: [{ id: 1, name: "Sam Lee", email: "sam@customer.example" }, { id: 2, name: "Mira Chen", email: "mira@fieldnote.example" }],
      });
    }
    if (url.startsWith("https://fieldnote.zendesk.com/api/v2/tickets/501/comments.json?")) {
      return json({
        comments: [
          { id: 3, author_id: 2, plain_body: "Looking at the job logs.", public: false, created_at: "2026-10-11T08:00:00Z" },
          { id: 2, author_id: 2, plain_body: "Thanks, checking now.", public: true, created_at: "2026-10-10T09:00:00Z" },
          { id: 1, author_id: 1, plain_body: "My CSV export has no rows.", public: true, created_at: "2026-10-10T08:00:00Z" },
        ],
      });
    }
    if (url === "https://fieldnote.zendesk.com/api/v2/tickets/501.json" && method === "PUT") return json({ ticket: { id: 501 } });
    if (url.startsWith("https://fieldnote.zendesk.com/api/v2/users.json?")) {
      return json({ users: [{ id: 2, name: "Mira Chen", email: "mira@fieldnote.example", role: "admin" }, { id: 4, name: "Old Agent", active: false }], next_page: "https://elsewhere.example/api/v2/users.json?page=2" });
    }
    if (url === "https://fieldnote.zendesk.com/api/v2/tickets/502.json?include=users") return json({ error: `Invalid credentials zd-secret-0004 for ${token}` }, 422);
    return json({ error: "RecordNotFound" }, 404);
  });

  const found = await zendeskItems.search(ctx, { q: "", limit: 10 });
  assert.equal(new URL(seen[0]!.url).searchParams.get("query"), "type:ticket assignee:me status<solved");
  assert.deepEqual(found.map((item) => [item.id, item.title, item.url]), [["501", "Export is empty", "https://fieldnote.zendesk.com/agent/tickets/501"]]);
  assert.equal(seen[0]!.headers.authorization, `Basic ${Buffer.from(token).toString("base64")}`);

  const read = await zendeskItems.read(ctx, { kind: "ticket", id: "501" });
  assert.equal(read.facts?.Requester, "Sam Lee");
  assert.equal(read.text.match(/My CSV export has no rows\./g)?.length, 1, "the description is not repeated as a comment");
  assert.ok(read.text.indexOf("Thanks, checking now.") < read.text.indexOf("Looking at the job logs."));
  assert.match(read.text, /internal note/);

  seen.length = 0;
  assert.deepEqual(await zendeskItems.comment!(ctx, { kind: "ticket", id: "501" }, "Fix is deploying today."), { url: "https://fieldnote.zendesk.com/agent/tickets/501" });
  assert.equal(seen[0]!.method, "PUT");
  assert.equal(seen[0]!.url, "https://fieldnote.zendesk.com/api/v2/tickets/501.json");
  assert.deepEqual(seen[0]!.body, { ticket: { comment: { body: "Fix is deploying today.", public: false } } });

  assert.deepEqual(zendeskItems.fromUrl!("https://fieldnote.zendesk.com/agent/tickets/501"), { kind: "ticket", id: "fieldnote.zendesk.com/501" });
  seen.length = 0;
  await refusedWith(zendeskItems.comment!(ctx, { kind: "ticket", id: "other.zendesk.com/501" }, "hi"), /other\.zendesk\.com/);
  assert.equal(seen.length, 0);

  seen.length = 0;
  assert.deepEqual(await zendeskItems.people!(ctx), [{ name: "Mira Chen", email: "mira@fieldnote.example" }]);
  assert.equal(seen.length, 1, "a next page on another host is not followed");
  assert.match(seen[0]!.url, /role%5B%5D=agent&role%5B%5D=admin/);

  await refusedWith(zendeskItems.read(ctx, { kind: "ticket", id: "502" }), /Zendesk answered with an error \(422\)/, "zd-secret-0004");
});

test("Front: open conversations, a thread in time order, teammates and internal comments", async () => {
  const token = "front-token-secret-0005";
  const { ctx, seen } = context({ token }, ({ url, method }) => {
    if (url === "https://api2.frontapp.com/conversations/search/is%3Aopen?limit=10") {
      return json({ _results: [{ id: "cnv_55a", subject: "Invoice question", status: "assigned", assignee: { first_name: "Mira", last_name: "Chen", email: "mira@fieldnote.example" }, recipient: { handle: "sam@customer.example", name: "Sam Lee" }, created_at: 1760000000 }] });
    }
    if (url === "https://api2.frontapp.com/conversations/cnv_55a") {
      return json({ id: "cnv_55a", subject: "Invoice question", status: "assigned", assignee: { first_name: "Mira", last_name: "Chen", email: "mira@fieldnote.example" }, recipient: { handle: "sam@customer.example", name: "Sam Lee" }, tags: [{ name: "billing" }] });
    }
    if (url === "https://api2.frontapp.com/conversations/cnv_55a/messages?limit=20") {
      return json({
        _results: [
          { id: "msg_2", is_inbound: false, created_at: 1760003600, text: "Sending a corrected invoice.", author: { first_name: "Mira", last_name: "Chen" } },
          { id: "msg_1", is_inbound: true, created_at: 1760000000, body: "<p>The total looks <b>wrong</b>.</p>", author: null, recipients: [{ handle: "sam@customer.example", name: "Sam Lee", role: "from" }] },
        ],
      });
    }
    if (url === "https://api2.frontapp.com/conversations/cnv_55a/comments" && method === "POST") return json({ id: "com_1" }, 201);
    if (url === "https://api2.frontapp.com/teammates") return json({ _results: [{ email: "mira@fieldnote.example", first_name: "Mira", last_name: "Chen", username: "mira" }, { email: "gone@fieldnote.example", is_blocked: true }] });
    return json({ _error: { message: "Not found" } }, 404);
  });

  const found = await frontItems.search(ctx, { q: "", limit: 10 });
  assert.deepEqual(found.map((item) => [item.id, item.title, item.subtitle, item.url]), [["cnv_55a", "Invoice question", "Sam Lee · assigned · Mira Chen", "https://app.frontapp.com/open/cnv_55a"]]);
  assert.equal(seen[0]!.headers.authorization, `Bearer ${token}`);

  const read = await frontItems.read(ctx, { kind: "conversation", id: "cnv_55a" });
  assert.ok(read.text.indexOf("The total looks wrong") < read.text.indexOf("Sending a corrected invoice."));
  assert.match(read.text, /\*\*Sam Lee\*\*/);
  assert.equal(read.facts?.Tags, "billing");

  seen.length = 0;
  await frontItems.comment!(ctx, { kind: "conversation", id: "cnv_55a" }, "Corrected invoice sent.");
  assert.deepEqual(seen[0]!.body, { body: "Corrected invoice sent." });
  assert.deepEqual(await frontItems.people!(ctx), [{ name: "Mira Chen", email: "mira@fieldnote.example", handle: "mira" }]);
  assert.deepEqual(frontItems.fromUrl!("https://app.frontapp.com/open/cnv_55a"), { kind: "conversation", id: "cnv_55a" });
  await refusedWith(frontItems.read(ctx, { kind: "conversation", id: "../teammates" }), /not a Front conversation/);
});

test("HubSpot: CRM search per object, a deal with owner and associations, owners, and a note on a ticket", async () => {
  const token = "pat-na1-mira-secret-0006";
  const { ctx, seen } = context({ token, meta: { portalId: 4410021, uiDomain: "app-eu1.hubspot.com" } }, ({ url, method }) => {
    if (url === "https://api.hubapi.com/crm/v3/objects/companies/search") return json({ status: "error", message: "This app hasn't been granted all required scopes" }, 403);
    const search = /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/(contacts|deals|tickets)\/search$/.exec(url);
    if (search && method === "POST") {
      const rows: Record<string, unknown[]> = {
        contacts: [{ id: "101", properties: { firstname: "Sam", lastname: "Lee", email: "sam@customer.example", company: "Customer Co" }, updatedAt: "2026-10-10T08:00:00Z" }],
        deals: [{ id: "9001", properties: { dealname: "Customer Co renewal", dealstage: "contractsent", amount: "12000" } }],
        tickets: [{ id: "7001", properties: { subject: "Refund request", hs_pipeline_stage: "1", hs_ticket_priority: "HIGH" } }],
      };
      return json({ results: rows[search[1]!] });
    }
    if (url.startsWith("https://api.hubapi.com/crm/v3/objects/deals/9001?")) {
      return json({
        id: "9001",
        properties: { dealname: "Customer Co renewal", dealstage: "contractsent", amount: "12000", closedate: "2026-11-01T00:00:00Z", hubspot_owner_id: "77", description: "Renewal for 40 seats." },
        associations: { contacts: { results: [{ id: "101" }, { id: "102" }] }, companies: { results: [{ id: "5" }] } },
      });
    }
    if (url === "https://api.hubapi.com/crm/v3/owners/77") return json({ id: "77", firstName: "Mira", lastName: "Chen", email: "mira@fieldnote.example" });
    if (url.startsWith("https://api.hubapi.com/crm/v3/owners?")) return json({ results: [{ id: "77", firstName: "Mira", lastName: "Chen", email: "mira@fieldnote.example" }], paging: {} });
    if (url === "https://api.hubapi.com/crm/v3/objects/notes" && method === "POST") return json({ id: "n1" }, 201);
    return json({ message: "not found" }, 404);
  });

  const all = await hubspotItems.search(ctx, { q: "customer", limit: 10 });
  assert.deepEqual(all.map((item) => [item.kind, item.id]), [["deal", "9001"], ["contact", "101"], ["ticket", "7001"]], "a kind without access is skipped");
  assert.equal(all[1]!.url, "https://app-eu1.hubspot.com/contacts/4410021/record/0-1/101");
  const ticketSearch = seen.find((request) => request.url.endsWith("/tickets/search"))!;
  assert.deepEqual((ticketSearch.body as { query: string; sorts: unknown }).query, "customer");
  assert.deepEqual((ticketSearch.body as { sorts: unknown }).sorts, [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }]);

  const deal = await hubspotItems.read(ctx, { kind: "deal", id: "9001" });
  assert.equal(deal.facts?.Owner, "Mira Chen");
  assert.equal(deal.facts?.Associated, "2 contacts, 1 companies");
  assert.equal(deal.facts?.["Close date"], "2026-11-01");
  assert.match(deal.text, /Renewal for 40 seats\./);
  assert.match(seen.find((request) => request.url.includes("/deals/9001?"))!.url, /associations=contacts,companies,tickets/);

  seen.length = 0;
  await hubspotItems.comment!(ctx, { kind: "ticket", id: "7001" }, "Refund approved\nby finance");
  const note = seen[0]!.body as { properties: { hs_note_body: string; hs_timestamp: string }; associations: unknown };
  assert.equal(note.properties.hs_note_body, "Refund approved<br>by finance");
  assert.ok(!Number.isNaN(Date.parse(note.properties.hs_timestamp)));
  assert.deepEqual(note.associations, [{ to: { id: "7001" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 228 }] }]);

  assert.deepEqual(hubspotItems.fromUrl!("https://app-eu1.hubspot.com/contacts/4410021/record/0-5/7001"), { kind: "ticket", id: "4410021/7001" });
  seen.length = 0;
  await refusedWith(hubspotItems.comment!(ctx, { kind: "ticket", id: "999/7001" }, "hi"), /account 999/);
  assert.equal(seen.length, 0);
  assert.deepEqual(await hubspotItems.people!(ctx), [{ name: "Mira Chen", email: "mira@fieldnote.example" }]);
});

test("Dropbox: search, small text files, Paper docs as Markdown, and other files by their details", async () => {
  const token = "dropbox-token-secret-0007";
  const { ctx, seen } = context({ token }, ({ url, headers, body }) => {
    if (url === "https://api.dropboxapi.com/2/files/search_v2") {
      return json({
        matches: [
          { metadata: { ".tag": "metadata", metadata: { ".tag": "folder", id: "id:folder1", name: "Roadmaps" } } },
          { metadata: { ".tag": "metadata", metadata: { ".tag": "file", id: "id:roadmap1", name: "roadmap.md", path_display: "/Plans/roadmap.md", size: 120, server_modified: "2026-10-09T08:00:00Z" } } },
        ],
      });
    }
    if (url === "https://api.dropboxapi.com/2/files/get_metadata") {
      const path = (body as { path: string }).path;
      if (path === "id:roadmap1") return json({ ".tag": "file", id: "id:roadmap1", name: "roadmap.md", path_display: "/Plans/roadmap.md", size: 120 });
      if (path === "id:paper1") return json({ ".tag": "file", id: "id:paper1", name: "Launch notes.paper", path_display: "/Launch notes.paper", is_downloadable: false, export_info: { export_as: "html", export_options: ["html", "markdown"] } });
      return json({ ".tag": "file", id: "id:deck1", name: "Pitch.key", path_display: "/Pitch.key", size: 5_000_000 });
    }
    if (url === "https://content.dropboxapi.com/2/files/download") return text(`# Roadmap\n\nQ4: ship Atlas (${headers["dropbox-api-arg"]})`);
    if (url === "https://content.dropboxapi.com/2/files/export") return text("# Launch notes\n\n- Press kit");
    return json({ error_summary: "path/not_found/" }, 409);
  });

  const found = await dropboxItems.search(ctx, { q: "roadmap", limit: 10 });
  assert.deepEqual(found.map((item) => [item.id, item.title, item.subtitle]), [["id:roadmap1", "roadmap.md", "/Plans · 120 B"]]);
  assert.equal(found[0]!.url, "https://www.dropbox.com/home/Plans?preview=roadmap.md");
  assert.equal((seen[0]!.body as { query: string }).query, "roadmap");

  const file = await dropboxItems.read(ctx, { kind: "file", id: "id:roadmap1" });
  assert.match(file.text, /Q4: ship Atlas \(\{"path":"id:roadmap1"\}\)/);
  const download = seen.find((request) => request.url.endsWith("/files/download"))!;
  assert.equal(download.method, "POST");
  assert.equal(download.headers["content-type"], undefined, "content endpoints take no JSON body");

  const paper = await dropboxItems.read(ctx, { kind: "file", id: "id:paper1" });
  assert.match(paper.text, /- Press kit/);
  assert.equal(seen.find((request) => request.url.endsWith("/files/export"))!.headers["dropbox-api-arg"], '{"path":"id:paper1","export_format":"markdown"}');

  const deck = await dropboxItems.read(ctx, { kind: "file", id: "id:deck1" });
  assert.match(deck.text, /Open in Dropbox to read this file type\./);
  assert.equal(dropboxArg({ path: "/Café/Ünïcode" }), '{"path":"/Caf\\u00e9/\\u00dcn\\u00efcode"}');
  await refusedWith(dropboxItems.read(ctx, { kind: "file", id: "/etc/passwd" }), /not a Dropbox file id/);
});

test("Box: search, extracted text for documents, and the token only goes to Box hosts", async () => {
  const token = "box-token-secret-0008";
  const template = "https://dl.boxcloud.com/api/2.0/internal_files/123/versions/456/representations/extracted_text/content/{+asset_path}";
  const { ctx, seen } = context({ token }, ({ url }) => {
    if (url.startsWith("https://api.box.com/2.0/search?")) {
      return json({ entries: [{ type: "file", id: "123", name: "Contract.pdf", size: 204800, modified_at: "2026-10-08T08:00:00Z", path_collection: { entries: [{ id: "0", name: "All Files" }, { id: "9", name: "Legal" }] } }] });
    }
    if (url.startsWith("https://api.box.com/2.0/files/123?")) {
      return json({ type: "file", id: "123", name: "Contract.pdf", extension: "pdf", size: 204800, representations: { entries: [{ representation: "extracted_text", status: { state: "success" }, content: { url_template: template } }] } });
    }
    if (url.startsWith("https://api.box.com/2.0/files/124?")) {
      return json({ type: "file", id: "124", name: "Plan.docx", extension: "docx", representations: { entries: [{ representation: "extracted_text", status: { state: "success" }, content: { url_template: "https://evil.example/steal/{+asset_path}" }, info: { url: "https://evil.example/info" } }] } });
    }
    if (url === template.replace("{+asset_path}", "")) return text("This agreement is between Fieldnote and Customer Co.");
    return json({ message: "Not Found" }, 404);
  });

  const found = await boxItems.search(ctx, { q: "contract", limit: 5 });
  assert.deepEqual(found.map((item) => [item.id, item.subtitle, item.url]), [["123", "Legal · 200 KB", "https://app.box.com/file/123"]]);

  const read = await boxItems.read(ctx, { kind: "file", id: "123" });
  assert.match(read.text, /This agreement is between Fieldnote and Customer Co\./);
  assert.equal(seen.find((request) => request.url.startsWith("https://api.box.com/2.0/files/123?"))!.headers["x-rep-hints"], "[extracted_text]");
  assert.equal(seen.find((request) => request.url.startsWith("https://dl.boxcloud.com/"))!.headers.authorization, `Bearer ${token}`);

  seen.length = 0;
  await boxItems.read(ctx, { kind: "file", id: "124" });
  assert.ok(seen.every((request) => !request.url.includes("evil.example")), "links outside Box are never fetched with the token");
});

test("Xero: invoices by contact name, an invoice's lines, a contact's recent invoices", async () => {
  const tenantId = "3f1c2b7e-9a4d-4c1e-8b2a-5d6e7f8a9b0c";
  const invoiceId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const contactId = "c0ffee00-1111-4222-8333-444455556666";
  const invoice = {
    InvoiceID: invoiceId,
    InvoiceNumber: "INV-0042",
    Type: "ACCREC",
    Status: "AUTHORISED",
    Contact: { ContactID: contactId, Name: "Customer Co" },
    DateString: "2026-10-01T00:00:00",
    DueDateString: "2026-10-31T00:00:00",
    CurrencyCode: "EUR",
    SubTotal: 1000,
    TotalTax: 200,
    Total: 1200,
    AmountDue: 1200,
    UpdatedDateUTC: "/Date(1760054400000+0000)/",
    LineItems: [{ Description: "Atlas seats | annual", Quantity: 10, UnitAmount: 100, LineAmount: 1000 }],
  };
  const { ctx, seen } = context({ token: "xero-token-secret-0009", meta: { tenantId } }, ({ url }) => {
    if (url.startsWith("https://api.xero.com/api.xro/2.0/Invoices?ContactIDs=")) return json({ Invoices: [invoice] });
    if (url.startsWith("https://api.xero.com/api.xro/2.0/Invoices?")) return json({ Invoices: [invoice] });
    if (url === `https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`) return json({ Invoices: [invoice] });
    if (url.startsWith("https://api.xero.com/api.xro/2.0/Contacts?")) return json({ Contacts: [{ ContactID: contactId, Name: "Customer Co", EmailAddress: "ap@customer.example", IsCustomer: true, ContactStatus: "ACTIVE" }] });
    if (url === `https://api.xero.com/api.xro/2.0/Contacts/${contactId}`) {
      return json({ Contacts: [{ ContactID: contactId, Name: "Customer Co", EmailAddress: "ap@customer.example", IsCustomer: true, Balances: { AccountsReceivable: { Outstanding: 1200, Overdue: 0 } } }] });
    }
    return json({ Message: "Not found" }, 404);
  });

  const found = await xeroItems.search(ctx, { q: 'Customer "Co"', limit: 5 });
  assert.deepEqual(found.map((item) => [item.kind, item.title]), [["invoice", "INV-0042 · Customer Co"], ["contact", "Customer Co"]]);
  assert.equal(found[0]!.subtitle, "Invoice · authorised · 1200.00 EUR · due 2026-10-31");
  assert.equal(found[0]!.url, `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${invoiceId}`);
  const where = new URL(seen[0]!.url).searchParams.get("where");
  assert.equal(where, 'Contact.Name.Contains("Customer Co") OR (InvoiceNumber != null AND InvoiceNumber.Contains("Customer Co"))', "quotes cannot end the filter string");
  assert.equal(new URL(seen[1]!.url).searchParams.get("searchTerm"), "Customer Co");
  assert.ok(seen.every((request) => request.headers["xero-tenant-id"] === tenantId));

  const read = await xeroItems.read(ctx, { kind: "invoice", id: invoiceId });
  assert.equal(read.facts?.Due, "2026-10-31");
  assert.match(read.text, /\| Atlas seats \\\| annual \| 10 \| 100\.00 \| 1000\.00 \|/);
  assert.match(read.text, /Total: 1200\.00 EUR/);

  const contact = await xeroItems.read(ctx, { kind: "contact", id: contactId });
  assert.equal(contact.facts?.["Owes you"], "1200.00");
  assert.match(contact.text, /INV-0042 \(2026-10-01\)/);

  assert.equal(xeroDate("/Date(1760054400000+0000)/"), "2025-10-10T00:00:00.000Z");
  const missing = context({ token: "xero-token-secret-0009", meta: {} }, () => json({}));
  await refusedWith(xeroItems.search(missing.ctx, { q: "", limit: 5 }), /without an organisation/);
});

test("Discord: refuses without the bot token, reads only servers the person added the bot to", async () => {
  const userToken = "discord-user-token-0010";
  const botToken = "discord-bot-secret-0010";
  const meta = { discordUserId: "555000111", guilds: [{ id: "111111111111", name: "Fieldnote" }] };
  const { ctx, seen } = context({ token: userToken, meta }, ({ url }) => {
    if (url === "https://discord.com/api/v10/guilds/111111111111/channels") {
      return json([
        { id: "200000000001", type: 0, name: "general", position: 1, guild_id: "111111111111" },
        { id: "200000000002", type: 2, name: "general-voice", position: 2, guild_id: "111111111111" },
        { id: "200000000003", type: 5, name: "announcements", position: 0, guild_id: "111111111111", topic: "Launch news" },
      ]);
    }
    if (url === "https://discord.com/api/v10/channels/200000000001") return json({ id: "200000000001", type: 0, name: "general", guild_id: "111111111111" });
    if (url === "https://discord.com/api/v10/channels/300000000001") return json({ id: "300000000001", type: 0, name: "secret", guild_id: "999999999999" });
    if (url === "https://discord.com/api/v10/channels/200000000001/messages?limit=50") {
      return json([
        { id: "m2", content: "Ship it on Friday", timestamp: "2026-10-11T10:05:00.000Z", author: { username: "arjun", global_name: "Arjun Rao" } },
        { id: "m1", content: "", timestamp: "2026-10-11T10:00:00.000Z", author: { username: "mira", global_name: "Mira Chen" }, attachments: [{ filename: "plan.pdf" }] },
      ]);
    }
    if (url === "https://discord.com/api/v10/channels/200000000009") return json({ message: `Unknown token ${botToken}` }, 401);
    return json({ message: "Unknown Channel" }, 404);
  });

  delete process.env.DISCORD_BOT_TOKEN;
  await refusedWith(discordItems.search(ctx, { q: "", limit: 10 }), /not set up on this server/);
  assert.equal(seen.length, 0);

  process.env.DISCORD_BOT_TOKEN = botToken;
  const found = await discordItems.search(ctx, { q: "", limit: 10 });
  assert.deepEqual(found.map((item) => [item.id, item.title]), [["200000000003", "#announcements"], ["200000000001", "#general"]]);
  assert.equal(found[1]!.url, "https://discord.com/channels/111111111111/200000000001");
  assert.ok(seen.every((request) => request.headers.authorization === `Bot ${botToken}`), "channels are read as the bot, never with the person's token");

  const read = await discordItems.read(ctx, { kind: "channel", id: "200000000001" });
  assert.match(read.text, /\*\*Mira Chen\*\* \(2026-10-11 10:00\): \[attachment: plan\.pdf\]\n\*\*Arjun Rao\*\* \(2026-10-11 10:05\): Ship it on Friday/);
  assert.deepEqual(read.people?.map((person) => person.handle), ["mira", "arjun"]);

  seen.length = 0;
  await refusedWith(discordItems.read(ctx, { kind: "channel", id: "300000000001" }), /not in a Discord server you added/);
  assert.ok(!seen.some((request) => request.url.includes("/messages")), "messages of other servers are never fetched");
  await refusedWith(discordItems.read(ctx, { kind: "channel", id: "200000000009" }), /refused this server's bot token/, botToken);

  const noGuilds = context({ token: userToken, meta: { discordUserId: "555000111" } }, () => json([]));
  await refusedWith(discordItems.search(noGuilds.ctx, { q: "", limit: 5 }), /pick a server/);
});

test("Discord install: a second server is added for the same Discord user, a different user starts over", () => {
  const first = discordGuilds({ guild: { id: "111111111111", name: "Fieldnote" } }, {}, "555000111");
  assert.deepEqual(first, [{ id: "111111111111", name: "Fieldnote" }]);
  const second = discordGuilds({ guild: { id: "222222222222", name: "Atlas beta" } }, { discordUserId: "555000111", guilds: first }, "555000111");
  assert.deepEqual(second.map((guild) => guild.id), ["111111111111", "222222222222"]);
  const reinstall = discordGuilds({ guild: { id: "111111111111", name: "Fieldnote HQ" } }, { discordUserId: "555000111", guilds: second }, "555000111");
  assert.deepEqual(reinstall, [{ id: "111111111111", name: "Fieldnote HQ" }, { id: "222222222222", name: "Atlas beta" }]);
  assert.deepEqual(discordGuilds({ guild: { id: "333333333333", name: "Other" } }, { discordUserId: "555000111", guilds: second }, "777000222"), [{ id: "333333333333", name: "Other" }]);
  assert.deepEqual(discordGuilds({ guild: { id: "../../x", name: "Bad" } }, {}, "555000111"), []);
});

const ZOTERO_PAPER = {
  key: "ABCD2345",
  links: { alternate: { href: "https://www.zotero.org/mira_chen/items/ABCD2345" } },
  meta: { creatorSummary: "Chen and Rao", parsedDate: "2025-03-01", numChildren: 3 },
  data: {
    key: "ABCD2345",
    itemType: "journalArticle",
    title: "Field notes at scale: offline-first data collection",
    creators: [
      { creatorType: "author", firstName: "Mira", lastName: "Chen" },
      { creatorType: "author", firstName: "Arjun", lastName: "Rao" },
    ],
    date: "March 2025",
    DOI: "https://doi.org/10.5555/fieldnote.2025.42",
    publicationTitle: "Journal of Field Methods",
    volume: "12",
    issue: "3",
    pages: "45-67",
    url: "https://journal.example/field-notes-at-scale",
    abstractNote: "We describe how a small team collects field notes without a network.",
    tags: [{ tag: "offline" }, { tag: "methods" }],
    collections: ["COLL2345"],
    dateAdded: "2026-09-01T10:00:00Z",
    dateModified: "2026-10-01T10:00:00Z",
  },
};

const ZOTERO_GROUP_PAPER = {
  key: "GRPP2345",
  links: { alternate: { href: "https://www.zotero.org/groups/fieldnote_reading/items/GRPP2345" } },
  meta: { creatorSummary: "Park", parsedDate: "2024" },
  data: { key: "GRPP2345", itemType: "conferencePaper", title: "Sync conflicts in the wild", proceedingsTitle: "Proceedings of FieldConf", extra: "DOI: 10.5555/fieldconf.2024.7", dateModified: "2026-10-05T10:00:00Z" },
};

test("Zotero: recent references across the library and groups, search with collections, links and DOIs", async () => {
  const token = "P9xKfieldnoteMiraKey0001";
  const meta = { userID: 4412001, username: "mira_chen", groups: [{ id: 99001, name: "Fieldnote Reading Group", write: false }] };
  const { ctx, seen } = context({ token, meta }, ({ url }) => {
    const path = url.replace("https://api.zotero.org", "");
    if (path.startsWith("/users/4412001/items/top?")) {
      return json([ZOTERO_PAPER, { key: "NOTE0001", meta: {}, data: { key: "NOTE0001", itemType: "note", note: "<p>Standalone</p>", dateModified: "2026-10-09T10:00:00Z" } }]);
    }
    if (path.startsWith("/groups/99001/items/top?")) return json([ZOTERO_GROUP_PAPER]);
    if (path === "/users/4412001/collections?limit=100") {
      return json([
        { key: "COLL2345", meta: { numItems: 3 }, data: { key: "COLL2345", name: "Offline methods" } },
        { key: "COLL9999", meta: { numItems: 1 }, data: { key: "COLL9999", name: "Archive" } },
      ]);
    }
    if (path === "/groups/99001/collections?limit=100") return json([]);
    if (path === "/users/4412001/items/ABCD2345") return json(ZOTERO_PAPER);
    if (path === "/groups/99001/items/GRPP2345") return json(ZOTERO_GROUP_PAPER);
    return json({}, 404);
  });

  const recent = await zoteroItems.search(ctx, { q: "", limit: 10 });
  assert.deepEqual(
    recent.map((item) => [item.kind, item.id, item.title]),
    [
      ["reference", "99001/GRPP2345", "Sync conflicts in the wild"],
      ["reference", "ABCD2345", "Field notes at scale: offline-first data collection"],
    ],
    "newest first across libraries; standalone notes are not references",
  );
  assert.equal(recent[1]!.subtitle, "Chen and Rao · 2025 · Journal of Field Methods · doi:10.5555/fieldnote.2025.42");
  assert.equal(recent[0]!.subtitle, "Park · 2024 · Proceedings of FieldConf · doi:10.5555/fieldconf.2024.7 · Fieldnote Reading Group");
  assert.equal(recent[1]!.url, "https://www.zotero.org/mira_chen/items/ABCD2345");
  assert.ok(seen.some((request) => request.url === "https://api.zotero.org/users/4412001/items/top?limit=10&sort=dateModified&direction=desc&itemType=-attachment"));
  assert.ok(!seen.some((request) => request.url.includes("/collections")), "an empty search lists references only");
  assert.ok(seen.every((request) => request.headers["zotero-api-key"] === token && request.headers["zotero-api-version"] === "3"));

  seen.length = 0;
  const found = await zoteroItems.search(ctx, { q: "offline", limit: 10 });
  assert.ok(seen.some((request) => request.url.endsWith("/users/4412001/items/top?limit=10&sort=dateModified&direction=desc&itemType=-attachment&q=offline&qmode=everything")));
  assert.deepEqual(found.at(-1), { source: "zotero", kind: "collection", id: "COLL2345", title: "Offline methods", subtitle: "3 items · My Library", url: "https://www.zotero.org/mira_chen/collections/COLL2345" });

  seen.length = 0;
  await zoteroItems.search(ctx, { q: "https://doi.org/10.5555/fieldnote.2025.42", kind: "reference", limit: 5 });
  assert.ok(seen.some((request) => request.url.includes("&q=10.5555%2Ffieldnote.2025.42&qmode=everything")), "a DOI link searches for the DOI");

  const collections = await zoteroItems.search(ctx, { q: "", kind: "collection", limit: 10 });
  assert.deepEqual(collections.map((item) => item.title), ["Archive", "Offline methods"]);

  const byLink = await zoteroItems.search(ctx, { q: "https://www.zotero.org/mira_chen/items/ABCD2345/item-details", limit: 5 });
  assert.deepEqual(byLink.map((item) => item.id), ["ABCD2345"]);
  const byGroupName = await zoteroItems.search(ctx, { q: "https://www.zotero.org/groups/fieldnote_reading/items/GRPP2345", limit: 5 });
  assert.deepEqual(byGroupName.map((item) => item.id), ["99001/GRPP2345"], "a link naming the group is found in the saved groups");
  assert.deepEqual(await zoteroItems.search(ctx, { q: "https://www.zotero.org/mira_chen/items/ABCD2345", kind: "collection", limit: 5 }), []);

  assert.deepEqual(zoteroRef("zotero://select/groups/99001/items/GRPP2345"), { kind: "reference", id: "99001/GRPP2345" });
  assert.deepEqual(zoteroRef("zotero://select/library/collections/COLL2345"), { kind: "collection", id: "COLL2345" });
  assert.deepEqual(zoteroRef("https://www.zotero.org/groups/99001/fieldnote_reading/collections/COLL2345/items/GRPP2345/item-list"), { kind: "reference", id: "99001/GRPP2345" });
  assert.deepEqual(zoteroRef("https://www.zotero.org/mira_chen/items/itemKey/ABCD2345"), { kind: "reference", id: "ABCD2345" });
  assert.equal(zoteroRef("https://www.zotero.org/groups/fieldnote_reading/items/GRPP2345"), null, "a group link without its number cannot be resolved");
  assert.equal(zoteroRef("https://www.zotero.org/support/dev/web_api/v3/start"), null);
  assert.equal(zoteroItems.fromUrl!("https://www.zotero.org/mira_chen/collections/COLL2345"), null, "updates go on references only");
  assert.deepEqual(zoteroItems.fromUrl!("https://www.zotero.org/mira_chen/items/ABCD2345"), { kind: "reference", id: "ABCD2345" });
  assert.equal(zoteroDoi("doi: 10.1000/xyz123."), "10.1000/xyz123");
  assert.deepEqual(await zoteroItems.search(ctx, { q: "x", kind: "issue", limit: 5 }), []);

  const noUser = context({ token, meta: {} }, () => json({}, 500));
  await assert.rejects(zoteroItems.search(noUser.ctx, { q: "", limit: 5 }), /Connect Zotero again/);
  assert.equal(noUser.seen.length, 0);
});

test("Zotero: a reference reads with its APA citation, abstract, notes and attachments; a collection reads as a reading list", async () => {
  const token = "P9xKfieldnoteMiraKey0001";
  const { ctx, seen } = context({ token, meta: { userID: 4412001, username: "mira_chen" } }, ({ url }) => {
    const path = url.replace("https://api.zotero.org", "");
    if (path === "/users/4412001/items/ABCD2345?include=data,bib,citation&style=apa") {
      return json({
        ...ZOTERO_PAPER,
        bib: '<div class="csl-bib-body"><div class="csl-entry">Chen, M., &amp; Rao, A. (2025). Field notes at scale: Offline-first data collection. <i>Journal of Field Methods</i>, <i>12</i>(3), 45–67. https://doi.org/10.5555/fieldnote.2025.42</div></div>',
        citation: "<span>(Chen &amp; Rao, 2025)</span>",
      });
    }
    if (path === "/users/4412001/items/ABCD2345/children?limit=100") {
      return json([
        { key: "NOTE0002", data: { key: "NOTE0002", itemType: "note", dateAdded: "2026-10-03T09:00:00Z", note: '<h1>Reading notes</h1><p>Strong on sync; weak on <a href="https://example.org/conflicts">conflict handling</a>.</p>' } },
        { key: "NOTE0001", data: { key: "NOTE0001", itemType: "note", dateAdded: "2026-09-02T09:00:00Z", note: "<p>First pass &amp; questions</p>" } },
        { key: "PDF00001", data: { key: "PDF00001", itemType: "attachment", title: "Full Text PDF", contentType: "application/pdf", linkMode: "imported_url" } },
      ]);
    }
    if (path === "/users/4412001/collections?limit=100") return json([{ key: "COLL2345", data: { key: "COLL2345", name: "Offline methods" } }]);
    if (path === "/users/4412001/collections/COLL2345") return json({ key: "COLL2345", meta: { numItems: 3, numCollections: 1 }, data: { key: "COLL2345", name: "Offline methods" } });
    if (path === "/users/4412001/collections/COLL2345/items/top?limit=50&sort=title&direction=asc&itemType=-attachment&include=data,bib&style=apa") {
      return json([
        { ...ZOTERO_PAPER, bib: '<div class="csl-entry">Chen, M., &amp; Rao, A. (2025). Field notes at scale. <i>Journal of Field Methods</i>.</div>' },
        { key: "OTHR2345", meta: { creatorSummary: "Lena Park", parsedDate: "2023" }, data: { key: "OTHR2345", itemType: "book", title: "Notebooks", publisher: "Fieldnote Press", DOI: "10.5555/books.1" } },
      ]);
    }
    if (path === "/users/4412001/collections/COLL2345/collections?limit=50") return json([{ key: "SUBC2345", data: { key: "SUBC2345", name: "Sync conflicts" } }]);
    return json({}, 404);
  });

  const paper = await zoteroItems.read(ctx, { kind: "reference", id: "ABCD2345" });
  assert.equal(paper.title, "Field notes at scale: offline-first data collection");
  assert.equal(paper.url, "https://www.zotero.org/mira_chen/items/ABCD2345");
  assert.deepEqual(paper.facts, {
    Type: "Journal article",
    Authors: "Chen, Mira; Rao, Arjun",
    Year: "2025",
    "Published in": "Journal of Field Methods",
    Volume: "12",
    Issue: "3",
    Pages: "45-67",
    DOI: "https://doi.org/10.5555/fieldnote.2025.42",
    URL: "https://journal.example/field-notes-at-scale",
    Tags: "offline, methods",
    Collections: "Offline methods",
    Added: "2026-09-01",
    Notes: "2",
    Citation: "(Chen & Rao, 2025)",
  });
  assert.match(paper.text, /## Citation \(APA\)\n\nChen, M\., & Rao, A\. \(2025\)\. Field notes at scale: Offline-first data collection\. _Journal of Field Methods_, _12_\(3\), 45–67\. https:\/\/doi\.org\/10\.5555\/fieldnote\.2025\.42/);
  assert.match(paper.text, /## Abstract\n\nWe describe how a small team/);
  assert.match(paper.text, /### Note \(2026-10-03\)\n\n#### Reading notes\nStrong on sync; weak on \[conflict handling\]\(https:\/\/example\.org\/conflicts\)\./);
  assert.ok(paper.text.indexOf("First pass & questions") < paper.text.indexOf("Reading notes"), "notes read oldest first");
  assert.match(paper.text, /## Attachments\n\n- Full Text PDF \(PDF\)/);
  assert.deepEqual(paper.people, [
    { name: "Mira Chen", title: "author" },
    { name: "Arjun Rao", title: "author" },
  ]);

  const list = await zoteroItems.read(ctx, { kind: "collection", id: "COLL2345" });
  assert.equal(list.title, "Offline methods");
  assert.deepEqual(list.facts, { Items: "3", Subcollections: "Sync conflicts", Library: "My Library" });
  assert.match(list.text, /## Reading list \(APA\)\n\n- Chen, M\., & Rao, A\. \(2025\)\. Field notes at scale\. _Journal of Field Methods_\. \(\[Zotero\]\(https:\/\/www\.zotero\.org\/mira_chen\/items\/ABCD2345\)\)/);
  assert.match(list.text, /- \*\*Notebooks\*\* Lena Park \(2023\) _Fieldnote Press_ https:\/\/doi\.org\/10\.5555\/books\.1 \(\[Zotero\]\(https:\/\/www\.zotero\.org\/mira_chen\/items\/OTHR2345\)\)/);
  assert.match(list.text, /… 1 more in Zotero\./);

  await assert.rejects(zoteroItems.read(ctx, { kind: "reference", id: "../keys/current" }), /not a Zotero id/);
  await assert.rejects(zoteroItems.read(ctx, { kind: "reference", id: "99001/abcd2345" }), /not a Zotero id/);
  assert.ok(seen.every((request) => request.url.startsWith("https://api.zotero.org/")));
});

test("Zotero: posting an update adds an escaped child note, and a read-only key is told what to change", async () => {
  const token = "P9xKfieldnoteMiraKey0001";
  let reply: (request: { url: string }) => Response = () => json({ successful: { "0": { key: "NOTE0003" } }, success: { "0": "NOTE0003" }, unchanged: {}, failed: {} });
  const { ctx, seen } = context({ token, meta: { userID: 4412001, username: "mira_chen", groups: [{ id: 99001, name: "Fieldnote Reading Group", write: false }] } }, (request) => reply(request));

  const posted = await zoteroItems.comment!(ctx, { kind: "reference", id: "ABCD2345" }, "Read it & liked the <sync> part.\nSee ch. 2\n\nNext: cite in the review");
  assert.deepEqual(posted, { url: "https://www.zotero.org/mira_chen/items/ABCD2345" });
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.url, "https://api.zotero.org/users/4412001/items");
  assert.deepEqual(seen[0]!.body, [{ itemType: "note", parentItem: "ABCD2345", note: "<p>Read it &amp; liked the &lt;sync&gt; part.<br>See ch. 2</p>\n<p>Next: cite in the review</p>", tags: [] }]);
  assert.match(seen[0]!.headers["zotero-write-token"] ?? "", /^[0-9a-f]{32}$/);
  assert.equal(seen[0]!.headers["zotero-api-key"], token);

  reply = () => json({ code: 403, message: `Write access denied for ${token}` }, 403);
  const denied = await refusedWith(zoteroItems.comment!(ctx, { kind: "reference", id: "99001/GRPP2345" }, "Shared note"), /can't add notes in Fieldnote Reading Group\. At zotero\.org\/settings\/keys, edit the key and tick Allow write access for this group/, token);
  assert.equal(denied.statusCode, 403);
  assert.equal(seen.at(-1)!.url, "https://api.zotero.org/groups/99001/items");

  reply = () => json({ successful: {}, success: {}, unchanged: {}, failed: { "0": { key: "", code: 400, message: "Parent item ZZZZ2345 not found" } } });
  await refusedWith(zoteroItems.comment!(ctx, { kind: "reference", id: "ZZZZ2345" }, "Hello"), /did not save the note: Parent item ZZZZ2345 not found/);

  const before = seen.length;
  await refusedWith(zoteroItems.comment!(ctx, { kind: "collection", id: "COLL2345" }, "Hello"), /go on a reference/);
  await refusedWith(zoteroItems.comment!(ctx, { kind: "reference", id: "ABCD2345" }, "  \n\n "), /Write the note first/);
  assert.equal(seen.length, before, "nothing is sent for a refused note");
  assert.equal(zoteroNoteHtml("One\n\n\nTwo"), "<p>One</p>\n<p>Two</p>");
});

