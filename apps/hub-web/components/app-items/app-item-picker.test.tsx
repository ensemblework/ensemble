import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AppItem, AppItemSourceInfo } from "@ensemble/shared-types";
import { AppItemPicker } from "./app-item-picker.js";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

type Call = { method: string; url: URL; body: unknown };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const SOURCES: AppItemSourceInfo[] = [
  { id: "notion", name: "Notion", logo: "notion", kinds: ["page", "database"], people: false, comments: true },
  { id: "github", name: "GitHub", logo: "github", kinds: ["repo", "issue", "pull_request"], people: true, comments: true },
];

const PLAN: AppItem = { source: "notion", kind: "page", id: "page-1", title: "Q4 plan", subtitle: "Fieldnote wiki", url: "https://www.notion.so/page-1" };
const ISSUE: AppItem = { source: "github", kind: "issue", id: "fieldnote/web#42", title: "Grower survey export", subtitle: "fieldnote/web · open · #42", url: "https://github.com/fieldnote/web/issues/42" };
const REPO: AppItem = { source: "github", kind: "repo", id: "fieldnote/web", title: "fieldnote/web", subtitle: "private · TypeScript" };

async function mount(node: React.ReactNode, handle: (call: Call) => unknown) {
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
    searches: () => calls.filter((call) => call.url.pathname === "/api/app-items/search").map((call) => Object.fromEntries(call.url.searchParams)),
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
    },
  };
}

const text = () => document.body.textContent ?? "";

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

const row = (id: string) => document.querySelector<HTMLElement>(`[data-app-item="${id}"]`);

async function click(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(target: HTMLElement, name: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const searchBox = () => document.querySelector<HTMLInputElement>('input[type="search"]')!;

test("lists recent items from every app, notes an app that failed, and Attach hands the item over", async () => {
  const picked: AppItem[] = [];
  const view = await mount(
    <AppItemPicker open onClose={() => undefined} actionLabel="Attach" doneLabel="Attached" onPick={(item) => void picked.push(item)} />,
    (call) => {
      if (call.url.pathname === "/api/app-items/sources") return { sources: SOURCES };
      if (call.url.pathname === "/api/app-items/search") return { items: [PLAN, ISSUE], errors: [{ source: "github", message: "GitHub did not answer in time." }] };
      return undefined;
    },
  );
  try {
    await waitFor(() => Boolean(row("notion:page:page-1")), "the results");
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.ok(document.activeElement === searchBox(), "the search box has focus");
    assert.deepEqual(view.searches()[0], { limit: "10" }, "an empty search asks every app for recent items");
    assert.match(text(), /Recent in your apps/);
    assert.match(row("github:issue:fieldnote/web#42")!.textContent ?? "", /Issue · fieldnote\/web · open · #42/);
    assert.match(text(), /GitHub:\s*GitHub did not answer in time\./);
    const open = row("notion:page:page-1")!.querySelector<HTMLAnchorElement>("a")!;
    assert.equal(open.getAttribute("href"), "https://www.notion.so/page-1");
    assert.equal(open.getAttribute("target"), "_blank");

    await click(button(/^Attach$/, row("notion:page:page-1")!));
    assert.deepEqual(picked, [PLAN]);
    assert.match(row("notion:page:page-1")!.textContent ?? "", /Attached/);
    assert.equal(button(/Attached/, row("notion:page:page-1")!).disabled, true);
  } finally {
    await view.done();
  }
});

test("typing searches after a pause, app chips narrow it, arrows and Enter pick, Preview reads the item", async () => {
  const picked: AppItem[] = [];
  const view = await mount(
    <AppItemPicker open onClose={() => undefined} actionLabel="Attach" onPick={(item) => void picked.push(item)} />,
    (call) => {
      if (call.url.pathname === "/api/app-items/sources") return { sources: SOURCES };
      if (call.url.pathname === "/api/app-items/search") {
        const source = call.url.searchParams.get("source");
        return { items: source === "notion" ? [PLAN] : [ISSUE, PLAN], errors: [] };
      }
      if (call.url.pathname === "/api/app-items/read") return { item: { ...PLAN, text: `# Q4 plan\n\n${"Ship the survey. ".repeat(80)}`, facts: { Status: "Draft" } } };
      return undefined;
    },
  );
  try {
    await waitFor(() => Boolean(row("github:issue:fieldnote/web#42")), "recent items");
    await type(searchBox(), "launch");
    await waitFor(() => view.searches().some((params) => params.q === "launch"), "a search for the typed words");
    assert.match(text(), /Results/);

    await click(button(/^Notion$/, document.querySelector('[aria-label="Apps"]')!));
    await waitFor(() => view.searches().some((params) => params.source === "notion" && params.q === "launch"), "a Notion-only search");
    assert.equal(searchBox().getAttribute("placeholder"), "Search Notion, or paste a link");
    await waitFor(() => !row("github:issue:fieldnote/web#42"), "only Notion results");

    await click(button(/^All apps$/));
    await waitFor(() => Boolean(row("github:issue:fieldnote/web#42")), "every app again");
    await key(searchBox(), "ArrowDown");
    const second = row("notion:page:page-1")!;
    assert.equal(second.getAttribute("aria-selected"), "true");
    assert.equal(searchBox().getAttribute("aria-activedescendant"), second.id);
    await key(searchBox(), "Enter");
    assert.deepEqual(picked, [PLAN]);

    await click(button(/^Preview$/, second));
    await waitFor(() => Boolean(document.querySelector('[data-testid="app-item-preview"] p:last-child')), "the preview");
    const read = view.calls.find((call) => call.url.pathname === "/api/app-items/read")!;
    assert.deepEqual(read.body, { source: "notion", kind: "page", id: "page-1" });
    const preview = document.querySelector('[data-testid="app-item-preview"]')!.textContent ?? "";
    assert.match(preview, /Status: Draft/);
    assert.ok(preview.endsWith("…"), "long text is cut");
    assert.ok(preview.length < 900);
  } finally {
    await view.done();
  }
});

test("a source and kind filter searches only that, and a failed pick shows why", async () => {
  const view = await mount(
    <AppItemPicker
      open
      onClose={() => undefined}
      title="Pick a GitHub repository"
      sources={["github"]}
      kinds={["repo"]}
      actionLabel="Use this repo"
      onPick={() => {
        throw new Error("GitHub is not connected. Connect it in Settings → Connections.");
      }}
    />,
    (call) => {
      if (call.url.pathname === "/api/app-items/sources") return { sources: SOURCES };
      if (call.url.pathname === "/api/app-items/search") return { items: [REPO, ISSUE], errors: [] };
      return undefined;
    },
  );
  try {
    await waitFor(() => Boolean(row("github:repo:fieldnote/web")), "the repository");
    assert.equal(document.querySelector('[aria-label="Apps"]'), null, "no app chips for a single app");
    assert.equal(document.querySelector('select[aria-label="Kind"]'), null, "no kind filter for a single kind");
    assert.deepEqual(view.searches()[0], { source: "github", kind: "repo", limit: "20" });
    assert.equal(row("github:issue:fieldnote/web#42"), null, "other kinds are left out");
    await click(button(/^Use this repo$/));
    const alert = document.querySelector('[data-testid="app-item-picker"] [role="alert"]');
    assert.match(alert?.textContent ?? "", /Connect it in Settings → Connections/);
    assert.equal(alert?.querySelector("a")?.getAttribute("href"), "/settings?tab=connections");
  } finally {
    await view.done();
  }
});

test("with nothing connected it points to Settings → Connections", async () => {
  const view = await mount(<AppItemPicker open onClose={() => undefined} actionLabel="Attach" onPick={() => undefined} />, (call) =>
    call.url.pathname === "/api/app-items/sources" ? { sources: [] } : undefined,
  );
  try {
    await waitFor(() => Boolean(document.querySelector('[data-testid="app-items-none"]')), "the empty state");
    assert.match(text(), /Nothing to pick from yet/);
    assert.match(text(), /Notion, GitHub, Linear/);
    const link = document.querySelector<HTMLAnchorElement>('[data-testid="app-items-none"] a')!;
    assert.equal(link.getAttribute("href"), "/settings?tab=connections");
    assert.ok(document.activeElement === link, "the Settings link has focus");
    assert.equal(view.searches().length, 0, "nothing to search");
  } finally {
    await view.done();
  }
  const github = await mount(<AppItemPicker open onClose={() => undefined} sources={["github"]} actionLabel="Use this repo" onPick={() => undefined} />, (call) =>
    call.url.pathname === "/api/app-items/sources" ? { sources: [SOURCES[0]] } : undefined,
  );
  try {
    await waitFor(() => /Connect GitHub first/.test(text()), "the GitHub empty state");
  } finally {
    await github.done();
  }
});
