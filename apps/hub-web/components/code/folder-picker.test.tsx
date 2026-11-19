import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BranchMenu } from "./branch-menu.js";
import { FolderPicker } from "./folder-picker.js";

(globalThis as { React?: typeof React }).React = React;

const OLD = "Update Ensemble on Home Server to 0.8.3 or later (`ensemble update`) to browse its folders and branches from here.";

/** A paired computer on Code API 5: no picker or branch calls, but it knows its repositories. */
function olderComputer() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as { path?: string }) : {};
    if (body.path === "/api/code/browse" || body.path === "/api/code/branches") return new Response(JSON.stringify({ error: OLD }), { status: 409, headers: { "Content-Type": "application/json" } });
    if (body.path === "/api/code/repos") return new Response(JSON.stringify({ repos: ["/home/me/code/site", "/home/me/ensemble-workspace/runs/082db2b5-7f47-467a-ae2a-d3c265595b70"], roots: ["/home/me/code"] }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return () => void (globalThis.fetch = real);
}

async function render(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 10))));
  };
  await settle();
  return { settle, done: async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  } };
}

test("on an older computer the folder picker lists the repositories it knows, and picking one opens it", async () => {
  const restore = olderComputer();
  const picked: string[] = [];
  const view = await render(<FolderPicker open onClose={() => undefined} target={{ kind: "device", deviceId: "d1" }} computerName="Home Server" onPick={(folder) => picked.push(folder.path)} />);
  try {
    const old = document.querySelector('[data-testid="folder-picker-old"]');
    assert.ok(old, "the picker falls back instead of failing");
    assert.match(old.textContent ?? "", /0\.8\.3 or later/);
    const rows = [...old.querySelectorAll("button")];
    assert.deepEqual(rows.map((row) => row.textContent?.includes("site")), [true], "run checkouts are left out");
    await act(async () => rows[0]!.click());
    assert.deepEqual(picked, ["/home/me/code/site"]);
  } finally {
    await view.done();
    restore();
  }
});

test("on an older computer the branch menu shows the branch quietly and offers no change", async () => {
  const restore = olderComputer();
  const view = await render(
    <BranchMenu target={{ kind: "device", deviceId: "d1" }} repo="/home/me/code/site" branch="main" trigger={(_open, toggle, current) => <button type="button" data-testid="open-branches" onClick={toggle}>{current}</button>} />,
  );
  try {
    await act(async () => (document.querySelector('[data-testid="open-branches"]') as HTMLButtonElement).click());
    await view.settle();
    const menu = document.querySelector('[data-testid="branch-menu"]');
    assert.ok(menu);
    assert.match(document.querySelector('[data-testid="branch-menu-old"]')?.textContent ?? "", /0\.8\.3 or later/);
    assert.equal(menu.querySelector(".text-danger"), null, "not shown as an error");
    assert.doesNotMatch(menu.textContent ?? "", /New branch/);
  } finally {
    await view.done();
    restore();
  }
});
