import { setTestUrl } from "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountRecovery } from "./account-recovery.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

test("email verification keeps the secret out of the URL and waits for explicit confirmation", async () => {
  setTestUrl("http://localhost/verify#token=verification-secret");
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ verified: true }), { headers: { "Content-Type": "application/json" } });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AccountRecovery mode="verify" /></QueryClientProvider>));
    assert.equal(window.location.hash, "");
    assert.equal(calls.length, 0);
    const form = host.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.deepEqual(calls, [{ url: "/api/auth/verify-email", body: { token: "verification-secret" } }]);
    assert.match(host.textContent ?? "", /Email verified/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = realFetch;
    setTestUrl("http://localhost/");
  }
});

test("a reset page without an email token cannot submit", async () => {
  setTestUrl("http://localhost/reset");
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AccountRecovery mode="reset" /></QueryClientProvider>));
    assert.match(host.textContent ?? "", /Open the full link/);
    assert.equal(host.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled, true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  }
});
