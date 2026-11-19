import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolCatalog } from "@ensemble/shared-types";
import { ToolsPicker } from "./tools-picker.js";

Object.defineProperty(globalThis, "self", { configurable: true, value: window });
(globalThis as { React?: typeof React }).React = React;

const CATALOG: ToolCatalog = {
  apps: [
    {
      key: "google_workspace",
      name: "Google Workspace",
      logo: "google",
      source: "connector",
      account: "mira@fieldnote.example",
      tools: [
        { name: "gmail_search", title: "Search", product: "Gmail", write: false },
        { name: "calendar_create_event", title: "Create event", product: "Google Calendar", write: true, blocked: "Changes in apps are off in Settings › Assistant" },
      ],
    },
    { key: "github", name: "GitHub", logo: "github", source: "connector", account: "mira", tools: [{ name: "apps_search", title: "Search", write: false }] },
    { key: "mcp:custom-wip", name: "Work in progress", logo: null, source: "mcp", account: null, blocked: "Sign-in not finished", tools: [{ name: "get_thing", title: "get_thing", write: false, blocked: "Sign-in not finished" }] },
  ],
};

function Harness({ seen }: { seen: string[][] }) {
  const [off, setOff] = useState<string[]>([]);
  return <ToolsPicker scope="thread" value={off} onChange={(next) => { seen.push(next); setOff(next); }} />;
}

test("the Tools picker lists connected apps, switches one off for the thread, and says why another cannot be on", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(CATALOG), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const seen: string[][] = [];
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 10))));
  };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Harness seen={seen} /></QueryClientProvider>));
    await settle();
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="tools-picker"]')!;
    assert.match(trigger.getAttribute("aria-label") ?? "", /All on/);
    await act(async () => trigger.click());
    await settle();
    const panel = document.querySelector('[data-testid="tools-panel"]')!;
    assert.match(panel.textContent ?? "", /Tools for this thread/);
    const rows = [...panel.querySelectorAll('[data-testid="tools-app"]')];
    assert.deepEqual(rows.map((row) => row.querySelector(".text-ink")?.textContent), ["Google Workspace", "GitHub", "Work in progress"]);
    assert.match(rows[2]!.textContent ?? "", /Sign-in not finished/);
    assert.equal(rows[2]!.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled, true);

    await act(async () => rows[0]!.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    assert.deepEqual(seen.at(-1), ["google_workspace"]);
    await settle();
    assert.match(host.querySelector('[data-testid="tools-picker"]')!.getAttribute("aria-label") ?? "", /1 app off/);
    assert.equal(host.querySelector(".tools-count")?.textContent, "1");

    // The blocked write shows its reason when the app is opened.
    await act(async () => rows[0]!.querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
    assert.match(document.querySelector('[data-testid="tools-panel"]')!.textContent ?? "", /Changes in apps are off/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = real;
  }
});
