import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Settings } from "@ensemble/shared-types";
import { DeleteDataSection } from "./sections.js";
import { ToastProvider } from "../toast.js";

(globalThis as { React?: typeof React }).React = React;

test("Danger zone requires a typed scope-specific phrase and a separate final confirmation", async () => {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  const button = (label: RegExp) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(node => label.test(node.textContent ?? ""))!;
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><ToastProvider><DeleteDataSection settings={Settings.parse({})} /></ToastProvider></QueryClientProvider>));
    assert.match(host.textContent ?? "", /Danger zone/);
    await act(async () => host.querySelector<HTMLInputElement>('input[value="everything"]')!.click());
    await act(async () => button(/Delete selected data/).click());
    const field = document.querySelector<HTMLInputElement>('[aria-label="Deletion confirmation phrase"]')!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    await act(async () => field.dispatchEvent(paste));
    assert.equal(paste.defaultPrevented, true);
    assert.equal(button(/Review deletion/).disabled, true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, "delete everything");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(button(/Review deletion/).disabled, false);
    assert.equal(calls.length, 0);
    await act(async () => button(/Review deletion/).click());
    assert.equal(calls.length, 0, "review does not erase data");
    await act(async () => button(/^Permanently delete$/).click());
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.endsWith("/api/data/delete"));
    assert.deepEqual(calls[0]!.body, { scope: "everything", confirm: "delete everything" });
  } finally {
    await act(async () => root.unmount()); host.remove(); client.clear(); globalThis.fetch = realFetch;
  }
});
