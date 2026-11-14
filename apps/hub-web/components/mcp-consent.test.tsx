import { setTestUrl } from "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { McpConsent } from "./mcp-consent.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
const id = `ens_oauth_request_${"x".repeat(43)}`;
const info = {
  csrf: `ens_oauth_csrf_${"y".repeat(43)}`, clientName: "Example Agent", clientOrigin: "https://client.example.test",
  clientMetadataOrigin: null, accountEmail: "mira@example.test", expiresAt: "2026-11-14T06:00:00Z",
  canWrite: true, canUseApps: true, spaces: [{ id: "home", name: "Home" }, { id: "side", name: "Side" }],
};

const json = (value: unknown, status = 200) => Response.json(value, { status });
const tick = () => new Promise(resolve => setTimeout(resolve, 15));

test("consent shows the destination, preserves explicit read-only grants and the chosen space, and redirects after approval", async () => {
  setTestUrl(`http://localhost/oauth?request=${id}`);
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path === `/api/mcp-oauth/consent?request=${id}`) return json(info);
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return json({ redirect: `${window.location.href}#connected` });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><McpConsent initialRequest={id} /></QueryClientProvider>); await tick(); });
    await act(tick);
    assert.match(host.textContent ?? "", /Example Agent/);
    assert.match(host.textContent ?? "", /https:\/\/client\.example\.test/);
    assert.match(host.textContent ?? "", /mira@example\.test/);
    const changes = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Allow this app to make changes"]');
    const apps = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Allow use of your connected apps"]');
    const space = host.querySelector<HTMLSelectElement>("#mcp-start-space");
    assert.ok(changes && apps && space);
    await act(async () => {
      changes.click(); apps.click(); space.value = "side"; space.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const allow = [...host.querySelectorAll("button")].find(button => button.textContent === "Allow");
    assert.ok(allow);
    await act(async () => { allow.click(); await tick(); });
    assert.deepEqual(calls.at(-1), {
      path: "/api/mcp-oauth/consent",
      body: { request: id, csrf: info.csrf, decision: "allow", spaceId: "side", canWrite: false, canUseApps: false },
    });
    assert.equal(window.location.hash, "#connected");
    assert.match(host.textContent ?? "", /Returning to app/);
  } finally {
    await act(async () => root.unmount());
    host.remove(); client.clear(); globalThis.fetch = original; setTestUrl("http://localhost/");
  }
});

test("expired consent is an explicit error and never presents an approval button", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => json({ error: "This sign-in request expired. Connect the app again." }, 404);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><McpConsent initialRequest={id} /></QueryClientProvider>); await tick(); });
    await act(tick);
    assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /expired/);
    assert.equal([...host.querySelectorAll("button")].some(button => button.textContent === "Allow"), false);
  } finally {
    await act(async () => root.unmount());
    host.remove(); client.clear(); globalThis.fetch = original;
  }
});
