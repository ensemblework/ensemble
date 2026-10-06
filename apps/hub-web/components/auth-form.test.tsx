import { setTestUrl } from "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthForm, authRedirectTarget } from "./auth-form.js";
import { HUB_API } from "@/lib/api";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

test("open registration offers configured social logins without connector scopes and email password signup", async () => {
  setTestUrl("http://localhost/signup");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  client.setQueryData(["auth-status"], {
    hasAccounts: true, signup: "open", bypass: false,
    providers: ["google", "github", "microsoft"], emailConfigured: true, turnstileSiteKey: null,
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(client.getQueryData(["auth-status"])), { headers: { "Content-Type": "application/json" } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AuthForm mode="signup" /></QueryClientProvider>));
    assert.match(host.textContent ?? "", /Create your account/);
    assert.doesNotMatch(host.textContent ?? "", /invite only/i);
    for (const provider of ["google", "github", "microsoft"]) {
      assert.ok(host.querySelector(`a[href="${HUB_API}/api/auth/oauth/${provider}/start"]`), provider);
    }
    assert.ok(host.querySelector("input[type=email]"));
    assert.equal(host.querySelector<HTMLInputElement>("input[type=password]")?.minLength, 8);
    assert.equal(host.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled, false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = realFetch;
    setTestUrl("http://localhost/");
  }
});

test("unconfigured hosted signup hides the unusable email form but keeps available providers", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const providers of [[], ["google"]]) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
      const status = { hasAccounts: true, signup: "open", bypass: false, providers, emailConfigured: false, emailSignupAvailable: false, turnstileSiteKey: null };
      client.setQueryData(["auth-status"], status);
      globalThis.fetch = async () => new Response(JSON.stringify(status), { headers: { "Content-Type": "application/json" } });
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(<QueryClientProvider client={client}><AuthForm mode="signup" /></QueryClientProvider>));
        assert.equal(host.querySelector("input[type=email]"), null);
        assert.equal(host.querySelector("button[type=submit]"), null);
        assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", providers.length ? /configured providers/ : /not available/);
        assert.equal(host.querySelectorAll(`a[href^="${HUB_API}/api/auth/oauth/"]`).length, providers.length);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        client.clear();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signup with verification mail goes to the code page before onboarding", () => {
  assert.equal(authRedirectTarget("signup", { verificationSent: true }, null), "/verify?next=/start");
  assert.equal(authRedirectTarget("signup", { verificationSent: false }, null), "/start");
  assert.equal(authRedirectTarget("login", {}, "/context"), "/context");
  assert.equal(authRedirectTarget("login", {}, "https://evil.example"), "/today");
});
