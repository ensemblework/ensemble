import assert from "node:assert/strict";
import test from "node:test";
import { notionSource, NOTION_VERSION } from "./api/notion.js";
import { linearSource } from "./api/linear.js";
import { jiraSource } from "./api/jira.js";
import { todoistSource } from "./api/todoist.js";
import { csvItems, detectPreset, parseCsv, proposeMapping } from "./files/csv.js";
import { createImportHttp, retryAfterMs } from "./http.js";
import { adfToMarkdown, notionBlocksToMarkdown, separateLists } from "./markdown.js";
import { cleanLabels, guessStatus, mapPriority, normalizeDate, resolveStatus, splitDescription, splitRange, stripNotionId } from "./mapping.js";
import type { ImportContainer, ImportItem, SourceAuth, SourceContext } from "./types.js";
import { zipSync } from "fflate";
import { safeUnzip, unzipBudget } from "./files/zip.js";
import { parseNotionExport, readNotionZip } from "./files/notion-zip.js";
import { parseUpload } from "./files/index.js";
import { assertPreviewRoom, clearPreviewsForTests, getPreview, previewStats, savePreview, setPreviewLimitsForTests, withUploadSlot } from "./previews.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function mockFetch(handler: (call: Call) => unknown | Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const result = handler(call);
    if (result instanceof Response) return result;
    if (result === undefined) return new Response(JSON.stringify({ message: "not mocked" }), { status: 404 });
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function context(auth: SourceAuth, fetchImpl: typeof fetch, options: SourceContext["options"] = {}): SourceContext {
  const signal = new AbortController().signal;
  return { auth, signal, options, http: createImportHttp({ signal, label: "Test", gapMs: 0, fetchImpl }) };
}

async function collect(generator: AsyncGenerator<ImportItem[]>): Promise<ImportItem[]> {
  const items: ImportItem[] = [];
  for await (const page of generator) items.push(...page);
  return items;
}

test("status, priority, labels and dates map the forgiving way", () => {
  assert.equal(guessStatus("Done"), "done");
  assert.equal(guessStatus("Won't do"), "dropped");
  assert.equal(guessStatus("Cancelled"), "dropped");
  assert.equal(guessStatus("In Review"), "in_progress");
  assert.equal(guessStatus("Blocked"), "blocked");
  assert.equal(guessStatus("Backlog"), "todo");
  assert.equal(guessStatus("Ready to ship QA pass"), null);
  assert.equal(guessStatus("Ideas", "started"), "in_progress");
  assert.equal(guessStatus(null, "done"), "done");
  assert.equal(resolveStatus({ status: "Ideas" }, {}), "todo");
  assert.equal(resolveStatus({ status: "Ideas" }, { ideas: "proposed" }), "proposed");
  assert.equal(resolveStatus({ status: "To Do", done: true }, {}), "done");

  assert.equal(mapPriority("Critical"), "critical");
  assert.equal(mapPriority("Blocker"), "critical");
  assert.equal(mapPriority("Urgent"), "p0");
  assert.equal(mapPriority("Highest"), "p0");
  assert.equal(mapPriority("High"), "p0");
  assert.equal(mapPriority("Medium"), "p1");
  assert.equal(mapPriority("No priority"), "p1");
  assert.equal(mapPriority("Low"), "p2");
  assert.equal(mapPriority("Lowest"), "p2");
  assert.equal(mapPriority(null), "p1");

  assert.deepEqual(cleanLabels([" Design ", "design", "", "A".repeat(60), ...Array.from({ length: 30 }, (_, index) => `t${index}`)]).slice(0, 3), ["Design", "A".repeat(40), "t0"]);
  assert.equal(cleanLabels(Array.from({ length: 30 }, (_, index) => `t${index}`)).length, 20);

  assert.equal(normalizeDate("2026-10-07"), "2026-10-07");
  assert.equal(normalizeDate("2026-10-07T09:30:00.000+05:30"), "2026-10-07T04:00:00.000Z");
  assert.equal(normalizeDate("2026-10-07T09:30:00"), "2026-10-07", "a floating time stays on its day");
  assert.equal(normalizeDate("October 7, 2026"), "2026-10-07");
  assert.equal(normalizeDate("Sept 7, 2026"), "2026-09-07");
  assert.equal(normalizeDate("7 Oct 2026"), "2026-10-07");
  assert.equal(normalizeDate("10/28/2026"), "2026-10-28");
  assert.equal(normalizeDate("28/10/2026"), "2026-10-28");
  assert.equal(normalizeDate("07/Oct/26 2:00 PM"), "2026-10-07");
  assert.equal(normalizeDate("1791360000000"), "2026-10-07T08:00:00.000Z");
  assert.equal(normalizeDate("every monday"), null);
  assert.equal(normalizeDate("2026-02-30"), null);
  assert.deepEqual(splitRange("October 9, 2026 → October 12, 2026"), ["2026-10-09", "2026-10-12"]);

  assert.deepEqual(splitDescription("Short note.", null), { description: "Short note.", page: null });
  const long = splitDescription("First line.\n\n- one\n- two", null);
  assert.equal(long.description, "First line.");
  assert.equal(long.page, "First line.\n\n- one\n- two");
  assert.equal(stripNotionId("Tasks 9a8b7c6d5e4f30211203f4e5d6c7b8a9.csv"), "Tasks.csv");
  assert.equal(separateLists("- a\n- [ ] b\n1. c"), "- a\n\n- [ ] b\n\n1. c");
});

test("CSV presets are recognised from their headers", () => {
  assert.equal(detectPreset(["Task ID", "Created At", "Name", "Section/Column", "Assignee", "Assignee Email", "Due Date", "Tags", "Notes", "Projects"]), "asana");
  assert.equal(detectPreset(["Summary", "Issue key", "Issue id", "Status", "Labels", "Labels"]), "jira");
  assert.equal(detectPreset(["ID", "Team", "Title", "Description", "Status", "Priority", "Project ID", "Cycle Name"]), "linear");
  assert.equal(detectPreset(["Task ID", "Task Name", "Task Content", "Status", "List Name"]), "clickup");
  assert.equal(detectPreset(["TYPE", "CONTENT", "DESCRIPTION", "PRIORITY", "INDENT", "AUTHOR", "RESPONSIBLE", "DATE"]), "todoist");
  assert.equal(detectPreset(["Name", "Due"], "notion"), "notion");
  assert.equal(detectPreset(["Name", "Due"]), "generic");

  const jira = parseCsv("Summary,Issue key,Issue id,Status,Priority,Labels,Labels,Due date,Project name\nFix soil map,FLD-7,10007,In Progress,Highest,maps,urgent,2026-10-30,Field\n");
  const jiraItems = csvItems(jira, proposeMapping(jira, "jira"), "jira", { containerId: "file" });
  assert.equal(jiraItems[0]!.externalId, "10007");
  assert.deepEqual(jiraItems[0]!.labels, ["maps", "urgent"]);
  assert.equal(jiraItems[0]!.projectName, "Field");

  const todoist = parseCsv(
    "TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE\n" +
      "section,This week,,,,,,,,\n" +
      "task,Water the test beds @garden @daily,Before 9am,1,1,Mira Chen,,Oct 9 2026,en,UTC\n" +
      "note,A comment,,,,,,,,\n",
  );
  const todoistItems = csvItems(todoist, proposeMapping(todoist, "todoist"), "todoist", { containerId: "file", projectName: "Garden" });
  assert.equal(todoistItems.length, 1);
  assert.equal(todoistItems[0]!.title, "Water the test beds");
  assert.deepEqual(todoistItems[0]!.labels, ["garden", "daily", "This week"]);
  assert.equal(todoistItems[0]!.priority, "urgent");
  assert.equal(todoistItems[0]!.dueDate, "2026-10-09");
  assert.equal(todoistItems[0]!.projectName, "Garden");

  const semi = parseCsv("Report title;Owner\nQuarterly notes;Mira Chen\n");
  assert.deepEqual(semi.headers, ["Report title", "Owner"]);
  const tsv = parseCsv("Fieldnote export\n\nTitle\tDue\tTags\nPlant cover crop\t2026-11-01\tsoil, autumn\n");
  assert.deepEqual(tsv.headers, ["Title", "Due", "Tags"], "a title line above the header is skipped");
  const tsvItems = csvItems(tsv, proposeMapping(tsv, "generic"), "generic", { containerId: "f" });
  assert.deepEqual(tsvItems[0]!.labels, ["soil", "autumn"]);
});

test("HTTP waits on 429 Retry-After and never echoes the token", async () => {
  assert.equal(retryAfterMs("2", 0), 2000);
  assert.equal(retryAfterMs(null, 2), 4000);
  let attempts = 0;
  const { fetch } = mockFetch(() => {
    attempts += 1;
    if (attempts === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    return { ok: true };
  });
  const signal = new AbortController().signal;
  const http = createImportHttp({ signal, label: "Linear", gapMs: 0, fetchImpl: fetch, headers: { Authorization: "secret-token-value" } });
  assert.deepEqual(await http.json("https://api.example.test/x"), { ok: true });
  assert.equal(attempts, 2);
  const denied = createImportHttp({ signal, label: "Linear", gapMs: 0, fetchImpl: mockFetch(() => new Response("no", { status: 401 })).fetch, headers: { Authorization: "secret-token-value" } });
  await assert.rejects(denied.json("https://api.example.test/x"), (error: Error) => /did not accept the token/.test(error.message) && !error.message.includes("secret"));
});

test("Notion: data sources, standalone pages, row properties and blocks to Markdown", async () => {
  const { fetch, calls } = mockFetch((call) => {
    if (call.url.endsWith("/v1/search")) {
      const value = (call.body as { filter: { value: string } }).filter.value;
      if (value === "data_source") return { results: [{ object: "data_source", id: "ds-1", title: [{ plain_text: "Field tasks" }] }], has_more: false };
      return {
        results: [
          { object: "page", id: "row-in-db", parent: { type: "data_source_id", data_source_id: "ds-1" }, properties: {} },
          { object: "page", id: "1111-2222", url: "https://www.notion.so/Guide-11112222", parent: { type: "page_id", page_id: "aaaa-bbbb" }, properties: { title: { type: "title", title: [{ plain_text: "Guide" }] } } },
          { object: "page", id: "aaaa-bbbb", parent: { type: "workspace", workspace: true }, properties: { title: { type: "title", title: [{ plain_text: "Home" }] } } },
          { object: "page", id: "gone", in_trash: true, parent: { type: "workspace" }, properties: {} },
        ],
        has_more: false,
      };
    }
    if (call.url.endsWith("/v1/data_sources/ds-1/query")) {
      return {
        results: [
          {
            object: "page",
            id: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
            url: "https://www.notion.so/Draft-aaaabbbb",
            properties: {
              Name: { type: "title", title: [{ plain_text: "Draft field guide" }] },
              Due: { type: "date", date: { start: "2026-10-18", end: "2026-10-20" } },
              Status: { type: "status", status: { name: "In progress" } },
              Priority: { type: "select", select: { name: "High" } },
              Tags: { type: "multi_select", multi_select: [{ name: "Writing" }, { name: "Field guide" }] },
              Owner: { type: "people", people: [{ name: "Mira Chen" }] },
              Done: { type: "checkbox", checkbox: false },
              Budget: { type: "number", number: 1200 },
            },
          },
        ],
        has_more: false,
      };
    }
    if (call.url.includes("/v1/blocks/aaaabbbb-cccc-dddd-eeee-ffff00001111/children")) {
      return {
        results: [
          { id: "b1", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Outline" }] } },
          { id: "b2", type: "to_do", to_do: { checked: true, rich_text: [{ plain_text: "Soil", annotations: { bold: true } }] } },
          { id: "b3", type: "code", code: { language: "python", rich_text: [{ plain_text: "print('hi')" }] } },
          { id: "b4", type: "callout", callout: { icon: { emoji: "💡" }, rich_text: [{ plain_text: "Keep it short" }] } },
          { id: "b5", type: "table", has_children: true, table: {} },
          { id: "b6", type: "image", image: { type: "external", external: { url: "https://images.example.test/cover.png" }, caption: [{ plain_text: "Cover" }] } },
          { id: "b7", type: "toggle", has_children: true, toggle: { rich_text: [{ plain_text: "More" }] } },
        ],
        has_more: false,
      };
    }
    if (call.url.includes("/v1/blocks/b5/children")) {
      return { results: [
        { id: "r1", type: "table_row", table_row: { cells: [[{ plain_text: "Plot" }], [{ plain_text: "Crop" }]] } },
        { id: "r2", type: "table_row", table_row: { cells: [[{ plain_text: "A" }], [{ plain_text: "Rye" }]] } },
      ], has_more: false };
    }
    if (call.url.includes("/v1/blocks/b7/children")) return { results: [{ id: "t1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Hidden detail" }] } }], has_more: false };
    if (call.url.includes("/v1/blocks/1111-2222/children")) return { results: [{ id: "p1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Chapters", href: "https://fieldnote.example.test" }] } }], has_more: false };
    if (call.url.includes("/children")) return { results: [], has_more: false };
    return undefined;
  });
  const ctx = context({ token: "secret_notion", via: "token" }, fetch);
  const containers = await notionSource.listContainers(ctx);
  assert.deepEqual(containers.map((container) => [container.id, container.name, container.count, container.importAs]), [
    ["ds-1", "Field tasks", null, "tasks"],
    ["pages", "Pages", 2, "pages"],
  ]);
  assert.equal(calls[0]!.headers["Notion-Version"], NOTION_VERSION);
  assert.equal(calls[0]!.headers.Authorization, "Bearer secret_notion");
  const items = await collect(notionSource.fetchItems(ctx, containers));
  const row = items.find((item) => item.kind === "task")!;
  assert.equal(row.externalId, "aaaabbbbccccddddeeeeffff00001111");
  assert.equal(row.title, "Draft field guide");
  assert.equal(row.dueDate, "2026-10-20");
  assert.equal(row.startDate, "2026-10-18");
  assert.equal(row.status, "In progress");
  assert.equal(row.priority, "High");
  assert.deepEqual(row.labels, ["Writing", "Field guide"]);
  assert.deepEqual(row.assignees, ["Mira Chen"]);
  assert.equal(row.projectRef, "ds1");
  assert.match(row.pageMarkdown!, /\*\*Budget:\*\* 1200/);
  assert.match(row.pageMarkdown!, /## Outline/);
  assert.match(row.pageMarkdown!, /- \[x\] \*\*Soil\*\*/);
  assert.match(row.pageMarkdown!, /```python\nprint\('hi'\)\n```/);
  assert.match(row.pageMarkdown!, /> 💡 Keep it short/);
  assert.match(row.pageMarkdown!, /\| Plot \| Crop \|\n\| --- \| --- \|\n\| A \| Rye \|/);
  assert.match(row.pageMarkdown!, /\[Image: Cover\]\(https:\/\/images\.example\.test\/cover\.png\)/);
  assert.match(row.pageMarkdown!, /\*\*More\*\*\n\nHidden detail/);
  const guide = items.find((item) => item.title === "Guide")!;
  assert.equal(guide.kind, "page");
  assert.equal(guide.parentTitle, "Home");
  assert.equal(guide.pageMarkdown, "[Chapters](https://fieldnote.example.test)");
  const query = calls.find((call) => call.url.endsWith("/v1/data_sources/ds-1/query"))!;
  assert.equal(query.method, "POST");
});

test("Linear: personal keys go in raw, issues map with state type and project", async () => {
  const { fetch, calls } = mockFetch((call) => {
    const body = call.body as { query: string; variables: Record<string, unknown> };
    if (body.query.includes("teams(first")) return { data: { viewer: { name: "Mira" }, teams: { nodes: [{ id: "t1", name: "Field", key: "FLD" }], pageInfo: { hasNextPage: false, endCursor: null } } } };
    return {
      data: {
        viewer: {
          assignedIssues: {
            nodes: [
              {
                id: "uuid-1",
                identifier: "FLD-12",
                title: "Map the plots",
                description: "## Steps\n\n- walk\n- mark",
                url: "https://linear.app/fieldnote/issue/FLD-12",
                priorityLabel: "High",
                dueDate: "2026-10-30",
                state: { name: "Ready", type: "unstarted" },
                labels: { nodes: [{ name: "Maps" }] },
                assignee: { name: "Mira Chen" },
                project: { id: "p1", name: "Field guide" },
                cycle: { number: 4, name: null },
                parent: { identifier: "FLD-1", title: "Survey" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
  });
  const ctx = context({ token: "lin_api_fictional", via: "token" }, fetch, { includeCompleted: false });
  const containers = await linearSource.listContainers(ctx);
  assert.deepEqual(containers.map((container) => container.id), ["mine", "t1"]);
  const items = await collect(linearSource.fetchItems(ctx, [containers[0]!]));
  assert.equal(calls[0]!.headers.Authorization, "lin_api_fictional");
  assert.match((calls[1]!.body as { query: string }).query, /nin: \["completed", "canceled"\]/);
  const issue = items[0]!;
  assert.equal(issue.externalId, "FLD-12");
  assert.equal(issue.statusCategory, "unstarted");
  assert.equal(guessStatus(issue.status, issue.statusCategory), "todo");
  assert.deepEqual(issue.labels, ["Maps", "Cycle 4"]);
  assert.equal(issue.projectName, "Field guide");
  assert.match(issue.description!, /Sub-issue of FLD-1 Survey/);
  const oauth = context({ token: "oauth-token", via: "account" }, mockFetch(() => ({ data: { viewer: { name: "x" }, teams: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } })).fetch);
  await linearSource.listContainers(oauth);
});

test("Jira: Basic auth on the site, JQL pages with nextPageToken, ADF descriptions", async () => {
  const issue = (id: string, key: string) => ({
    id,
    key,
    fields: {
      summary: `Issue ${key}`,
      description: {
        type: "doc",
        version: 1,
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Context" }] },
          { type: "paragraph", content: [{ type: "text", text: "See " }, { type: "text", text: "the map", marks: [{ type: "link", attrs: { href: "https://maps.example.test" } }] }] },
          { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "rows", marks: [{ type: "strong" }] }] }] }] },
          { type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "text", text: "measured" }] }] },
          { type: "codeBlock", attrs: { language: "sql" }, content: [{ type: "text", text: "select 1" }] },
        ],
      },
      duedate: "2026-11-04",
      labels: ["soil"],
      status: { name: "In QA", statusCategory: { key: "indeterminate" } },
      priority: { name: "Highest" },
      assignee: { displayName: "Theo Park" },
      project: { id: "100", key: "FLD", name: "Field" },
      issuetype: { name: "Bug" },
      resolutiondate: null,
    },
  });
  const { fetch, calls } = mockFetch((call) => {
    if (call.url.includes("/rest/api/3/project/search")) return { values: [{ id: "100", key: "FLD", name: "Field" }], isLast: true };
    if (call.url.endsWith("/rest/api/3/search/approximate-count")) return { count: 2 };
    if (call.url.endsWith("/rest/api/3/search/jql")) {
      const token = (call.body as { nextPageToken?: string }).nextPageToken;
      return token ? { issues: [issue("10002", "FLD-2")], isLast: true } : { issues: [issue("10001", "FLD-1")], nextPageToken: "next-1", isLast: false };
    }
    return undefined;
  });
  const ctx = context({ token: "atl-token", via: "token", site: "https://fieldnote.atlassian.net/jira", email: "mira@fieldnote.example" }, fetch);
  const containers = await jiraSource.listContainers(ctx);
  assert.deepEqual(containers.map((container) => [container.id, container.count]), [["mine", 2], ["100", 2]]);
  assert.equal(calls[0]!.url.startsWith("https://fieldnote.atlassian.net/rest/api/3/project/search"), true);
  assert.equal(calls[0]!.headers.Authorization, `Basic ${Buffer.from("mira@fieldnote.example:atl-token").toString("base64")}`);
  const items = await collect(jiraSource.fetchItems(ctx, [containers[1]!]));
  assert.deepEqual(items.map((item) => item.externalId), ["10001", "10002"]);
  const searches = calls.filter((call) => call.url.endsWith("/search/jql"));
  assert.equal((searches[0]!.body as { jql: string }).jql, 'project = "FLD" ORDER BY created ASC');
  assert.equal((searches[1]!.body as { nextPageToken: string }).nextPageToken, "next-1");
  const first = items[0]!;
  assert.equal(first.url, "https://fieldnote.atlassian.net/browse/FLD-1");
  assert.deepEqual(first.labels, ["soil", "Bug"]);
  assert.equal(first.statusCategory, "indeterminate");
  assert.equal(mapPriority(first.priority), "p0");
  assert.match(first.description!, /## Context/);
  assert.match(first.description!, /See \[the map\]\(https:\/\/maps\.example\.test\)/);
  assert.match(first.description!, /- \*\*rows\*\*/);
  assert.match(first.description!, /- \[x\] measured/);
  assert.match(first.description!, /```sql\nselect 1\n```/);

  const oauth = mockFetch(() => ({ values: [], isLast: true, count: 0 }));
  await jiraSource.listContainers(context({ token: "bearer", via: "account", cloudId: "cloud-1" }, oauth.fetch));
  assert.ok(oauth.calls[0]!.url.startsWith("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/"));
  assert.equal(oauth.calls[0]!.headers.Authorization, "Bearer bearer");
  await assert.rejects(jiraSource.listContainers(context({ token: "x", via: "token", site: "evil.example.com", email: "a@b.c" }, oauth.fetch)), /atlassian\.net/);
});

test("Todoist: API v1 cursors, sections as labels, deadline as due, priority 4 is urgent", async () => {
  const { fetch, calls } = mockFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === "/api/v1/projects") return { results: [{ id: "p1", name: "Garden" }, { id: "p2", name: "Old", is_archived: true }], next_cursor: null };
    if (url.pathname === "/api/v1/sections") return { results: [{ id: "s1", name: "This week" }], next_cursor: null };
    if (url.pathname === "/api/v1/tasks") {
      if (!url.searchParams.get("cursor")) {
        return {
          results: [{ id: "t1", content: "Water beds", description: "Before 9am", labels: ["garden"], priority: 4, section_id: "s1", due: { date: "2026-10-08", is_recurring: true, string: "every day" }, deadline: { date: "2026-10-31" } }],
          next_cursor: "c2.x",
        };
      }
      return { results: [{ id: "t2", content: "Buy seeds", priority: 1, due: null }], next_cursor: null };
    }
    if (url.pathname === "/api/v1/tasks/completed/by_completion_date") return { items: [{ id: "t3", content: "Turn compost", priority: 2, completed_at: "2026-10-01T10:00:00Z" }], next_cursor: null };
    return undefined;
  });
  const ctx = context({ token: "todo-token", via: "token" }, fetch);
  const containers: ImportContainer[] = await todoistSource.listContainers(ctx);
  assert.deepEqual(containers.map((container) => container.name), ["Garden"]);
  const items = await collect(todoistSource.fetchItems(ctx, containers));
  assert.equal(calls[0]!.headers.Authorization, "Bearer todo-token");
  assert.deepEqual(items.map((item) => item.title), ["Water beds", "Buy seeds", "Turn compost"]);
  const water = items[0]!;
  assert.equal(water.dueDate, "2026-10-31");
  assert.equal(water.startDate, "2026-10-08");
  assert.deepEqual(water.labels, ["garden", "This week"]);
  assert.equal(mapPriority(water.priority), "p0");
  assert.match(water.description!, /Repeats: every day/);
  assert.equal(mapPriority(items[1]!.priority), "p1");
  assert.equal(items[2]!.done, true);
  assert.equal(items[2]!.completedAt, "2026-10-01T10:00:00Z");
});

test("Markdown converters handle empty and odd input", () => {
  assert.equal(adfToMarkdown(null), "");
  assert.equal(adfToMarkdown("plain text"), "plain text");
  assert.equal(notionBlocksToMarkdown([]), "");
  assert.equal(
    notionBlocksToMarkdown([
      { type: "numbered_list_item", numbered_list_item: { rich_text: [{ plain_text: "one" }] } },
      { type: "numbered_list_item", numbered_list_item: { rich_text: [{ plain_text: "two" }] } },
      { type: "divider", divider: {} },
      { type: "bookmark", bookmark: { url: "javascript:alert(1)" } },
    ]),
    "1. one\n2. two\n\n---\n\njavascript:alert(1)",
  );
});

const encode = (text: string) => new TextEncoder().encode(text);

test("one unzip budget covers every entry and nested zip of an upload", () => {
  const big = encode("a".repeat(600_000));
  const flat = zipSync({ "one.md": big, "two.md": big });
  assert.throws(() => safeUnzip(flat, { want: () => true, budget: unzipBudget(1_000_000), maxEntries: 10 }), (error: Error & { statusCode?: number }) => error.statusCode === 413);
  assert.equal(safeUnzip(flat, { want: () => true, budget: unzipBudget(1_300_000), maxEntries: 10 }).size, 2);
  const shared = unzipBudget(1_000_000);
  safeUnzip(zipSync({ "one.md": big }), { want: () => true, budget: shared, maxEntries: 10 });
  assert.throws(() => safeUnzip(zipSync({ "two.md": big }), { want: () => true, budget: shared, maxEntries: 10 }), /more than Ensemble imports at once/);
  // Only wanted entries are inflated, so images and the like cost nothing.
  assert.equal(safeUnzip(zipSync({ "photo.png": big, "a.md": encode("# A") }), { want: (name) => name.endsWith(".md"), budget: unzipBudget(1000), maxEntries: 10 }).size, 1);

  // Notion's wrapper zip: the outer entries and the inner zip share one budget.
  const nested = zipSync({ "Home 0f1e2d3c4b5a69788796a5b4c3d2e1f0.md": big, "Export-Part-1.zip": zipSync({ "Page 11112222333344445555666677778888.md": big }) });
  assert.equal(readNotionZip(nested, 1_300_000).size, 2);
  assert.throws(() => readNotionZip(nested, 1_000_000), (error: Error & { statusCode?: number }) => error.statusCode === 413);
});

test("page text is capped across a Notion export", () => {
  const texts = new Map([
    ["Home 0f1e2d3c4b5a69788796a5b4c3d2e1f0.md", `# Home\n\n${"word ".repeat(20)}`],
    ["Guide 11112222333344445555666677778888.md", `# Guide\n\n${"word ".repeat(20)}`],
  ]);
  assert.equal(parseNotionExport(texts, 1000).pages.length, 2);
  assert.throws(() => parseNotionExport(texts, 150), (error: Error & { statusCode?: number }) => error.statusCode === 413);
});

test("sheet ids are scoped to the sheet; vendor ids are not", () => {
  const roadmap = parseUpload("Q3 roadmap.csv", encode("ID,Title\n1,Plan launch\n"), "csv");
  const again = parseUpload("Q3 roadmap (1) 2026-10-07.csv", encode("ID,Title\n1,Plan launch\n"), "csv");
  const hiring = parseUpload("Hiring.csv", encode("ID,Title\n1,Post the role\n"), "csv");
  const idOf = (parsed: ReturnType<typeof parseUpload>) => parsed.tables[0]!.options.idNamespace;
  assert.ok(idOf(roadmap));
  assert.equal(idOf(roadmap), idOf(again), "the same export downloaded again keeps its ids");
  assert.notEqual(idOf(roadmap), idOf(hiring));
  const jira = parseUpload("Jira.csv", encode("Summary,Issue key,Issue id\nFix map,FLD-7,10007\n"), "jira");
  assert.equal(idOf(jira), undefined);
});

test("previews: one per person, a shared byte budget, one upload read at a time", async () => {
  clearPreviewsForTests();
  try {
    const file = (bytes: number) => ({ name: "tasks.csv", data: new Uint8Array(bytes), hint: "csv" as const });
    const first = savePreview({ userId: "mira", source: "csv", kind: "file", options: {}, containers: [], file: file(10) });
    const second = savePreview({ userId: "mira", source: "csv", kind: "file", options: {}, containers: [], file: file(10) });
    assert.equal(getPreview("mira", first.id), null, "a new preview replaces the older one");
    assert.ok(getPreview("mira", second.id));
    assert.equal(getPreview("theo", second.id), null);
    assert.equal(previewStats().entries, 1);

    setPreviewLimitsForTests({ totalBytes: 200_000 });
    const mira = savePreview({ userId: "mira", source: "csv", kind: "file", options: {}, containers: [], file: file(120_000) });
    assert.throws(() => assertPreviewRoom("theo", 120_000), (error: Error & { statusCode?: number }) => error.statusCode === 503);
    assert.throws(() => assertPreviewRoom("theo", 500_000), (error: Error & { statusCode?: number }) => error.statusCode === 413);
    mira.lastUsedAt = Date.now() - 10 * 60_000;
    const theo = savePreview({ userId: "theo", source: "csv", kind: "file", options: {}, containers: [], file: file(120_000) });
    assert.equal(getPreview("mira", mira.id), null, "an idle preview makes room");
    assert.ok(getPreview("theo", theo.id));
    assert.ok(previewStats().bytes <= 200_000);

    let release!: () => void;
    const held = withUploadSlot("mira", () => new Promise<void>((resolve) => (release = resolve)));
    await assert.rejects(withUploadSlot("mira", () => "second"), (error: Error & { statusCode?: number }) => error.statusCode === 429);
    assert.equal(await withUploadSlot("theo", () => "other person"), "other person");
    release();
    await held;
    assert.equal(await withUploadSlot("mira", () => "after"), "after");
  } finally {
    clearPreviewsForTests();
  }
});
