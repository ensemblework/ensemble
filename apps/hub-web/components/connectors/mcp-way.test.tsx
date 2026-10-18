import { setTestUrl } from "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectorState, McpConnection } from "@/lib/api-connectors";
import { statusLabel } from "./catalog-view.js";
import { browser } from "./connector-detail.js";
import { tokenPhrase } from "./mcp-way.js";
import { ConnectorStore } from "./store-dialog.js";
import { catalogWith } from "./test-fixtures.js";

(globalThis as { React?: typeof React }).React = React;

type Call = { method: string; url: string; body: unknown };

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

/** The store opened on one connector, with hub-api answered in-process. */
async function mount(connector: string, options: { states?: Record<string, Partial<ConnectorState>>; mcp?: McpConnection[]; answer?: (call: Call) => unknown } = {}) {
  setTestUrl("http://localhost/settings?tab=connections");
  const calls: Call[] = [];
  const assigned: string[] = [];
  const realFetch = globalThis.fetch;
  const realAssign = browser.assign;
  browser.assign = (url) => void assigned.push(url);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const custom = options.answer?.(call);
    if (custom !== undefined) return json(custom);
    if (url === "/api/connectors/catalog") return json({ entries: catalogWith(options.states ?? {}) });
    if (url === "/api/mcp-connections" && call.method === "GET") return json({ connections: options.mcp ?? [] });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ConnectorStore open category="all" connectorId={connector} onNavigate={() => undefined} onClose={() => undefined} onImport={() => undefined} />
      </QueryClientProvider>,
    );
  });
  await settle();
  return {
    calls,
    assigned,
    detail: () => document.querySelector<HTMLElement>('[data-testid="connector-detail"]')!,
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

function buttons(root: ParentNode, label: RegExp): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll("button")).filter((node) => label.test((node.textContent ?? "").trim()));
}

function button(root: ParentNode, label: RegExp): HTMLButtonElement {
  const [found] = buttons(root, label);
  assert.ok(found, `Missing button ${label}`);
  return found;
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

test("Hugging Face asks for an account: sign in with Hugging Face, or paste an access token", async () => {
  const view = await mount("huggingface", {
    answer: (call) => {
      if (call.url !== "/api/mcp-connections" || call.method !== "POST") return undefined;
      return (call.body as { token?: string }).token
        ? { id: "h2", status: "connected", account: "mira-chen" }
        : { id: "h1", status: "pending", authorizeUrl: "https://huggingface.co/oauth/authorize?client_id=x" };
    },
  });
  try {
    const detail = view.detail();
    assert.equal(detail.dataset.connector, "huggingface");
    assert.equal(buttons(detail, /Connect tools/).length, 0, "no anonymous connect");

    await click(button(detail, /^Sign in with Hugging Face$/));
    assert.deepEqual(view.calls.at(-1), {
      method: "POST",
      url: "/api/mcp-connections",
      body: { serverId: "huggingface", returnTo: "/settings?tab=connections&connector=huggingface" },
    });
    assert.equal(view.assigned.at(-1), "https://huggingface.co/oauth/authorize?client_id=x");

    await click(button(detail, /^Paste an access token$/));
    const form = detail.querySelector<HTMLFormElement>('[data-testid="mcp-token-form"]')!;
    assert.ok(form, "token form shown");
    assert.match(form.textContent ?? "", /Hugging Face access token/);
    assert.match(form.textContent ?? "", /A Read token is enough to search and read your models, datasets and Spaces; use Write only if you want the assistant to create repos\./);
    assert.equal(form.querySelector("a")?.getAttribute("href"), "https://huggingface.co/settings/tokens");
    await type(form.querySelector<HTMLInputElement>('input[type="password"]')!, "hf_mira_read_token_123");
    await click(button(form, /Connect with token/));
    assert.deepEqual(view.calls.filter((call) => call.method === "POST").at(-1)?.body, {
      serverId: "huggingface",
      returnTo: "/settings?tab=connections&connector=huggingface",
      token: "hf_mira_read_token_123",
    });
  } finally {
    await view.done();
  }
});

test("an anonymous Hugging Face connection shows as public data only and offers sign-in or a token", async () => {
  const connection: McpConnection = {
    id: "m-hf",
    serverId: "huggingface",
    name: "Hugging Face",
    url: "https://huggingface.co/mcp",
    status: "connected",
    auth: "none",
    account: null,
    toolCount: 2,
    tools: [
      { name: "model_search", title: null, description: "Find models.", readOnly: true },
      { name: "dataset_search", title: null, description: "Find datasets.", readOnly: true },
    ],
    disabledTools: [],
    lastError: null,
    updatedAt: "2026-10-18T00:00:00.000Z",
  };
  const view = await mount("huggingface", {
    states: { huggingface: { mcp: { status: "connected", toolCount: 2, lastError: null, auth: "none", account: null } } },
    mcp: [connection],
  });
  try {
    const detail = view.detail();
    assert.match(detail.querySelector("header")?.textContent ?? "", /Connected · public data only/);
    const panel = detail.querySelector<HTMLElement>('[data-testid="mcp-panel"]')!;
    assert.match(panel.textContent ?? "", /connected · public data only/);
    assert.match(panel.textContent ?? "", /Public data only — sign in to use your account\. 2 of 2 tools on\./);
    assert.ok(button(panel, /^Sign in with Hugging Face$/));
    assert.ok(button(panel, /^Paste an access token$/));
  } finally {
    await view.done();
  }
});

test("store labels: the account behind an MCP token, public data only, and open servers", () => {
  const entries = catalogWith({
    huggingface: { mcp: { status: "connected", toolCount: 4, lastError: null, auth: "oauth", account: "mira-chen" } },
    grain: { mcp: { status: "connected", toolCount: 1, lastError: null, auth: "none", account: null } },
    context7: { mcp: { status: "connected", toolCount: 2, lastError: null, auth: "none", account: null } },
    wispr_flow: { mcp: { status: "connected", toolCount: 6, lastError: null, auth: "oauth", account: null } },
  });
  const label = (id: string) => statusLabel(entries.find((entry) => entry.id === id)!);
  assert.equal(label("huggingface"), "Connected as mira-chen");
  assert.equal(label("grain"), "Connected · public data only");
  assert.equal(label("context7"), "Connected");
  assert.equal(label("wispr_flow"), "Connected");
  assert.equal(tokenPhrase("Hugging Face access token", "Hugging Face"), "an access token");
  assert.equal(tokenPhrase("Stripe agent API key", "Stripe"), "an agent API key");
  assert.equal(tokenPhrase("Cloudflare API token", "Cloudflare"), "an API token");
});
