import { setTestUrl } from "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Settings } from "@ensemble/shared-types";
import { statusOf, SubscriptionsCard } from "./subscriptions.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

const SETTINGS = Settings.parse({ email: "mira@fieldnote.example", timezone: "Europe/London" });

/** A Linux computer with the Cursor app and VS Code, and neither Cursor's agent nor Copilot CLI. */
const VIEW = {
  preferred: null,
  computers: [
    {
      id: "device-1",
      name: "Homeserver",
      platform: "linux",
      local: false,
      online: true,
      lastSeenAt: "2026-11-15T09:00:00.000Z",
      appVersion: "cli-0.7.19",
      ready: true,
      agents: [{ id: "claude-code", via: "cli", version: "2.1.300", signedIn: false, plan: null, models: [{ id: "default", label: "Your plan's default", isDefault: true }], typedModels: true, checkedAt: "2026-11-15T09:00:00.000Z" }],
      apps: ["cursor-app", "vscode-copilot"],
    },
  ],
};

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  }
}

async function mount(url: string) {
  setTestUrl(url);
  const realFetch = globalThis.fetch;
  const posted: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method && init.method !== "GET") posted.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    if (path === "/api/subscriptions") return new Response(JSON.stringify(VIEW), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/subscriptions/set-up") return new Response(JSON.stringify({ message: "A terminal window is opening on Homeserver." }), { status: 202, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SubscriptionsCard settings={SETTINGS} patch={() => undefined} />
      </QueryClientProvider>,
    );
  });
  await settle();
  return {
    host,
    posted,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
      setTestUrl("http://localhost/");
    },
  };
}

test("an agent's app without the agent says so, and Set up asks that computer to install it", async () => {
  const view = await mount("http://localhost/settings?tab=assistant");
  try {
    const tile = (id: string) => view.host.querySelector<HTMLElement>(`[data-subscription="${id}"]`)!;
    assert.ok(tile("cursor-agent"), "the Cursor app's plan is shown with the ones found");
    assert.equal(tile("cursor-agent").dataset.state, "setup");
    assert.match(tile("cursor-agent").textContent ?? "", /Needs setup/);
    assert.match(tile("cursor-agent").querySelector('[data-testid="subscription-app-found"]')?.textContent ?? "", /^Cursor app found\. Set up its agent\.$/);
    assert.match(tile("copilot-cli").querySelector('[data-testid="subscription-app-found"]')?.textContent ?? "", /^VS Code found\. Set up Copilot CLI\.$/);
    assert.equal(tile("claude-code").dataset.state, "signed-out");
    assert.equal(view.host.querySelector('[data-subscription="gemini-cli"]'), null, "a plan with neither its app nor its agent waits in Manage subscriptions");
    assert.equal(tile("cursor-agent").querySelector('a[href="https://cursor.com/cli"]'), null, "one button, not the install link");
    await act(async () => {
      tile("cursor-agent").querySelector<HTMLElement>('[data-testid="subscription-set-up"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(3);
    assert.deepEqual(view.posted, [{ path: "/api/subscriptions/set-up", body: { deviceId: "device-1", agent: "cursor-agent" } }]);
  } finally {
    await view.done();
  }
});

test("Manage subscriptions lists an agent's app with the plans on that computer", async () => {
  const view = await mount("http://localhost/settings?tab=assistant&dialog=subscriptions");
  try {
    const dialog = document.querySelector<HTMLElement>('[data-testid="subscriptions-dialog"]')!;
    assert.ok(dialog, "the dialog is open");
    const rows = [...dialog.querySelectorAll<HTMLElement>("[data-subscription-row]")].map((row) => row.dataset.subscriptionRow);
    assert.deepEqual(rows.slice(0, 3), ["claude-code", "cursor-agent", "copilot-cli"], "on Homeserver first, then the other plans");
    assert.equal(dialog.querySelector('[data-subscription-row="cursor-agent"] [aria-label]')?.getAttribute("aria-label"), "Needs setup");
    assert.equal(dialog.querySelector('[data-subscription-row="gemini-cli"] [aria-label]')?.getAttribute("aria-label"), "Not on this computer");
  } finally {
    await view.done();
  }
});

test("the status of a plan whose app is there without its agent", () => {
  assert.deepEqual(statusOf(null, "cursor-app"), { tone: "orange", text: "Needs setup" });
  assert.deepEqual(statusOf(null), { tone: "gray", text: "Not on this computer" });
});
