import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PageMention } from "@ensemble/shared-types";
import { AddFileToMessage } from "./add-to-message.js";

(globalThis as { React?: typeof React }).React = React;

test("attachment picker lists saved files only, opens without any connected-app requests, and inserts a file ID", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const picked: PageMention[] = [];
  globalThis.fetch = (async input => {
    const path = new URL(String(input), "http://localhost").pathname;
    calls.push(path);
    assert.equal(path, "/api/documents", "only saved files may be requested");
    return new Response(JSON.stringify({ files: [{ id: "saved-file-id", filename: "Research.pdf", byteSize: 1234 }], usage: {} }));
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AddFileToMessage onInsert={file => picked.push(file)} /></QueryClientProvider>));
    assert.equal(calls.length, 0);
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    for (let i = 0; i < 20 && !document.body.textContent?.includes("Research.pdf"); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    const file = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(button => button.textContent?.includes("Research.pdf"));
    assert.ok(file);
    await act(async () => file.click());
    assert.deepEqual(picked, [{ kind: "file", id: "saved-file-id", label: "Research.pdf" }]);
    assert.deepEqual(calls, ["/api/documents"]);
  } finally {
    await act(async () => root.unmount()); host.remove(); client.clear(); globalThis.fetch = realFetch;
  }
});
