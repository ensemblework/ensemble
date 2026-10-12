import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AppItem, AppItemSourceInfo, AttachedAppItem } from "@ensemble/shared-types";
import { AttachedItems } from "./attached-items.js";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

type Call = { method: string; url: URL; body: unknown };

const TASK = "11111111-1111-4111-8111-111111111111";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const SOURCES: AppItemSourceInfo[] = [
  { id: "notion", name: "Notion", logo: "notion", kinds: ["page", "database"], people: false, comments: true },
  { id: "linear", name: "Linear", logo: "linear", kinds: ["issue", "project"], people: true, comments: true },
];

function attached(id: string, extra: Partial<AttachedAppItem> = {}): AttachedAppItem {
  return {
    artifactId: id,
    source: "notion",
    kind: "page",
    id: `page-${id}`,
    title: "Q4 plan",
    subtitle: "Fieldnote wiki",
    url: "https://www.notion.so/page-1",
    attachedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    chars: 1234,
    taskId: TASK,
    projectId: null,
    ...extra,
  };
}

async function mount(handle: (call: Call) => unknown, node: React.ReactNode = <AttachedItems taskId={TASK} />) {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url: new URL(String(input), "http://localhost"), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (call.url.pathname === "/api/shell") return json({ user: { name: "Mira Chen" } });
    const answer = handle(call);
    if (answer instanceof Response) return answer;
    if (answer !== undefined) return json(answer);
    return json({ error: `not mocked: ${call.method} ${call.url.pathname}` }, 404);
  }) as typeof fetch;
  // gcTime Infinity: no garbage-collection timers left behind to keep the test process alive.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return {
    calls,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
    },
  };
}

const text = () => document.body.textContent ?? "";
const section = () => document.querySelector<HTMLElement>('[data-testid="attached-items"]');
const row = (id: string) => document.querySelector<HTMLElement>(`[data-attached="${id}"]`);

async function waitFor(check: () => boolean, label: string, timeout = 3000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}; page says: ${text().slice(0, 500)}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
}

function button(label: RegExp, root: ParentNode = document): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll("button")).find((node) => label.test((node.textContent ?? "").trim()) || label.test(node.getAttribute("aria-label") ?? ""));
  assert.ok(found, `Missing button ${label}; page says: ${text().slice(0, 400)}`);
  return found as HTMLButtonElement;
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test("lists attached items, refreshes one and removes another", async () => {
  let items = [attached("a1"), attached("a2", { source: "linear", kind: "issue", id: "ENG-42", title: "Fix the export", subtitle: "Field · In Progress", url: undefined, chars: 380 })];
  const view = await mount((call) => {
    const path = call.url.pathname;
    if (path === "/api/app-items/sources") return { sources: SOURCES };
    if (path === "/api/app-items/attached" && call.method === "GET") return { items };
    if (path === "/api/app-items/attached/a1/refresh") return { item: { ...items[0]!, chars: 2000 } };
    if (path === "/api/app-items/attached/a2" && call.method === "DELETE") {
      items = items.filter((item) => item.artifactId !== "a2");
      return new Response(null, { status: 204 });
    }
    if (path === "/api/app-items/update-target") return { target: null };
    return undefined;
  });
  try {
    await waitFor(() => Boolean(row("a1")), "the attached items");
    const listed = view.calls.find((call) => call.url.pathname === "/api/app-items/attached")!;
    assert.equal(listed.url.searchParams.get("taskId"), TASK);
    assert.match(text(), /From your apps/);
    assert.match(text(), /The assistant and agents working on this task read these\./);
    assert.match(row("a1")!.textContent ?? "", /Q4 plan/);
    assert.match(row("a1")!.textContent ?? "", /Page · Fieldnote wiki · added 2 h ago · 1,234 characters kept/);
    assert.equal(row("a1")!.querySelector("a")?.getAttribute("href"), "https://www.notion.so/page-1");
    assert.equal(row("a2")!.querySelector("a"), null, "no link when the app gave none");
    assert.match(row("a2")!.textContent ?? "", /Issue · Field · In Progress/);

    await click(button(/^Refresh Q4 plan$/, row("a1")!));
    assert.ok(view.calls.some((call) => call.method === "POST" && call.url.pathname === "/api/app-items/attached/a1/refresh"));

    await click(button(/^Remove Fix the export$/, row("a2")!));
    const removed = view.calls.find((call) => call.method === "DELETE")!;
    assert.equal(removed.url.pathname, "/api/app-items/attached/a2");
    assert.equal(removed.url.searchParams.get("taskId"), TASK);
    await waitFor(() => !row("a2"), "the removed row to go");
    assert.ok(row("a1"));
  } finally {
    await view.done();
  }
});

test("empty, it is just the add button; picking an item attaches it to the project", async () => {
  const PROJECT = "22222222-2222-4222-8222-222222222222";
  const PLAN: AppItem = { source: "notion", kind: "page", id: "page-9", title: "Launch brief", subtitle: "Fieldnote wiki" };
  let items: AttachedAppItem[] = [];
  const view = await mount(
    (call) => {
      const path = call.url.pathname;
      if (path === "/api/app-items/sources") return { sources: SOURCES };
      if (path === "/api/app-items/attached") return { items };
      if (path === "/api/app-items/search") return { items: [PLAN], errors: [] };
      if (path === "/api/app-items/attach") {
        const item = attached("a9", { ...PLAN, taskId: null, projectId: PROJECT });
        items = [item];
        return { item };
      }
      return undefined;
    },
    <AttachedItems projectId={PROJECT} />,
  );
  try {
    await waitFor(() => view.calls.some((call) => call.url.pathname === "/api/app-items/attached"), "the attached list");
    assert.equal(view.calls.find((call) => call.url.pathname === "/api/app-items/attached")!.url.searchParams.get("projectId"), PROJECT);
    assert.doesNotMatch(section()!.textContent ?? "", /read these/);
    assert.equal((section()!.textContent ?? "").trim(), "Add from apps…");

    await click(button(/^Add from apps…$/));
    await waitFor(() => Boolean(document.querySelector('[data-app-item="notion:page:page-9"]')), "the picker results");
    assert.match(text(), /kept as text with this project/);
    await click(button(/^Attach$/, document.querySelector<HTMLElement>('[data-app-item="notion:page:page-9"]')!));
    const attach = view.calls.find((call) => call.url.pathname === "/api/app-items/attach")!;
    assert.deepEqual(attach.body, { source: "notion", kind: "page", id: "page-9", projectId: PROJECT });
    await waitFor(() => Boolean(row("a9")), "the attached row");
    assert.match(text(), /The assistant and agents working on this project read these\./);
  } finally {
    await view.done();
  }
});
