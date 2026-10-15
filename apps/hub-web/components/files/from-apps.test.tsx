import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ArtifactRecord } from "@/lib/api";
import type { AppItemDetail } from "@/lib/api-files";
import { filesHref } from "@/lib/files/links";
import { bindToast } from "@/lib/toast-bus";
import { FilesScreen } from "./files-screen.js";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });

type Call = { method: string; url: URL };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

function item(id: string, kind: string, title: string, more: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return { id, kind, title, url: null, ts: hours(-2), projectId: null, repoId: null, taskId: null, metadata: {}, origin: null, ...more };
}

const ITEMS: ArtifactRecord[] = [
  item("a1", "email", "Site visit photos", { origin: { app: "gmail", label: "Gmail" }, url: "https://mail.google.com/mail/u/0/#all/t1", metadata: { source: "gmail" } }),
  item("a2", "event", "Fieldnote standup", { origin: { app: "google_calendar", label: "Google Calendar" }, ts: hours(30), metadata: { source: "google" } }),
  item("a3", "pr", "Add the offline photo queue", { origin: { app: "github", label: "GitHub" }, ts: hours(-5) }),
  item("a4", "file", "Field guide", { origin: { app: "notion", label: "Notion" }, ts: hours(-8), metadata: { via: "app-item", source: "notion", itemKind: "page" } }),
];

function detail(row: ArtifactRecord, more: Partial<AppItemDetail> = {}): AppItemDetail {
  return { ...row, text: "", participants: [], authoredByMe: false, documentId: null, ...more };
}

const DETAILS: Record<string, AppItemDetail> = {
  a1: detail(ITEMS[0]!, {
    text: "Hi Mira,\nthe photos from the Fieldnote visit are in the shared folder.",
    participants: [{ name: "Arjun Rao", email: "arjun@fieldnote.example" }],
    metadata: { source: "gmail", from: "Arjun Rao <arjun@fieldnote.example>", to: "mira@fieldnote.example" },
  }),
  a4: detail(ITEMS[3]!, { text: "# Field guide\n\n- **Bring** a spare battery", metadata: { via: "app-item", source: "notion", itemKind: "page", facts: { Status: "Published" } } }),
};

/** The page's address as state, the way app/(hub)/files/page.tsx passes it in. */
function Routed({ start, visited }: { start: string; visited: string[] }) {
  const [href, setHref] = useState(start);
  const url = new URL(href, "http://localhost");
  const view = url.pathname === "/files" && url.searchParams.get("view") === "apps" ? "apps" : "files";
  return (
    <FilesScreen
      view={view}
      item={url.searchParams.get("item")}
      navigate={(next) => {
        visited.push(next);
        setHref(next);
      }}
    />
  );
}

async function mount(start: string, handle: (call: Call) => unknown) {
  const calls: Call[] = [];
  const visited: string[] = [];
  const toasts: Array<{ text: string; tone?: string }> = [];
  bindToast((text, options) => void toasts.push({ text, tone: options?.tone }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url: new URL(String(input), "http://localhost") };
    calls.push(call);
    const answer = handle(call);
    if (answer instanceof Response) return answer;
    if (answer !== undefined) return json(answer);
    return json({ error: `not mocked: ${call.method} ${call.url.pathname}` }, 404);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Routed start={start} visited={visited} />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return {
    calls,
    visited,
    toasts,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
      bindToast(null);
    },
  };
}

const text = () => document.body.textContent ?? "";

async function waitFor(check: () => boolean, label: string, timeout = 3000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}; page says: ${text().slice(0, 600)}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
}

function button(label: RegExp): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((node) => label.test((node.textContent ?? "").trim()) || label.test(node.getAttribute("aria-label") ?? ""));
  assert.ok(found, `Missing button ${label}; page says: ${text().slice(0, 400)}`);
  return found as HTMLButtonElement;
}

async function click(node: Element) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const COUNTS = [
  { kind: "email", count: 1 },
  { kind: "event", count: 1 },
  { kind: "pr", count: 1 },
  { kind: "file", count: 1 },
];

/** GET /api/artifacts as routes/context.ts answers it, filtered by kind and q. */
function listing(call: Call, rows: ArtifactRecord[] = ITEMS, counts = COUNTS) {
  const kind = call.url.searchParams.get("kind");
  const q = call.url.searchParams.get("q")?.toLowerCase();
  const artifacts = rows.filter((row) => (!kind || row.kind === kind) && (!q || row.title.toLowerCase().includes(q)));
  return { artifacts, counts, sync: [], nextCursor: null };
}

const rows = () => Array.from(document.querySelectorAll("[data-app-item]")).map((node) => node.getAttribute("data-app-item"));

test("Files loads only stored files and never automatically reads connected items", async () => {
  const view = await mount("/files", (call) => {
    if (call.url.pathname === "/api/documents") return { files: [], usage: { count: 0, bytes: 0, maxCount: null, maxBytes: null, maxFileBytes: 1 } };
    return undefined;
  });
  try {
    await waitFor(() => view.calls.some((call) => call.url.pathname === "/api/documents"), "the library");
    assert.equal(document.querySelector('[role="tab"]'), null);
    assert.equal(view.calls.some((call) => call.url.pathname === "/api/artifacts"), false);
    assert.doesNotMatch(text(), /From your apps/);
  } finally { await view.done(); }
});

test("items show their kind, app and date; the kind chips and search ask the server", async () => {
  const view = await mount("/files?view=apps", (call) => (call.url.pathname === "/api/artifacts" ? listing(call) : undefined));
  try {
    await waitFor(() => rows().length === 4, "the items");
    assert.deepEqual(rows(), ["a1", "a2", "a3", "a4"]);
    const mail = document.querySelector('[data-app-item="a1"]')!;
    assert.match(mail.textContent ?? "", /Site visit photos/);
    assert.match(mail.textContent ?? "", /Email · Gmail · 2 h ago/);
    assert.equal(mail.querySelector("[data-brand]")?.getAttribute("data-brand"), "gmail");
    assert.match(document.querySelector('[data-app-item="a4"]')?.textContent ?? "", /Page · Notion/, "an attached item says what it is in its app");
    assert.doesNotMatch(document.querySelector('[data-app-item="a2"]')?.textContent ?? "", /ago/, "an event shows its day and time");

    await click(button(/^Pull requests/));
    await waitFor(() => rows().length === 1, "the pull requests");
    assert.deepEqual(rows(), ["a3"]);
    assert.equal(view.calls.at(-1)?.url.searchParams.get("kind"), "pr");
    await click(button(/^All/));
    await waitFor(() => rows().length === 4, "every item again");

    const search = document.querySelector<HTMLInputElement>('[aria-label="Search items from your apps"]')!;
    assert.ok(search.classList.contains("search-line"), "the field draws no ring of its own inside the box");
    await type(search, "standup");
    await waitFor(() => rows().length === 1, "the search");
    assert.equal(view.calls.at(-1)?.url.searchParams.get("q"), "standup");
  } finally {
    await view.done();
  }
});

test("an item opens in the reader with its facts, people and text, and a link to it in its app", async () => {
  const view = await mount("/files?view=apps", (call) => {
    if (call.url.pathname === "/api/artifacts") return listing(call);
    const id = call.url.pathname.match(/^\/api\/artifacts\/(.+)$/)?.[1];
    if (id && DETAILS[id]) return { artifact: DETAILS[id] };
    return undefined;
  });
  try {
    await waitFor(() => rows().length === 4, "the items");
    await click(document.querySelector('[data-app-item="a1"]')!);
    assert.deepEqual(view.visited, ["/files?view=apps&item=a1"]);
    await waitFor(() => Boolean(document.querySelector("[data-app-item-text]")), "the reader");
    const reader = document.querySelector('[data-app-item-reader="a1"]')!;
    assert.match(reader.textContent ?? "", /FromArjun Rao <arjun@fieldnote\.example>/);
    assert.match(reader.textContent ?? "", /Tomira@fieldnote\.example/);
    assert.match(reader.querySelector("[data-app-item-text]")?.textContent ?? "", /photos from the Fieldnote visit/);
    const open = Array.from(reader.querySelectorAll("a")).find((link) => /Open in Gmail/.test(link.textContent ?? ""));
    assert.equal(open?.getAttribute("href"), "https://mail.google.com/mail/u/0/#all/t1");
    assert.equal(document.querySelector('[data-app-item="a1"]')?.getAttribute("aria-current"), "true");

    await click(document.querySelector('[data-app-item="a4"]')!);
    await waitFor(() => Boolean(document.querySelector('[data-app-item-reader="a4"] [data-app-item-text] strong')), "the page as markdown");
    assert.match(document.querySelector('[data-app-item-reader="a4"]')?.textContent ?? "", /StatusPublished/);

    await click(button(/^Close$/));
    assert.equal(view.visited.at(-1), "/files?view=apps");
    assert.equal(document.querySelector("[data-app-item-reader]"), null);
  } finally {
    await view.done();
  }
});

test("Remove asks first, removes the item and refreshes the list", async () => {
  let listed = ITEMS;
  const view = await mount("/files?view=apps&item=a1", (call) => {
    if (call.url.pathname === "/api/artifacts") return listing(call, listed);
    if (call.url.pathname === "/api/artifacts/a1" && call.method === "DELETE") {
      listed = ITEMS.filter((row) => row.id !== "a1");
      return new Response(null, { status: 204 });
    }
    if (call.url.pathname === "/api/artifacts/a1") return { artifact: DETAILS.a1 };
    return undefined;
  });
  try {
    await waitFor(() => Boolean(document.querySelector("[data-app-item-text]")), "the reader");
    await click(button(/^Remove$/));
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent ?? "", /Remove this item\?/);
    assert.match(dialog.textContent ?? "", /syncing Gmail will not bring it back\. It stays in Gmail\./);
    assert.ok(!view.calls.some((call) => call.method === "DELETE"), "nothing is removed before you confirm");
    await click(Array.from(dialog.querySelectorAll("button")).find((node) => /Remove/.test(node.textContent ?? ""))!);
    await waitFor(() => view.toasts.some((toast) => toast.text === "Removed Site visit photos."), "the toast");
    assert.equal(view.calls.filter((call) => call.method === "DELETE").map((call) => call.url.pathname).join(), "/api/artifacts/a1");
    assert.equal(view.visited.at(-1), "/files?view=apps", "the reader closes");
    await waitFor(() => rows().length === 3, "the refreshed list");
    assert.ok(!rows().includes("a1"));
  } finally {
    await view.done();
  }
});

test("more items load a page at a time", async () => {
  const many = Array.from({ length: 3 }, (_, index) => item(`p${index}`, "issue", `Issue ${index}`, { ts: hours(-index - 1) }));
  const view = await mount("/files?view=apps", (call) => {
    if (call.url.pathname !== "/api/artifacts") return undefined;
    const counts = [{ kind: "issue", count: 3 }];
    return call.url.searchParams.get("before") === "cursor-1"
      ? { artifacts: many.slice(2), counts, sync: [], nextCursor: null }
      : { artifacts: many.slice(0, 2), counts, sync: [], nextCursor: "cursor-1" };
  });
  try {
    await waitFor(() => rows().length === 2, "the first page");
    await click(button(/^Show more$/));
    await waitFor(() => rows().length === 3, "the next page");
    assert.deepEqual(rows(), ["p0", "p1", "p2"]);
    assert.ok(!Array.from(document.querySelectorAll("button")).some((node) => /Show more/.test(node.textContent ?? "")), "nothing left to load");
  } finally {
    await view.done();
  }
});

test("with nothing yet, the owner is pointed to Connections and a guest is not", async () => {
  const empty = { artifacts: [], counts: [], sync: [], nextCursor: null };
  const owner = await mount("/files?view=apps", (call) => (call.url.pathname === "/api/artifacts" ? empty : undefined));
  try {
    await waitFor(() => /Nothing from your apps yet/.test(text()), "the empty state");
    assert.match(text(), /Mail, calendar events, docs and messages from your connected apps appear here/);
    assert.equal(Array.from(document.querySelectorAll("a")).find((link) => /Connections/.test(link.textContent ?? ""))?.getAttribute("href"), "/settings?tab=connections");
  } finally {
    await owner.done();
  }
  const guest = await mount("/files?view=apps", (call) => {
    if (call.url.pathname === "/api/shell") return { user: { id: "u2", name: "Ben Ortiz" }, space: { id: "s1", name: "Mira's space", icon: null, primary: true, shared: { owner: { id: "u1", name: "Mira Chen" }, role: "viewer" } } };
    if (call.url.pathname === "/api/artifacts") return empty;
    return undefined;
  });
  try {
    await waitFor(() => /Nothing from your apps yet/.test(text()) && guest.calls.some((call) => call.url.pathname === "/api/shell"), "the guest's empty state");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    assert.ok(!Array.from(document.querySelectorAll("a")).some((link) => /Connections/.test(link.textContent ?? "")), "no connect action in someone else's space");
  } finally {
    await guest.done();
  }
});

test("a guest reads an item but has no Remove; an uploaded file's text opens the file", async () => {
  const guest = await mount("/files?view=apps&item=a1", (call) => {
    if (call.url.pathname === "/api/shell") return { user: { id: "u2", name: "Ben Ortiz" }, space: { id: "s1", name: "Mira's space", icon: null, primary: true, shared: { owner: { id: "u1", name: "Mira Chen" }, role: "editor" } } };
    if (call.url.pathname === "/api/artifacts") return listing(call);
    if (call.url.pathname === "/api/artifacts/a1") return { artifact: DETAILS.a1 };
    return undefined;
  });
  try {
    await waitFor(() => Boolean(document.querySelector("[data-app-item-text]")) && guest.calls.some((call) => call.url.pathname === "/api/shell"), "the reader");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    assert.ok(!Array.from(document.querySelectorAll("button")).some((node) => (node.textContent ?? "").trim() === "Remove"));
  } finally {
    await guest.done();
  }
  const upload = await mount("/files?view=apps&item=t1", (call) => {
    if (call.url.pathname === "/api/artifacts") return listing(call);
    if (call.url.pathname === "/api/artifacts/t1") return { artifact: detail(item("t1", "file", "Visit notes.md"), { documentId: "doc-1" }) };
    if (call.url.pathname === "/api/documents") return { files: [], usage: { count: 0, bytes: 0, maxCount: null, maxBytes: null, maxFileBytes: 1 } };
    return undefined;
  });
  try {
    await waitFor(() => upload.visited.includes("/files/doc-1"), "the file's own screen");
  } finally {
    await upload.done();
  }
});
