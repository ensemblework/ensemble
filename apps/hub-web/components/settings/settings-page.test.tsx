import { setTestUrl } from "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Settings } from "@ensemble/shared-types";
import { catalogWith } from "../connectors/test-fixtures.js";
import SettingsPage from "../../app/(hub)/settings/page.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
// The Account tab's appearance and motion pieces read media queries.
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }),
});

const SETTINGS = Settings.parse({ email: "mira@fieldnote.example", timezone: "Europe/London" });

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  }
}

/** Waits for a lazily loaded tab to show something. */
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await settle(1);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function mount(url: string) {
  setTestUrl(url);
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === "/api/settings") return json({ settings: SETTINGS });
    if (path === "/api/connectors/catalog") return json({ entries: catalogWith({ github: { connected: true, account: "mira-chen" } }) });
    if (path === "/api/model-keys") return json({ credentials: [{ provider: "google", source: "you", hint: "…a1b2", updatedAt: null }] });
    if (path === "/api/models") return json({ providers: [], runtime: true, updatedAt: "2026-10-07T00:00:00.000Z" });
    if (path === "/api/watchers") return json({ watchers: [] });
    if (path === "/api/connections") return json({ connections: [], lastFetch: null });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>,
    );
  });
  await settle();
  return {
    host,
    calls,
    selected: () => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "",
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
      setTestUrl("http://localhost/");
    },
  };
}

test("an old #models link opens the Assistant tab and writes the tab into the address", async () => {
  const view = await mount("http://localhost/settings#models");
  try {
    assert.match(view.selected(), /^Assistant/);
    assert.equal(new URL(window.location.href).searchParams.get("tab"), "assistant");
    assert.equal(window.location.hash, "#models");
    await until(() => Boolean(document.getElementById("models")), "the Models card");
    assert.match(document.getElementById("models")!.textContent ?? "", /Which model each tier uses/);
    // Watchers stay hidden while there are none.
    assert.equal(document.getElementById("watchers"), null);
  } finally {
    await view.done();
  }
});

test("tabs switch by click and arrow keys, and every tab is a real link", async () => {
  const view = await mount("http://localhost/settings");
  try {
    assert.match(view.selected(), /^Account/);
    const tabs = Array.from(view.host.querySelectorAll<HTMLAnchorElement>('[role="tab"]'));
    assert.deepEqual(
      tabs.map((tab) => tab.querySelector("span")?.textContent),
      ["Account", "Spaces", "Sharing", "Assistant", "Connections", "Notifications", "Shortcuts", "Data"],
    );
    assert.equal(tabs[7]!.getAttribute("href"), "?tab=data");
    await act(async () => {
      tabs[7]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle(2);
    assert.match(view.selected(), /^Data/);
    assert.equal(new URL(window.location.href).searchParams.get("tab"), "data");
    await act(async () => {
      tabs[7]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await settle(2);
    assert.match(view.selected(), /^Account/, "wraps around");
    assert.equal(document.activeElement, tabs[0]);
  } finally {
    await view.done();
  }
});

test("Connections shows the five featured apps, and a connector link opens the store on it", async () => {
  const view = await mount("http://localhost/settings?tab=connections&connector=github");
  try {
    await until(() => Boolean(document.querySelector('[data-testid="featured-connectors"]')), "the featured list");
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="featured-connectors"] [data-connector]')).map((row) => row.dataset.connector);
    assert.deepEqual(rows, ["google_workspace", "microsoft_365", "notion", "linear", "github"]);
    assert.match(document.querySelector('[data-connector="github"]')!.textContent ?? "", /Connected as mira-chen/);
    await until(() => Boolean(document.querySelector('[data-testid="connector-detail"]')), "the GitHub detail");
    assert.equal(document.querySelector<HTMLElement>('[data-testid="connector-detail"]')!.dataset.connector, "github");
    assert.ok(document.querySelector('[data-testid="fetch-paused"]'), "fetching shows the paused notice");
    assert.equal(document.querySelector('input[type="time"][aria-label^="Fetch time"]'), null, "no schedule editor");
    assert.ok(document.querySelector('a[href="/connect"]'), "editors link to the Connect page");
  } finally {
    await view.done();
  }
});

test("Model providers & keys opens as a dialog from the Models card, and Escape closes it", async () => {
  const view = await mount("http://localhost/settings?tab=assistant");
  try {
    await until(() => Boolean(document.querySelector('[data-testid="model-keys-row"]')), "the keys row");
    assert.match(document.querySelector('[data-testid="model-keys-row"]')!.textContent ?? "", /Google Gemini has a key/);
    assert.equal(document.querySelector('[data-testid="model-keys-dialog"]'), null);
    const open = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.trim() === "Manage keys")!;
    await act(async () => {
      open.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle(3);
    const dialog = document.querySelector<HTMLElement>('[data-testid="model-keys-dialog"]');
    assert.ok(dialog);
    assert.equal(new URL(window.location.href).searchParams.get("dialog"), "keys");
    assert.match(dialog.textContent ?? "", /OpenRouter/);
    assert.match(dialog.textContent ?? "", /Ollama URL/);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle(2);
    assert.equal(document.querySelector('[data-testid="model-keys-dialog"]'), null);
    assert.equal(new URL(window.location.href).searchParams.get("dialog"), null);
    assert.match(document.body.textContent ?? "", /Your field/);
    assert.match(document.querySelector('[data-testid="changes-summary"]')?.textContent ?? "", /Everything inside Ensemble · Connected apps ask first/);
  } finally {
    await view.done();
  }
});
