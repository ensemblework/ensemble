import { setTestUrl } from "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountRecovery, verificationSuccessTarget } from "./account-recovery.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

function typeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter);
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("email verification submits a code for the signed-in account", async () => {
  setTestUrl("http://localhost/verify?next=/start");
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/auth/me") {
      return new Response(JSON.stringify({
        user: { id: "user-1", email: "mira@fieldnote.example", name: "Mira Chen", profile: { gender: null, profession: null, organization: null, heardFrom: null } },
        via: "session",
        onboardingComplete: false,
        profileComplete: true,
      }), { headers: { "Content-Type": "application/json" } });
    }
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ verified: true }), { headers: { "Content-Type": "application/json" } });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AccountRecovery mode="verify" /></QueryClientProvider>));
    assert.match(host.textContent ?? "", /mira@fieldnote\.example/);
    assert.equal(calls.length, 0);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Verification code"]')!;
    await act(async () => {
      typeInput(input, "ab-c");
    });
    assert.equal(input.value, "ABC");
    await act(async () => {
      typeInput(input, "ABCD");
    });
    const form = host.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.deepEqual(calls, [{ url: "/api/auth/verify-email", body: { code: "ABCD" } }]);
    assert.equal(verificationSuccessTarget("/start", false), "/start");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = realFetch;
    setTestUrl("http://localhost/");
  }
});

test("email verification asks signed-out people to sign in first", async () => {
  setTestUrl("http://localhost/verify");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Sign in." }), { status: 401, headers: { "Content-Type": "application/json" } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<QueryClientProvider client={client}><AccountRecovery mode="verify" /></QueryClientProvider>);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    assert.match(host.textContent ?? "", /Sign in first/);
    assert.ok(host.querySelector('a[href="/login?next=/verify"]'));
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
