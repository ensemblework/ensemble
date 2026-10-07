import { CONNECTOR_CATALOG } from "@ensemble/shared-types";
import { setTestUrl } from "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectorState, McpConnection } from "@/lib/api-connectors";
import { browser } from "./connector-detail.js";
import { ConnectorStore } from "./store-dialog.js";
import { catalogWith } from "./test-fixtures.js";

(globalThis as { React?: typeof React }).React = React;

type Call = { method: string; url: string; body: unknown };
type Handler = (call: Call) => unknown | Response | undefined;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function Harness({ start, onImport }: { start: { store: string | null; connector: string | null }; onImport: (source?: string) => void }) {
  const [view, setView] = useState(start);
  const [open, setOpen] = useState(true);
  return (
    <ConnectorStore
      open={open}
      category={view.store}
      connectorId={view.connector}
      onNavigate={setView}
      onClose={() => setOpen(false)}
      onImport={onImport}
    />
  );
}

async function mount({
  states = {},
  mcp = [],
  start = { store: "all", connector: null },
  handle,
}: {
  states?: Record<string, Partial<ConnectorState>>;
  mcp?: McpConnection[];
  start?: { store: string | null; connector: string | null };
  handle?: Handler;
}) {
  setTestUrl("http://localhost/settings?tab=connections");
  const calls: Call[] = [];
  const assigned: string[] = [];
  const imports: Array<string | undefined> = [];
  const realFetch = globalThis.fetch;
  const realAssign = browser.assign;
  browser.assign = (url) => void assigned.push(url);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const custom = handle?.(call);
    if (custom instanceof Response) return custom;
    if (custom !== undefined) return json(custom);
    if (url === "/api/connectors/catalog") return json({ entries: catalogWith(states) });
    if (url === "/api/mcp-connections" && call.method === "GET") return json({ connections: mcp });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  // gcTime Infinity: no garbage-collection timers left behind to keep the test process alive.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Harness start={start} onImport={(source) => imports.push(source)} />
      </QueryClientProvider>,
    );
  });
  await settle();
  return {
    calls,
    assigned,
    imports,
    dialog: () => document.querySelector<HTMLElement>('[data-testid="connector-store"]'),
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
      browser.assign = realAssign;
      setTestUrl("http://localhost/");
    },
  };
}

const cards = () => Array.from(document.querySelectorAll<HTMLElement>("[data-store-card]")).map((node) => node.dataset.storeCard);

function button(label: RegExp, root: ParentNode = document): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll("button")).find((node) => label.test((node.textContent ?? "").trim()) || label.test(node.getAttribute("aria-label") ?? ""));
  assert.ok(found, `Missing button ${label}`);
  return found as HTMLButtonElement;
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(2);
}

test("the store focuses search, filters as you type, and \"/\" brings focus back", async () => {
  const view = await mount({});
  try {
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search connectors"]');
    assert.ok(search);
    assert.equal(document.activeElement, search);
    assert.ok(cards().length > 20);
    await type(search, "jira");
    assert.deepEqual(cards(), ["atlassian"]);
    await type(search, "zzzz");
    assert.ok(document.querySelector('[data-testid="store-empty"]'));
    await type(search, "");
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    });
    await settle(2);
    assert.equal(document.activeElement, search);
    assert.match(view.dialog()?.textContent ?? "", /are property of their respective owners/);
  } finally {
    await view.done();
  }
});

test("categories and Connected narrow the grid", async () => {
  const view = await mount({
    states: { notion: { connected: true, account: "mira@fieldnote.example" } },
    mcp: [{ id: "m1", serverId: null, name: "Fieldnote tools", url: "https://mcp.fieldnote.example/mcp", status: "connected", toolCount: 2, tools: [], disabledTools: [], lastError: null, updatedAt: "2026-10-07T00:00:00.000Z" }],
  });
  try {
    const nav = document.querySelector('nav[aria-label="Categories"]')!;
    await click(button(/^Connected/, nav));
    assert.deepEqual(cards().sort(), ["mcp:m1", "notion"]);
    await click(button(/^Chat/, nav));
    assert.deepEqual(cards().sort(), CONNECTOR_CATALOG.filter((entry) => entry.category === "chat").map((entry) => entry.id).sort());
    assert.ok(cards().includes("slack"));
    await click(button(/^Import/, nav));
    assert.ok(cards().includes("csv"));
    assert.ok(!cards().includes("slack"));
  } finally {
    await view.done();
  }
});

test("Notion detail: MCP, sign-in and token each call the right endpoint", async () => {
  const view = await mount({
    handle: (call) => {
      if (call.url === "/api/mcp-connections" && call.method === "POST") return { id: "m9", authorizeUrl: "https://mcp.notion.com/authorize?x=1", status: "pending" };
      if (call.url.startsWith("/api/connectors/notion/start")) return { url: "https://api.notion.com/v1/oauth/authorize?x=1" };
      if (call.url === "/api/connectors/notion/token") return { ok: true, account: "Fieldnote workspace" };
      return undefined;
    },
  });
  try {
    await click(document.querySelector<HTMLElement>('[data-store-card="notion"]')!);
    const detail = document.querySelector<HTMLElement>('[data-testid="connector-detail"]');
    assert.equal(detail?.dataset.connector, "notion");
    assert.equal(document.activeElement?.tagName, "H3");

    await click(button(/Connect tools/, detail!));
    assert.deepEqual(view.calls.at(-1), {
      method: "POST",
      url: "/api/mcp-connections",
      body: { serverId: "notion", returnTo: "/settings?tab=connections&connector=notion" },
    });
    assert.equal(view.assigned.at(-1), "https://mcp.notion.com/authorize?x=1");

    await click(button(/^Connect$/, detail!));
    const start = view.calls.at(-1)!;
    assert.equal(start.method, "GET");
    const url = new URL(start.url, "http://localhost");
    assert.equal(url.pathname, "/api/connectors/notion/start");
    assert.equal(url.searchParams.get("returnTo"), "/settings?tab=connections&connector=notion");
    assert.equal(view.assigned.at(-1), "https://api.notion.com/v1/oauth/authorize?x=1");

    await click(button(/Paste a token/, detail!));
    const form = document.querySelector<HTMLFormElement>('[data-testid="token-form"]')!;
    assert.ok(form.querySelector('a[href="https://www.notion.so/profile/integrations"]'), "links to where the token comes from");
    await type(form.querySelector<HTMLInputElement>('input[name="token"]')!, "ntn_secret_value_123");
    await click(button(/Check and connect/, form));
    assert.deepEqual(view.calls.find((call) => call.url === "/api/connectors/notion/token"), {
      method: "POST",
      url: "/api/connectors/notion/token",
      body: { token: "ntn_secret_value_123" },
    });

    await click(button(/Import…/, detail!));
    assert.equal(view.imports.at(-1), "notion");

    await click(button(/All connectors/));
    assert.ok(document.querySelector('input[aria-label="Search connectors"]'));
  } finally {
    await view.done();
  }
});

test("Jira's token form sends email, token and site", async () => {
  const view = await mount({
    start: { store: "all", connector: "atlassian" },
    states: { atlassian: { oauthReady: false } },
    handle: (call) => (call.url === "/api/connectors/atlassian/token" ? { ok: true, account: "mira@fieldnote.example" } : undefined),
  });
  try {
    await click(button(/Paste a token/));
    const form = document.querySelector<HTMLFormElement>('[data-testid="token-form"]')!;
    await type(form.querySelector<HTMLInputElement>('input[name="email"]')!, "mira@fieldnote.example");
    await type(form.querySelector<HTMLInputElement>('input[name="token"]')!, "ATATT3xFfGF0-test-token");
    await type(form.querySelector<HTMLInputElement>('input[name="site"]')!, "fieldnote.atlassian.net");
    await click(button(/Check and connect/, form));
    assert.deepEqual(view.calls.find((call) => call.url === "/api/connectors/atlassian/token")?.body, {
      email: "mira@fieldnote.example",
      token: "ATATT3xFfGF0-test-token",
      site: "fieldnote.atlassian.net",
    });
    assert.match(document.body.textContent ?? "", /not set up on this server yet/);
  } finally {
    await view.done();
  }
});

test("Google Workspace asks only for the products that are on", async () => {
  const view = await mount({
    start: { store: null, connector: "google_workspace" },
    handle: (call) => (call.url.startsWith("/api/connectors/google/start") ? { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" } : undefined),
  });
  try {
    const gmail = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Gmail"]')!;
    assert.equal(gmail.getAttribute("aria-checked"), "true");
    await click(gmail);
    await click(button(/Sign in with Google/));
    const url = new URL(view.calls.at(-1)!.url, "http://localhost");
    assert.equal(url.pathname, "/api/connectors/google/start");
    assert.equal(url.searchParams.get("products"), "calendar,drive_docs");
    assert.equal(view.assigned.at(-1), "https://accounts.google.com/o/oauth2/v2/auth?x=1");
  } finally {
    await view.done();
  }
});

test("connected suite: a product that needs consent asks before leaving, and disconnect can delete data", async () => {
  const view = await mount({
    start: { store: null, connector: "google_workspace" },
    states: {
      google_workspace: {
        connected: true,
        account: "mira@fieldnote.example",
        products: { gmail: true, calendar: true, drive_docs: true, drive_search: false },
        sources: { gmail: { enabled: true, lastSyncAt: "2026-10-07T08:00:00.000Z", lastError: null } },
      },
    },
    handle: (call) => {
      if (call.url === "/api/connectors/google_workspace/products") return { reconnect: true, url: "https://accounts.google.com/o/oauth2/v2/auth?more=1", needs: ["drive_search"] };
      if (call.url.startsWith("/api/connectors/google") && call.method === "DELETE") return { ok: true, revoked: true, deleted: 12 };
      if (call.url === "/api/connections/gmail/sync") return { ok: true, message: "Gmail synced." };
      return undefined;
    },
  });
  try {
    assert.match(document.body.textContent ?? "", /Connected as mira@fieldnote\.example/);
    await click(button(/Sync Gmail now/));
    assert.ok(view.calls.some((call) => call.method === "POST" && call.url === "/api/connections/gmail/sync"));

    await click(document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Search all of Drive"]')!);
    const put = view.calls.find((call) => call.method === "PUT")!;
    assert.equal(put.url, "/api/connectors/google_workspace/products");
    assert.deepEqual((put.body as { products: Record<string, boolean> }).products, { gmail: true, calendar: true, drive_docs: true, drive_search: true });
    assert.equal(view.assigned.length, 0, "no surprise redirect");
    await click(button(/Continue to Google/));
    assert.equal(view.assigned.at(-1), "https://accounts.google.com/o/oauth2/v2/auth?more=1");

    await click(button(/^Disconnect$/));
    const confirm = document.querySelector<HTMLElement>('[data-testid="disconnect-confirm"]')!;
    await click(confirm.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(button(/^Disconnect$/, confirm));
    assert.deepEqual(view.calls.find((call) => call.method === "DELETE"), { method: "DELETE", url: "/api/connectors/google?deleteData=1", body: null });
  } finally {
    await view.done();
  }
});

test("MCP tools can be switched off one by one", async () => {
  const connection: McpConnection = {
    id: "g1",
    serverId: "granola",
    name: "Granola",
    url: "https://mcp.granola.ai/mcp",
    status: "connected",
    toolCount: 2,
    tools: [
      { name: "list_meetings", title: "List meetings", description: "Recent meetings", readOnly: true },
      { name: "get_transcript", title: "Get transcript", description: "One transcript", readOnly: true },
    ],
    disabledTools: [],
    lastError: null,
    updatedAt: "2026-10-07T00:00:00.000Z",
  };
  const view = await mount({
    start: { store: "all", connector: "granola" },
    states: { granola: { mcp: { status: "connected", toolCount: 2, lastError: null } } },
    mcp: [connection],
    handle: (call) => (call.url === "/api/mcp-connections/g1" && call.method === "PATCH" ? { ok: true } : undefined),
  });
  try {
    await click(document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Use Get transcript"]')!);
    assert.deepEqual(view.calls.find((call) => call.method === "PATCH"), { method: "PATCH", url: "/api/mcp-connections/g1", body: { disabledTools: ["get_transcript"] } });
  } finally {
    await view.done();
  }
});

test("a custom connector posts its name and URL", async () => {
  const view = await mount({
    start: { store: "all", connector: "custom" },
    handle: (call) => (call.url === "/api/mcp-connections" && call.method === "POST" ? { id: "c1", status: "connected" } : undefined),
  });
  try {
    const form = document.querySelector<HTMLElement>('[data-testid="custom-connector"]')!;
    const name = form.querySelector<HTMLInputElement>('input[name="name"]');
    const url = form.querySelector<HTMLInputElement>('input[name="url"]');
    await type(name!, "Fieldnote tools");
    await type(url!, "http://mcp.fieldnote.example/mcp");
    assert.equal(button(/Add connector/, form).disabled, true, "plain http is refused");
    await type(url!, "https://mcp.fieldnote.example/mcp");
    await click(button(/Add connector/, form));
    assert.deepEqual(view.calls.find((call) => call.method === "POST")?.body, {
      url: "https://mcp.fieldnote.example/mcp",
      name: "Fieldnote tools",
      returnTo: "/settings?tab=connections&store=connected",
    });
  } finally {
    await view.done();
  }
});

test("a custom connector can send a token, and a refused URL is explained under the field", async () => {
  let attempt = 0;
  const view = await mount({
    start: { store: "all", connector: "custom" },
    handle: (call) => {
      if (call.url !== "/api/mcp-connections" || call.method !== "POST") return undefined;
      attempt += 1;
      if (attempt === 1) return json({ error: "That address points inside a private network.", code: "MCP_URL_REFUSED" }, 400);
      if (attempt === 2) return json({ error: "Fieldnote tools does not publish OAuth sign-in details Ensemble can use.", code: "MCP_TOKEN_REQUIRED" }, 400);
      return { id: "c2", status: "connected" };
    },
  });
  try {
    const form = document.querySelector<HTMLElement>('[data-testid="custom-connector"]')!;
    await type(form.querySelector<HTMLInputElement>('input[name="name"]')!, "Fieldnote tools");
    await type(form.querySelector<HTMLInputElement>('input[name="url"]')!, "https://mcp.fieldnote.example/mcp");
    await click(button(/Add connector/, form));
    assert.match(form.querySelector("#custom-url-help")?.textContent ?? "", /private network/);
    await click(button(/Add connector/, form));
    // The server asked for a token: the form switches to it instead of failing.
    const token = form.querySelector<HTMLInputElement>('input[name="token"]');
    assert.ok(token, "token field shown");
    assert.match(form.textContent ?? "", /does not publish OAuth sign-in details/);
    await type(token, "fn_mcp_token_123456");
    await click(button(/Add connector/, form));
    assert.deepEqual((view.calls.filter((call) => call.method === "POST").at(-1)?.body as { token?: string }).token, "fn_mcp_token_123456");
  } finally {
    await view.done();
  }
});

test("a vendor MCP server that wants a token gets a token field instead of a dead end", async () => {
  const view = await mount({
    start: { store: "all", connector: "granola" },
    handle: (call) => {
      if (call.url !== "/api/mcp-connections" || call.method !== "POST") return undefined;
      const body = call.body as { token?: string };
      return body.token ? { id: "g2", status: "connected" } : json({ error: "Granola asked for a sign-in Ensemble could not start.", code: "MCP_TOKEN_REQUIRED" }, 400);
    },
  });
  try {
    await click(button(/Connect tools/));
    const prompt = document.querySelector<HTMLFormElement>('[data-testid="mcp-token-prompt"]');
    assert.ok(prompt);
    assert.match(prompt.textContent ?? "", /asked for a sign-in/);
    await type(prompt.querySelector<HTMLInputElement>('input[type="password"]')!, "gr_token_abcdef");
    await click(button(/Connect with token/, prompt));
    assert.deepEqual(view.calls.filter((call) => call.method === "POST").at(-1)?.body, {
      serverId: "granola",
      returnTo: "/settings?tab=connections&connector=granola",
      token: "gr_token_abcdef",
    });
    assert.equal(view.assigned.length, 0);
  } finally {
    await view.done();
  }
});

test("Escape closes the store and a missing server app explains itself", async () => {
  const view = await mount({ start: { store: null, connector: "microsoft_365" }, states: { microsoft_365: { appReady: false, oauthReady: false } } });
  try {
    assert.ok(document.querySelector('[data-testid="not-set-up"]'));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle(2);
    assert.equal(view.dialog(), null);
  } finally {
    await view.done();
  }
});
