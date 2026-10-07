import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportDialog } from "./import-dialog.js";
import { RecentImports } from "./recent-imports.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

type Call = { url: string; method: string; body: unknown };

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json" } });
}

const sources = [
  { id: "linear", name: "Linear", logo: "linear", connectorId: "linear", api: true, connected: true, tokenUrl: "https://linear.app/settings/account/security", tokenHint: "Settings → Security & access → Personal API keys.", tokenFields: [], files: ["csv"], exportHelp: "In Linear: Settings → Import / export.", brings: ["Issues"] },
  { id: "csv", name: "CSV or spreadsheet", logo: "csv", connectorId: "csv", api: false, connected: false, tokenUrl: null, tokenHint: null, tokenFields: [], files: ["csv", "tsv"], exportHelp: "Any spreadsheet saved as CSV.", brings: ["Rows as tasks"] },
];

const counts = { tasks: { created: 3, updated: 0, unchanged: 0 }, pages: { created: 0, updated: 0, unchanged: 0, keptEdits: 0 }, projects: { created: 1, linked: 0 }, skipped: 0, failed: 0 };

function job(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    source: "csv",
    sourceLabel: "CSV",
    status,
    error: null,
    counts,
    progress: { phase: status === "running" ? "writing" : "finished", fetched: 3, written: status === "running" ? 1 : 3, total: 3, note: null, created: { tasks: 3, pages: 0, projects: 1 }, undone: null },
    links: { projects: [{ id: "project-1", name: "Launch" }], labels: ["Launch"], pages: [] },
    containers: [{ id: "file-1", name: "Fieldnote tasks" }],
    fileName: "Fieldnote tasks.csv",
    canUndo: status === "done",
    startedAt: "2026-10-07T09:00:00.000Z",
    finishedAt: null,
    createdAt: "2026-10-07T09:00:00.000Z",
    ...extra,
  };
}

function csvPreview() {
  return {
    previewId: "11111111-1111-4111-8111-111111111111",
    source: "csv",
    sourceLabel: "CSV",
    via: "file",
    format: "csv",
    formatLabel: "Spreadsheet",
    fileName: "Fieldnote tasks.csv",
    containers: [{ id: "file-1", name: "Fieldnote tasks", kind: "file", count: 3, importAs: "tasks" }],
    mapping: {
      fields: ["title", "due", "labels", "status", "priority", "assignee", "description", "project"],
      tables: [{ containerId: "file-1", headers: ["Task", "Due", "Tags", "Status"], preset: "generic", presetLabel: "Spreadsheet", columns: { title: ["Task"], due: ["Due"], labels: ["Tags"], status: ["Status"] } }],
      statuses: [
        { value: "In progress", count: 1, proposed: "in_progress" },
        { value: "Waiting on print", count: 1, proposed: "todo" },
      ],
    },
    samples: [{ kind: "task", containerId: "file-1", title: "Draft the grower survey", status: "In progress", due: "2026-10-20", labels: ["Research"], assignees: ["Mira Chen"], project: "Field guide", priority: "High" }],
    summary: { containers: 1, items: 3, sampled: false },
    expiresAt: "2026-10-07T09:30:00.000Z",
  };
}

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // gcTime Infinity: no garbage-collection timers left behind to keep the test process alive.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return {
    root,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
    },
  };
}

const text = () => document.body.textContent ?? "";

function button(label: RegExp): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button")).find((item) => label.test((item.textContent ?? "").trim()) || label.test(item.getAttribute("aria-label") ?? ""));
  assert.ok(found, `Missing button ${label}; page says: ${text().slice(0, 400)}`);
  return found;
}

async function click(label: RegExp, wait = 30) {
  const target = button(label);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, wait));
  });
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function waitFor(check: () => boolean, label: string, timeout = 3000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}; page says: ${text().slice(0, 500)}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

test("CSV upload: review mapping, run, see the summary and undo", async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  let polls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url === "/api/imports/sources") return json({ sources });
    if (url === "/api/imports/preview" && body instanceof FormData) return json(csvPreview());
    if (url === "/api/imports" && method === "POST") return json({ job: job("running") }, { status: 202 });
    if (url === "/api/imports/job-1") {
      polls += 1;
      return json({ job: polls > 1 ? job("done") : job("running") });
    }
    if (url === "/api/imports/job-1/undo") return json({ job: job("undone", { canUndo: false, progress: { ...job("done").progress, undone: { tasks: 3, pages: 0, projects: 1, at: "2026-10-07T09:05:00.000Z" } } }) });
    return json({ error: `not mocked: ${method} ${url}` }, { status: 404 });
  }) as typeof fetch;
  const { cleanup } = await render(<ImportDialog open onClose={() => undefined} />);
  try {
    assert.match(text(), /Where are you coming from\?/);
    assert.ok(document.body.querySelector('[role="dialog"]'));
    await click(/CSV or spreadsheet/);
    assert.match(text(), /Any spreadsheet saved as CSV/);
    assert.doesNotMatch(text(), /Paste a token/, "file-only sources do not ask for a token");

    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(input);
    assert.equal(input.accept, ".csv,.txt,.tsv,.txt");
    const file = new File(["Task,Due\nDraft,2026-10-20\n"], "Fieldnote tasks.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const upload = calls.find((call) => call.url === "/api/imports/preview")!;
    assert.ok(upload.body instanceof FormData);
    assert.equal((upload.body as FormData).get("source"), "csv");

    // One file → straight to review.
    assert.match(text(), /Check how it comes across/);
    assert.match(text(), /Draft the grower survey/);
    const statusSelect = document.body.querySelector<HTMLSelectElement>('select[aria-label="Ensemble status for Waiting on print"]');
    assert.ok(statusSelect);
    assert.equal(statusSelect.value, "todo");
    await choose(statusSelect, "blocked");

    await click(/Import 3 items/);
    const start = calls.find((call) => call.url === "/api/imports" && call.method === "POST")!;
    assert.deepEqual(start.body, {
      previewId: "11111111-1111-4111-8111-111111111111",
      containers: ["file-1"],
      statusMap: { "in progress": "in_progress", "waiting on print": "blocked" },
      importAs: { "file-1": "tasks" },
      columns: { "file-1": { title: ["Task"], due: ["Due"], labels: ["Tags"], status: ["Status"] } },
    });
    assert.match(text(), /Importing from CSV/);
    assert.ok(document.body.querySelector('[role="progressbar"]'));

    await waitFor(() => /Imported from CSV/.test(text()), "the summary");
    assert.match(text(), /3 tasks added/);
    assert.match(text(), /1 project added/);
    const links = Array.from(document.body.querySelectorAll<HTMLAnchorElement>("a")).map((link) => link.getAttribute("href"));
    assert.ok(links.includes("/board"));
    assert.ok(links.includes("/projects/project-1"));
    assert.ok(links.includes(`/board?q=${encodeURIComponent("#Launch")}`));

    await click(/^Undo this import$/);
    assert.match(text(), /removes the 3 tasks, 0 pages and 1 project/);
    await click(/^Undo import$/);
    assert.ok(calls.some((call) => call.url === "/api/imports/job-1/undo" && call.method === "POST"));
    assert.match(text(), /Removed 3 tasks, 0 pages and 1 project/);
    assert.doesNotMatch(text(), /Undo this import/);
  } finally {
    await cleanup();
    globalThis.fetch = realFetch;
  }
});

test("Connected account: choose containers, include completed, review statuses", async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url === "/api/imports/sources") return json({ sources });
    if (url === "/api/imports/preview" && body?.source === "linear") {
      return json({
        ...csvPreview(),
        previewId: "22222222-2222-4222-8222-222222222222",
        source: "linear",
        sourceLabel: "Linear",
        via: "account",
        format: null,
        formatLabel: null,
        fileName: null,
        containers: [
          { id: "mine", name: "Issues assigned to me", kind: "view", count: null, importAs: "tasks" },
          { id: "team-1", name: "Field (FLD)", kind: "team", count: 12, importAs: "tasks" },
        ],
        mapping: { fields: [], tables: [], statuses: [] },
        samples: [],
        summary: { containers: 2, items: null, sampled: false },
      });
    }
    if (url === "/api/imports/preview" && body?.previewId) {
      return json({
        ...csvPreview(),
        previewId: body.previewId,
        source: "linear",
        sourceLabel: "Linear",
        via: "account",
        containers: [{ id: "team-1", name: "Field (FLD)", kind: "team", count: 12, importAs: "tasks" }, { id: "mine", name: "Issues assigned to me", kind: "view", count: null, importAs: "tasks" }],
        mapping: { fields: [], tables: [], statuses: [{ value: "In Review", count: 4, proposed: "in_progress" }] },
        summary: { containers: 2, items: null, sampled: true },
      });
    }
    if (url === "/api/imports" && method === "POST") return json({ job: { ...job("done"), source: "linear", sourceLabel: "Linear" } }, { status: 202 });
    return json({ error: `not mocked: ${method} ${url}` }, { status: 404 });
  }) as typeof fetch;
  const { cleanup } = await render(<ImportDialog open onClose={() => undefined} initialSource="linear" />);
  try {
    assert.match(text(), /Import from Linear/);
    assert.match(text(), /Your Linear account is connected/);
    assert.match(text(), /Or paste a token/);
    await click(/Use connected account/);
    assert.deepEqual(calls.find((call) => call.url === "/api/imports/preview")!.body, { source: "linear" });
    assert.match(text(), /Choose what to import/);
    const boxes = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    assert.equal(boxes.length, 4, "select all, two containers, include completed");
    assert.ok(boxes.slice(1, 3).every((box) => box.checked), "small lists start selected");
    // Leave only the team selected and skip completed issues.
    await act(async () => {
      boxes[1]!.click();
      boxes[3]!.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(boxes[0]!.indeterminate, true);
    await click(/^Review$/);
    const refine = calls.filter((call) => call.url === "/api/imports/preview")[1]!;
    assert.deepEqual(refine.body, { previewId: "22222222-2222-4222-8222-222222222222", containers: ["team-1"], options: { includeCompleted: false } });
    assert.match(text(), /In Review/);
    assert.match(text(), /From a sample/);
    assert.doesNotMatch(text(), /Import as/, "Linear issues are always tasks");
    await click(/Import 12 items/);
    const start = calls.find((call) => call.url === "/api/imports")!;
    assert.deepEqual(start.body, {
      previewId: "22222222-2222-4222-8222-222222222222",
      containers: ["team-1"],
      statusMap: { "in review": "in_progress" },
      importAs: { "team-1": "tasks" },
      options: { includeCompleted: false },
    });
    assert.match(text(), /Imported from Linear/);
  } finally {
    await cleanup();
    globalThis.fetch = realFetch;
  }
});

test("Recent imports lists jobs with counts and expands to details", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/imports") return json({ jobs: [job("done"), { ...job("failed"), id: "job-2", error: "Linear did not accept the token." }] });
    return json({ error: "not mocked" }, { status: 404 });
  }) as typeof fetch;
  let opened = 0;
  const { cleanup } = await render(<RecentImports onImport={() => (opened += 1)} />);
  try {
    await waitFor(() => /Imported from CSV/.test(text()), "the list");
    assert.match(text(), /3 tasks added · 1 project added/);
    assert.match(text(), /The import stopped/);
    await click(/The import stopped/);
    assert.match(text(), /Linear did not accept the token/);
    await click(/Import from other apps/);
    assert.equal(opened, 1);
  } finally {
    await cleanup();
    globalThis.fetch = realFetch;
  }
});
